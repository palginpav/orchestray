#!/usr/bin/env node
'use strict';

/**
 * validate-mcp-grounding.js — SubagentStop hook (v2.2.10 F2).
 *
 * MCP grounding hard-block gate. For roles in the F2 allowlist (pm, researcher,
 * debugger, architect), verifies that at least one `mcp_tool_call` event exists
 * in events.jsonl for the current orchestration_id. If none found, emits
 * `agent_mcp_grounding_missing` and exits 2 (hard-reject the SubagentStop).
 *
 * The gate ensures agents in grounding-required roles actually invoked MCP tools
 * (via M1 prefetch or direct calls) before completing.
 *
 * Allowlist (must match M1's ROLE_TOOL_MAP in prefetch-mcp-grounding.js):
 *   pm, researcher, debugger, architect
 *
 * Kill switch: ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED=1 → exit 0, no emit.
 *
 * Fail-open: if events.jsonl is unreadable, emit `f2_validation_error` and
 * exit 0 (never permanently brick spawns on audit-log unavailability).
 *
 * Input:  Claude Code SubagentStop JSON payload on stdin
 * Output: exit 0 (pass) or exit 2 (hard-block); stderr on block
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }             = require('./_lib/resolve-project-cwd');
const { writeEvent }                 = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }            = require('./_lib/constants');

// ---------------------------------------------------------------------------
// F2 allowlist — single source of truth.
// Must match M1's ROLE_TOOL_MAP keys in bin/prefetch-mcp-grounding.js.
// Future changes require updating both M1 + F2 together.
// ---------------------------------------------------------------------------
const F2_ALLOWLIST = new Set(['pm', 'researcher', 'debugger', 'architect']);

// Scan up to 4 MB of events.jsonl tail (enough for most sessions; avoids
// reading the entire file on very long runs).
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the active orchestration_id from current-orchestration.json.
 * Returns 'unknown' on any failure (fail-open).
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData && orchData.orchestration_id) return orchData.orchestration_id;
  } catch (_e) { /* fail-open */ }
  return 'unknown';
}

/**
 * Count `mcp_tool_call` events in events.jsonl that match the given
 * orchestration_id. Reads up to MAX_SCAN_BYTES from the tail of the file
 * to keep the hook fast on long-running sessions.
 *
 * Returns { count, error } where error is a string on I/O failure.
 */
function countMcpToolCalls(eventsPath, orchestrationId) {
  let raw = '';
  try {
    const stat = fs.statSync(eventsPath);
    const size = stat.size;
    if (size === 0) return { count: 0, error: null };

    if (size <= MAX_SCAN_BYTES) {
      raw = fs.readFileSync(eventsPath, 'utf8');
    } else {
      // Read only the tail
      const fd = fs.openSync(eventsPath, 'r');
      try {
        const buf  = Buffer.alloc(MAX_SCAN_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES);
        raw = buf.slice(0, read).toString('utf8');
      } finally {
        try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      }
    }
  } catch (e) {
    return { count: 0, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }

  // Parse JSONL and count matching mcp_tool_call rows
  let count = 0;
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (
        ev &&
        (ev.type === 'mcp_tool_call' || ev.event_type === 'mcp_tool_call') &&
        (orchestrationId === 'unknown' || ev.orchestration_id === orchestrationId)
      ) {
        count++;
      }
    } catch (_e) {
      // Malformed line — skip
    }
  }
  return { count, error: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      // Input too large — fail-open
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    let cwd;

    try {
      event = input.length > 0 ? JSON.parse(input) : {};
      cwd = resolveSafeCwd(event.cwd);
    } catch (_e) {
      // Malformed payload — fail-open
      process.exit(0);
    }

    // Kill switch
    if (process.env.ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED === '1') {
      process.exit(0);
    }

    // Determine the agent role. SubagentStop payload uses `agent_type`.
    const agentType = typeof event.agent_type === 'string'
      ? event.agent_type.toLowerCase()
      : null;
    const agentId = event.agent_id || null;

    // Role not in allowlist → pass
    if (!agentType || !F2_ALLOWLIST.has(agentType)) {
      process.exit(0);
    }

    // Resolve orchestration_id and events.jsonl path
    const orchestrationId = resolveOrchestrationId(cwd);
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

    // Check for events.jsonl existence — fail-open on missing file
    if (!fs.existsSync(eventsPath)) {
      try {
        writeEvent({
          type:       'f2_validation_error',
          agent_id:   agentId,
          agent_type: agentType,
          reason:     'events.jsonl not found; grounding gate skipped (fail-open)',
        }, { cwd });
      } catch (_e) { /* best-effort */ }
      process.exit(0);
    }

    // Count mcp_tool_call rows
    const { count, error } = countMcpToolCalls(eventsPath, orchestrationId);

    if (error !== null) {
      // I/O error — fail-open
      try {
        writeEvent({
          type:       'f2_validation_error',
          agent_id:   agentId,
          agent_type: agentType,
          reason:     'events.jsonl read error: ' + error,
        }, { cwd });
      } catch (_e) { /* best-effort */ }
      process.exit(0);
    }

    if (count >= 1) {
      // Grounding satisfied — pass
      process.exit(0);
    }

    // count === 0 → hard-block
    try {
      writeEvent({
        type:       'agent_mcp_grounding_missing',
        agent_id:   agentId,
        agent_type: agentType,
        orchestration_id: orchestrationId,
        mcp_tool_call_count: 0,
      }, { cwd });
    } catch (_e) { /* best-effort — still exit 2 */ }

    const msg = [
      '[orchestray] Agent spawn blocked: MCP grounding check failed.',
      'agent_id=' + (agentId || '(unknown)'),
      'agent_type=' + agentType,
      'orchestration_id=' + orchestrationId,
      'No mcp_tool_call events found for this orchestration.',
      'Ensure M1 prefetch (bin/prefetch-mcp-grounding.js) is wired as PreToolUse:Agent',
      'and is not disabled (ORCHESTRAY_MCP_PREFETCH_DISABLED!=1).',
      'Kill switch: set ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED=1 to bypass.',
    ].join('\n');
    process.stderr.write(msg + '\n');
    process.exit(2);
  });
}

main();
