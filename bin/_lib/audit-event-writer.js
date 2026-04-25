'use strict';

/**
 * audit-event-writer.js — central audit-event gateway (R-SHDW-EMIT, v2.1.15).
 *
 * THE single emit path for `.orchestray/audit/events.jsonl`. Every production
 * write to that file MUST flow through `writeEvent()`. Direct
 * `atomicAppendJsonl(eventsPath, ...)` calls are forbidden — the migration
 * audit script `bin/_tools/audit-emit-sites.js` enforces this at dev-time.
 *
 * Contract:
 *   - Validates the event payload against `agents/pm-reference/event-schemas.md`
 *     before the line touches disk (via `bin/_lib/schema-emit-validator.js`).
 *   - On validation failure: DROPS the original event and writes a
 *     `schema_shadow_validation_block` surrogate in its place via a recursive
 *     self-call with `skipValidation: true`. The 3-strike miss counter
 *     (`recordMiss`) is incremented so v2.1.14's auto-disable kicks in.
 *   - On unknown event type: same as validation failure.
 *   - On 3-strike circuit broken (sentinel present, env kill switch set, or
 *     `event_schema_shadow.enabled === false`): bypasses validation entirely
 *     and appends the event as-is. Emits a one-shot stderr warning per process.
 *   - Auto-fills `timestamp` (ISO 8601) and `orchestration_id` (read from
 *     `.orchestray/audit/current-orchestration.json`) when absent.
 *   - Never throws. Fail-open is the contract for every audit-event surface in
 *     Orchestray (hooks must never block Claude Code on audit failures).
 *
 * Recursion guard: the surrogate write is opt-in to validation skipping via
 * `opts.skipValidation: true`, plus a module-level `_inGuardEmit` boolean
 * that falls through to a raw `atomicAppendJsonl` if a second nested call is
 * attempted (defence in depth against a corrupted `schema_shadow_validation_block`
 * schema).
 *
 * The legacy `writeAuditEvent({ type, mode, extraFieldsPicker, additionalEventsPicker })`
 * wrapper API is preserved for `bin/audit-event.js` and `bin/audit-team-event.js`,
 * but the body is rewired to construct event payloads and call `writeEvent`.
 */

const fs   = require('fs');
const path = require('path');

const { atomicAppendJsonl }            = require('./atomic-append');
const { resolveSafeCwd }               = require('./resolve-project-cwd');
const { getCurrentOrchestrationFile }  = require('./orchestration-state');
const { MAX_INPUT_BYTES }              = require('./constants');
const { validateEvent }                = require('./schema-emit-validator');
const {
  isSentinelActive,
  recordMiss,
  computeSourceHash,
}                                      = require('./load-schema-shadow');

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _inGuardEmit       = false;  // recursion guard for surrogate emission
let _circuitWarnedThisProcess = false;
let _schemaWarnedThisProcess  = false;

const SHADOW_REL_CONFIG = path.join('.orchestray', 'config.json');

/**
 * Load event_schema_shadow config block (mirrors inject-schema-shadow.js
 * loadShadowConfig — copied locally to avoid circular dependency).
 */
function loadShadowConfig(cwd) {
  const defaults = { enabled: true, miss_threshold_24h: 3 };
  try {
    const raw    = fs.readFileSync(path.join(cwd, SHADOW_REL_CONFIG), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const block = parsed.event_schema_shadow;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return defaults;
    return Object.assign({}, defaults, block);
  } catch (_e) {
    return defaults;
  }
}

/**
 * Read the active orchestration_id from .orchestray/audit/current-orchestration.json.
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
 * Ensure .orchestray/audit exists and return the events.jsonl path.
 */
function resolveEventsPath(cwd, eventsPathOverride) {
  if (eventsPathOverride) return eventsPathOverride;
  const auditDir = path.join(cwd, '.orchestray', 'audit');
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
  } catch (_e) { /* fail-open */ }
  return path.join(auditDir, 'events.jsonl');
}

/**
 * Auto-fill timestamp + orchestration_id on the event if absent.
 * version is NOT auto-filled — explicit emit-site responsibility.
 */
function withAutofill(event, cwd) {
  const out = Object.assign({}, event);
  // Legacy field-name compatibility: pre-v2.1.15 emit code used `event_type`
  // and `schema_version` field names in some sites (e.g. cache-prefix-lock,
  // kill-switch-event, project-intent-fallback). The gateway/validator expect
  // canonical `type` and `version`. Mirror legacy <-> canonical so both
  // schema validation and downstream consumers (audit log readers, tests)
  // see the field name they expect.
  if (out.event_type && !out.type) out.type = out.event_type;
  if (out.type && !out.event_type) out.event_type = out.type;
  if (typeof out.schema_version === 'number' && typeof out.version !== 'number') {
    out.version = out.schema_version;
  }
  if (typeof out.version === 'number' && typeof out.schema_version !== 'number') {
    out.schema_version = out.version;
  }
  if (!out.timestamp) out.timestamp = new Date().toISOString();
  // Only autofill orchestration_id when the field is genuinely absent.
  // Explicit `null` from the caller is a deliberate "no orchestration active"
  // marker (see cache-prefix-lock orchestration_id-null behavior) and must
  // not be replaced.
  if (!('orchestration_id' in out)) out.orchestration_id = resolveOrchestrationId(cwd);
  return out;
}

// ---------------------------------------------------------------------------
// writeEvent — single audit-event gateway
// ---------------------------------------------------------------------------

/**
 * Single emit path for events.jsonl.
 *
 * @param {object} eventPayload   - Event object. Must include `type`.
 * @param {object} [opts]
 * @param {string} [opts.cwd]              - Project root (default: process.cwd()).
 * @param {string} [opts.eventsPath]       - Override target path (default:
 *                                            `<cwd>/.orchestray/audit/events.jsonl`).
 * @param {boolean} [opts.skipValidation]  - Internal escape hatch; only set by
 *                                            the recursion guard (surrogate emit)
 *                                            and the validate-schema-emit hook itself.
 * @returns {{
 *   written:    boolean,
 *   reason:     string|null,
 *   event_type: string|null,
 *   errors:     string[]
 * }}
 *
 * Never throws.
 */
function writeEvent(eventPayload, opts) {
  opts = opts || {};
  const cwd = resolveSafeCwd(opts.cwd);
  const eventsPath = resolveEventsPath(cwd, opts.eventsPath);

  // -------------------------------------------------------------------------
  // Skip-validation branch (recursion guard / explicit hook bypass)
  // -------------------------------------------------------------------------
  if (opts.skipValidation === true) {
    try {
      const filled = withAutofill(eventPayload || {}, cwd);
      atomicAppendJsonl(eventsPath, filled);
      return {
        written:    true,
        reason:     'ok',
        event_type: filled.type || null,
        errors:     [],
      };
    } catch (e) {
      return {
        written:    false,
        reason:     'io_error',
        event_type: (eventPayload && eventPayload.type) || null,
        errors:     [String(e && e.message ? e.message : e)],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Circuit-broken bypass: env, config, or sentinel
  // -------------------------------------------------------------------------
  let circuitBroken = false;
  try {
    const envDisabled    = process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW === '1';
    const cfg            = loadShadowConfig(cwd);
    const configDisabled = cfg && cfg.enabled === false;
    if (envDisabled || configDisabled || isSentinelActive(cwd)) {
      circuitBroken = true;
    }
  } catch (_e) { /* fail-open */ }

  if (circuitBroken) {
    if (!_circuitWarnedThisProcess) {
      _circuitWarnedThisProcess = true;
      try {
        process.stderr.write(
          '[audit-event-writer] circuit broken — bypassing validation (event-schema shadow disabled)\n'
        );
      } catch (_e) { /* ignore stderr write failures */ }
    }
    try {
      const filled = withAutofill(eventPayload || {}, cwd);
      atomicAppendJsonl(eventsPath, filled);
      return {
        written:    true,
        reason:     'circuit_broken_bypass',
        event_type: filled.type || null,
        errors:     [],
      };
    } catch (e) {
      return {
        written:    false,
        reason:     'io_error',
        event_type: (eventPayload && eventPayload.type) || null,
        errors:     [String(e && e.message ? e.message : e)],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Validation (run on the autofilled payload — required fields like
  // `timestamp` and `orchestration_id` are auto-populated when absent)
  // -------------------------------------------------------------------------
  const filledPayload = withAutofill(eventPayload || {}, cwd);
  let validation;
  try {
    validation = validateEvent(cwd, filledPayload);
  } catch (e) {
    // Defence in depth: validator threw — append the event and return io_error.
    try {
      atomicAppendJsonl(eventsPath, filledPayload);
    } catch (_e) { /* fail-open */ }
    return {
      written:    true,
      reason:     'io_error',
      event_type: (filledPayload && filledPayload.type) || null,
      errors:     ['validator threw: ' + String(e && e.message ? e.message : e)],
    };
  }

  // Schema unreadable -> validator returns valid:true with warnings field.
  if (validation.valid && Array.isArray(validation.warnings) && validation.warnings.length > 0) {
    if (!_schemaWarnedThisProcess) {
      _schemaWarnedThisProcess = true;
      try {
        process.stderr.write(
          '[audit-event-writer] schema unreadable — validation skipped: ' +
          validation.warnings.join('; ') + '\n'
        );
      } catch (_e) { /* ignore */ }
    }
    try {
      atomicAppendJsonl(eventsPath, filledPayload);
      return {
        written:    true,
        reason:     'ok',
        event_type: validation.event_type,
        errors:     [],
      };
    } catch (e) {
      return {
        written:    false,
        reason:     'io_error',
        event_type: validation.event_type,
        errors:     [String(e && e.message ? e.message : e)],
      };
    }
  }

  if (!validation.valid) {
    // -----------------------------------------------------------------------
    // Unknown event type ≠ shape violation. The validator returns
    // valid:false with an "unknown event type" error when a payload's `type`
    // is not yet in event-schemas.md. Pre-v2.1.15 emit code wrote events
    // (e.g. prefix_drift, kill_switch_event) that were never schemaed; the
    // strict drop+surrogate path on unknown types would silently lose those
    // emits and break observability. Emit the event as-is and record a
    // separate `schema_unknown_type_warn` advisory so the schema gap is
    // visible without losing the original signal. Missing-required-field
    // failures still take the drop+surrogate path below.
    // -----------------------------------------------------------------------
    const isUnknownType = validation.errors.some(function (msg) {
      return /unknown event type/i.test(String(msg));
    });
    if (isUnknownType && !_inGuardEmit) {
      _inGuardEmit = true;
      try {
        // Increment the 3-strike miss counter for unknown-type emissions —
        // matches the strict drop+surrogate path. Preserves the v2.1.14
        // auto-disable invariant: 3 misses in 24h still trip the circuit.
        try {
          const cfg = loadShadowConfig(cwd);
          const sourceHash = computeSourceHash(cwd);
          recordMiss(
            cwd,
            validation.event_type || 'unknown',
            sourceHash,
            cfg && cfg.miss_threshold_24h ? cfg.miss_threshold_24h : 3
          );
        } catch (_e) { /* fail-open */ }
        try { atomicAppendJsonl(eventsPath, filledPayload); } catch (_e) { /* fail-open */ }
        const warn = {
          version:            1,
          type:               'schema_unknown_type_warn',
          unknown_event_type: validation.event_type || 'unknown',
          schema_ref:         'agents/pm-reference/event-schemas.md',
        };
        try {
          writeEvent(warn, { cwd, eventsPath, skipValidation: true });
        } catch (_e) { /* fail-open */ }
      } finally {
        _inGuardEmit = false;
      }
      return {
        written:    true,
        reason:     'unknown_type_emitted',
        event_type: validation.event_type,
        errors:     validation.errors,
      };
    }
    // -----------------------------------------------------------------------
    // Drop original + emit surrogate via recursion-guarded self-call
    // -----------------------------------------------------------------------
    if (_inGuardEmit) {
      // Defence in depth: a surrogate emit somehow re-entered. Fall through to
      // a raw append of the *surrogate* using atomicAppendJsonl directly.
      try {
        process.stderr.write(
          '[audit-event-writer] recursion guard tripped — emitting raw surrogate\n'
        );
      } catch (_e) { /* ignore */ }
      try {
        const rawSurrogate = withAutofill({
          version: 1,
          type:    'schema_shadow_validation_block',
          blocked_event_type: validation.event_type || 'unknown',
          errors:  validation.errors,
          schema_ref: 'agents/pm-reference/event-schemas.md',
        }, cwd);
        atomicAppendJsonl(eventsPath, rawSurrogate);
      } catch (_e) { /* ignore */ }
      return {
        written:    false,
        reason:     'validation_failed',
        event_type: validation.event_type,
        errors:     validation.errors,
      };
    }

    _inGuardEmit = true;
    try {
      // Increment the 3-strike miss counter (matches v2.1.14 semantics).
      try {
        const cfg = loadShadowConfig(cwd);
        const sourceHash = computeSourceHash(cwd);
        recordMiss(
          cwd,
          validation.event_type || 'unknown',
          sourceHash,
          cfg && cfg.miss_threshold_24h ? cfg.miss_threshold_24h : 3
        );
      } catch (_e) { /* fail-open */ }

      // Emit the surrogate with skipValidation:true to break recursion.
      const surrogate = {
        version:            1,
        type:               'schema_shadow_validation_block',
        blocked_event_type: validation.event_type || 'unknown',
        errors:             validation.errors,
        schema_ref:         'agents/pm-reference/event-schemas.md',
      };
      writeEvent(surrogate, { cwd, eventsPath, skipValidation: true });
    } finally {
      _inGuardEmit = false;
    }

    return {
      written:    false,
      reason:     'validation_failed',
      event_type: validation.event_type,
      errors:     validation.errors,
    };
  }

  // -------------------------------------------------------------------------
  // Happy path: append
  // -------------------------------------------------------------------------
  try {
    atomicAppendJsonl(eventsPath, filledPayload);
    return {
      written:    true,
      reason:     'ok',
      event_type: validation.event_type,
      errors:     [],
    };
  } catch (e) {
    return {
      written:    false,
      reason:     'io_error',
      event_type: validation.event_type,
      errors:     [String(e && e.message ? e.message : e)],
    };
  }
}

// ---------------------------------------------------------------------------
// writeAuditEvent — preserved legacy API for audit-event.js / audit-team-event.js
// ---------------------------------------------------------------------------

/**
 * Stdin-driven hook helper. Reads a JSON payload from stdin, constructs an
 * audit event, and routes it through `writeEvent`. Preserved for backward
 * compatibility with bin/audit-event.js and bin/audit-team-event.js.
 *
 * @see writeEvent for behaviour details.
 */
function writeAuditEvent({ type, mode, extraFieldsPicker, additionalEventsPicker }) {
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
      const cwd = resolveSafeCwd(event.cwd);

      const auditEvent = { type };
      if (mode !== undefined) auditEvent.mode = mode;
      const extras = (typeof extraFieldsPicker === 'function')
        ? extraFieldsPicker(event) || {}
        : {};
      Object.assign(auditEvent, extras);

      const primary = writeEvent(auditEvent, { cwd });

      // v2.0.21: optionally append additional events (e.g. dynamic_agent_spawn).
      if (typeof additionalEventsPicker === 'function') {
        try {
          const ctx = {
            orchestrationId: primary && primary.event_type ? resolveOrchestrationId(cwd) : 'unknown',
            baseTimestamp:   new Date().toISOString(),
          };
          const extra = additionalEventsPicker(event, ctx);
          if (Array.isArray(extra)) {
            for (const ev of extra) {
              if (ev && typeof ev === 'object') {
                writeEvent(ev, { cwd });
              }
            }
          }
        } catch (_e) {
          process.stderr.write('[orchestray] audit-event-writer: additionalEventsPicker threw — skipping additional events: ' + String(_e) + '\n');
        }
      }
    } catch (_e) {
      // Never block the hook due to audit failure
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = writeAuditEvent;
module.exports.writeEvent       = writeEvent;
module.exports.writeAuditEvent  = writeAuditEvent;
