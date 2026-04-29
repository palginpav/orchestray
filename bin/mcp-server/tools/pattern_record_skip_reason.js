'use strict';

/**
 * `pattern_record_skip_reason` MCP tool.
 *
 * Records a structured "none of the returned patterns shaped this
 * decomposition" decision immediately after a `pattern_find` call. This
 * handler is a pure result emitter — it does NOT emit the `mcp_tool_call`
 * audit row itself. The central dispatcher in `server.js` (tools/call
 * dispatch block) emits that event for all non-ask_user tools. The audit
 * row will carry the `orchestration_id` from this tool's input (via the
 * T2 F4 override in server.js) rather than the filesystem marker.
 *
 * W11 (LL1): counterfactual skip enrichment.
 * Added structured skip-signal fields so operators can distinguish
 * "skipped because contextually mismatched" from "skipped because forgotten".
 * Emits an additional `pattern_skip_enriched` audit event with all new fields.
 *
 * Per 2014-scope-proposal.md §W1 and W11 design spec.
 */

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { writeAuditEvent } = require('../lib/audit');
const { logStderr } = require('../lib/rpc');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

// The four-value reason enum per scope-proposal §W1 R5 risk.
const SKIP_REASONS = ['all-irrelevant', 'all-low-confidence', 'all-stale', 'other'];

// W11: Five-value skip_category enum for counterfactual signal.
const SKIP_CATEGORIES = [
  'contextual-mismatch',  // matched surface criteria, but key context differs
  'stale',                // decayed_confidence below action threshold
  'superseded',           // another pattern in result set supersedes this one
  'operator-override',    // user directed a different approach
  'forgotten',            // PM saw the pattern but didn't explicitly weigh it (fallback)
];

// W11: Three-value match_quality enum.
const MATCH_QUALITIES = ['strong-match', 'weak-match', 'edge-case'];

// Window size for the forgotten-rate warning check.
const FORGOTTEN_RATE_WINDOW = 25;
// Threshold above which a stderr warning fires (30%).
const FORGOTTEN_RATE_THRESHOLD = 0.30;

const INPUT_SCHEMA = {
  type: 'object',
  required: ['orchestration_id', 'reason'],
  properties: {
    orchestration_id: { type: 'string', minLength: 1, maxLength: 64 },
    // Legacy prose reason field — kept for backward compatibility.
    // Now the freeform prose companion to the structured skip_category.
    reason: { type: 'string', enum: SKIP_REASONS },
    note: { type: 'string', maxLength: 500 },
    // W11 new fields (strongly recommended; callers that omit them default to
    // skip_category: "forgotten" and match_quality: "edge-case" with a stderr warning
    // so existing callers keep working without hard failures):
    pattern_name: { type: 'string', minLength: 1, maxLength: 200 },
    match_quality: { type: 'string', enum: MATCH_QUALITIES },
    skip_category: { type: 'string', enum: SKIP_CATEGORIES },
    // Optional: decayed_confidence value seen at decision time.
    cited_confidence: { type: 'number', minimum: 0, maximum: 1 },
    // Optional: name of pattern that supersedes this one (only when skip_category: superseded).
    superseded_by: { type: 'string', minLength: 1, maxLength: 200 },
    // Optional: free-form skip reason prose (replaces/complements the legacy note).
    skip_reason: { type: 'string', maxLength: 1000 },
  },
};

const definition = deepFreeze({
  name: 'pattern_record_skip_reason',
  description:
    'Record that none of the patterns returned by pattern_find shaped the ' +
    'current decomposition. Call once per pattern that was NOT applied, ' +
    'immediately after a pattern_find call. Produces an auditable ' +
    'mcp_tool_call row and a pattern_skip_enriched audit event for the ' +
    'LL1 counterfactual analysis. ' +
    'reason must be one of: all-irrelevant, all-low-confidence, all-stale, other. ' +
    'When reason is "other", note is required. ' +
    'RECOMMENDED: match_quality (strong-match | weak-match | edge-case) and ' +
    'skip_category (contextual-mismatch | stale | superseded | operator-override | forgotten). ' +
    'If omitted, both default to "edge-case"/"forgotten" with a stderr notice. ' +
    'Use "forgotten" only as a last resort when no other category fits — ' +
    'it triggers a stderr warning if its rate exceeds 30% over the last 25 skips. ' +
    'When skip_category is "superseded", provide superseded_by with the superseding pattern name. ' +
    'cited_confidence: the decayed_confidence value seen when deciding to skip (optional but recommended).',
  inputSchema: INPUT_SCHEMA,
});

/**
 * Count recent `pattern_skip_enriched` events from the audit stream and
 * return the fraction that used skip_category: "forgotten". Uses the context's
 * auditSink to get the audit path when available, or the standard audit path.
 *
 * Returns { forgottenCount, totalCount, rate } — all numbers; rate is 0..1.
 * Never throws.
 */
function _computeForgottenRate(orchId, context) {
  try {
    const paths = require('../lib/paths');
    let auditPath;
    if (context && context.projectRoot) {
      const path = require('node:path');
      auditPath = path.join(context.projectRoot, '.orchestray', 'audit', 'events.jsonl');
    } else {
      auditPath = paths.getAuditEventsPath();
    }
    const fs = require('node:fs');
    if (!fs.existsSync(auditPath)) {
      return { forgottenCount: 0, totalCount: 0, rate: 0 };
    }
    const raw = fs.readFileSync(auditPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    // Scan from the end, collecting pattern_skip_enriched events for this orch.
    const recent = [];
    for (let i = lines.length - 1; i >= 0 && recent.length < FORGOTTEN_RATE_WINDOW; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (
          ev.type === 'pattern_skip_enriched' &&
          ev.orchestration_id === orchId
        ) {
          recent.push(ev);
        }
      } catch (_e) { /* skip malformed line */ }
    }
    if (recent.length === 0) return { forgottenCount: 0, totalCount: 0, rate: 0 };
    const forgottenCount = recent.filter(ev => ev.skip_category === 'forgotten').length;
    const rate = forgottenCount / recent.length;
    return { forgottenCount, totalCount: recent.length, rate };
  } catch (_e) {
    return { forgottenCount: 0, totalCount: 0, rate: 0 };
  }
}

async function handle(input, context) {
  emitHandlerEntry('pattern_record_skip_reason', context);
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_record_skip_reason: ' + validation.errors.join('; '));
  }

  // Extra rule: when reason is 'other', note is mandatory.
  if (input.reason === 'other' && (!input.note || input.note.trim().length === 0)) {
    return toolError(
      'pattern_record_skip_reason: note is required when reason is "other"'
    );
  }

  // W11: resolve effective match_quality and skip_category, defaulting to
  // 'forgotten'/'edge-case' when absent (backward-compat: old callers omit them).
  // When either field is absent, emit a stderr notice so operators can see the gap.
  const effectiveSkipCategory = input.skip_category || 'forgotten';
  const effectiveMatchQuality = input.match_quality || 'edge-case';
  if (!input.skip_category || !input.match_quality) {
    logStderr(
      'pattern_record_skip_reason: match_quality/skip_category not provided — ' +
      'defaulting to skip_category="forgotten", match_quality="edge-case". ' +
      'Provide these fields for accurate LL1 analysis.'
    );
  }

  // W11: cross-field validation — superseded_by only valid when skip_category is 'superseded'.
  if (
    input.superseded_by !== undefined &&
    input.superseded_by !== null &&
    effectiveSkipCategory !== 'superseded'
  ) {
    return toolError(
      'pattern_record_skip_reason: superseded_by is only meaningful when ' +
      'skip_category is "superseded" (got skip_category: "' + effectiveSkipCategory + '")'
    );
  }

  // Build the success result (backward-compatible: includes all original fields).
  const result = {
    orchestration_id: input.orchestration_id,
    reason: input.reason,
    recorded: true,
    match_quality: effectiveMatchQuality,
    skip_category: effectiveSkipCategory,
  };

  if (input.note !== undefined && input.note !== null) {
    result.note = input.note;
  }
  if (input.pattern_name !== undefined && input.pattern_name !== null) {
    result.pattern_name = input.pattern_name;
  }
  if (input.cited_confidence !== undefined && input.cited_confidence !== null) {
    result.cited_confidence = input.cited_confidence;
  }
  if (input.superseded_by !== undefined && input.superseded_by !== null) {
    result.superseded_by = input.superseded_by;
  }
  if (input.skip_reason !== undefined && input.skip_reason !== null) {
    result.skip_reason = input.skip_reason;
  }

  // W11: emit the pattern_skip_enriched audit event.
  const skipEnrichedEvent = {
    timestamp: new Date().toISOString(),
    type: 'pattern_skip_enriched',
    orchestration_id: input.orchestration_id,
    pattern_name: input.pattern_name || null,
    match_quality: effectiveMatchQuality,
    skip_category: effectiveSkipCategory,
    skip_reason: input.skip_reason || input.note || null,
  };
  if (input.cited_confidence !== undefined && input.cited_confidence !== null) {
    skipEnrichedEvent.cited_confidence = input.cited_confidence;
  }
  if (input.superseded_by !== undefined && input.superseded_by !== null) {
    skipEnrichedEvent.superseded_by = input.superseded_by;
  }

  // Resolve the audit writer. When context supplies an auditSink or projectRoot
  // (e.g., in tests), write directly to the test-controlled path. Otherwise fall
  // back to the global writeAuditEvent which resolves the project root at call time.
  // Fail-open: never block the tool response on an audit write failure.
  try {
    if (context && typeof context.auditSink === 'function') {
      // Test-injected or server-injected sink (e.g., ask_user pattern).
      context.auditSink(skipEnrichedEvent);
    } else if (context && context.projectRoot) {
      // Test fixture: write directly to the test project root's events.jsonl.
      const fs = require('node:fs');
      const nodePath = require('node:path');
      const auditPath = nodePath.join(context.projectRoot, '.orchestray', 'audit', 'events.jsonl');
      fs.appendFileSync(auditPath, JSON.stringify(skipEnrichedEvent) + '\n', 'utf8');
    } else {
      writeAuditEvent(skipEnrichedEvent);
    }
  } catch (_e) { /* fail-open */ }

  // W11: check forgotten rate and emit stderr warning if threshold exceeded.
  // Do this AFTER writing the current event so it counts this call.
  if (effectiveSkipCategory === 'forgotten') {
    try {
      const { forgottenCount, totalCount, rate } = _computeForgottenRate(input.orchestration_id, context);
      if (totalCount > 0 && rate > FORGOTTEN_RATE_THRESHOLD) {
        const pct = Math.round(rate * 100);
        logStderr(
          'pattern skip enrichment: ' + pct + '% forgotten over last ' +
          totalCount + ' skips — consider explicit categorisation'
        );
      }
    } catch (_e) { /* fail-open */ }
  }

  return toolSuccess(result);
}

module.exports = {
  definition,
  handle,
  SKIP_REASONS,
  SKIP_CATEGORIES,
  MATCH_QUALITIES,
};
