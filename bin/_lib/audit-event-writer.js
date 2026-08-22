'use strict';

/**
 * audit-event-writer.js — central audit-event gateway (R-SHDW-EMIT, v2.1.15).
 *
 * THE single emit path for `.orchestray/audit/events.jsonl`. Every production
 * write to that file MUST flow through `writeEvent()`. Direct
 * `atomicAppendJsonl(eventsPath, ...)` calls are forbidden — the migration
 * audit script `bin/_tools/audit-emit-sites.js` enforces this at dev-time,
 * wired into `npm test` (v2.3.23) via `tests/regression/v2323-audit-emit-sites-gate.test.js`.
 *
 * Contract:
 *   - Validates the event payload against `agents/pm-reference/event-schemas.md`
 *     before the line touches disk (via `bin/_lib/schema-emit-validator.js`).
 *   - On validation failure (declared type, missing required field): the
 *     original event is STILL WRITTEN (D6, v2.3.18 W1b — degrade to
 *     emit-with-warning, never drop), plus a `schema_shadow_validation_block`
 *     surrogate + rate-limited `schema_shape_violation` advisory via a
 *     recursive self-call with `skipValidation: true`. recordMiss is NOT
 *     incremented for shape violations (only for unknown types, below) —
 *     see W-MISS-SPLIT.
 *   - On unknown event type: same emit-original-plus-advisory behavior, via
 *     a separate `schema_unknown_type_warn` advisory. Unlike shape
 *     violations, this DOES increment the 3-strike miss counter
 *     (`recordMiss`) so v2.1.14's auto-disable kicks in.
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

const {
  atomicAppendJsonl,
  atomicWriteFile,
  _withAdvisoryLock,
}                                      = require('./atomic-append');
const { resolveSafeCwd }               = require('./resolve-project-cwd');
const { getCurrentOrchestrationFile }  = require('./orchestration-state');
const { MAX_INPUT_BYTES }              = require('./constants');
const { validateEvent, getSchemas }    = require('./schema-emit-validator');
const {
  isSentinelActive,
  recordMiss,
  computeSourceHash,
}                                      = require('./load-schema-shadow');
const { peekOrchestrationId }          = require('./peek-orchestration-id');
// === v2.2.21 W4-T18: state-gc safeReadJson for corrupt state-file self-heal (F-15) ===
const { safeReadJson }                 = require('./state-gc');
const { readHookInputRaw } = require('./hook-stdin');
const { recordDegradation } = require('./degraded-journal');

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _inGuardEmit       = false;  // recursion guard for surrogate emission
let _inAutofillEmit    = false;  // recursion guard for audit_event_autofilled emit
let _circuitWarnedThisProcess = false;
let _schemaWarnedThisProcess  = false;

// Rate-limit schema_shape_violation: emit at most once per event_type per process.
// Shape violations are high-frequency (321/24h baseline); without this they flood events.jsonl.
const _shapeViolationWarnedTypes = new Map(); // event_type -> true

// Rate-limited deprecation warn for pre-rename event types.
const _deprecatedNamesWarnedThisProcess = new Set();

const SHADOW_REL_CONFIG = path.join('.orchestray', 'config.json');

// Package root = <repo>/bin/_lib -> <repo>. Derived from __dirname, so it is
// the SAME value in a hook child process spawned with a temp cwd — which is
// what makes the D7/E2 test redirects safe: a test that spawns a hook into its
// own tmpdir keeps writing to that tmpdir, only writes aimed at the real
// project move. Declared here rather than next to `testRedirectFor` because
// `autofillSampleRedirectFor` (~190 lines earlier) reads it too.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

// D4 (v2.3.18 W1a): `audit_event_autofilled` used to fire 1:1 with every
// autofilled field — 9,781 rows/day baseline, doubling log volume for no
// extra diagnostic value (every occurrence just restates "field X was
// autofilled again"). Sample instead: accumulate occurrences + the union of
// autofilled field names per event_type in a small state file (survives the
// short-lived hook processes that emit most of these), and emit one row per
// AUTOFILL_SAMPLE_INTERVAL occurrences carrying the full field union for that
// window — no diagnostic signal lost, only the 1:1 duplication.
const AUTOFILL_SAMPLE_INTERVAL = parseInt(process.env.ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL, 10) || 10;

// Event types that close an orchestration. Emitting one flushes whatever
// partial sampling windows that orchestration accumulated (E3, below).
const AUTOFILL_FLUSH_EVENT_TYPES = new Set(['orchestration_complete', 'orchestration_end']);

// E2 (v2.3.18 W6b): the sampling file is the SECOND live artefact under the
// package root, and W0's D7 redirect covered only events.jsonl. A full
// `npm test` therefore mutated the PRODUCTION counters in place
// (state_file_corrupt 8 -> 1 across the %10 boundary, mcp_tool_call 9 -> 5),
// so `sample_count` on emitted rows was wrong and windows straddled unrelated
// orchestrations. Same seam, same rule as D7: a test-context write aimed at
// THIS package's own sample file lands in a per-process sandbox instead.
function sandboxAutofillSamplePath() {
  if (process.env.ORCHESTRAY_TEST_AUTOFILL_SAMPLE_PATH) {
    return process.env.ORCHESTRAY_TEST_AUTOFILL_SAMPLE_PATH;
  }
  return path.join(
    require('os').tmpdir(),
    'orchestray-test-autofill-sample-' + process.pid + '.json'
  );
}

function autofillSampleRedirectFor(resolved) {
  if (!isTestContext()) return null;
  try {
    const live = path.join(PACKAGE_ROOT, '.orchestray', 'state', 'audit-autofill-sample.json');
    if (path.resolve(resolved) !== live) return null;
    return sandboxAutofillSamplePath();
  } catch (_e) {
    return null;
  }
}

function autofillSamplePath(cwd) {
  const candidate = path.join(cwd, '.orchestray', 'state', 'audit-autofill-sample.json');
  return autofillSampleRedirectFor(candidate) || candidate;
}

function loadAutofillSample(cwd) {
  try {
    const raw = fs.readFileSync(autofillSamplePath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.by_type && typeof parsed.by_type === 'object') return parsed;
  } catch (_e) { /* fail-open */ }
  return { by_type: {} };
}

function saveAutofillSample(cwd, data) {
  try {
    const file = autofillSamplePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // E3 (v2.3.18 W6b): tmp+rename, not a bare writeFileSync. A concurrent
    // reader used to be able to hit a half-written file; the JSON.parse throw
    // fails open to `{by_type:{}}`, which silently RESETS the counter. Under
    // sustained concurrency the reset can beat the interval every time, so
    // `audit_event_autofilled` stops emitting entirely — total loss of the
    // signal the sampling exists to preserve.
    atomicWriteFile(file, JSON.stringify(data));
    try { fs.chmodSync(file, 0o600); } catch (_e) { /* best-effort */ }
  } catch (_e) { /* fail-open */ }
}

/**
 * Advance the sampling window for one event_type under an advisory lock.
 *
 * E3: the read-modify-write was lock-free, so two hook processes racing on the
 * same key both read `count=N` and both wrote `N+1` — one occurrence lost per
 * collision. `_withAdvisoryLock` + `atomicWriteFile` is the pair already used
 * for this shape in `kb-index-validator.js`.
 *
 * @returns {{due: object|null, flushes: object[], lock_contention?: boolean}}
 *   `due` is non-null when this occurrence completed a window; `flushes`
 *   carries windows inherited from a previous orchestration.
 */
function _advanceAutofillSample(cwd, key, fields, orchId) {
  const file = autofillSamplePath(cwd);
  const result = _withAdvisoryLock(file + '.lock', function () {
    const sample  = loadAutofillSample(cwd);
    const flushes = [];

    // Orchestration rollover. A partial window (count 1..interval-1) never
    // reaches the emit threshold, and before this fix it simply persisted:
    // the next orchestration inherited the count and the eventual row
    // straddled two unrelated runs. Flush partials against the orchestration
    // that produced them, then start clean.
    const prevOrch = sample.orchestration_id;
    if (orchId && prevOrch && prevOrch !== orchId) {
      for (const type of Object.keys(sample.by_type)) {
        const e = sample.by_type[type];
        if (e && e.count > 0) {
          flushes.push({
            eventType: type,
            count:     e.count,
            fields:    (e.fields || []).slice(),
            orchId:    prevOrch,
          });
        }
      }
      sample.by_type = {};
    }
    if (orchId) sample.orchestration_id = orchId;

    const entry = sample.by_type[key] || { count: 0, fields: [] };
    entry.count += 1;
    entry.fields = Array.from(new Set(entry.fields.concat(fields)));

    let due = null;
    if (entry.count % AUTOFILL_SAMPLE_INTERVAL === 0) {
      due = { count: entry.count, fields: entry.fields };
      sample.by_type[key] = { count: 0, fields: [] };
    } else {
      sample.by_type[key] = entry;
    }

    saveAutofillSample(cwd, sample);
    return { due: due, flushes: flushes };
  });

  if (!result || result.skipped) {
    // Lock unavailable. Fail toward EMITTING: a duplicate row costs log
    // volume, a swallowed one costs the signal outright.
    return { due: { count: 1, fields: fields.slice() }, flushes: [], lock_contention: true };
  }
  return result;
}

/**
 * Emit whatever partial windows are pending and clear them. Called when an
 * orchestration-closing event is written so a sub-interval window is reported
 * against its own orchestration instead of bleeding into the next one.
 */
function _flushAutofillSample(cwd, eventsPath) {
  if (process.env.ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED === '1') return;
  if (_inAutofillEmit || _inGuardEmit) return;

  const file = autofillSamplePath(cwd);
  const result = _withAdvisoryLock(file + '.lock', function () {
    const sample = loadAutofillSample(cwd);
    const rows   = [];
    for (const type of Object.keys(sample.by_type)) {
      const e = sample.by_type[type];
      if (e && e.count > 0) {
        rows.push({
          eventType: type,
          count:     e.count,
          fields:    (e.fields || []).slice(),
          orchId:    sample.orchestration_id || null,
        });
      }
    }
    if (rows.length === 0) return { rows: [] };
    sample.by_type = {};
    saveAutofillSample(cwd, sample);
    return { rows: rows };
  });

  if (!result || result.skipped) return;
  _emitAutofillRows(result.rows, cwd, eventsPath, null);
}

// Single-source-of-truth for the 24h miss threshold so `loadShadowConfig`
// defaults and the recordMiss fallback at the unknown-type emit branch can
// never drift. Mirrors the `loadShadowConfig` defaults block.
const DEFAULT_MISS_THRESHOLD_24H = 10;

/**
 * Load event_schema_shadow config block (mirrors inject-schema-shadow.js
 * loadShadowConfig — copied locally to avoid circular dependency).
 */
function loadShadowConfig(cwd) {
  const defaults = { enabled: true, miss_threshold_24h: DEFAULT_MISS_THRESHOLD_24H };
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
 * Uses safeReadJson to emit state_file_corrupt + auto-truncate on SyntaxError (F-15).
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    // safeReadJson handles SyntaxError: emits state_file_corrupt, truncates to {}.
    const orchData = safeReadJson(orchFile, {});
    if (orchData && orchData.orchestration_id) return orchData.orchestration_id;
  } catch (_e) { /* fail-open */ }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// D7 (v2.3.18 W0) — test writes must never land in the live project audit log.
//
// Tests exercise writeEvent with a temp cwd for the *subject* file but let the
// writer resolve the audit path back to the real project (via resolveSafeCwd's
// process.cwd() fallback). That contaminated events.jsonl with 184
// `state_file_corrupt`, 46 `multiple_structured_result_blocks` and 23
// `task_validation_failed` rows carrying obvious test fixtures — and misdirected
// a whole bug-mining pass.
//
// Rule: under the test harness, a write that would land on THIS package's own
// events.jsonl is redirected to a per-process sandbox log. Writes to a
// caller-supplied temp cwd (the correct pattern) are untouched, as are explicit
// `eventsPath` overrides.
// ---------------------------------------------------------------------------

// PACKAGE_ROOT is declared with the other module constants at the top of the
// file — `autofillSampleRedirectFor` needs it before this point.

function isTestContext() {
  return process.env.ORCHESTRAY_TEST === '1' || process.env.NODE_ENV === 'test';
}

/** Per-process sandbox events log used in place of the live project log. */
function sandboxEventsPath() {
  if (process.env.ORCHESTRAY_TEST_EVENTS_PATH) return process.env.ORCHESTRAY_TEST_EVENTS_PATH;
  return path.join(require('os').tmpdir(), 'orchestray-test-events-' + process.pid + '.jsonl');
}

/**
 * Return a redirect target when `resolved` points at a live (non-test) project
 * audit log while running under test, else null.
 */
function testRedirectFor(resolved) {
  if (!isTestContext()) return null;
  try {
    const live = path.join(PACKAGE_ROOT, '.orchestray', 'audit', 'events.jsonl');
    if (path.resolve(resolved) !== live) return null;
    return sandboxEventsPath();
  } catch (_e) {
    return null;
  }
}

/**
 * Ensure .orchestray/audit exists and return the events.jsonl path.
 */
function resolveEventsPath(cwd, eventsPathOverride) {
  if (eventsPathOverride) {
    const redirected = testRedirectFor(eventsPathOverride);
    return redirected || eventsPathOverride;
  }
  const auditDir = path.join(cwd, '.orchestray', 'audit');
  const candidate = path.join(auditDir, 'events.jsonl');
  const redirected = testRedirectFor(candidate);
  if (redirected) return redirected;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
  } catch (_e) { /* fail-open */ }
  return candidate;
}

/**
 * Resolve a best-effort session_id from env. Returns null when neither
 * `CLAUDE_SESSION_ID` nor `ORCHESTRAY_SESSION_ID` is set — F1 deliberately
 * does NOT fall back to the pid here. A fabricated session_id would mask
 * the very emit-side bugs the autofill is meant to surface, so callers
 * that genuinely have no session context still drop on the missing-field
 * validation path.
 */
function resolveSessionId() {
  const sid = process.env.CLAUDE_SESSION_ID || process.env.ORCHESTRAY_SESSION_ID;
  if (sid && typeof sid === 'string' && sid.length > 0) return sid;
  return null;
}

/**
 * F1 (v2.2.9) — explicit allowlist of fields safe to autofill.
 *
 * Per `feedback_default_on_shipping.md` + `feedback_mechanical_over_prose.md`,
 * the autofill closes the v2.2.8 bombshell (W4 RCA-9: 64/74 = 86% of
 * `agent_stop` rows silently dropped because emitters omitted `version: 1`).
 * The allowlist is deliberately small — fields outside the allowlist still
 * drop+surrogate so genuinely-missing payload data does not get masked.
 *
 * Each entry is `{ resolve(payload, cwd, schema) -> value | undefined }`.
 * A resolver returning `undefined` means "no autofill for this field on this
 * emit" (e.g. session_id with no env present, or version with no schema
 * declared default). A resolved value of `null` is allowed and counts as a
 * successful autofill.
 */
const AUTOFILL_ALLOWLIST = {
  version: function (_payload, _cwd, schema) {
    if (schema && typeof schema.version === 'number') return schema.version;
    return 1; // hardcoded fallback — every event-schemas.md entry uses v1 by convention
  },
  timestamp: function () {
    return new Date().toISOString();
  },
  ts: function () {
    return new Date().toISOString();
  },
  orchestration_id: function (_payload, cwd) {
    return resolveOrchestrationId(cwd);
  },
  session_id: function () {
    return resolveSessionId();
  },
};

/**
 * Auto-fill required fields when the emitter omits them.
 *
 * History: pre-v2.2.9 this only filled `timestamp` and `orchestration_id`.
 * v2.2.9 F1 extended the allowlist with `version` (the bombshell fix) and
 * `session_id` (best-effort env-derived). The expansion is gated by the
 * schema's declared `required` set — fields outside the allowlist are
 * untouched even when the schema requires them, so the surrogate path keeps
 * surfacing genuinely-missing data.
 *
 * Kill switch: `ORCHESTRAY_AUDIT_AUTOFILL_DISABLED=1` reverts to the v2.2.8
 * two-field behavior (`timestamp` + `orchestration_id` only) for paranoid
 * debug.
 *
 * Returns `{ filled, autofilled }` where `autofilled` is the array of field
 * names this call populated (caller-provided values are NEVER counted).
 */
function withAutofill(event, cwd) {
  const out = Object.assign({}, event);
  const autofilled = [];

  // Legacy field-name compatibility: pre-v2.1.15 emit code used `event_type`
  // and `schema_version` field names in some sites (e.g. cache-prefix-lock,
  // kill-switch-event, project-intent-fallback). The gateway/validator expect
  // canonical `type` and `version`. Mirror legacy <-> canonical so both
  // schema validation and downstream consumers (audit log readers, tests)
  // see the field name they expect.
  if (out.event_type && !out.type) out.type = out.event_type;
  if (out.type && !out.event_type) out.event_type = out.type;
  // I-OP-1 (v2.2.21): normalize version fields so EVERY emitted event ends up
  // with both `version` and `schema_version` set to the same integer. Some
  // historical emit sites (`bin/audit-*.js` per the I-OP-1 finding) omit the
  // version field entirely and rely on the autofill below. The mirror below
  // bridges legacy <-> canonical names; the autofill at the bottom of this
  // function fills `version` when neither is set; the trailing mirror then
  // sets `schema_version` from the autofilled `version`. After this function
  // returns, an emitted payload with `type` is guaranteed to carry both names.
  if (typeof out.schema_version === 'number' && typeof out.version !== 'number') {
    out.version = out.schema_version;
  }
  if (typeof out.version === 'number' && typeof out.schema_version !== 'number') {
    out.schema_version = out.version;
  }

  const killSwitchOn = process.env.ORCHESTRAY_AUDIT_AUTOFILL_DISABLED === '1';

  if (killSwitchOn) {
    // Kill-switch fallback: only timestamp + orchestration_id.
    if (!out.timestamp) out.timestamp = new Date().toISOString();
    if (!('orchestration_id' in out)) out.orchestration_id = resolveOrchestrationId(cwd);
    return { filled: out, autofilled: [] };
  }

  // Schema-aware allowlist autofill.
  //
  // Look up the schema for this event-type so we can (a) source `version`
  // from the schema's declared default and (b) only autofill fields that
  // the schema actually requires (no point filling an optional field).
  let schema = null;
  try {
    const schemas = getSchemas(cwd);
    if (schemas && out.type) schema = schemas.get(out.type) || null;
  } catch (_e) { /* fail-open — schema unreadable, fall through */ }

  // The set of required field-names per schema. When schema is unreadable
  // we still fill timestamp + orchestration_id (preserves v2.2.8 behavior
  // for the schema-unreadable path) but skip the schema-gated extras.
  const requiredFields = (schema && Array.isArray(schema.required))
    ? new Set(schema.required)
    : null;

  // Iterate the allowlist deterministically (ordered keys).
  for (const field of Object.keys(AUTOFILL_ALLOWLIST)) {
    // Caller-provided value wins always — `in` honours explicit `null`/`undefined`
    // (cache-prefix-lock orchestration_id-null marker, etc.).
    if (field in out) continue;

    // Schema gating: when we know the schema, only autofill fields the
    // schema declares as required. timestamp + orchestration_id are filled
    // unconditionally below to preserve v2.2.8 surface on unknown event-types.
    if (field !== 'timestamp' && field !== 'orchestration_id') {
      if (requiredFields && !requiredFields.has(field)) continue;
      // No schema available → skip schema-gated extras (avoid masking new bugs).
      if (!requiredFields && field !== 'session_id') continue;
      // session_id is special: skip when env not present even if schema requires it
      // (resolver returns undefined and the for-loop continues).
    }

    const resolver = AUTOFILL_ALLOWLIST[field];
    let value;
    try {
      value = resolver(out, cwd, schema);
    } catch (_e) {
      value = undefined;
    }
    // `undefined` AND `null` both mean "no autofill on this emit". Returning
    // `null` would mask the missing-data signal F1 is meant to surface
    // (session_id is the canonical case — absent env means we genuinely do
    // not know the session).
    if (value === undefined || value === null) continue;
    out[field] = value;
    autofilled.push(field);
  }

  // Mirror canonical/legacy version names again post-autofill so the validator
  // and consumers see both shapes.
  if (typeof out.version === 'number' && typeof out.schema_version !== 'number') {
    out.schema_version = out.version;
  }
  // I-OP-1 (v2.2.21): also fill the reverse direction so a payload that
  // arrived with only `schema_version` (rare — legacy callers) ends up with
  // both `version` and `schema_version` post-normalization. The earlier
  // mirror at the top of this function handles the normal case; this trailing
  // mirror catches a `version` field cleared by an autofill resolver that
  // returned undefined while a `schema_version` was already present.
  if (typeof out.schema_version === 'number' && typeof out.version !== 'number') {
    out.version = out.schema_version;
  }

  return { filled: out, autofilled };
}

/**
 * Public helper: ensure an event payload carries both `version` and
 * `schema_version` set to 1 (or to whatever value either field already
 * carries). Idempotent. Never throws.
 *
 * I-OP-1 (v2.2.21): exposed so callers that emit events through paths that
 * bypass the gateway (rare; mostly legacy `bin/audit-*.js`) can pre-normalize
 * before writing. Most callers should keep using `writeEvent()` directly.
 *
 * @param {object} event
 * @returns {object} the same event, mutated in place
 */
function normalizeVersionFields(event) {
  if (!event || typeof event !== 'object') return event;
  if (typeof event.version === 'number' && typeof event.schema_version !== 'number') {
    event.schema_version = event.version;
  }
  if (typeof event.schema_version === 'number' && typeof event.version !== 'number') {
    event.version = event.schema_version;
  }
  if (typeof event.version !== 'number' && typeof event.schema_version !== 'number') {
    event.version = 1;
    event.schema_version = 1;
  }
  return event;
}

/**
 * Compatibility shim for callers that only need the filled payload.
 * Pre-v2.2.9 callers used the bare object return; v2.2.9 expanded the return
 * shape. New code should call withAutofill() directly and consume the
 * `autofilled` list when it needs to emit observability.
 */
function withAutofillObject(event, cwd) {
  return withAutofill(event, cwd).filled;
}

/**
 * Emit `audit_event_autofilled` observability row when one or more fields were
 * autofilled on the just-written event. Recursion-guarded so the telemetry
 * emit cannot itself trigger a cascade (a self-emit would have an empty
 * `autofilled` list anyway, but the guard is belt-and-braces).
 *
 * The telemetry emit goes through `writeEvent` itself with skipValidation:
 * the event-type is registered in event-schemas.md (added by F1) so it must
 * pass schema validation, but we skip the validator to avoid lock-step
 * recursion across the schema-unreadable path. Failures are swallowed —
 * observability must never break the underlying write.
 *
 * @param {string|null} schemaState - Optional. When set, included as `schema_state`
 *   in the telemetry row. Callers on the schema-unreadable branch pass
 *   `'unreadable'` (P1-13, v2.2.15 W2-07) so analytics can distinguish
 *   schema-readable vs schema-unreadable autofills without dropping the signal.
 */
function emitAutofillTelemetry(eventType, fields, cwd, eventsPath, schemaState) {
  if (!fields || fields.length === 0) return;
  if (_inAutofillEmit) return;
  if (_inGuardEmit) return; // surrogate path — never emit telemetry from there

  // D4 sampling gate — see AUTOFILL_SAMPLE_INTERVAL comment above. Disabled
  // via kill switch reverts to the pre-D4 1:1 behavior.
  const key = eventType || 'unknown';
  let occurrenceCount   = 1;
  let fieldsSinceSample = fields.slice();
  let flushes           = [];

  if (process.env.ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED !== '1') {
    let orchId = null;
    try { orchId = peekOrchestrationId(cwd); } catch (_e) { /* fail-open */ }

    const advanced = _advanceAutofillSample(cwd, key, fields, orchId);
    flushes = advanced.flushes || [];
    if (!advanced.due) {
      // Sampled out — not yet due. Any inherited windows still get reported.
      _emitAutofillRows(flushes, cwd, eventsPath, schemaState);
      return;
    }
    occurrenceCount   = advanced.due.count;
    fieldsSinceSample = advanced.due.fields;
  }

  _emitAutofillRows(
    flushes.concat([{ eventType: key, count: occurrenceCount, fields: fieldsSinceSample, orchId: null }]),
    cwd,
    eventsPath,
    schemaState
  );
}

/**
 * Write one `audit_event_autofilled` row per aggregated window.
 *
 * @param {Array<{eventType:string,count:number,fields:string[],orchId:?string}>} rows
 */
function _emitAutofillRows(rows, cwd, eventsPath, schemaState) {
  if (!rows || rows.length === 0) return;

  _inAutofillEmit = true;
  try {
    for (const row of rows) {
      const telemetry = {
        version:           1,
        type:              'audit_event_autofilled',
        event_type:        row.eventType,
        fields_autofilled: row.fields,
        sample_count:      row.count,
      };
      // A flushed window belongs to the orchestration that produced it — stamp
      // that id explicitly so autofill is never reattributed to the run that
      // happened to trigger the flush.
      if (row.orchId) telemetry.orchestration_id = row.orchId;
      // Include schema_state tag when provided (schema-unreadable branch).
      if (schemaState !== undefined && schemaState !== null) {
        telemetry.schema_state = schemaState;
      }
      try {
        writeEvent(telemetry, { cwd, eventsPath, skipValidation: true });
      } catch (_e) { /* fail-open */ }
    }
  } finally {
    _inAutofillEmit = false;
  }
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
      const { filled } = withAutofill(eventPayload || {}, cwd);
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
      const { filled } = withAutofill(eventPayload || {}, cwd);
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
  // `timestamp`, `orchestration_id`, `version`, and best-effort `session_id`
  // are auto-populated when absent per F1 (v2.2.9, W4 RCA-9 fix).
  // -------------------------------------------------------------------------
  const { filled: filledPayload, autofilled: autofilledFields } =
    withAutofill(eventPayload || {}, cwd);
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
        // Reason already states "validation skipped" — don't re-prefix it (was
        // producing "schema unreadable — validation skipped: schema file
        // unreadable — validation skipped").
        process.stderr.write(
          '[audit-event-writer] ' + validation.warnings.join('; ') + '\n'
        );
      } catch (_e) { /* ignore */ }
      // Durable record: schema validation is silently off for this process's
      // lifetime (e.g. running inside a non-Orchestray project). Reuse the
      // existing degraded-journal mechanism rather than inventing a new one.
      recordDegradation({
        kind:     'event_schema_unreadable',
        severity: 'warn',
        detail:   { reason: validation.warnings.join('; ') },
        projectRoot: cwd,
      });
    }
    try {
      atomicAppendJsonl(eventsPath, filledPayload);
      // Emit autofill telemetry on schema-unreadable branch with
      // schema_state:'unreadable' tag so analytics pipelines can distinguish
      // these from production noise.
      emitAutofillTelemetry(
        validation.event_type,
        autofilledFields,
        cwd,
        eventsPath,
        /* schema_state */ 'unreadable'
      );
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
        // M4 (v2.2.10): self-call schema_get for the unknown type and emit
        // mcp_tool_call observability row (cached — at most once per type per process).
        try {
          _schemaGetSelfCall(validation.event_type || 'unknown', cwd, eventsPath);
        } catch (_e) { /* fail-open */ }

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
            cfg && cfg.miss_threshold_24h ? cfg.miss_threshold_24h : DEFAULT_MISS_THRESHOLD_24H
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
    // D6 (v2.3.18 W1b): degrade to emit-with-warning, never drop.
    //
    // Pre-fix this branch DROPPED the original event and wrote only a
    // `schema_shadow_validation_block` surrogate carrying `blocked_event_type`
    // + errors — the real payload was gone. Live data showed 55+ lifecycle
    // events lost this way (orchestration_start missing "task",
    // orchestration_complete missing "status", etc.), which silently
    // corrupted history: collect-agent-metrics.js's `_hasOrchestrationComplete`
    // scan looks for `ev.type === 'orchestration_complete'`, which the
    // surrogate never satisfies, so the completion rollup never fired either.
    //
    // Fix: a shape violation on a KNOWN type now emits the original
    // (autofilled) payload AND the advisory/surrogate rows, matching the
    // unknown-type branch above. Only a genuinely unparseable payload (never
    // reaches here) or an I/O failure loses data now.
    // -----------------------------------------------------------------------
    if (_inGuardEmit) {
      // Defence in depth: a surrogate emit somehow re-entered. Fall through to
      // a raw append of BOTH the original payload and the surrogate using
      // atomicAppendJsonl directly — never drop, even in the re-entrant case.
      try {
        process.stderr.write(
          '[audit-event-writer] recursion guard tripped — emitting raw original + surrogate\n'
        );
      } catch (_e) { /* ignore */ }
      try {
        atomicAppendJsonl(eventsPath, filledPayload);
      } catch (_e) { /* ignore */ }
      try {
        const { filled: rawSurrogate } = withAutofill({
          version: 1,
          type:    'schema_shadow_validation_block',
          blocked_event_type: validation.event_type || 'unknown',
          errors:  validation.errors,
          schema_ref: 'agents/pm-reference/event-schemas.md',
        }, cwd);
        atomicAppendJsonl(eventsPath, rawSurrogate);
      } catch (_e) { /* ignore */ }
      return {
        written:    true,
        reason:     'shape_violation_emitted',
        event_type: validation.event_type,
        errors:     validation.errors,
      };
    }

    _inGuardEmit = true;
    try {
      // W-MISS-SPLIT (v2.2.12): recordMiss NOT called here — a declared type
      // with bad shape is a shape violation, not a shadow miss. recordMiss stays
      // ONLY in the unknown_type_emitted path above.

      // Emit the original event despite the shape violation — see D6 note above.
      try { atomicAppendJsonl(eventsPath, filledPayload); } catch (_e) { /* fail-open */ }

      // Emit schema_shape_violation once per event_type per process (rate-limited
      // to avoid flooding events.jsonl; was 321 false miss-writes/24h before fix).
      const violatedType = validation.event_type || 'unknown';
      if (!_shapeViolationWarnedTypes.has(violatedType)) {
        _shapeViolationWarnedTypes.set(violatedType, true);
        try {
          writeEvent({
            version: 1, type: 'schema_shape_violation',
            event_type: violatedType, validation_errors: validation.errors, rate_limited: false,
          }, { cwd, eventsPath, skipValidation: true });
        } catch (_e) { /* fail-open */ }
      }

      // Emit legacy surrogate (backward-compat — other consumers may read this).
      const surrogate = {
        version:            1,
        type:               'schema_shadow_validation_block',
        blocked_event_type: violatedType,
        errors:             validation.errors,
        schema_ref:         'agents/pm-reference/event-schemas.md',
      };
      writeEvent(surrogate, { cwd, eventsPath, skipValidation: true });
    } finally {
      _inGuardEmit = false;
    }

    return {
      written:    true,
      reason:     'shape_violation_emitted',
      event_type: validation.event_type,
      errors:     validation.errors,
    };
  }

  // -------------------------------------------------------------------------
  // Happy path: append
  // -------------------------------------------------------------------------
  try {
    atomicAppendJsonl(eventsPath, filledPayload);
    emitAutofillTelemetry(validation.event_type, autofilledFields, cwd, eventsPath);
    // E3 (v2.3.18 W6b): an orchestration closing flushes its partial sampling
    // windows. Without this a window of 1-9 occurrences never reached the
    // emit threshold and persisted into whatever ran next.
    if (AUTOFILL_FLUSH_EVENT_TYPES.has(validation.event_type)) {
      try { _flushAutofillSample(cwd, eventsPath); } catch (_e) { /* fail-open */ }
    }
    // B3 (v2.2.11): wire min-denominator guard — track every event so the
    // denominator is real before the threshold-exceeded alarm can fire.
    // peekOrchestrationId returns null when no orchestration is active;
    // _trackAutofillThreshold uses null as a stable key prefix, which is fine.
    try {
      const orchId = peekOrchestrationId(cwd);
      _trackAutofillThreshold(
        validation.event_type,
        autofilledFields.length > 0,
        orchId,
        cwd,
        eventsPath
      );
    } catch (_e) { /* fail-open — observability must never block the write */ }
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
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
  setImmediate(() => {
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

// ---------------------------------------------------------------------------
// B3: autofill-threshold tracking (v2.2.10)
// ---------------------------------------------------------------------------
// Per-event-type counters: { eventType -> { total, autofilled } }
const _autofillCounters = new Map();
// Guard set: orch+eventType pairs that have already fired the threshold event.
const _autofillThresholdFired = new Set();

const AUTOFILL_THRESHOLD_DEFAULT = 0.20;
const AUTOFILL_MIN_OBSERVATIONS  = 20;  // must have at least this many before threshold fires

/**
 * Track one observation toward the autofill-threshold counter.
 * Called from emitAutofillTelemetry (production path) and _testHooks (tests).
 *
 * @param {string} eventType   - The event type being tracked
 * @param {boolean} wasAutofilled - Whether this observation was autofilled
 * @param {string} orchId      - Active orchestration ID
 * @param {string} cwd         - Project root (for writing events + banner)
 * @param {string} eventsPath  - Path to events.jsonl
 */
function _trackAutofillThreshold(eventType, wasAutofilled, orchId, cwd, eventsPath) {
  // Kill switch
  if (process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED === '1') return;

  const key = orchId + '::' + eventType;
  if (!_autofillCounters.has(key)) {
    _autofillCounters.set(key, { total: 0, autofilled: 0 });
  }
  const counter = _autofillCounters.get(key);
  counter.total++;
  if (wasAutofilled) counter.autofilled++;

  // Check threshold only if we haven't already fired for this key
  if (_autofillThresholdFired.has(key)) return;

  const threshold = parseFloat(process.env.ORCHESTRAY_AUTOFILL_THRESHOLD || String(AUTOFILL_THRESHOLD_DEFAULT));
  if (counter.total < AUTOFILL_MIN_OBSERVATIONS) return;

  const ratio = counter.autofilled / counter.total;
  if (ratio <= threshold) return;

  // Threshold exceeded — fire once
  _autofillThresholdFired.add(key);

  // Emit threshold event
  try {
    const thresholdEvent = {
      version:         1,
      type:            'audit_event_autofill_threshold_exceeded',
      // D4 (v2.3.18 W1a): this event bypasses writeEvent (raw appendFileSync
      // below) to avoid recursing into the autofill gateway it polices, which
      // means it never got the `timestamp` autofill every other event gets —
      // 48/48 production rows carried no timestamp, violating the required-
      // field contract this event exists to enforce. Stamp it explicitly.
      timestamp:       new Date().toISOString(),
      event_type:      eventType,
      autofilled_count: counter.autofilled,
      total_count:     counter.total,
      ratio:           ratio,
      threshold:       threshold,
      orchestration_id: orchId,
    };
    const raw = JSON.stringify(thresholdEvent);
    const line = raw + '\n';
    try {
      fs.appendFileSync(eventsPath, line, 'utf8');
    } catch (_e) { /* fail-open */ }
  } catch (_e) { /* fail-open */ }

  // Write banner file
  try {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const bannerPath = path.join(stateDir, 'quarantine-banner-autofill-' + orchId + '.txt');
    const content =
      '[orchestray] autofill-threshold exceeded for event_type=' + eventType +
      ' in orchestration=' + orchId + '\n' +
      'ratio=' + ratio.toFixed(4) + ' threshold=' + threshold + '\n' +
      'autofilled=' + counter.autofilled + ' total=' + counter.total + '\n';
    fs.writeFileSync(bannerPath, content, 'utf8');
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// M4: schema_get self-call cache (v2.2.10)
// ---------------------------------------------------------------------------
// Set of event types we've already attempted a schema_get self-call for.
const _schemaGetCalledTypes = new Set();

/**
 * When writeEvent encounters an unknown event type, self-call getChunk()
 * (which is the schema_get implementation) and emit a mcp_tool_call event.
 * Subsequent calls for the same type are suppressed (cache).
 *
 * @param {string} eventType   - The unknown event type
 * @param {string} cwd         - Project root
 * @param {string} eventsPath  - Path to events.jsonl
 */
function _schemaGetSelfCall(eventType, cwd, eventsPath) {
  if (process.env.ORCHESTRAY_SCHEMA_GET_SELF_CALL_DISABLED === '1') return;
  if (_schemaGetCalledTypes.has(eventType)) return;
  _schemaGetCalledTypes.add(eventType);

  // Invoke getChunk from tier2-index.js (same as schema_get MCP tool).
  // Only emit the mcp_tool_call observability row when the tier2 index is
  // accessible (i.e. buildIndex() was called for this cwd). If the index is
  // absent (e.g. unit test fixtures that don't build the index), silently
  // skip the emit so existing "exactly N lines" dedup tests are not broken.
  let indexFound = false;
  try {
    const tier2Index = require('./tier2-index');
    if (typeof tier2Index.getChunk === 'function') {
      const result = tier2Index.getChunk(eventType, { cwd });
      // result.found is false when index missing/stale — treat as cache miss
      // but only emit the mcp_tool_call row when the lookup actually ran.
      // Emit the mcp_tool_call row only when the index was reachable (even if the
      // event type wasn't in it — that IS the cache-miss signal). When the index
      // file is missing entirely (upgrade window / test fixture without buildIndex),
      // getChunk returns error:'index_missing' — skip the emit so "exactly N lines"
      // dedup tests are not broken by a spurious row.
      if (result && typeof result === 'object' && result.error !== 'index_missing') {
        indexFound = true; // index accessible — getChunk probe ran
      }
    }
  } catch (_e) { /* fail-open */ }

  if (!indexFound) return;

  // Emit mcp_tool_call observability event directly (bypassing writeEvent recursion)
  try {
    const mcpEvent = {
      version:          1,
      type:             'mcp_tool_call',
      tool:             'schema_get',
      source:           'audit-writer-cache-miss',
      event_type_query: eventType,
      timestamp:        new Date().toISOString(),
    };
    const line = JSON.stringify(mcpEvent) + '\n';
    fs.appendFileSync(eventsPath, line, 'utf8');
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// W2-11: rename-cycle alias table (v2.2.11)
// ---------------------------------------------------------------------------
// When `staging_write_failed` or `task_validation_failed` is emitted, ALSO emit
// paired `*_attempt` + `*_result` shadow aliases so downstream analytics can
// start consuming the new names before the old ones are retired in v2.2.13.
//
// Kill switch: ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED=1
//
// The alias table maps each pre-rename event type to its two shadow aliases.
// `attempt` fires first (start-of-operation marker), `result` fires second
// (outcome marker, always "failed" in this release since aliases only fire
// when the *_failed event fires).
const _RENAME_CYCLE_ALIAS_TABLE = {
  staging_write_failed:    { attempt: 'staging_write_attempt',    result: 'staging_write_result' },
  task_validation_failed:  { attempt: 'task_validation_attempt',  result: 'task_validation_result' },
};

/**
 * Emit rename-cycle shadow aliases when a pre-rename event type fires.
 *
 * @param {object} originalEvent  - The already-written (filled) event payload.
 * @param {string} cwd            - Project root.
 * @param {string} eventsPath     - Path to events.jsonl.
 */
function _emitRenameCycleAliases(originalEvent, cwd, eventsPath) {
  if (process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED === '1') return;
  const eventType = originalEvent && (originalEvent.type || originalEvent.event_type);
  if (!eventType) return;
  const aliases = _RENAME_CYCLE_ALIAS_TABLE[eventType];
  if (!aliases) return;

  const baseFields = {
    version:          1,
    orchestration_id: originalEvent.orchestration_id || null,
    original_event_type: eventType,
    schema_version:   1,
  };

  // Emit attempt alias first
  try {
    const attemptEvent = Object.assign({}, baseFields, {
      type: aliases.attempt,
    });
    writeEvent(attemptEvent, { cwd, eventsPath });
  } catch (_e) { /* fail-open — alias loss is acceptable */ }

  // Emit result alias second
  try {
    const resultEvent = Object.assign({}, baseFields, {
      type:    aliases.result,
      outcome: 'failed',
    });
    writeEvent(resultEvent, { cwd, eventsPath });
  } catch (_e) { /* fail-open — alias loss is acceptable */ }
}

/**
 * Wrap writeEvent to also fire rename-cycle aliases for pre-rename event types.
 * This is called instead of writeEvent directly at the happy-path exit point.
 * Only runs when the original write succeeded (reason: 'ok' or 'unknown_type_emitted').
 *
 * @param {object} eventPayload - Raw (pre-autofill) event payload.
 * @param {object} opts         - Same as writeEvent opts.
 * @returns {object}            - Same return shape as writeEvent.
 */
function writeEventWithAliases(eventPayload, opts) {
  opts = opts || {};

  // W2b (v2.2.12): deprecation warn for pre-rename event types (rate-limited 1/process/type).
  const requestedType = eventPayload && (eventPayload.type || eventPayload.event_type);
  if (requestedType && _RENAME_CYCLE_ALIAS_TABLE[requestedType] &&
      process.env.ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED !== '1' &&
      !_deprecatedNamesWarnedThisProcess.has(requestedType)) {
    _deprecatedNamesWarnedThisProcess.add(requestedType);
    const aliases = _RENAME_CYCLE_ALIAS_TABLE[requestedType];
    process.stderr.write(
      '[orchestray] event type "' + requestedType + '" is deprecated since v2.2.12' +
      ' — emit "' + aliases.attempt + '" + "' + aliases.result + '" instead.\n'
    );
  }

  const result = writeEvent(eventPayload, opts);

  // Only emit aliases when the original event was written (not surrogated/dropped).
  if (result && (result.reason === 'ok' || result.reason === 'unknown_type_emitted' ||
      result.reason === 'circuit_broken_bypass')) {
    const cwd = resolveSafeCwd(opts.cwd);
    const eventsPath = resolveEventsPath(cwd, opts.eventsPath);
    // Pass the raw payload — _emitRenameCycleAliases reads .type from it.
    _emitRenameCycleAliases(eventPayload, cwd, eventsPath);
  }

  return result;
}

module.exports = writeAuditEvent;
module.exports.writeEvent             = writeEvent;
module.exports.writeEventWithAliases  = writeEventWithAliases;
module.exports.writeAuditEvent        = writeAuditEvent;
module.exports.resolveOrchestrationId = resolveOrchestrationId;
module.exports.normalizeVersionFields = normalizeVersionFields;

// ---------------------------------------------------------------------------
// _testHooks — exported for B3 unit tests only (not production API)
// ---------------------------------------------------------------------------
module.exports._testHooks = {
  /**
   * Reset per-orch counters and fired-set entries for a given orchId.
   * Allows unit tests to run in isolation despite module caching.
   */
  resetForOrch(orchId) {
    for (const key of _autofillCounters.keys()) {
      if (key.startsWith(orchId + '::')) _autofillCounters.delete(key);
    }
    for (const key of _autofillThresholdFired.keys()) {
      if (key.startsWith(orchId + '::')) _autofillThresholdFired.delete(key);
    }
  },

  /**
   * Expose _trackAutofillThreshold for direct test driving.
   */
  trackThreshold: _trackAutofillThreshold,

  /**
   * Reset the per-process shape-violation rate-limit map (W-MISS-SPLIT v2.2.12).
   * Required so tests can run in isolation against the module cache.
   */
  resetShapeViolationWarnedTypes() { _shapeViolationWarnedTypes.clear(); },

  /** Expose the map for test assertions. */
  get shapeViolationWarnedTypes() { return _shapeViolationWarnedTypes; },

  /** W2b (v2.2.12): reset per-process deprecated-name warn set for test isolation. */
  resetDeprecatedNamesWarned() { _deprecatedNamesWarnedThisProcess.clear(); },

  /** W2b (v2.2.12): expose set for test assertions. */
  get deprecatedNamesWarnedThisProcess() { return _deprecatedNamesWarnedThisProcess; },

  /**
   * P1-13 (v2.2.15): expose emitAutofillTelemetry for direct test driving.
   * Allows tests to verify the schema_state field is propagated correctly
   * without going through the full writeEvent pipeline.
   */
  emitAutofillTelemetry,

  /** P1-13: reset the schema-warned-this-process flag between tests. */
  resetSchemaWarned() { _schemaWarnedThisProcess = false; },

  /** D7 (v2.3.18): expose the test-log-pollution guard for direct assertions. */
  resolveEventsPath,
  testRedirectFor,
  sandboxEventsPath,
  PACKAGE_ROOT,

  /** E2/E3 (v2.3.18 W6b): sampling-state sandbox + locked RMW internals. */
  autofillSamplePath,
  autofillSampleRedirectFor,
  sandboxAutofillSamplePath,
  loadAutofillSample,
  saveAutofillSample,
  advanceAutofillSample: _advanceAutofillSample,
  flushAutofillSample:   _flushAutofillSample,
  AUTOFILL_SAMPLE_INTERVAL,
};
