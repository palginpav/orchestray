'use strict';

/**
 * `curator_tombstone` MCP tool.
 *
 * Bridge between the curator LLM agent and `bin/_lib/curator-tombstone.js`.
 *
 * The curator agent has no `Bash` tool and cannot `require()` Node modules
 * directly. This MCP tool is a thin dispatcher that exposes the full tombstone
 * library API (startRun, writeTombstone, undoLast, undoById, clearTombstones,
 * listTombstones) as a single named tool — matching the pattern established by
 * `pattern_deprecate` (one tool, one responsibility, input `action` field for
 * dispatch).
 *
 * Additional responsibilities beyond the library:
 *   1. `curator.enabled` gate — reject ALL actions when the config key is false.
 *   2. `run.lock` concurrency guard on `start_run` — atomic EEXIST check.
 *   3. Audit event emission — emits `curator_run_start`, `curator_action_promoted`,
 *      `curator_action_merged`, `curator_action_deprecated`, and (v2.3.23)
 *      `curator_run_complete` per event-schemas.md §44.
 *
 * Resolves: C1a F01 (dead-code), C1a F04 (run.lock), C1a F07 (fsync+rename),
 *           C1c #3 (phantom curator-lib.js), C1c #4 (no CLI entry),
 *           C1c P1 #2 (curator.enabled prompt-only).
 *
 * F1 (v2.1.0) — see .orchestray/kb/artifacts/2100-c1-bugs.md and
 * .orchestray/kb/artifacts/2100-c1-dead-code.md.
 *
 * `close_run` (v2.3.23) — the curator agent's own §8 instruction to append
 * `curator_run_complete` as its "final action" was never mechanically viable:
 * the curator has no MCP verb that can append an audit event, and `Edit`-ing
 * the live 10+ MB `events.jsonl` requires reading the whole file first. See
 * .orchestray/kb/decisions/curator-run-complete-emission-gap.md. `close_run` is
 * called by `agents/curate-runner.md`'s deterministic protocol (a mandatory
 * step, not left to the curator LLM's discretion) after reconciliation and
 * stamp-apply. It also fixes a pre-existing lock leak: `handler_start_run`
 * acquires `run.lock`, but before this change only `undo_last`/`clear`
 * released it — a normal successful run never did, leaving the lock held
 * until its 10-minute staleness window expired. `close_run` now releases it
 * unconditionally, mirroring `undo_last`/`clear`.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError }            = require('../lib/tool-result');
const { writeAuditEvent }                   = require('../lib/audit');

// Tombstone library — this tool is the only production caller.
const {
  startRun,
  writeTombstone,
  undoLast,
  undoById,
  clearTombstones,
  listTombstones,
} = require('../../_lib/curator-tombstone');

// Config loader for the curator.enabled gate.
const { loadCuratorConfig } = require('../../_lib/config-schema');

// MCP server path helpers (project root resolution).
const paths = require('../lib/paths');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_ENUM = deepFreeze([
  'start_run',   // Begin a new curator run; returns run_id.
  'write',       // Write one tombstone row; returns action_id.
  'undo_last',   // Reverse all actions from the most-recent run.
  'undo_by_id',  // Reverse a single action by action_id.
  'clear',       // Hard-delete all tombstones (active + archive).
  'list',        // Read tombstones for display / dry-run.
  'close_run',   // End-of-run: emit curator_run_complete, release run.lock.
]);

/** run.lock stale threshold: 10 minutes in milliseconds. */
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * close_run kill switch (v2.3.23) — env + config, matching the project's
 * established convention (e.g. ORCHESTRAY_BARE_EVENT_REPAIR_DISABLED /
 * bare_event_key_repair.enabled). Scoped to the completion EMISSION only —
 * distinct from `curator.enabled`, which gates the whole tool. Even when
 * disabled, close_run still releases run.lock and honours its idempotency
 * marker (mechanical lifecycle cleanup is not something an observability
 * kill switch should hold hostage); it just skips writing the audit row.
 * Default-on per feedback_default_on_shipping.md; fail-open to enabled on
 * any read/parse error.
 */
const ENV_RUN_COMPLETE_DISABLED = 'ORCHESTRAY_CURATOR_RUN_COMPLETE_DISABLED';

function isRunCompleteEmitDisabled(projectRoot) {
  if (process.env[ENV_RUN_COMPLETE_DISABLED] === '1') return true;
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.curator && cfg.curator.run_complete_emit_enabled === false) {
      return true;
    }
  } catch (_e) { /* fail-open: default-on */ }
  return false;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTION_ENUM,
      description:
        'Dispatcher key. "start_run" begins a new curator run (must be called first). ' +
        '"write" appends one tombstone row before a destructive action. ' +
        '"undo_last" reverses the most-recent run. "undo_by_id" reverses one action. ' +
        '"clear" hard-deletes all tombstone history. "list" returns current tombstones. ' +
        '"close_run" ends a run: emits curator_run_complete and releases run.lock.',
    },
    run_id: {
      type: 'string',
      description:
        'Curator run ID returned by "start_run". Required for "write" and "undo_by_id".',
    },
    tombstone: {
      type: 'string',
      description:
        'JSON-serialised tombstone payload (object). Required for "write". ' +
        'Must include at least: action ("promote"|"merge"|"deprecate"), inputs (array), output (object).',
    },
    action_id: {
      type: 'string',
      description: 'Action ID to reverse. Required for "undo_by_id".',
    },
    include_archive: {
      type: 'string',
      description:
        '"true" (default) or "false". For "list" only — whether to include archived runs.',
    },
    only_run_id: {
      type: 'string',
      description: 'For "list" only — filter rows to a single run ID.',
    },
    event_type: {
      type: 'string',
      description:
        'Audit event type to emit after a successful "write". ' +
        'One of: curator_action_promoted, curator_action_merged, curator_action_deprecated. ' +
        'When omitted the event is derived from the tombstone action field.',
    },
    summary: {
      type: 'string',
      description:
        'JSON-serialised run summary. Required for "close_run". Shape: ' +
        '{ actions_applied: {promote_n,merge_n,deprecate_n}, ' +
        'actions_skipped: {promote_n,merge_n,deprecate_n}, tombstones_written_count, ' +
        'dry_run: boolean, reconciliation?: {repaired,flagged}, ' +
        'stamps?: {applied,skipped,failed} }. Missing counters default to 0; ' +
        'omitted reconciliation/stamps are recorded as null (per event-schemas.md).',
    },
  },
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const definition = deepFreeze({
  name: 'curator_tombstone',
  description:
    'Tombstone management for the pattern curator agent. ' +
    'Provides atomic write, keep-last-N retention, undo-last, undo-by-id, ' +
    'clear, list, and close_run operations over .orchestray/curator/tombstones.jsonl. ' +
    'All writes are atomic (tmp+rename). ' +
    'Gated on curator.enabled config key — returns an error when curator is disabled. ' +
    'Emits curator audit events (curator_run_start, curator_action_*, curator_run_complete) automatically.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// run.lock helpers
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the run.lock file.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function lockPath(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'curator', 'run.lock');
}

/**
 * Acquire the run.lock via atomic `open(O_EXCL | O_CREAT)`.
 *
 * If the lock file already exists:
 *   - If stale (mtime older than LOCK_STALE_MS), unlink and retry once.
 *   - If fresh, return { ok: false, error: "curator already running ..." }.
 *
 * On success, returns { ok: true }. Caller MUST call releaseLock() on completion
 * or crash recovery.
 *
 * @param {string} projectRoot
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function acquireLock(projectRoot) {
  const lp = lockPath(projectRoot);

  // Ensure .orchestray/curator/ exists before trying to lock.
  try {
    fs.mkdirSync(path.dirname(lp), { recursive: true });
  } catch (_) {
    // Already exists — fine.
  }

  let attempt = 0;
  while (attempt < 2) {
    attempt++;
    try {
      // O_EXCL + O_CREAT: atomic — throws EEXIST if lock already held.
      const fd = fs.openSync(lp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      // Write PID so humans can identify the owning process.
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Lock exists — check staleness.
        let stat;
        try {
          stat = fs.statSync(lp);
        } catch (_) {
          // Disappeared between open and stat — try again.
          continue;
        }
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          // Stale — clean and retry.
          try { fs.unlinkSync(lp); } catch (_) { /* best-effort */ }
          // Loop back for the second attempt.
          continue;
        }
        // Fresh lock held by another process.
        let pid = 'unknown';
        try { pid = fs.readFileSync(lp, 'utf8').trim(); } catch (_) {}
        return {
          ok: false,
          error: 'curator already running (pid ' + pid + '). ' +
                 'If the previous run crashed, delete .orchestray/curator/run.lock manually.',
        };
      }
      // Some other filesystem error.
      return { ok: false, error: 'run.lock acquire failed: ' + (err && err.message) };
    }
  }
  return { ok: false, error: 'run.lock acquire failed after retry' };
}

/**
 * Release the run.lock (unlink). Fail-open — lock removal must never crash the caller.
 *
 * @param {string} projectRoot
 */
function releaseLock(projectRoot) {
  try {
    fs.unlinkSync(lockPath(projectRoot));
  } catch (_) {
    // Best-effort: if the file is gone already, that's fine.
  }
}

// ---------------------------------------------------------------------------
// Audit event helpers
// ---------------------------------------------------------------------------

/**
 * Map a tombstone action field to the corresponding curator audit event type.
 *
 * @param {string} action - "promote" | "merge" | "deprecate"
 * @returns {string}
 */
function auditEventTypeForAction(action) {
  if (action === 'promote')   return 'curator_action_promoted';
  if (action === 'merge')     return 'curator_action_merged';
  if (action === 'deprecate') return 'curator_action_deprecated';
  return 'curator_action_unknown';
}

/**
 * Emit a curator audit event. Fail-open — never blocks the tool response.
 *
 * @param {string} type
 * @param {object} fields
 */
function emitCuratorEvent(type, fields) {
  try {
    writeAuditEvent(Object.assign({ timestamp: new Date().toISOString(), type }, fields));
  } catch (_) {
    // Audit failures must not block the response.
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * handler_start_run — begin a new curator run.
 *
 * Acquires run.lock (C1a F04), calls startRun() to handle retention rotation,
 * emits curator_run_start event, and returns the new run_id.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_start_run(input, context) {
  const projectRoot = (context && context.projectRoot) || null;

  const lockResult = acquireLock(projectRoot || process.cwd());
  if (!lockResult.ok) {
    return toolError('curator_tombstone: ' + lockResult.error);
  }

  let runId;
  try {
    runId = startRun({ projectRoot: projectRoot || undefined });
  } catch (err) {
    releaseLock(projectRoot || process.cwd());
    return toolError('curator_tombstone: startRun failed: ' + (err && err.message));
  }

  // Emit curator_run_start audit event (curator.md §8 — previously done via Write tool).
  emitCuratorEvent('curator_run_start', {
    orchestration_id: null,
    orch_id: runId,
    trigger: 'user',
  });

  return toolSuccess({ ok: true, run_id: runId });
}

/**
 * handler_write — append one tombstone row before a destructive action.
 *
 * Expects `run_id` and a JSON-serialised `tombstone` payload. Returns the
 * new action_id.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_write(input, context) {
  if (!input.run_id || typeof input.run_id !== 'string') {
    return toolError('curator_tombstone/write: run_id is required');
  }
  if (!input.tombstone || typeof input.tombstone !== 'string') {
    return toolError('curator_tombstone/write: tombstone (JSON string) is required');
  }

  let tombstoneObj;
  try {
    tombstoneObj = JSON.parse(input.tombstone);
  } catch (err) {
    return toolError('curator_tombstone/write: tombstone is not valid JSON: ' + (err && err.message));
  }

  if (!tombstoneObj || typeof tombstoneObj !== 'object' || Array.isArray(tombstoneObj)) {
    return toolError('curator_tombstone/write: tombstone must be a JSON object');
  }

  if (!tombstoneObj.action || typeof tombstoneObj.action !== 'string') {
    return toolError('curator_tombstone/write: tombstone.action is required (promote|merge|deprecate)');
  }

  if (!Array.isArray(tombstoneObj.inputs) || tombstoneObj.inputs.length === 0) {
    return toolError('curator_tombstone/write: tombstone.inputs must be a non-empty array');
  }

  if (!tombstoneObj.output || typeof tombstoneObj.output !== 'object') {
    return toolError('curator_tombstone/write: tombstone.output is required');
  }

  const projectRoot = (context && context.projectRoot) || null;

  let actionId;
  try {
    actionId = writeTombstone(input.run_id, tombstoneObj, { projectRoot: projectRoot || undefined });
  } catch (err) {
    return toolError('curator_tombstone/write: writeTombstone failed: ' + (err && err.message));
  }

  // Determine which audit event to emit.
  const explicitEventType = input.event_type;
  const eventType = (explicitEventType && typeof explicitEventType === 'string')
    ? explicitEventType
    : auditEventTypeForAction(tombstoneObj.action);

  emitCuratorEvent(eventType, {
    orchestration_id: null,
    run_id: input.run_id,
    action_id: actionId,
    action: tombstoneObj.action,
    slug: (tombstoneObj.inputs[0] && tombstoneObj.inputs[0].slug) || null,
  });

  return toolSuccess({ ok: true, action_id: actionId, run_id: input.run_id });
}

/**
 * handler_undo_last — reverse all actions from the most-recent run and release lock.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_undo_last(input, context) {
  const projectRoot = (context && context.projectRoot) || null;

  let result;
  try {
    result = undoLast({ projectRoot: projectRoot || undefined });
  } catch (err) {
    return toolError('curator_tombstone/undo_last: ' + (err && err.message));
  }

  // Release run.lock after undo (the run being undone held the lock).
  releaseLock(projectRoot || process.cwd());

  return toolSuccess({ ok: true, run_id: result.runId, reversed_count: result.count });
}

/**
 * handler_undo_by_id — reverse a single action by action_id.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_undo_by_id(input, context) {
  if (!input.action_id || typeof input.action_id !== 'string') {
    return toolError('curator_tombstone/undo_by_id: action_id is required');
  }

  const projectRoot = (context && context.projectRoot) || null;

  let result;
  try {
    result = undoById(input.action_id, { projectRoot: projectRoot || undefined });
  } catch (err) {
    return toolError('curator_tombstone/undo_by_id: ' + (err && err.message));
  }

  if (!result.found) {
    return toolError(
      'curator_tombstone/undo_by_id: action_id "' + input.action_id +
      '" not found in active tombstones or archives'
    );
  }

  return toolSuccess({ ok: true, action_id: result.action_id, source: result.source });
}

/**
 * handler_clear — hard-delete all tombstone history and release lock.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_clear(input, context) {
  const projectRoot = (context && context.projectRoot) || null;

  let result;
  try {
    result = clearTombstones({ projectRoot: projectRoot || undefined });
  } catch (err) {
    return toolError('curator_tombstone/clear: ' + (err && err.message));
  }

  // Release run.lock as part of a hard clear.
  releaseLock(projectRoot || process.cwd());

  return toolSuccess({ ok: true, deleted_files: result.deleted_files });
}

/**
 * handler_list — return tombstone rows for display.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_list(input, context) {
  const projectRoot = (context && context.projectRoot) || null;
  const includeArchive = input.include_archive !== 'false'; // default true
  const onlyRunId = (typeof input.only_run_id === 'string' && input.only_run_id.length > 0)
    ? input.only_run_id
    : undefined;

  let result;
  try {
    result = listTombstones({
      projectRoot: projectRoot || undefined,
      include_archive: includeArchive,
      only_run_id: onlyRunId,
    });
  } catch (err) {
    return toolError('curator_tombstone/list: ' + (err && err.message));
  }

  return toolSuccess({ ok: true, rows: result.rows, run_ids: result.run_ids });
}

// ---------------------------------------------------------------------------
// close_run helpers
// ---------------------------------------------------------------------------

/** Coerce to a non-negative integer, defaulting to 0 for anything else. */
function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function normalizeActionCounts(obj) {
  return {
    promote_n:   nonNegInt(obj && obj.promote_n),
    merge_n:     nonNegInt(obj && obj.merge_n),
    deprecate_n: nonNegInt(obj && obj.deprecate_n),
  };
}

/**
 * Absolute path to the idempotency marker for a given run_id. Created with
 * O_EXCL (same atomic-create idiom as acquireLock above) so two close_run
 * calls for the same run_id — e.g. a retried curate-runner step — emit
 * curator_run_complete at most once.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {string}
 */
function closedMarkerPath(projectRoot, runId) {
  // Sanitize runId for filesystem safety — it's caller-supplied.
  const safe = String(runId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(projectRoot, '.orchestray', 'curator', 'closed', safe + '.marker');
}

/**
 * handler_close_run — end-of-run lifecycle action (v2.3.23).
 *
 * Called by agents/curate-runner.md's deterministic protocol (not left to
 * the curator LLM's discretion — see file header). Always releases run.lock
 * (fixing the pre-v2.3.23 leak where a normal successful run never did) and,
 * unless the kill switch is set, emits curator_run_complete exactly once per
 * run_id via an atomic marker-file guard.
 *
 * @param {object} input
 * @param {object} context
 * @returns {object} toolSuccess or toolError
 */
function handler_close_run(input, context) {
  if (!input.run_id || typeof input.run_id !== 'string') {
    return toolError('curator_tombstone/close_run: run_id is required');
  }
  if (!input.summary || typeof input.summary !== 'string') {
    return toolError('curator_tombstone/close_run: summary (JSON string) is required');
  }

  let summaryObj;
  try {
    summaryObj = JSON.parse(input.summary);
  } catch (err) {
    return toolError('curator_tombstone/close_run: summary is not valid JSON: ' + (err && err.message));
  }
  if (!summaryObj || typeof summaryObj !== 'object' || Array.isArray(summaryObj)) {
    return toolError('curator_tombstone/close_run: summary must be a JSON object');
  }

  const projectRoot = (context && context.projectRoot) || process.cwd();

  // Always release run.lock, regardless of the emit kill switch or
  // idempotency outcome below — closing a run is a real lifecycle event,
  // not just an observability signal. Fail-open (releaseLock already is).
  releaseLock(projectRoot);

  // Idempotency guard: atomic marker create. EEXIST means this run_id was
  // already closed — skip re-emission rather than double-count the run.
  const markerPath = closedMarkerPath(projectRoot, input.run_id);
  let alreadyClosed = false;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const fd = fs.openSync(markerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    fs.writeSync(fd, new Date().toISOString());
    fs.closeSync(fd);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      alreadyClosed = true;
    }
    // Any other marker-write failure (e.g. permissions): fall through and
    // still emit — best-effort observability beats losing the signal, and
    // idempotency is a nice-to-have here, not a correctness requirement.
  }

  if (alreadyClosed) {
    return toolSuccess({ ok: true, run_id: input.run_id, already_closed: true });
  }

  if (isRunCompleteEmitDisabled(projectRoot)) {
    return toolSuccess({ ok: true, run_id: input.run_id, already_closed: false, emitted: false });
  }

  const eventFields = {
    orchestration_id: null,
    run_id: input.run_id,
    actions_applied: normalizeActionCounts(summaryObj.actions_applied),
    actions_skipped: normalizeActionCounts(summaryObj.actions_skipped),
    tombstones_written_count: nonNegInt(summaryObj.tombstones_written_count),
    dry_run: summaryObj.dry_run === true,
    reconciliation: (summaryObj.reconciliation && typeof summaryObj.reconciliation === 'object')
      ? { repaired: nonNegInt(summaryObj.reconciliation.repaired), flagged: nonNegInt(summaryObj.reconciliation.flagged) }
      : null,
    stamps: (summaryObj.stamps && typeof summaryObj.stamps === 'object')
      ? {
          applied: nonNegInt(summaryObj.stamps.applied),
          skipped: nonNegInt(summaryObj.stamps.skipped),
          failed:  nonNegInt(summaryObj.stamps.failed),
        }
      : null,
  };

  emitCuratorEvent('curator_run_complete', eventFields);

  return toolSuccess({ ok: true, run_id: input.run_id, already_closed: false, emitted: true });
}

// ---------------------------------------------------------------------------
// Dispatcher map
// ---------------------------------------------------------------------------

const ACTION_HANDLERS = {
  start_run:  handler_start_run,
  write:      handler_write,
  undo_last:  handler_undo_last,
  undo_by_id: handler_undo_by_id,
  clear:      handler_clear,
  list:       handler_list,
  close_run:  handler_close_run,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('curator_tombstone', context);
  // Schema validation (hand-rolled per project convention — no zod).
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('curator_tombstone: ' + validation.errors.join('; '));
  }

  // Resolve projectRoot from context (MCP server injects this).
  const projectRoot = (context && context.projectRoot) || null;
  const rootForConfig = projectRoot || (() => {
    try { return paths.getProjectRoot(); } catch (_) { return process.cwd(); }
  })();

  // curator.enabled gate (C1c P1 #2 — previously prompt-only).
  let curatorCfg;
  try {
    curatorCfg = loadCuratorConfig(rootForConfig);
  } catch (_) {
    // loadCuratorConfig is fail-open and should never throw, but guard anyway.
    curatorCfg = { enabled: true };
  }

  if (curatorCfg.enabled === false) {
    return toolError(JSON.stringify({
      ok: false,
      error: 'curator disabled by config',
      config_key: 'curator.enabled',
      hint: 'Enable via: /orchestray:config set curator.enabled true',
    }));
  }

  // Dispatch.
  const handler = ACTION_HANDLERS[input.action];
  if (!handler) {
    return toolError('curator_tombstone: unknown action "' + input.action + '"');
  }

  return handler(input, Object.assign({}, context, { projectRoot: rootForConfig }));
}

module.exports = { definition, handle };

// ---------------------------------------------------------------------------
// Smoke test (gated on direct execution)
// ---------------------------------------------------------------------------
// Run with: node bin/mcp-server/tools/curator_tombstone.js
//
// Verifies: start_run -> write -> undo_last -> state-matches-before.
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const os   = require('node:os');
    const assert = require('node:assert/strict');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-curator-bridge-smoke-'));
    // Minimal project structure.
    fs.mkdirSync(path.join(tmpRoot, '.orchestray', 'patterns'), { recursive: true });
    // Write a fake pattern for the tombstone's content_snapshot.
    const patternPath = path.join(tmpRoot, '.orchestray', 'patterns', 'test-pattern.md');
    const patternContent = '---\nname: test-pattern\nconfidence: 0.8\n---\n# Test\n';
    fs.writeFileSync(patternPath, patternContent, 'utf8');

    const ctx = { projectRoot: tmpRoot };

    // -----------------------------------------------------------------------
    // Step 1: start_run
    // -----------------------------------------------------------------------
    const startResult = await handle({ action: 'start_run' }, ctx);
    assert.strictEqual(startResult.isError, false, 'start_run should succeed');
    const { run_id } = startResult.structuredContent;
    assert.ok(run_id && run_id.startsWith('curator-'), 'run_id should have curator- prefix');
    process.stderr.write('[smoke] start_run ok — run_id: ' + run_id + '\n');

    // -----------------------------------------------------------------------
    // Step 2: write a tombstone
    // -----------------------------------------------------------------------
    const tombstonePayload = {
      action: 'deprecate',
      inputs: [{
        slug: 'test-pattern',
        path: patternPath,
        content_sha256: 'abc123',
        content_snapshot: patternContent,
      }],
      output: {
        path: patternPath,
        action_summary: 'smoke test deprecation',
      },
    };
    const writeResult = await handle({
      action: 'write',
      run_id,
      tombstone: JSON.stringify(tombstonePayload),
    }, ctx);
    assert.strictEqual(writeResult.isError, false, 'write should succeed');
    const { action_id } = writeResult.structuredContent;
    assert.ok(action_id && action_id.includes('-a'), 'action_id should contain -a serial');
    process.stderr.write('[smoke] write ok — action_id: ' + action_id + '\n');

    // Record state before undo.
    const { rows: rowsBefore } = listTombstones({ projectRoot: tmpRoot });
    const notRolledBack = rowsBefore.filter(r => !r.rolled_back_at);
    assert.strictEqual(notRolledBack.length, 1, 'one active tombstone before undo');

    // -----------------------------------------------------------------------
    // Step 3: undo_last — should reverse the write and release lock
    // -----------------------------------------------------------------------
    const undoResult = await handle({ action: 'undo_last' }, ctx);
    assert.strictEqual(undoResult.isError, false, 'undo_last should succeed');
    assert.strictEqual(undoResult.structuredContent.reversed_count, 1, 'reversed_count should be 1');
    process.stderr.write('[smoke] undo_last ok — reversed_count: ' +
      undoResult.structuredContent.reversed_count + '\n');

    // -----------------------------------------------------------------------
    // Step 4: verify state after undo
    // -----------------------------------------------------------------------
    const { rows: rowsAfter } = listTombstones({ projectRoot: tmpRoot });
    const stillActive = rowsAfter.filter(r => !r.rolled_back_at);
    assert.strictEqual(stillActive.length, 0, 'zero active tombstones after undo');
    // File should be restored.
    const restoredContent = fs.readFileSync(patternPath, 'utf8');
    assert.strictEqual(restoredContent, patternContent, 'pattern content restored after undo');

    // -----------------------------------------------------------------------
    // Step 5: verify run.lock was released
    // -----------------------------------------------------------------------
    const lp = path.join(tmpRoot, '.orchestray', 'curator', 'run.lock');
    assert.strictEqual(fs.existsSync(lp), false, 'run.lock should be released after undo_last');

    process.stderr.write('[smoke] All assertions passed.\n');

    // Cleanup.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  })().catch(err => {
    process.stderr.write('[smoke] FAIL: ' + err.message + '\n' + (err.stack || '') + '\n');
    process.exit(1);
  });
}
