'use strict';

/**
 * Audit-event helpers for the Orchestray MCP server.
 *
 * See CHANGELOG.md §2.0.11 (Stage 1 MCP surface) for design context. Pure logic — the
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
const { logStderr } = require('./rpc');
// Relative depth from bin/mcp-server/lib/audit.js to bin/_lib/audit-event-writer.js
// is three hops: ../ out of lib/, ../ out of mcp-server/, _lib/. Verified.
const { writeEvent } = require('../../_lib/audit-event-writer');

const LEGAL_OUTCOMES = new Set(['answered', 'cancelled', 'declined', 'timeout', 'error']);

/**
 * Build an `mcp_tool_call` audit event per plan §10.
 *
 * Shape:
 *   { timestamp, type: "mcp_tool_call", tool, orchestration_id,
 *     duration_ms, outcome, form_fields_count }
 *
 * `readOrchestrationId` is invoked per event (not cached) so a long-lived
 * server observes orchestration transitions. Future cache candidate: if
 * profiling shows contention, cache with a 1-second TTL.
 *
 * T2 F4: when `orchestration_id_override` is supplied (non-empty string),
 * it takes precedence over `readOrchestrationId()`. This ensures tools that
 * accept `orchestration_id` as input (pattern_record_skip_reason,
 * pattern_record_application, cost_budget_check, history_query_events)
 * emit audit rows keyed to the PM's explicit orchestration context rather
 * than the filesystem marker — critical during recovery or cross-orchestration
 * scenarios where the two may differ.
 */
function buildAuditEvent({ tool, outcome, duration_ms, form_fields_count, orchestration_id_override }) {
  // Sanity checks — don't throw; fall back to safe values so logging never
  // crashes the handler. The reviewer will still see bad outcomes at-rest.
  const safeOutcome = LEGAL_OUTCOMES.has(outcome) ? outcome : 'error';

  // Prefer explicit override; fall back to filesystem read.
  const orchId =
    (typeof orchestration_id_override === 'string' && orchestration_id_override.length > 0)
      ? orchestration_id_override
      : readOrchestrationId(); // Future cache candidate: 1-second TTL if contention observed.

  return {
    timestamp: new Date().toISOString(),
    type: 'mcp_tool_call',
    tool: tool || 'unknown',
    orchestration_id: orchId,
    duration_ms: typeof duration_ms === 'number' ? duration_ms : 0,
    outcome: safeOutcome,
    form_fields_count: typeof form_fields_count === 'number' ? form_fields_count : 0,
  };
}

/**
 * Build an `mcp_resource_read` audit event. Parallel shape to
 * `buildAuditEvent` but keyed by `uri` instead of `tool`, and without the
 * `form_fields_count` field (which is meaningful only for elicitation).
 * Added in v2.0.11 G6 cleanup to eliminate the inline/helper schema-drift
 * risk flagged by the full-codebase audit (B4).
 */
function buildResourceAuditEvent({ uri, outcome, duration_ms }) {
  const safeOutcome = LEGAL_OUTCOMES.has(outcome) ? outcome : 'error';

  return {
    timestamp: new Date().toISOString(),
    type: 'mcp_resource_read',
    uri: uri || 'unknown',
    orchestration_id: readOrchestrationId(), // Future cache candidate: 1-second TTL if contention observed.
    duration_ms: typeof duration_ms === 'number' ? duration_ms : 0,
    outcome: safeOutcome,
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
    // The MCP server resolves project root and events.jsonl through `paths`,
    // which may differ from process.cwd(). Pass both so writeEvent uses the
    // server-resolved target while still anchoring orchestration_id lookups
    // to the same project root.
    writeEvent(event, { cwd: paths.getProjectRoot(), eventsPath: target });
  } catch (err) {
    logStderr('audit write failed: ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Build an `mcp_data_quality` audit event with canonical shape aligned with
 * the other event builders (includes `orchestration_id`, `outcome`, and
 * `duration_ms` so downstream scanners that filter on those fields see the
 * row). Introduced in v2.0.15 preflight (B4) to replace the inline-constructed
 * event previously emitted from `pattern_resource.list`.
 *
 * @param {{source: string, file: string, reason: string}} params
 * @returns {object}
 */
function buildDataQualityEvent({ source, file, reason }) {
  return {
    timestamp: new Date().toISOString(),
    type: 'mcp_data_quality',
    source: typeof source === 'string' ? source : 'unknown',
    file: typeof file === 'string' ? file : 'unknown',
    reason: typeof reason === 'string' ? reason : 'unknown',
    orchestration_id: readOrchestrationId(),
    duration_ms: 0,
    outcome: 'data_quality_skip',
  };
}

module.exports = {
  buildAuditEvent,
  buildResourceAuditEvent,
  buildDataQualityEvent,
  readOrchestrationId,
  writeAuditEvent,
};
