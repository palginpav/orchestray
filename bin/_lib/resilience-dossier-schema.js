'use strict';

/**
 * resilience-dossier-schema.js — Build, serialize, parse the resilience dossier.
 *
 * The resilience dossier is an atomically-written snapshot of the live PM
 * orchestration posture. It survives auto-compaction: the hooks in
 * bin/write-resilience-dossier.js write it on Stop/SubagentStop/PreCompact,
 * and bin/inject-resilience-dossier.js reads it on UserPromptSubmit after a
 * compaction is detected.
 *
 * This module:
 *   - Defines the schema (DOSSIER_SCHEMA_VERSION = 1, field tiers).
 *   - Exports `buildDossier(sources)` to assemble a dossier from raw inputs.
 *   - Exports `serializeDossier(dossier)` to emit JSON with a hard 12 KB cap,
 *     degrading deferred → expanded fields as needed.
 *   - Exports `parseDossier(buf)` with strict schema-version guarding.
 *   - Exports `atomicWriteDossier(path, dossier)` using the tmp+rename pattern.
 *
 * Design: v217-compaction-resilience-design.md §B. Schema is load-bearing —
 * the PM's Section 7.C re-hydration protocol trusts every field.
 *
 * Contract: pure, no side effects except in atomicWriteDossier (which uses fs
 * and is wrapped by callers in try/catch so nothing here throws to hooks).
 */

const fs = require('fs');
const path = require('path');

// Lazy-required to break potential circular dep with degraded-journal.js; and
// because buildDossier is pure in test contexts that never call this journal path.
let _recordDegradation;
function _lazyRecordDeg() {
  if (!_recordDegradation) {
    _recordDegradation = require('./degraded-journal').recordDegradation;
  }
  return _recordDegradation;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOSSIER_SCHEMA_VERSION = 2;

/**
 * D3 (v2.1.7 zero-deferral): schema_version 1 was the v2.1.7 pre-patch version.
 * parseDossier accepts version 1 for backward compat (drops the vestigial
 * ingested_counter field silently) and version 2 going forward.
 */
const DOSSIER_COMPAT_VERSIONS = Object.freeze([1, 2]);

/**
 * Fence tag constants (SEC-01). Centralised here so serializeDossier and the
 * injector can both reference the same strings for collision scanning.
 * Any dossier field whose serialized representation contains either substring
 * would break the `<orchestray-resilience-dossier>` fence perceived by the
 * model and constitute a persistent prompt-injection channel.
 */
const FENCE_OPEN  = '<orchestray-resilience-dossier>';
const FENCE_CLOSE = '</orchestray-resilience-dossier>';

/**
 * Whole-dossier hard cap on disk (serialized UTF-8 bytes). Per W3 §B2.
 * If the fully-populated dossier exceeds this, serializer progressively drops
 * deferred-tier fields, then expanded-tier fields, and adds truncation flags.
 */
const MAX_BYTES = 12 * 1024;

/**
 * Max bytes injected as additionalContext on UserPromptSubmit. Per W3 §F1 the
 * default is 12288 (the whole dossier can be injected if the on-disk cap is
 * also 12288). The injector consults the runtime config; this constant is the
 * library default / schema-side ceiling.
 */
const INJECT_MAX_BYTES = 12288;

/**
 * Critical-tier fields MUST appear in every dossier. Losing any of these
 * forces the PM into a blind re-decomposition after compaction.
 */
const CRITICAL_FIELDS = Object.freeze([
  'schema_version',
  'written_at',
  'orchestration_id',
  'phase',
  'status',
  'complexity_score',
  'current_group_id',
  'pending_task_ids',
  'completed_task_ids',
  'cost_so_far_usd',
  'cost_budget_remaining_usd',
  'last_compact_detected_at',
  // D3 (v2.1.7 zero-deferral): ingested_counter removed from critical fields.
  // The live injection counter lives in compact-signal.lock (field: ingested_count).
  // The dossier field was always emitted as 0 and was misleading. Schema bumped to 2.
]);

/**
 * Expanded-tier fields. Dropped before critical when over-size, kept before
 * deferred.
 */
const EXPANDED_FIELDS = Object.freeze([
  'delegation_pattern',
  'failed_task_ids',
  'task_ref_uris',
  'kb_paths_cited',
  'mcp_checkpoints_outstanding',
  'retry_counter',
  'replan_count',
  'compact_trigger',
]);

/**
 * Deferred-tier fields. First to be dropped when the serialized dossier
 * exceeds MAX_BYTES.
 */
const DEFERRED_FIELDS = Object.freeze([
  'routing_lookup_keys',
  'planning_inputs',
  'drift_sentinel_invariants',
]);

/**
 * Field caps used by buildDossier to bound individual list fields. Matches
 * the "Max bytes" column in W3 §B1.
 */
const CAPS = Object.freeze({
  pending_task_ids: 20,
  completed_task_ids: 40,
  failed_task_ids: 20,
  task_ref_uris: 60, // covers pending + completed
  kb_paths_cited: 10,
  mcp_checkpoints_outstanding: 10,
  retry_counter_keys: 20,
  routing_lookup_keys: 20,
  drift_sentinel_invariants: 5,
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Assemble a resilience dossier from a `sources` bundle of raw disk-read data.
 * The caller (write-resilience-dossier.js) performs all file reads; this
 * function is pure so it can be unit-tested with synthetic inputs.
 *
 * `sources` shape (every field optional — missing fields fill with defaults):
 *   {
 *     orchestration: {           // parsed YAML frontmatter from orchestration.md
 *       id, phase, status, complexity_score, delegation_pattern,
 *       current_phase, current_group_id, replan_count, compact_trigger
 *     },
 *     task_ids: {
 *       pending: string[], completed: string[], failed: string[]
 *     },
 *     cost: { so_far_usd, budget_usd },       // both numbers or null
 *     events_tail: Array<{type, kb_path?, kb_uri?, ...}>,  // last ~50 events
 *     mcp_checkpoints: Array<{tool, task_id, created_at, consumed_at?}>,
 *     routing_tail: Array<{subtask_id, ...}>, // last 20 routing entries
 *     last_compact_detected_at: string|null,
 *     ingested_counter: number,
 *     planning_inputs: {release_plan_path?, phase_slug?} | null,
 *     drift_invariants: string[],
 *   }
 *
 * @param {object} sources
 * @param {string} [projectRoot] - Optional project root for journal emissions when path
 *   fields are sanitised. When absent, journaling is silently skipped (test contexts).
 * @returns {object} Fully populated (pre-serialize) dossier object.
 */
function buildDossier(sources, projectRoot) {
  const src = sources || {};
  const orch = src.orchestration || {};
  const taskIds = src.task_ids || {};
  const cost = src.cost || {};
  const eventsTail = Array.isArray(src.events_tail) ? src.events_tail : [];
  const checkpoints = Array.isArray(src.mcp_checkpoints) ? src.mcp_checkpoints : [];
  const routingTail = Array.isArray(src.routing_tail) ? src.routing_tail : [];

  // --- Critical scalars ---
  const orchestrationId = _strOrNull(orch.id);
  const phase = _enumOr(orch.phase || orch.current_phase, [
    'assessment', 'decomposition', 'delegation',
    'implementation', 'review', 'complete',
  ], null);
  const status = _enumOr(orch.status, [
    'in_progress', 'completed', 'failed', 'interrupted',
  ], null);
  const complexityScore = _intInRange(orch.complexity_score, 0, 12, 0);

  // --- Task id arrays (capped + deduped) ---
  const pending = _capStringArray(taskIds.pending, CAPS.pending_task_ids);
  const completed = _capStringArray(taskIds.completed, CAPS.completed_task_ids);
  const failed = _capStringArray(taskIds.failed, CAPS.failed_task_ids);

  // --- Task URI refs (union of pending + completed, capped) ---
  const taskRefUris = [];
  for (const id of pending.concat(completed).concat(failed)) {
    if (taskRefUris.length >= CAPS.task_ref_uris) break;
    taskRefUris.push('orchestray:orchestration://current/tasks/' + id);
  }

  // --- KB paths cited (tail of events, deduplicated) ---
  // SEC-05: sanitise path-shaped values before they enter the dossier.
  const kbPathsSeen = new Set();
  const kbPathsCitedRaw = [];
  for (let i = eventsTail.length - 1; i >= 0; i--) {
    if (kbPathsCitedRaw.length >= CAPS.kb_paths_cited) break;
    const evt = eventsTail[i];
    if (!evt || typeof evt !== 'object') continue;
    const p = _strOrNull(evt.kb_path);
    if (p && !kbPathsSeen.has(p)) {
      kbPathsSeen.add(p);
      kbPathsCitedRaw.push(p);
    }
    const u = _strOrNull(evt.kb_uri);
    if (u && !kbPathsSeen.has(u)) {
      kbPathsSeen.add(u);
      kbPathsCitedRaw.push(u);
    }
  }
  const { sanitised: kbPathsCited, dropped: kbDropped } = _sanitiseDossierPathArray(kbPathsCitedRaw);
  if (kbDropped > 0 && projectRoot) {
    _lazyRecordDeg()({
      kind: 'dossier_field_sanitised',
      severity: 'warn',
      projectRoot,
      detail: {
        field: 'kb_paths_cited',
        dropped_count: kbDropped,
        dedup_key: 'dossier_field_sanitised|kb_paths_cited',
      },
    });
  }

  // --- Outstanding MCP checkpoints (no consumed_at) ---
  const mcpOutstanding = [];
  for (const cp of checkpoints) {
    if (mcpOutstanding.length >= CAPS.mcp_checkpoints_outstanding) break;
    if (!cp || typeof cp !== 'object') continue;
    if (cp.consumed_at) continue;
    const tool = _strOrNull(cp.tool);
    if (!tool) continue;
    mcpOutstanding.push({
      tool,
      task_id: _strOrNull(cp.task_id),
      created_at: _strOrNull(cp.created_at),
    });
  }

  // --- Retry counter (from verify_fix_retry events) ---
  const retryCounter = {};
  let retryCounterKeys = 0;
  for (const evt of eventsTail) {
    if (!evt || evt.type !== 'verify_fix_retry') continue;
    const tid = _strOrNull(evt.task_id);
    if (!tid) continue;
    if (!(tid in retryCounter)) {
      if (retryCounterKeys >= CAPS.retry_counter_keys) continue;
      retryCounter[tid] = 0;
      retryCounterKeys++;
    }
    retryCounter[tid] += 1;
  }

  // --- Routing lookup keys (tail of routing.jsonl) ---
  const routingLookupKeys = [];
  for (const r of routingTail) {
    if (routingLookupKeys.length >= CAPS.routing_lookup_keys) break;
    if (!r || typeof r !== 'object') continue;
    const sid = _strOrNull(r.subtask_id || r.task_id);
    if (sid) routingLookupKeys.push(sid);
  }

  // --- Cost ---
  const costSoFar = _numberOrNull(cost.so_far_usd);
  const costBudget = _numberOrNull(cost.budget_usd);
  const costRemaining = (costBudget != null && costSoFar != null)
    ? Math.max(0, round4(costBudget - costSoFar))
    : null;

  // --- Assemble ---
  // SEC-05: sanitise path-shaped scalar fields before assembly; journal on rejection.
  const rawDelegationPattern = _strOrNull(orch.delegation_pattern) || '';
  const delegationPattern = _sanitiseDossierPathField(rawDelegationPattern) || null;
  if (delegationPattern === null && rawDelegationPattern.length > 0 && projectRoot) {
    _lazyRecordDeg()({
      kind: 'dossier_field_sanitised',
      severity: 'warn',
      projectRoot,
      detail: {
        field: 'delegation_pattern',
        dedup_key: 'dossier_field_sanitised|delegation_pattern',
      },
    });
  }
  const rawCurrentGroupId = _strOrNull(orch.current_group_id) || '';
  const currentGroupId = _sanitiseDossierPathField(rawCurrentGroupId) || null;
  if (currentGroupId === null && rawCurrentGroupId.length > 0 && projectRoot) {
    _lazyRecordDeg()({
      kind: 'dossier_field_sanitised',
      severity: 'warn',
      projectRoot,
      detail: {
        field: 'current_group_id',
        dedup_key: 'dossier_field_sanitised|current_group_id',
      },
    });
  }

  const dossier = {
    schema_version: DOSSIER_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    orchestration_id: orchestrationId,
    phase,
    status,
    complexity_score: complexityScore,
    delegation_pattern: delegationPattern,
    current_group_id: currentGroupId,
    pending_task_ids: pending,
    completed_task_ids: completed,
    failed_task_ids: failed,
    task_ref_uris: taskRefUris,
    kb_paths_cited: kbPathsCited,
    mcp_checkpoints_outstanding: mcpOutstanding,
    retry_counter: retryCounter,
    replan_count: _intInRange(orch.replan_count, 0, 999, 0),
    cost_so_far_usd: costSoFar,
    cost_budget_remaining_usd: costRemaining,
    routing_lookup_keys: routingLookupKeys,
    last_compact_detected_at: _strOrNull(src.last_compact_detected_at),
    // D3: ingested_counter removed — live counter is in compact-signal.lock.
    compact_trigger: _enumOr(orch.compact_trigger || src.compact_trigger, [
      'manual', 'auto',
    ], null),
    planning_inputs: _planningInputs(src.planning_inputs),
    drift_sentinel_invariants: _capStringArray(
      src.drift_invariants,
      CAPS.drift_sentinel_invariants
    ),
    truncation_flags: [],
  };

  return dossier;
}

// ---------------------------------------------------------------------------
// Serialize (with tiered truncation)
// ---------------------------------------------------------------------------

/**
 * Serialize a dossier to UTF-8 JSON, capping total size at MAX_BYTES by
 * dropping deferred → expanded fields as needed. Records any drops in
 * `truncation_flags`.
 *
 * Critical fields are NEVER dropped — if the critical-only dossier exceeds
 * MAX_BYTES (shouldn't happen per §B2 math) we accept the overflow rather
 * than emit an unusable dossier. Callers should treat that as an error-case
 * signal (the returned `serialized` will still be valid JSON and parseable).
 *
 * @param {object} dossier - As produced by buildDossier().
 * @returns {{serialized: string, truncation_flags: string[], size_bytes: number, dropped: string[]}}
 */
function serializeDossier(dossier) {
  if (!dossier || typeof dossier !== 'object') {
    throw new TypeError('serializeDossier: dossier must be an object');
  }

  // Work on a shallow copy so callers can re-serialize.
  const work = Object.assign({}, dossier);
  work.truncation_flags = [];
  const dropped = [];

  // First-pass serialization.
  let json = _json(work);
  let size = Buffer.byteLength(json, 'utf8');

  // SEC-01: fence-collision guard. Scan the serialized JSON for the
  // fence substrings (case-insensitive via NFKC-normalized lower-case) before
  // returning. If found, clear the offending fields that carry user-influenced
  // strings and re-serialize.  Do NOT throw — return { ok: false } so the
  // caller (write-resilience-dossier.js) can journal and fail open.
  const collisionCheck = _fenceCollisionScan(json);
  if (collisionCheck.found) {
    // Clear expanded-tier user-ish fields most likely to carry the collision.
    work.kb_paths_cited = [];
    work.drift_sentinel_invariants = [];
    work.current_group_id = null;
    work.delegation_pattern = null;
    work.planning_inputs = null;
    work.routing_lookup_keys = [];
    if (!work.truncation_flags) work.truncation_flags = [];
    work.truncation_flags.push('fence_collision_cleared');
    json = _json(work);
    size = Buffer.byteLength(json, 'utf8');
    return {
      ok: false,
      reason: 'fence_collision',
      offending_field: collisionCheck.offending_field,
      serialized: json,
      truncation_flags: work.truncation_flags.slice(),
      size_bytes: size,
      dropped: [],
    };
  }

  if (size <= MAX_BYTES) {
    return {
      serialized: json,
      truncation_flags: work.truncation_flags.slice(),
      size_bytes: size,
      dropped: [],
    };
  }

  // Drop deferred tier first (set to empty/null rather than deleting — preserves
  // schema presence so parseDossier roundtrips are stable).
  for (const field of DEFERRED_FIELDS) {
    if (field in work) {
      work[field] = _emptyFor(work[field]);
      dropped.push(field);
    }
  }
  work.truncation_flags.push('deferred_dropped');
  json = _json(work);
  size = Buffer.byteLength(json, 'utf8');
  if (size <= MAX_BYTES) {
    return {
      serialized: json,
      truncation_flags: work.truncation_flags.slice(),
      size_bytes: size,
      dropped: dropped.slice(),
    };
  }

  // Drop expanded tier.
  for (const field of EXPANDED_FIELDS) {
    if (field in work) {
      work[field] = _emptyFor(work[field]);
      dropped.push(field);
    }
  }
  work.truncation_flags.push('expanded_dropped');
  json = _json(work);
  size = Buffer.byteLength(json, 'utf8');
  if (size <= MAX_BYTES) {
    return {
      serialized: json,
      truncation_flags: work.truncation_flags.slice(),
      size_bytes: size,
      dropped: dropped.slice(),
    };
  }

  // Critical-only still overflowed (shouldn't happen). Truncate the longest
  // task-id arrays last-ditch.
  work.truncation_flags.push('critical_overflow');
  if (Array.isArray(work.completed_task_ids) && work.completed_task_ids.length > 5) {
    work.completed_task_ids = work.completed_task_ids.slice(0, 5);
    dropped.push('completed_task_ids:truncated');
  }
  if (Array.isArray(work.pending_task_ids) && work.pending_task_ids.length > 5) {
    work.pending_task_ids = work.pending_task_ids.slice(0, 5);
    dropped.push('pending_task_ids:truncated');
  }

  json = _json(work);
  size = Buffer.byteLength(json, 'utf8');
  return {
    serialized: json,
    truncation_flags: work.truncation_flags.slice(),
    size_bytes: size,
    dropped: dropped.slice(),
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a dossier buffer (string or Buffer). Strictly rejects unknown future
 * schema versions and missing critical fields.
 *
 * Returns `{ ok: true, dossier }` on success or `{ ok: false, reason, detail? }`
 * on any failure mode. Never throws.
 *
 * Failure reasons:
 *   'empty'           — buf is empty / whitespace-only
 *   'parse_error'     — JSON.parse threw
 *   'not_object'      — parsed value is not a plain object
 *   'schema_mismatch' — schema_version !== DOSSIER_SCHEMA_VERSION
 *   'missing_critical'— one or more CRITICAL_FIELDS absent
 *
 * @param {Buffer|string} buf
 * @returns {{ok: true, dossier: object} | {ok: false, reason: string, detail?: string}}
 */
function parseDossier(buf) {
  try {
    if (buf == null) return { ok: false, reason: 'empty' };
    const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (!s || !s.trim()) return { ok: false, reason: 'empty' };

    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (err) {
      return {
        ok: false,
        reason: 'parse_error',
        detail: String(err && err.message || err).slice(0, 200),
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not_object' };
    }

    if (!DOSSIER_COMPAT_VERSIONS.includes(parsed.schema_version)) {
      return {
        ok: false,
        reason: 'schema_mismatch',
        detail: 'accepted=' + DOSSIER_COMPAT_VERSIONS.join(',') + ' got=' + String(parsed.schema_version),
      };
    }

    // D3 compat shim: schema_version=1 dossiers carried ingested_counter in critical
    // fields (always 0). Drop it silently so parseDossier accepts pre-patch dossiers.
    if (parsed.schema_version === 1 && 'ingested_counter' in parsed) {
      delete parsed.ingested_counter;
    }

    const missing = CRITICAL_FIELDS.filter((f) => !(f in parsed));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'missing_critical',
        detail: missing.slice(0, 5).join(','),
      };
    }

    return { ok: true, dossier: parsed };
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_error',
      detail: String(err && err.message || err).slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Atomically write a serialized dossier to `dossierPath` using tmp+rename.
 *
 * Pattern:
 *   1. Ensure parent directory exists.
 *   2. Write to `<path>.tmp-<pid>`.
 *   3. Rename over `<path>`.
 *
 * Never throws — returns { ok: false, err } on failure. The temp file is
 * cleaned up on error.
 *
 * Collision guard: if a non-file exists at `dossierPath` (directory, symlink,
 * etc.), the write is aborted with reason='path_collision'. The writer does
 * not blindly overwrite non-file paths.
 *
 * @param {string} dossierPath
 * @param {string} serialized - Output of serializeDossier().
 * @returns {{ok: boolean, err?: Error, size_bytes?: number, reason?: string}}
 */
function atomicWriteDossier(dossierPath, serialized) {
  if (typeof dossierPath !== 'string' || !dossierPath) {
    return { ok: false, err: new Error('bad path'), reason: 'bad_path' };
  }
  if (typeof serialized !== 'string') {
    return { ok: false, err: new Error('bad payload'), reason: 'bad_payload' };
  }

  // Collision guard — never overwrite a non-file.
  try {
    const st = fs.lstatSync(dossierPath);
    if (!st.isFile()) {
      return { ok: false, reason: 'path_collision', err: new Error('path_collision') };
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      return { ok: false, err, reason: 'stat_failed' };
    }
    // ENOENT is fine — we'll create it.
  }

  try {
    fs.mkdirSync(path.dirname(dossierPath), { recursive: true });
  } catch (_e) { /* best-effort */ }

  const tmpPath = dossierPath + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, dossierPath);
    return { ok: true, size_bytes: Buffer.byteLength(serialized, 'utf8') };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_e) {}
    return { ok: false, err, reason: 'write_failed' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _json(obj) {
  return JSON.stringify(obj);
}

function _strOrNull(v) {
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

function _numberOrNull(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? round4(v) : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function _intInRange(v, min, max, def) {
  if (!Number.isInteger(v)) return def;
  return Math.max(min, Math.min(max, v));
}

function _enumOr(v, allowed, def) {
  return (typeof v === 'string' && allowed.indexOf(v) !== -1) ? v : def;
}

function _capStringArray(arr, cap) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (out.length >= cap) break;
    if (typeof item !== 'string') continue;
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function _planningInputs(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  if (typeof v.release_plan_path === 'string') out.release_plan_path = v.release_plan_path;
  if (typeof v.phase_slug === 'string') out.phase_slug = v.phase_slug;
  return Object.keys(out).length > 0 ? out : null;
}

function _emptyFor(v) {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') return {};
  return null;
}

/**
 * SEC-05: Sanitise a single path-shaped dossier field value.
 *
 * Rejects values that:
 *   - Contain NUL bytes or ASCII control characters (< 0x20).
 *   - Exceed 1024 characters.
 *   - Contain `..` path-traversal segments.
 *
 * On acceptance, normalises the value with `path.normalize()`.
 * On rejection, returns `null` so callers can journal `dossier_field_sanitised`.
 *
 * @param {string} value
 * @returns {string|null}
 */
function _sanitiseDossierPathField(value) {
  if (typeof value !== 'string') return null;
  if (value.length > 1024) return null;
  // Reject NUL byte or any ASCII control character (0x00–0x1F).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(value)) return null;
  // Reject path-traversal segments.
  const segments = value.replace(/\\/g, '/').split('/');
  if (segments.some((seg) => seg === '..')) return null;
  return path.normalize(value);
}

/**
 * SEC-05: Sanitise an array of path-shaped dossier field values.
 * Silently drops invalid entries; the caller should journal if any were dropped.
 *
 * @param {string[]} arr
 * @returns {{ sanitised: string[], dropped: number }}
 */
function _sanitiseDossierPathArray(arr) {
  if (!Array.isArray(arr)) return { sanitised: [], dropped: 0 };
  const sanitised = [];
  let dropped = 0;
  for (const item of arr) {
    const s = _sanitiseDossierPathField(item);
    if (s !== null) {
      sanitised.push(s);
    } else {
      dropped++;
    }
  }
  return { sanitised, dropped };
}

/**
 * SEC-01: Scan a serialized dossier JSON string for fence substrings.
 *
 * Two scans are performed:
 *   1. NFKC + lower-case on the full buffer — catches case-insensitive matches
 *      and compatibility-equivalent variants (fullwidth letters, ligatures, etc.).
 *      Does NOT catch cross-script confusables (e.g. Cyrillic 'о' (U+043E) vs
 *      Latin 'o') because NFKC does not map between distinct scripts.
 *   2. Literal ASCII scan via `includes()` on the raw buffer — ensures the exact
 *      fence string is always caught even if NFKC normalisation somehow alters it.
 *
 * Both scans must fire; no single scan is sufficient.
 *
 * @param {string} json - The serialised dossier JSON.
 * @returns {{ found: boolean, offending_field?: string }}
 */
function _fenceCollisionScan(json) {
  if (typeof json !== 'string') return { found: false };
  // Scan 1: NFKC normalise + lower-case catches compatibility-equivalent variants.
  const normalised = json.normalize('NFKC').toLowerCase();
  const openLower  = FENCE_OPEN.toLowerCase();
  const closeLower = FENCE_CLOSE.toLowerCase();
  // Scan 2: literal ASCII scan on the raw buffer (defence-in-depth; both must fire).
  const fenceFound = normalised.includes(openLower) || normalised.includes(closeLower)
    || json.includes(FENCE_OPEN) || json.includes(FENCE_CLOSE);
  if (fenceFound) {
    // Best-effort: identify which logical field the hit came from.
    let offending_field;
    try {
      const parsed = JSON.parse(json);
      const candidateFields = [
        'kb_paths_cited', 'drift_sentinel_invariants', 'current_group_id',
        'delegation_pattern', 'routing_lookup_keys',
      ];
      for (const f of candidateFields) {
        const v = parsed[f];
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s && s.normalize('NFKC').toLowerCase().includes(openLower)) {
          offending_field = f; break;
        }
        if (s && s.normalize('NFKC').toLowerCase().includes(closeLower)) {
          offending_field = f; break;
        }
      }
    } catch (_e) { /* best-effort */ }
    return { found: true, offending_field };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DOSSIER_SCHEMA_VERSION,
  DOSSIER_COMPAT_VERSIONS,
  MAX_BYTES,
  INJECT_MAX_BYTES,
  CRITICAL_FIELDS,
  EXPANDED_FIELDS,
  DEFERRED_FIELDS,
  CAPS,
  // SEC-01: fence tag constants (auditable single source of truth)
  FENCE_OPEN,
  FENCE_CLOSE,
  buildDossier,
  serializeDossier,
  parseDossier,
  atomicWriteDossier,
  // exported for unit tests
  _strOrNull,
  _intInRange,
  _enumOr,
  _capStringArray,
  _fenceCollisionScan,
  // SEC-05: path sanitiser (exported for tests)
  _sanitiseDossierPathField,
  _sanitiseDossierPathArray,
};
