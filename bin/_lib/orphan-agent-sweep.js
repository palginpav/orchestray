'use strict';

/**
 * orphan-agent-sweep.js — reconciles agent-registry rows stuck at `running`
 * with no terminal transition (v2.3.29 Fix C).
 *
 * Why this exists
 * ----------------
 * `reconciled_orphan` has been defined in `STATE_ORDER` (agent-registry.js)
 * since it was added but never written — see
 * `.orchestray/kb/artifacts/v2329-w3-turn-budget-diagnosis.md` Finding 4. A
 * subagent whose SubagentStop never fires (e.g. a role-scoped write-path
 * denial that leaves the process dark, as with agent_id a1e5674a142d82756)
 * sits at `running` forever, indistinguishable in the registry from an agent
 * that is still legitimately mid-task.
 *
 * Liveness heuristic — deliberately NOT the dirty-worktree sweep's 90s
 * -------------------------------------------------------------------
 * `dirty-worktree-sweep.js` uses QUIESCENCE_MS=90s because it watches a
 * single worktree's file mtimes at fine grain — any file touch resets the
 * clock. This sweep watches whether an *entire agent* has produced ANY
 * transcript activity at all. Real subagents commonly run 10-20+ minutes
 * between transcript-visible events during legitimate long single-turn
 * tool calls (a big grep, a slow build). Reusing 90s here would repeat the
 * exact mistake v2.3.28 fixed for worktrees — declaring a live agent dead.
 * ORPHAN_QUIESCENCE_MS=30 minutes: an order of magnitude larger, chosen so
 * that zero transcript writes for that long is a strong death signal, not
 * a slow-turn false positive.
 *
 * v2.3.29 follow-up (W5R) — `row.transcript_path` is always null in production
 * ------------------------------------------------------------------------
 * The first cut of this sweep required `row.transcript_path` (populated at
 * `register-agent-spawn.js`'s SubagentStart handler from
 * `event.agent_transcript_path`) as its ONLY corroborating liveness signal,
 * and skipped every row when it was absent. Measured against the live
 * registry: 0 of 13 `running` rows carry a `transcript_path` — including a
 * row written by THIS module's own current session, moments after start.
 * `event.agent_transcript_path` is simply not populated on the SubagentStart
 * hook payload in practice (verified by direct probe, not assumption). The
 * dual-signal guard was therefore rejecting every candidate by construction:
 * the row it exists to reconcile is exactly the row it can never see.
 *
 * `subagent-janitor.js`'s `runJanitor` already solves the same problem for
 * the context-telemetry cache by deriving the transcript path deterministically
 * instead of trusting the event field:
 *   <homedir>/.claude/projects/-<encoded-cwd>/<session_id>/subagents/agent-<agent_id>.jsonl
 * That derivation was confirmed live: it resolves to a real, correctly-aged
 * file both for an active agent (this session) and for the stranded orphan
 * agent_id a1e5674a142d82756 this fix targets. `deriveTranscriptPath` below
 * reuses that exact formula as the PRIMARY liveness signal, falling back to
 * `row.transcript_path` first (in case some future/other write path ever
 * populates it directly — cheaper than a stat call).
 *
 * What's traded away — no-transcript fallback
 * ---------------------------------------------
 * If NEITHER `row.transcript_path` nor the derived path stats successfully
 * (transcript file never created at all, e.g. the agent died before Claude
 * Code created it, or the local `~/.claude/projects` layout is unavailable),
 * there is still no corroborating signal. Rather than skip forever (the
 * original bug's failure mode), the sweep falls back to the registry row's
 * own timestamp alone, but requires `ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS`
 * (3x `ORPHAN_QUIESCENCE_MS`, 90 minutes) of staleness before acting. This
 * explicitly trades safety margin (no second signal to catch a slow-but-alive
 * agent) for the ability to fire at all — the weakest of the documented
 * candidate approaches, used only when the stronger transcript-based checks
 * both come back empty.
 *
 * Design constraints (from the v2.3.29 task brief)
 * -------------------------------------------------
 * - Never mark a live agent orphaned: requires BOTH the registry `running`
 *   row's own age AND a transcript-derived mtime to be past threshold when a
 *   transcript signal is available at all; fails toward "not quiescent"
 *   (skip) when a signal claims freshness — same policy `newestMtimeMs`
 *   documents in dirty-worktree-sweep.js.
 * - Reconciled rows record cost/turns as `null` (unavailable), never
 *   inferred or zeroed — a stranded agent's real usage was never captured.
 * - Historical rows are never rewritten; this only appends a new transition.
 *
 * Fail-open contract: every error path is swallowed. This module (and its
 * hook caller) must never throw past its own boundary or block PM Stop.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { writeEvent }     = require('./audit-event-writer');
const { readRegistry, appendTransition } = require('./agent-registry');
const { encodeProjectPath } = require('./path-containment');

const ORPHAN_QUIESCENCE_MS  = 30 * 60 * 1000; // 30 min — see header note above
const ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS = ORPHAN_QUIESCENCE_MS * 3; // 90 min — registry-timestamp-only fallback, see header note
const MIN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;  // 5 min debounce between full sweeps

/** @param {string} msg */
function logStderr(msg) {
  try { process.stderr.write('[orchestray/orphan-agent-sweep] ' + msg + '\n'); } catch (_e) {}
}

/** @param {string} projectRoot @returns {string} */
function statePath(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'state', 'orphan-agent-sweep.json');
}

/** @param {string} projectRoot @returns {{last_sweep_ts:number}} */
function readSweepState(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8'));
    if (parsed && typeof parsed.last_sweep_ts === 'number') return parsed;
  } catch (_e) { /* no state yet, or corrupt — treat as never swept */ }
  return { last_sweep_ts: 0 };
}

/** @param {string} projectRoot @param {number} nowMs */
function writeSweepState(projectRoot, nowMs) {
  try {
    fs.mkdirSync(path.dirname(statePath(projectRoot)), { recursive: true });
    fs.writeFileSync(statePath(projectRoot), JSON.stringify({ last_sweep_ts: nowMs }) + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }
}

/**
 * Transcript file mtime in ms, or null if it can't be stat'd (fails toward
 * "not quiescent" — caller must treat null as "unknown, skip this row").
 * @param {string|null} transcriptPath
 * @returns {number|null}
 */
function transcriptMtimeMs(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch (_e) {
    return null;
  }
}

/**
 * Deterministically derive the path Claude Code writes a subagent's
 * transcript to, matching the formula `subagent-janitor.js`'s `runJanitor`
 * already relies on for cache recovery. Used because `event.agent_transcript_path`
 * (the value `row.transcript_path` would otherwise carry) is not populated on
 * the real SubagentStart hook payload in production — see header note.
 *
 * @param {string} homeDir     - Overridable for tests; defaults to os.homedir() by caller.
 * @param {string} projectRoot
 * @param {string|null} sessionId
 * @param {string|null} agentId
 * @returns {string|null}
 */
function deriveTranscriptPath(homeDir, projectRoot, sessionId, agentId) {
  if (!sessionId || !agentId) return null;
  try {
    return path.join(homeDir, '.claude', 'projects',
      '-' + encodeProjectPath(projectRoot), sessionId, 'subagents', 'agent-' + agentId + '.jsonl');
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve the best available liveness mtime for a `running` row, in priority
 * order: explicit `row.transcript_path` (cheap, in case some future writer
 * populates it directly) → derived transcript path (the real-world signal —
 * see header note) → null (no transcript signal at all).
 *
 * @param {string} homeDir
 * @param {string} projectRoot
 * @param {object} row
 * @returns {{mtime: number|null, source: string}}
 */
function resolveLivenessMtimeMs(homeDir, projectRoot, row) {
  let mtime = transcriptMtimeMs(row.transcript_path);
  if (mtime !== null) return { mtime, source: 'transcript_path' };

  const derived = deriveTranscriptPath(homeDir, projectRoot, row.session_id, row.agent_id);
  mtime = transcriptMtimeMs(derived);
  if (mtime !== null) return { mtime, source: 'derived_transcript_path' };

  return { mtime: null, source: 'none' };
}

/**
 * @param {string} projectRoot
 * @param {{nowMs?: number, force?: boolean, homeDir?: string, transcriptRoot?: string}} [opts]
 *   force bypasses the debounce; homeDir overrides os.homedir(); transcriptRoot overrides
 *   the project root used ONLY for `deriveTranscriptPath`'s encoded-cwd component (tests /
 *   read-only verification against a copied registry that lives outside the real project
 *   root — defaults to `projectRoot`, i.e. normal production behavior).
 * @returns {{ran: boolean, scanned: number, reconciled: number, elapsedMs: number}}
 */
function sweepOrphanedAgents(projectRoot, opts) {
  opts = opts || {};
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const homeDir = opts.homeDir || os.homedir();
  const transcriptRoot = opts.transcriptRoot || projectRoot;
  const startedAt = Date.now();
  const EMPTY = { ran: false, scanned: 0, reconciled: 0, elapsedMs: 0 };

  const state = readSweepState(projectRoot);
  if (!opts.force && (nowMs - state.last_sweep_ts) < MIN_SWEEP_INTERVAL_MS) {
    return Object.assign({}, EMPTY, { elapsedMs: Date.now() - startedAt });
  }
  writeSweepState(projectRoot, nowMs);

  const { byId } = readRegistry(projectRoot, {});
  let scanned = 0;
  let reconciled = 0;

  for (const row of byId.values()) {
    if (!row || row.event !== 'running') continue; // only genuinely-stuck rows
    scanned++;

    const rowTs = row.ts ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(rowTs) || (nowMs - rowTs) < ORPHAN_QUIESCENCE_MS) continue; // registry row itself too fresh

    const liveness = resolveLivenessMtimeMs(homeDir, transcriptRoot, row);
    if (liveness.mtime !== null) {
      if ((nowMs - liveness.mtime) < ORPHAN_QUIESCENCE_MS) continue; // transcript still being written — agent may be alive
    } else {
      // No transcript signal at all (row + derived path both absent/unstat-able).
      // Fall back to registry-timestamp-only, requiring a much longer window
      // to compensate for the lost corroborating signal — see header note.
      if ((nowMs - rowTs) < ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS) continue;
    }

    const ok = appendTransition(projectRoot, {
      event: 'reconciled_orphan',
      orchestration_id: row.orchestration_id || null,
      agent_id: row.agent_id,
      roster_name: row.roster_name || null,
      agent_type: row.agent_type || null,
      task_id: row.task_id || null,
      model: row.model || null,
      effort: row.effort || null,
      session_id: row.session_id || null,
      spawn_key: row.spawn_key || null,
      spawn_tool: row.spawn_tool || null,
      description: row.description || null,
      // Never captured for a stranded agent — unavailable, not zero/inferred.
      turns_used: null,
      estimated_cost_usd: null,
      transcript_path: row.transcript_path || null,
      result_status: 'unavailable_orphaned',
      hold_for_resume: null,
      resume_count: row.resume_count || 0,
      reason: 'no terminal transition for ' + Math.round((nowMs - rowTs) / 1000) + 's; liveness signal=' + liveness.source +
        (liveness.mtime !== null
          ? ' quiescent for ' + Math.round((nowMs - liveness.mtime) / 1000) + 's (threshold ' + Math.round(ORPHAN_QUIESCENCE_MS / 1000) + 's)'
          : ' unavailable — registry-timestamp-only fallback (threshold ' + Math.round(ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS / 1000) + 's)'),
    });

    if (ok) {
      reconciled++;
      logStderr('reconciled orphan agent_id=' + row.agent_id + ' (orch=' + (row.orchestration_id || 'unknown') + ')');
      try {
        writeEvent({
          type: 'agent_orphan_reconciled',
          schema_version: 1,
          orchestration_id: row.orchestration_id || null,
          agent_id: row.agent_id,
          agent_type: row.agent_type || null,
          task_id: row.task_id || null,
          registry_age_seconds: Math.round((nowMs - rowTs) / 1000),
          liveness_signal: liveness.source,
          transcript_quiescent_seconds: liveness.mtime !== null ? Math.round((nowMs - liveness.mtime) / 1000) : null,
        }, { cwd: projectRoot });
      } catch (_e) { /* fail-open */ }
    }
  }

  return { ran: true, scanned, reconciled, elapsedMs: Date.now() - startedAt };
}

module.exports = {
  sweepOrphanedAgents,
  transcriptMtimeMs,
  deriveTranscriptPath,
  resolveLivenessMtimeMs,
  ORPHAN_QUIESCENCE_MS,
  ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS,
  MIN_SWEEP_INTERVAL_MS,
};
