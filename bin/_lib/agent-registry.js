'use strict';

/**
 * agent-registry.js — append/fold semantics for the agent lifecycle registry.
 *
 * `.orchestray/state/agent-registry.jsonl` is an append-only transition log,
 * folded on read. See `.orchestray/kb/artifacts/v2326-lifecycle-design.md`
 * §3 for the full design. This module implements only the W2 (registry) and
 * W4 (model attribution) surface — `holdForResume` / `isResumable` (W3/W8/W9)
 * are NOT implemented here; they are out of scope for this change and gated
 * on a hook-firing smoke probe that has not run yet.
 *
 * Why append-only, not a mutable JSON document: parallel spawns write
 * concurrently (five SubagentStart events inside one second is normal in
 * this repo). A read-modify-write under an advisory lock can silently drop
 * a write on lock contention (see context-telemetry.json's fail-open
 * contract). `atomicAppendJsonl` is O_APPEND-safe and loses nothing.
 *
 * Fail-open contract: `appendTransition` never throws (returns false on
 * error). `readRegistry` never throws (returns an empty fold on error).
 */

const fs = require('fs');
const path = require('path');

const { appendJsonlWithRotation } = require('./jsonl-rotate');
const { atomicWriteFile, _withAdvisoryLock } = require('./atomic-append');

const REGISTRY_MAX_BYTES = 5 * 1024 * 1024;
const REGISTRY_MAX_GENERATIONS = 3;

// Terminal states — a row in one of these will never legally transition again
// except the single documented back-edge completed -> resumed (handled by
// the fold's monotonicity check, not enforced here since resume writers are
// out of this change's scope).
const TERMINAL_STATES = new Set(['dismissed', 'abandoned']);

// Lattice order used to reject illegal back-edges at fold time. Higher index
// = later in the lifecycle. `resumed` is a legal back-edge FROM `completed`
// only (handled specially below).
const STATE_ORDER = {
  registered: 0,
  running: 1,
  completed: 2,
  resumed: 2, // same rank as completed — completed<->resumed is the one legal cycle
  dismissed: 3,
  abandoned: 3,
  dismiss_failed: 3,
  reconciled_orphan: 3,
};

/**
 * @param {string} cwd
 * @returns {string} absolute path to the registry JSONL file
 */
function registryPath(cwd) {
  return path.join(cwd, '.orchestray', 'state', 'agent-registry.jsonl');
}

/**
 * Append one transition row. Fail-open: returns false on error, never throws.
 *
 * @param {string} cwd
 * @param {object} row - Partial row; `ts` and `schema_version` are filled if absent.
 * @returns {boolean}
 */
function appendTransition(cwd, row) {
  try {
    const filePath = registryPath(cwd);
    const filled = Object.assign(
      {
        ts: new Date().toISOString(),
        schema_version: 1,
      },
      row
    );
    appendJsonlWithRotation(filePath, filled, {
      maxSizeBytes: REGISTRY_MAX_BYTES,
      maxGenerations: REGISTRY_MAX_GENERATIONS,
    });
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Read up to maxBytes of the registry file and return parsed rows in file
 * order. Fail-open: malformed lines are skipped, missing file yields [].
 *
 * @param {string} cwd
 * @returns {object[]}
 */
function readRawRows(cwd) {
  const filePath = registryPath(cwd);
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch (_e) {
      // Malformed line — skip silently (fail-open).
    }
  }
  return rows;
}

const PENDING_ABANDON_MS = 10 * 60 * 1000;

/**
 * Fold the append-only log into current state.
 *
 * @param {string} cwd
 * @param {{orchestrationId?: string, sessionId?: string, includeTerminal?: boolean}} [opts]
 * @returns {{
 *   byId: Map<string, object>,
 *   pending: Map<string, object>,
 *   counts: {registered:number, running:number, completed:number, resumed:number, dismissed:number, abandoned:number}
 * }}
 */
function readRegistry(cwd, opts) {
  opts = opts || {};
  const byId = new Map();
  const pending = new Map();

  try {
    const rows = readRawRows(cwd);
    const nowMs = Date.now();

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (opts.orchestrationId && row.orchestration_id !== opts.orchestrationId) continue;
      if (opts.sessionId && row.session_id && row.session_id !== opts.sessionId) continue;

      if (!row.agent_id) {
        // `registered` row (or any row without an agent_id yet) — keyed by spawn_key.
        const key = row.spawn_key || null;
        if (key) pending.set(key, row);
        continue;
      }

      const existing = byId.get(row.agent_id);
      if (!existing) {
        byId.set(row.agent_id, row);
        // A `running` row can bind a pending `registered` row by spawn_key.
        if (row.event === 'running' && row.spawn_key && pending.has(row.spawn_key)) {
          pending.delete(row.spawn_key);
        }
        continue;
      }

      // Reject illegal back-edges: never move backwards in the lattice,
      // except the documented completed -> resumed -> completed cycle
      // (both ranked equally in STATE_ORDER, so that transition is allowed).
      const fromRank = STATE_ORDER[existing.event] !== undefined ? STATE_ORDER[existing.event] : -1;
      const toRank = STATE_ORDER[row.event] !== undefined ? STATE_ORDER[row.event] : -1;
      if (toRank < fromRank) {
        // Illegal transition — drop the row, keep existing state.
        continue;
      }

      // Merge: non-null fields on the later row overwrite; null never clobbers.
      const merged = Object.assign({}, existing);
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && v !== undefined) merged[k] = v;
      }
      byId.set(row.agent_id, merged);

      if (row.event === 'running' && row.spawn_key && pending.has(row.spawn_key)) {
        pending.delete(row.spawn_key);
      }
    }

    // Fold-time derivation: pending entries older than 10 minutes are
    // logically `abandoned` (spawn was denied by a gate, or the tool call
    // errored before SubagentStart). Not written back — just reflected in
    // the returned fold and counts.
    const counts = { registered: 0, running: 0, completed: 0, resumed: 0, dismissed: 0, abandoned: 0 };
    for (const [key, row] of pending.entries()) {
      const t = row.ts ? Date.parse(row.ts) : NaN;
      if (Number.isFinite(t) && (nowMs - t) > PENDING_ABANDON_MS) {
        counts.abandoned++;
        pending.delete(key);
      } else {
        counts.registered++;
      }
    }
    for (const row of byId.values()) {
      if (Object.prototype.hasOwnProperty.call(counts, row.event)) counts[row.event]++;
    }

    if (opts.includeTerminal === false) {
      for (const [id, row] of byId.entries()) {
        if (TERMINAL_STATES.has(row.event)) byId.delete(id);
      }
    }

    return { byId, pending, counts };
  } catch (_e) {
    return {
      byId: new Map(),
      pending: new Map(),
      counts: { registered: 0, running: 0, completed: 0, resumed: 0, dismissed: 0, abandoned: 0 },
    };
  }
}

const MATCH_TTL_MS = 5000;

/**
 * FIFO bind of a SubagentStart to a pending `registered` row.
 * Mirrors the existing proven rule from collect-context-telemetry.js /
 * audit-event.js (v2.1.17 W11): 5 s TTL, filter to the same agent_type when
 * any candidate matches, pick the oldest.
 *
 * @param {Map<string, object>} pending
 * @param {{agentType?: string|null, nowMs?: number}} ctx
 * @returns {object|null}
 */
function matchPendingSpawn(pending, ctx) {
  ctx = ctx || {};
  const nowMs = typeof ctx.nowMs === 'number' ? ctx.nowMs : Date.now();
  const agentType = ctx.agentType || null;

  const candidates = [];
  let hasTypeMatch = false;
  for (const [key, row] of pending.entries()) {
    const t = row.ts ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(t)) continue;
    if ((nowMs - t) > MATCH_TTL_MS) continue;
    candidates.push({ key, row, t });
    if (agentType && row.agent_type === agentType) hasTypeMatch = true;
  }

  let filtered = candidates;
  if (agentType && hasTypeMatch) {
    filtered = candidates.filter((c) => c.row.agent_type === agentType);
  }

  let oldest = null;
  for (const c of filtered) {
    if (!oldest || c.t < oldest.t) oldest = c;
  }
  return oldest ? oldest.row : null;
}

/**
 * roster_name derivation from agent_id, verified 211/211 on named starts
 * (design §3.2): named spawns produce `a<roster>-<16 hex>`; unnamed spawns
 * produce `a<16 hex>` with no roster name.
 *
 * @param {string|null} agentId
 * @returns {string|null}
 */
function deriveRosterName(agentId) {
  if (!agentId || typeof agentId !== 'string') return null;
  const m = agentId.match(/^a(.+)-([0-9a-f]{16})$/i);
  return m ? m[1] : null;
}

/**
 * roster_name || agent_id — the handle passed to TaskStop / SendMessage.
 *
 * @param {object} row
 * @returns {string|null}
 */
function dismissalHandle(row) {
  if (!row) return null;
  return row.roster_name || row.agent_id || null;
}

/**
 * Rewrite the registry file retaining rows whose agent is non-terminal, plus
 * any row newer than 7 days. Runs under the same advisory lock
 * `atomicAppendJsonl` takes, so it cannot interleave with an append.
 *
 * @param {string} cwd
 * @param {{maxRows?: number}} [opts]
 * @returns {{rowsBefore: number, rowsAfter: number}}
 */
function compact(cwd, opts) {
  opts = opts || {};
  const filePath = registryPath(cwd);
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  const result = _withAdvisoryLock(filePath + '.lock', function () {
    const rows = readRawRows(cwd);
    const rowsBefore = rows.length;
    if (opts.maxRows && rowsBefore <= opts.maxRows) {
      return { rowsBefore, rowsAfter: rowsBefore };
    }

    const nowMs = Date.now();
    // Determine terminal agent_ids from the fold so non-terminal rows survive.
    const { byId } = readRegistry(cwd, {});
    const nonTerminalIds = new Set();
    for (const [id, row] of byId.entries()) {
      if (!TERMINAL_STATES.has(row.event)) nonTerminalIds.add(id);
    }

    const retained = rows.filter((row) => {
      if (row.agent_id && nonTerminalIds.has(row.agent_id)) return true;
      const t = row.ts ? Date.parse(row.ts) : NaN;
      if (Number.isFinite(t) && (nowMs - t) <= SEVEN_DAYS_MS) return true;
      return false;
    });

    const content = retained.map((r) => JSON.stringify(r)).join('\n') + (retained.length ? '\n' : '');
    atomicWriteFile(filePath, content);
    return { rowsBefore, rowsAfter: retained.length };
  });

  if (!result || result.skipped) {
    return { rowsBefore: 0, rowsAfter: 0 };
  }
  return result;
}

module.exports = {
  registryPath,
  appendTransition,
  readRegistry,
  matchPendingSpawn,
  deriveRosterName,
  dismissalHandle,
  compact,
};
