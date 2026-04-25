#!/usr/bin/env node
'use strict';

/**
 * PostToolUse:mcp__orchestray__* hook — writes one checkpoint row per enforced
 * MCP tool call to both the operational ledger and the sealed audit trail.
 *
 * Writes to:
 *   .orchestray/state/mcp-checkpoint.jsonl  (gate-readable ledger)
 *   .orchestray/audit/events.jsonl          (sealed audit trail, mcp_checkpoint_recorded)
 *
 * Enforced tools: pattern_find, kb_search, history_find_similar_tasks,
 *                 pattern_record_application.
 * Any other mcp__orchestray__* call is silently ignored (exit 0).
 *
 * PII discipline: tool_input and tool_response fields are NOT written to either
 * file. Only the outcome classification (answered|error|skipped) and the
 * result_count (table-driven for all three retrieval tools) are derived from
 * tool_response. Raw response content is never logged. (BUG-A-2.0.13 fix)
 *
 * The orchestration_id is read from .orchestray/audit/current-orchestration.json
 * via getCurrentOrchestrationFile() — the shared identity anchor that ensures
 * the gate (gate-agent-spawn.js) and this writer see the same ID even across
 * session restarts (T4 Finding C1 fix, DESIGN §D2 step 3).
 *
 * Fails open on every error. Never exits non-zero.
 *
 * Input:  JSON on stdin (Claude Code PostToolUse hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readRoutingEntries } = require('./_lib/routing-lookup');

const { appendCheckpointEntry } = require('./_lib/mcp-checkpoint');
// T3 X3: MAX_INPUT_BYTES is now the shared constant from _lib/constants.js.
const { MAX_INPUT_BYTES } = require('./_lib/constants');

/** Tools this hook enforces. Any mcp__orchestray__ call not in this set is ignored. */
const ENFORCED_TOOLS = new Set([
  'pattern_find',
  'kb_search',
  'history_find_similar_tasks',
  'pattern_record_application',
]);

// BUG-A-2.0.13: Claude Code 2.1.59 delivers MCP tool results as `event.tool_response`
// (a JSON STRING), not as `event.tool_result` (which is `undefined`). The 2.0.12 hook
// was written against an incorrect field name assumption. Probe record at:
//   .orchestray/kb/artifacts/2013-posttooluse-probe-record.md
// Both classifyOutcome and extractResultCount now read toolResponse (string) directly.
// Parse is done once in the handler and the parsed object passed to both classifiers.

/**
 * Classify tool_response string into outcome.
 * Only reads the top-level isError discriminator — raw content is never logged (PII).
 *
 * @param {*} toolResponse - event.tool_response (should be a JSON string; may be undefined/null)
 * @returns {"answered"|"error"|"skipped"}
 */
function classifyOutcome(toolResponse) {
  if (toolResponse === undefined || toolResponse === null) return 'skipped';
  // Claude Code 2.1.59 sends tool_response as a JSON string for MCP tools.
  // Parse defensively — malformed or non-object response is treated as 'error'.
  if (typeof toolResponse !== 'string') {
    // Future-proof: if Claude Code ever starts sending an object directly,
    // fall through to the object-level isError check.
    if (typeof toolResponse === 'object') {
      return toolResponse.isError === true ? 'error' : 'answered';
    }
    return 'error';
  }
  let parsed;
  try {
    parsed = JSON.parse(toolResponse);
  } catch (_parseErr) {
    return 'error';
  }
  if (parsed && typeof parsed === 'object' && parsed.isError === true) return 'error';
  return 'answered';
}

/**
 * Per-tool result_count extractors — table-driven for all three retrieval tools
 * (resolved OQ-T1-2: uniform coverage for pattern_find, kb_search,
 * history_find_similar_tasks). Accepts the already-parsed response object or null.
 * Returns a number or null. Raw response content is never accessed here (PII).
 */
const RESULT_COUNT_EXTRACTORS = {
  pattern_find:              (parsed) => Array.isArray(parsed && parsed.matches) ? parsed.matches.length : null,
  kb_search:                 (parsed) => Array.isArray(parsed && parsed.matches) ? parsed.matches.length : null,
  history_find_similar_tasks:(parsed) => Array.isArray(parsed && parsed.matches) ? parsed.matches.length : null,
  pattern_record_application:()       => null, // write tool — no count applicable
};

/**
 * Extract result_count from the already-parsed tool response object.
 * All three retrieval tools share the same {matches:[...]} shape (probe-verified).
 * Accepts the result of JSON.parse(event.tool_response), or null on parse failure.
 *
 * @param {string} tool - short tool name (without mcp__orchestray__ prefix)
 * @param {object|null} parsedResponse - parsed tool_response, or null
 * @returns {number|null}
 */
function extractResultCount(tool, parsedResponse) {
  const extractor = RESULT_COUNT_EXTRACTORS[tool];
  if (!extractor) return null;
  return extractor(parsedResponse);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);

    // Derive the short tool name by stripping the mcp__orchestray__ prefix.
    const rawToolName = event.tool_name || '';
    const PREFIX = 'mcp__orchestray__';
    if (!rawToolName.startsWith(PREFIX)) {
      // Not an mcp__orchestray__ call — nothing to record.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    const tool = rawToolName.slice(PREFIX.length);

    // R-FPM (AC-01): emit a fields_projected observation when tool_input carries
    // a non-empty `fields` parameter. This fires for ANY mcp__orchestray__ tool
    // (not just enforced ones) so that routing_lookup / metrics_query are covered
    // once R-FPX wires them up.
    try {
      const toolInput = event.tool_input;
      const rawFields = toolInput && toolInput.fields;
      // Count field_count: parse the fields value the same way field-projection.js does.
      let fieldCount = 0;
      if (rawFields !== undefined && rawFields !== null) {
        if (typeof rawFields === 'string') {
          const parts = rawFields.split(',').map(s => s.trim()).filter(s => s.length > 0);
          fieldCount = parts.length;
        } else if (Array.isArray(rawFields)) {
          fieldCount = rawFields.filter(s => typeof s === 'string' && s.trim().length > 0).length;
        }
      }
      // AC-01: zero-length or missing fields → no observation.
      if (fieldCount > 0) {
        const cwd2 = resolveSafeCwd(event.cwd);
        let oid2 = 'unknown';
        try {
          const orchFile2 = getCurrentOrchestrationFile(cwd2);
          const orchData2 = JSON.parse(fs.readFileSync(orchFile2, 'utf8'));
          if (orchData2 && orchData2.orchestration_id) oid2 = orchData2.orchestration_id;
        } catch (_e2) {}

        const fpEvent = {
          timestamp:        new Date().toISOString(),
          type:             'fields_projected',
          orchestration_id: oid2,
          tool_name:        tool,
          field_count:      fieldCount,
          source:           'hook',
        };
        const auditDir2 = path.join(cwd2, '.orchestray', 'audit');
        try {
          fs.mkdirSync(auditDir2, { recursive: true });
          atomicAppendJsonl(path.join(auditDir2, 'events.jsonl'), fpEvent);
        } catch (_fpWriteErr) {
          // Fail-open
        }
      }
    } catch (_fpErr) {
      // Fail-open — fields_projected emission must never block checkpoint recording.
    }

    // Ignore calls for tools not in the enforced set (checkpoint recording only).
    if (!ENFORCED_TOOLS.has(tool)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const cwd = resolveSafeCwd(event.cwd);
    const orchFile = getCurrentOrchestrationFile(cwd);

    // Read orchestration_id — identity anchor (DESIGN §D2 step 3 / T4 Finding C1).
    // Missing file means we are outside an orchestration; nothing to record.
    let orchId;
    try {
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      orchId = orchData && orchData.orchestration_id;
    } catch (_e) {
      // File missing or malformed — outside an orchestration, fail-open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    if (!orchId) {
      // orchestration_id absent from file — fail-open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // BUG-B-2.0.13: Derive phase by checking whether routing.jsonl contains any
    // entries for the CURRENT orchestration_id — not from global file presence.
    // The old file-existence check (fs.existsSync on routing.jsonl) was wrong:
    // routing.jsonl persists across orchestrations, so a file written by a prior
    // orchestration caused every subsequent pre-decomposition call to be recorded
    // as phase='post-decomposition', triggering BUG-C at the gate.
    //
    // Fix: filter routing entries by orchId. If at least one row exists for this
    // orchestration → post-decomposition (PM has already written its routing
    // decision for this orch). If none exist → pre-decomposition (we are still
    // in the trio window before decomposition). If readRoutingEntries throws
    // (corrupted file or ENOENT) → fail-open to 'pre-decomposition' to avoid
    // blocking on audit-data corruption.
    //
    // Do NOT revert to file-existence heuristic.
    // See CHANGELOG.md §2.0.13 BUG-B / BUG-D for the design rationale.
    let phase;
    try {
      const allRoutingEntries = readRoutingEntries(cwd);
      const hasOrchEntries = allRoutingEntries.some(e => e && e.orchestration_id === orchId);
      phase = hasOrchEntries ? 'post-decomposition' : 'pre-decomposition';
    } catch (_phaseErr) {
      // Fail-open: corrupted routing file must not block checkpoint recording.
      phase = 'pre-decomposition';
    }

    // Classify outcome and extract result_count (PII discipline: only these two
    // derived values leave tool_response; the raw string is never logged).
    // Parse tool_response once here and pass the parsed object to both classifiers
    // to avoid double-parse. If parse fails, parsedResponse stays null.
    // BUG-A-2.0.13: field is tool_response (JSON string), not tool_result (undefined).
    const toolResponse = event.tool_response;
    let parsedResponse = null;
    if (typeof toolResponse === 'string') {
      try { parsedResponse = JSON.parse(toolResponse); } catch (_e) { /* parse failure handled per-classifier */ }
    }
    const outcome = classifyOutcome(toolResponse);
    const result_count = extractResultCount(tool, parsedResponse);

    // R-PFX + R-TGATE (v2.1.14): extract fields_used and response_bytes for telemetry.
    // R-PFX mandates compact `fields` projection on pattern_find / kb_search;
    // R-TGATE captures fields_used + response_bytes across all ENFORCED_TOOLS.
    // fields_used: true when the caller passed a non-empty `fields` parameter (string
    // form "a,b,c" or array form). response_bytes: byte length of the raw tool_response
    // (never logged — only size). Fail-open: enrichment never blocks the checkpoint.
    let fields_used = false;
    let response_bytes = 0;
    try {
      const toolInput = event.tool_input;
      const rawFields = toolInput && toolInput.fields;
      if (rawFields !== undefined && rawFields !== null) {
        if (typeof rawFields === 'string') {
          fields_used = rawFields.split(',').map(s => s.trim()).filter(s => s.length > 0).length > 0;
        } else if (Array.isArray(rawFields)) {
          fields_used = rawFields.filter(s => typeof s === 'string' && s.trim().length > 0).length > 0;
        }
      }
      if (typeof toolResponse === 'string') {
        response_bytes = Buffer.byteLength(toolResponse, 'utf8');
      }
    } catch (_fieldsErr) {
      // Fail-open — fields_used/response_bytes enrichment must never block checkpoint.
    }

    // Build the checkpoint row.
    const row = {
      timestamp: new Date().toISOString(),
      orchestration_id: orchId,
      tool,
      outcome,
      phase,
      result_count,
      fields_used,
      response_bytes,
    };

    // --- Write 1: operational ledger (.orchestray/state/mcp-checkpoint.jsonl) ---
    try {
      appendCheckpointEntry(cwd, row);
    } catch (_writeErr) {
      process.stderr.write(
        '[orchestray] record-mcp-checkpoint: checkpoint write failed (' +
        (_writeErr && _writeErr.message) + '); failing open\n'
      );
      // Fall through to the audit write — do not abort.
    }

    // --- Write 2: sealed audit trail (.orchestray/audit/events.jsonl) ---
    // Shape: mcp_checkpoint_recorded (DESIGN §D4 item 1).
    try {
      const auditDir = path.join(cwd, '.orchestray', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening; chmod may fail on exotic filesystems */ }

      const auditEvent = {
        timestamp: row.timestamp,
        type: 'mcp_checkpoint_recorded',
        orchestration_id: orchId,
        tool,
        outcome,
        phase,
        result_count,
        fields_used,
        response_bytes,
        source: 'hook',
      };
      atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), auditEvent);
    } catch (_auditErr) {
      process.stderr.write(
        '[orchestray] record-mcp-checkpoint: audit write failed (' +
        (_auditErr && _auditErr.message) + '); failing open\n'
      );
      // Fall through — never block on audit failure.
    }

  } catch (_e) {
    // Fail open: malformed JSON, missing stdin, or any other unexpected error.
    process.stderr.write('[orchestray] record-mcp-checkpoint: unexpected error (' + (_e && _e.message) + '); failing open\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
