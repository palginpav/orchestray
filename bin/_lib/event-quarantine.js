'use strict';

/**
 * event-quarantine.js — Layer A input quarantine pre-processor.
 *
 * Implements the deterministic field-allowlist from v2.1.6 design §6.1.
 * The Haiku extractor NEVER sees raw events.jsonl. This module strips all
 * free-text, prompt-preview, and content-snapshot fields before the event
 * stream is handed to the extractor subagent.
 *
 * Also runs a secret-pattern regex pass (F-12): events whose retained string
 * fields match known secret patterns are dropped entirely.
 *
 * Fail-closed: anything not in the allowlist is dropped.
 *
 * v2.1.6 — W1 safety boundary.
 */

const path = require('node:path');
const fs   = require('node:fs');
const { writeEvent } = require('./audit-event-writer');
const { getCurrentOrchestrationFile } = require('./orchestration-state');

// ---------------------------------------------------------------------------
// Field allowlist (normative — copied verbatim from §6.1)
// Maps event_type → array of allowed field names (scalars only).
// ---------------------------------------------------------------------------

/**
 * Per-event-type allowlist of scalar fields that may reach the extractor.
 * Free-text, prompt content, rationale, and content-snapshot fields are absent.
 *
 * @type {Object.<string, string[]>}
 */
const QUARANTINE_ALLOWLIST = {
  orchestration_start: [
    'orchestration_id', 'timestamp', 'complexity_score', 'phase',
  ],
  orchestration_complete: [
    'orchestration_id', 'timestamp', 'outcome', 'duration_ms', 'total_cost_usd',
  ],
  agent_start: [
    'orchestration_id', 'timestamp', 'agent_type', 'model_used', 'task_id', 'phase',
  ],
  agent_stop: [
    'orchestration_id', 'timestamp', 'agent_type', 'model_used',
    'duration_ms', 'turns_used', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'outcome',
  ],
  agent_complete: [
    'orchestration_id', 'timestamp', 'agent_type', 'task_id', 'outcome', 'duration_ms',
  ],
  routing_outcome: [
    'orchestration_id', 'timestamp', 'agent_type', 'model', 'task_id', 'outcome', 'variant',
  ],
  routing_decision: [
    'orchestration_id', 'timestamp', 'agent_type', 'model', 'task_id', 'outcome',
  ],
  mcp_tool_call: [
    'orchestration_id', 'timestamp', 'tool', 'phase', 'duration_ms', 'outcome',
  ],
  mcp_checkpoint_recorded: [
    'orchestration_id', 'timestamp', 'tool',
  ],
  mcp_checkpoint_missing: [
    'orchestration_id', 'timestamp', 'missing_tools',
  ],
  pattern_skip_enriched: [
    'orchestration_id', 'timestamp', 'pattern_name', 'skip_category',
  ],
  pattern_deprecated: [
    'orchestration_id', 'timestamp', 'pattern_name', 'reason',
  ],
  task_completed: [
    'orchestration_id', 'timestamp', 'task_id', 'outcome', 'duration_ms',
  ],
  dynamic_agent_spawn: [
    'orchestration_id', 'timestamp', 'agent_type', 'model',
  ],
  curator_run_start: [
    'orchestration_id', 'timestamp', 'outcome',
  ],
  curator_run_complete: [
    'orchestration_id', 'timestamp', 'actions_taken', 'outcome',
  ],
  curator_action_promoted: [
    'orchestration_id', 'timestamp', 'pattern_name', 'action',
  ],
  curator_action_merged: [
    'orchestration_id', 'timestamp', 'pattern_name', 'action',
  ],
  curator_action_deprecated: [
    'orchestration_id', 'timestamp', 'pattern_name', 'action',
  ],
  pm_finding: [
    'orchestration_id', 'timestamp', 'severity',
  ],
  audit_round_complete: [
    'orchestration_id', 'timestamp', 'severity',
  ],
  group_start: [
    'orchestration_id', 'timestamp', 'group_id', 'outcome',
  ],
  group_complete: [
    'orchestration_id', 'timestamp', 'group_id', 'outcome',
  ],
  replan_triggered: [
    'orchestration_id', 'timestamp', 'cycle_count', 'reason_code',
  ],
  verify_fix_cycle: [
    'orchestration_id', 'timestamp', 'cycle_count', 'outcome',
  ],
  smoke_event: [
    'orchestration_id', 'timestamp', 'key',
  ],
  no_mode_event: [
    'orchestration_id', 'timestamp', 'key',
  ],
  config_key_seeded: [
    'orchestration_id', 'timestamp', 'key',
  ],
  review_dimension_scoping_applied: [
    'orchestration_id', 'timestamp', 'review_dimensions',
  ],
};

// ---------------------------------------------------------------------------
// Secret-pattern regex (F-12)
// Dropped events emit auto_extract_quarantine_skipped{reason: secret_pattern_detected}.
// The matched string is never logged.
// ---------------------------------------------------------------------------

// SECRET_PATTERNS — expanded in W1b patch (W2-02) to cover modern token formats.
// Mirrors the pattern set in bin/_lib/shared-promote.js:63-77 plus additional
// formats not present there. Both sets should stay in sync; if shared-promote.js
// gains new patterns, add them here too (and vice versa).
const SECRET_PATTERNS = [
  // Private key headers (covers OpenSSH, RSA, EC, DSA, PKCS8, etc.)
  /BEGIN\s+(OPENSSH|RSA|EC|DSA)\s+PRIVATE\s+KEY/i,
  /-----BEGIN\s+[A-Z ]*PRIVATE\s+KEY-----/,
  /-----BEGIN\s+CERTIFICATE-----/,

  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/,

  // GitHub tokens (classic + fine-grained + server/OAuth/app)
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /ghs_[A-Za-z0-9]{30,}/,
  /gho_[A-Za-z0-9]{30,}/,
  /gh[psuora]_[A-Za-z0-9_-]{20,}/,

  // GitLab personal access tokens
  /glpat-[A-Za-z0-9_-]{20,}/,

  // Slack tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/,

  // Anthropic API keys (sk-ant- prefix; api03, proj, and any future sub-type)
  /sk-ant-[a-zA-Z0-9]+-[A-Za-z0-9_-]{20,}/,

  // OpenAI keys (classic sk- and project sk-proj-)
  /sk-proj-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{32,}/,

  // Google API keys
  /AIza[0-9A-Za-z_-]{30,}/,

  // JWT: three base64url segments (header.payload.signature)
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,

  // Connection strings with embedded credentials
  /\b(postgres|mysql|mongodb|redis|amqp|https?):\/\/[^:@\s]+:[^@\s]+@[^\s/]+/i,

  // Generic high-entropy credential patterns (mirrors shared-promote.js)
  /(?:key|token|secret|bearer|password|passwd|credential)[=:\s"']+[a-zA-Z0-9_\-.\/+]{32,}/i,

  // Existing generic pattern kept for backward compatibility
  /(api_key|token|secret)=[A-Za-z0-9_\-]{16,}/i,
];

/**
 * Returns true if the string value looks like it contains a secret.
 *
 * @param {string} value
 * @returns {boolean}
 */
function _hasSecretPattern(value) {
  if (typeof value !== 'string') return false;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
}

/**
 * Scan all string values in an object (recursively up to maxDepth) for secret patterns.
 *
 * W1b patch (W2-05): changed from 1-level to iterative deep scan to catch secrets
 * in nested retained objects such as curator_run_complete.actions_taken sub-fields.
 * Uses an iterative stack (not recursion) to avoid prototype-pollution risks from
 * objects with __proto__ or cycles. Arrays are iterated element-by-element.
 *
 * @param {object} obj
 * @param {number} [maxDepth=5]
 * @returns {boolean}
 */
function _objectHasSecret(obj, maxDepth) {
  const limit = (maxDepth == null) ? 5 : maxDepth;
  if (!obj || typeof obj !== 'object') return false;

  // Stack entries: { value, depth }
  const stack = [{ value: obj, depth: 0 }];
  let iterations = 0;
  const MAX_ITER = 500; // safety cap against pathological objects

  while (stack.length > 0 && iterations < MAX_ITER) {
    iterations++;
    const { value, depth } = stack.pop();

    if (typeof value === 'string') {
      if (_hasSecretPattern(value)) return true;
      continue;
    }

    if (depth >= limit) continue;
    if (!value || typeof value !== 'object') continue;

    const vals = Array.isArray(value) ? value : Object.values(value);
    for (const v of vals) {
      if (typeof v === 'string') {
        if (_hasSecretPattern(v)) return true;
      } else if (v && typeof v === 'object') {
        stack.push({ value: v, depth: depth + 1 });
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Audit event emission
// ---------------------------------------------------------------------------

/**
 * Emit an auto_extract_quarantine_skipped event (fail-open).
 *
 * @param {string} orchestrationId
 * @param {string} eventTypeDrop
 * @param {string} reason
 * @param {string} cwd
 */
function _emitQuarantineSkipped(orchestrationId, eventTypeDrop, reason, cwd) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    // W2-09 fix: sanitize event_type_dropped to prevent adversary-controlled strings
    // from being echoed verbatim into events.jsonl. Truncate to 64 chars and replace
    // non-printable / non-ASCII bytes with '?'. Non-string types become 'unknown'.
    const sanitizedEventTypeDrop = typeof eventTypeDrop === 'string'
      ? eventTypeDrop.slice(0, 64).replace(/[^\x20-\x7E]/g, '?')
      : 'unknown';
    writeEvent({
      timestamp: new Date().toISOString(),
      type: 'auto_extract_quarantine_skipped',
      schema_version: 1,
      orchestration_id: orchestrationId,
      event_type_dropped: sanitizedEventTypeDrop,
      reason,
    }, { cwd });
  } catch (_e) {
    // Fail-open: quarantine skip emission must never block the caller.
  }
}

// ---------------------------------------------------------------------------
// Core quarantine logic
// ---------------------------------------------------------------------------

/**
 * Strip a single raw event object to only its allowlisted scalar fields.
 *
 * Returns the stripped object, or null if the event should be dropped entirely.
 *
 * @param {object} event - Parsed event object.
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root for audit event emission.
 * @param {string} [opts.orchestrationId] - Override orchestration_id for audit events.
 * @returns {object|null}
 */
function quarantineEvent(event, opts) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }

  const cwd = (opts && opts.cwd) || process.cwd();
  const orchId = (opts && opts.orchestrationId) || (typeof event.orchestration_id === 'string' ? event.orchestration_id : 'unknown');
  const eventType = typeof event.type === 'string' ? event.type : null;

  if (!eventType || !QUARANTINE_ALLOWLIST[eventType]) {
    // Unknown event type — drop entirely per fail-closed policy.
    _emitQuarantineSkipped(orchId, eventType || 'unknown', 'unknown_event_type', cwd);
    return null;
  }

  const allowed = QUARANTINE_ALLOWLIST[eventType];
  const stripped = {};

  for (const field of allowed) {
    if (field in event) {
      stripped[field] = event[field];
    }
  }

  // Always include 'type' for the extractor to identify the event.
  stripped.type = eventType;

  // Secret-pattern pass (F-12): check all retained string fields.
  if (_objectHasSecret(stripped)) {
    _emitQuarantineSkipped(orchId, eventType, 'secret_pattern_detected', cwd);
    return null;
  }

  // Drop events that are empty after stripping (no meaningful signal).
  const fieldsWithoutType = Object.keys(stripped).filter(k => k !== 'type');
  if (fieldsWithoutType.length === 0) {
    _emitQuarantineSkipped(orchId, eventType, 'empty_after_strip', cwd);
    return null;
  }

  return stripped;
}

/**
 * Quarantine an array of raw event objects.
 *
 * @param {object[]} events - Array of parsed event objects.
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root for audit event emission.
 * @param {string} [opts.orchestrationId] - Override orchestration_id for all audit events.
 * @returns {{ kept: object[], skipped: Array<{event_type: string, reason: string, count: number}> }}
 */
function quarantineEvents(events, opts) {
  if (!Array.isArray(events)) {
    return { kept: [], skipped: [] };
  }

  const kept = [];
  /** @type {Map<string, {event_type: string, reason: string, count: number}>} */
  const skippedMap = new Map();

  for (const event of events) {
    const result = quarantineEvent(event, opts);
    if (result !== null) {
      kept.push(result);
    } else {
      // Build a compact skip log: count by (event_type, reason) pair.
      const eventType = (event && typeof event.type === 'string') ? event.type : 'unknown';
      const key = eventType;
      if (skippedMap.has(key)) {
        skippedMap.get(key).count += 1;
      } else {
        skippedMap.set(key, { event_type: eventType, reason: 'quarantine', count: 1 });
      }
    }
  }

  return { kept, skipped: Array.from(skippedMap.values()) };
}

module.exports = {
  quarantineEvent,
  quarantineEvents,
  QUARANTINE_ALLOWLIST,
  SECRET_PATTERNS,
  _emitQuarantineSkipped,
};
