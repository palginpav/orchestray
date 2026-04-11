#!/usr/bin/env node
'use strict';

// T1→T2 merge note: when T2 lands, replace the fallback-write with the shared helper.

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
 * PII discipline: tool_input and tool_result fields are NOT written to either
 * file. Only the outcome classification (answered|error|skipped) and the
 * result_count (pattern_find only, best-effort) are derived from tool_result.
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
const { getRoutingFilePath } = require('./_lib/routing-lookup');

// T2 helper — try to import; fall back to direct atomicAppendJsonl if not yet committed.
let appendCheckpointEntry = null;
let CHECKPOINT_FILE = null;
try {
  const cpLib = require('./_lib/mcp-checkpoint');
  appendCheckpointEntry = cpLib.appendCheckpointEntry;
  CHECKPOINT_FILE = cpLib.CHECKPOINT_FILE;
} catch (_e) {
  // T2 not yet committed — use fallback path constant.
  CHECKPOINT_FILE = '.orchestray/state/mcp-checkpoint.jsonl';
}

/** Tools this hook enforces. Any mcp__orchestray__ call not in this set is ignored. */
const ENFORCED_TOOLS = new Set([
  'pattern_find',
  'kb_search',
  'history_find_similar_tasks',
  'pattern_record_application',
]);

const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB cap — guards against runaway payloads OOMing the hook (T14 audit I14)

/**
 * Classify tool_result into outcome.
 * Only reads isError — no other field of tool_result is logged (T4 Finding S1).
 *
 * @param {*} toolResult - event.tool_result (may be undefined/null)
 * @returns {"answered"|"error"|"skipped"}
 */
function classifyOutcome(toolResult) {
  if (toolResult === undefined || toolResult === null) return 'skipped';
  if (toolResult.isError === true) return 'error';
  return 'answered';
}

/**
 * Extract result_count for pattern_find only (best-effort).
 * Reads content[0].text and structuredContent.count — no other fields (T4 Finding S1).
 *
 * @param {string} tool
 * @param {*} toolResult
 * @returns {number|null}
 */
function extractResultCount(tool, toolResult) {
  if (tool !== 'pattern_find') return null;
  if (!toolResult) return null;

  // Prefer structuredContent.count if present (most reliable)
  if (
    toolResult.structuredContent &&
    typeof toolResult.structuredContent.count === 'number'
  ) {
    return toolResult.structuredContent.count;
  }

  // Fall back to heuristic regex on content[0].text
  try {
    const text =
      Array.isArray(toolResult.content) &&
      toolResult.content[0] &&
      typeof toolResult.content[0].text === 'string'
        ? toolResult.content[0].text
        : null;
    if (text) {
      const m = text.match(/(\d+)\s+match(?:es)?/i);
      if (m) return parseInt(m[1], 10);
    }
  } catch (_e) {
    // Best-effort — do not block on parse failure
  }

  return null;
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

    // Ignore calls for tools not in the enforced set.
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

    // Derive phase: routing.jsonl present → post-decomposition, absent → pre-decomposition.
    const routingFile = getRoutingFilePath(cwd);
    const phase = fs.existsSync(routingFile) ? 'post-decomposition' : 'pre-decomposition';

    // Classify outcome and extract result_count (PII discipline: only these two
    // derived values leave tool_result; the raw object is never logged).
    const toolResult = event.tool_result;
    const outcome = classifyOutcome(toolResult);
    const result_count = extractResultCount(tool, toolResult);

    // Build the checkpoint row.
    const row = {
      timestamp: new Date().toISOString(),
      orchestration_id: orchId,
      tool,
      outcome,
      phase,
      result_count,
    };

    // --- Write 1: operational ledger (.orchestray/state/mcp-checkpoint.jsonl) ---
    try {
      if (typeof appendCheckpointEntry === 'function') {
        // T2 helper is available — use it.
        appendCheckpointEntry(cwd, row);
      } else {
        // Fallback: T2 not yet committed — write directly.
        atomicAppendJsonl(path.join(cwd, CHECKPOINT_FILE), row);
      }
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
