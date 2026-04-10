'use strict';

/**
 * Audit-event helpers for the Orchestray MCP server.
 *
 * Per v2011c-stage1-plan.md §3.3 and §10. This module is pure logic — the
 * server wires the real atomic-append writer at the top level so handlers
 * stay unit-testable via an injected `auditSink`.
 *
 * Exports:
 *   buildAuditEvent(params)   -> object (the §10 event shape)
 *   readOrchestrationId()     -> string (never throws; "unknown" on failure)
 *   writeAuditEvent(event)    -> void   (fail-open; swallows write errors)
 */

const fs = require('node:fs');

const paths = require('./paths');
// Relative depth from bin/mcp-server/lib/audit.js to bin/_lib/atomic-append.js
// is three hops: ../ out of lib/, ../ out of mcp-server/, _lib/. Verified.
const { atomicAppendJsonl } = require('../../_lib/atomic-append');

const LEGAL_OUTCOMES = new Set(['answered', 'cancelled', 'declined', 'timeout', 'error']);

/**
 * Build an `mcp_tool_call` audit event per plan §10.
 *
 * Shape:
 *   { timestamp, type: "mcp_tool_call", tool, orchestration_id,
 *     duration_ms, outcome, form_fields_count }
 *
 * `readOrchestrationId` is invoked per event (not cached) so a long-lived
 * server observes orchestration transitions.
 */
function buildAuditEvent({ tool, outcome, duration_ms, form_fields_count }) {
  // Sanity checks — don't throw; fall back to safe values so logging never
  // crashes the handler. The reviewer will still see bad outcomes at-rest.
  const safeOutcome = LEGAL_OUTCOMES.has(outcome) ? outcome : 'error';

  return {
    timestamp: new Date().toISOString(),
    type: 'mcp_tool_call',
    tool: tool || 'unknown',
    orchestration_id: readOrchestrationId(),
    duration_ms: typeof duration_ms === 'number' ? duration_ms : 0,
    outcome: safeOutcome,
    form_fields_count: typeof form_fields_count === 'number' ? form_fields_count : 0,
  };
}

/**
 * Read `.orchestray/audit/current-orchestration.json` at call time and
 * return its `orchestration_id` field. Returns `"unknown"` on any failure
 * (missing file, missing project root, invalid JSON, missing field).
 *
 * Never throws.
 */
function readOrchestrationId() {
  try {
    const p = paths.getCurrentOrchestrationPath();
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.orchestration_id === 'string' && parsed.orchestration_id.length > 0) {
      return parsed.orchestration_id;
    }
    return 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

/**
 * Append an audit event to `.orchestray/audit/events.jsonl` via the shared
 * lockfile helper.
 *
 * Fail-open: if the write throws (e.g. missing project root, permission
 * error), log to stderr and return. Audit failures must never block the
 * tool response.
 */
function writeAuditEvent(event) {
  try {
    const target = paths.getAuditEventsPath();
    atomicAppendJsonl(target, event);
  } catch (err) {
    try {
      process.stderr.write(
        '[orchestray-mcp] audit write failed: ' +
          (err && err.message ? err.message : String(err)) +
          '\n'
      );
    } catch (_e) {
      // Stderr unavailable — nothing left to do.
    }
  }
}

module.exports = {
  buildAuditEvent,
  readOrchestrationId,
  writeAuditEvent,
};
