'use strict';

/**
 * dirty-worktree-sweep.js — core logic for the PM-Stop dirty-worktree sweep
 * (V3, v2.3.27).
 *
 * Why this exists
 * ----------------
 * `auto-commit-worktree-on-subagent-stop.js` (W1, v2.2.18) only fires on a
 * *clean* SubagentStop. When a subagent transcript ends mid tool-call (an
 * abrupt kill), SubagentStop never fires and that hook — along with every
 * other SubagentStop-gated safety net — never runs. Work survives on disk in
 * the worktree but is invisible to git history and to `worktree-remove.js`'s
 * own re-verification, until something else notices.
 *
 * This module hangs the same capture net off a trigger that DID fire
 * reliably through the incident that motivated it: the PM's own `Stop`
 * hook. It is deliberately independent of SubagentStop.
 *
 * Liveness heuristic
 * -------------------
 * There is no PID/session registry naming which agent still owns a given
 * worktree (checked: no such registry exists in this codebase as of
 * v2.3.27). The proxy used here is quiescence: the newest mtime among a
 * worktree's changed paths (`git status --porcelain` output, stat'd
 * individually). If nothing in the worktree has been touched in
 * `QUIESCENCE_MS`, the owning process is assumed to be gone (finished,
 * killed, or orphaned) — captured. If a file was touched more recently than
 * that, an agent may still be mid-edit; skip this turn and let a later sweep
 * (or the ordinary SubagentStop hook, if it still fires) pick it up.
 *
 * Cheap-by-construction, not by caching
 * ---------------------------------------
 * A per-worktree `git status --porcelain` is unavoidable to know whether
 * there is anything to capture. What is avoidable is doing it needlessly
 * often: a `MIN_SWEEP_INTERVAL_MS` debounce (state file) bounds sweeps to at
 * most once per interval regardless of how often PM Stop fires. Once a
 * worktree is captured its status naturally goes clean, so re-scanning it on
 * a later sweep is a single fast `git status` call that finds nothing and
 * writes nothing — no separate "already handled" bookkeeping is needed for
 * the not-spam requirement; git's own state is the source of truth.
 *
 * Fail-open contract: every error path is swallowed. This module (and its
 * hook caller) must never throw past its own boundary or block PM Stop.
 */

const fs            = require('node:fs');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeEvent }                  = require('./audit-event-writer');
const { getCurrentOrchestrationFile } = require('./orchestration-state');

const QUIESCENCE_MS          = 90 * 1000;       // 90s — see header note above
const MIN_SWEEP_INTERVAL_MS  = 15 * 1000;       // 15s debounce between full sweeps
const GIT_TIMEOUT_MS         = 8000;

/** @param {string} msg */
function logStderr(msg) {
  try { process.stderr.write('[orchestray/dirty-worktree-sweep] ' + msg + '\n'); } catch (_e) {}
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e && e.message ? e.message : e) };
  }
}

/**
 * `git status --porcelain` variant that trims only the trailing newline, not
 * leading whitespace. `porcelain` status codes for an unstaged tracked
 * modification carry a LEADING space (` M path`) that `git()`'s blanket
 * `.trim()` would strip off the first line, corrupting the 3-char
 * code-prefix slice every caller relies on to recover the bare path. Only
 * matters for the status call itself — `add`/`commit`/`rev-parse` output has
 * no such leading-space-significant first line, so `git()` above is fine
 * for those.
 * @param {string} cwd
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function gitStatusPorcelain(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return { status: r.status, stdout: (r.stdout || '').replace(/[\r\n]+$/, ''), stderr: (r.stderr || '').trim() };
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e && e.message ? e.message : e) };
  }
}

/** @param {string} statusOutput @returns {number} */
function countChangedFiles(statusOutput) {
  return statusOutput.split('\n').filter((l) => l.trim().length > 0).length;
}

/**
 * Parse `git status --porcelain` into relative paths (strips the 2-char
 * status code). Covers both tracked modifications and untracked (`??`) files.
 * @param {string} statusOutput
 * @returns {string[]}
 */
function changedPaths(statusOutput) {
  return statusOutput
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3).trim())
    .filter((l) => l.length > 0);
}

/**
 * Newest mtime (ms) among the given worktree-relative paths. Missing/
 * unreadable paths are skipped (e.g. a deleted-but-still-listed path).
 * Returns null if no path could be stat'd (fails toward "not quiescent" —
 * caller should treat null as "unknown, skip this turn" rather than capture
 * blind).
 * @param {string} worktreePath
 * @param {string[]} paths
 * @returns {number|null}
 */
function newestMtimeMs(worktreePath, paths) {
  let newest = null;
  for (const rel of paths) {
    try {
      const st = fs.statSync(path.join(worktreePath, rel));
      const m = st.mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch (_e) { /* path gone or unreadable — skip */ }
  }
  return newest;
}

/**
 * List immediate subdirectories of `<projectRoot>/.claude/worktrees`.
 * @param {string} projectRoot
 * @returns {{name: string, path: string}[]}
 */
function listWorktreeDirs(projectRoot) {
  const parent = path.join(projectRoot, '.claude', 'worktrees');
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(parent, e.name) }));
}

/**
 * Read orchestration_id from `.orchestray/audit/current-orchestration.json`
 * relative to a given cwd (best-effort).
 * @param {string} cwd
 * @returns {string}
 */
function readOrchestrationId(cwd) {
  try {
    const file = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.orchestration_id === 'string' && data.orchestration_id.length > 0) {
      return data.orchestration_id;
    }
  } catch (_e) { /* fail-open */ }
  return 'unknown';
}

/**
 * Commit all changes in a dirty worktree. Shared commit core so the sweep
 * doesn't duplicate the git add/commit sequence already proven by
 * `auto-commit-worktree-on-subagent-stop.js` (that script is untouched —
 * this is a fresh, independent implementation of the same two-step
 * sequence, not a shared function call into it, since that script has no
 * exported API surface).
 * @param {string} worktreePath
 * @param {string} commitMsg
 * @returns {{ok: boolean, commitSha: string|null, stderrExcerpt: string}}
 */
function commitWorktree(worktreePath, commitMsg) {
  const addResult = git(worktreePath, ['add', '-A']);
  if (addResult.status !== 0) {
    logStderr('git add -A failed (exit ' + addResult.status + '): ' + addResult.stderr.slice(0, 200));
    // Continue anyway — commit may still succeed for already-staged files.
  }

  const commitResult = spawnSync(
    'git',
    ['-C', worktreePath, '-c', 'user.email=orchestray@local', '-c', 'user.name=orchestray-auto-commit', 'commit', '-m', commitMsg],
    { encoding: 'utf8', timeout: GIT_TIMEOUT_MS },
  );

  if (commitResult.status !== 0) {
    return { ok: false, commitSha: null, stderrExcerpt: (commitResult.stderr || '').slice(0, 200) };
  }

  const sha = git(worktreePath, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, commitSha: sha.status === 0 ? sha.stdout : 'unknown', stderrExcerpt: '' };
}

// ---------------------------------------------------------------------------
// Debounce state
// ---------------------------------------------------------------------------

/** @param {string} projectRoot @returns {string} */
function statePath(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'state', 'dirty-worktree-sweep.json');
}

/**
 * @param {string} projectRoot
 * @returns {{last_sweep_ts: number}}
 */
function readSweepState(projectRoot) {
  try {
    const raw = fs.readFileSync(statePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.last_sweep_ts === 'number') return parsed;
  } catch (_e) { /* no state yet, or corrupt — treat as never swept */ }
  return { last_sweep_ts: 0 };
}

/**
 * @param {string} projectRoot
 * @param {number} nowMs
 */
function writeSweepState(projectRoot, nowMs) {
  try {
    const dir = path.dirname(statePath(projectRoot));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath(projectRoot), JSON.stringify({ last_sweep_ts: nowMs }) + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// M2 — worktree-meta staleness check
// ---------------------------------------------------------------------------

/**
 * Compare a worktree's recorded creation-time main-tree HEAD (written by
 * `worktree-create.js`, P2/W15) against the CURRENT main-tree HEAD. Emits
 * `worktree_head_stale` (suffix `_stale`, already a TIER3 diagnostic suffix
 * in `bin/_lib/recent-diagnostics.js` — no changes needed there or in
 * `dark-event-banner.js` for this to reach the banner surface) when they
 * diverge.
 *
 * @param {string} projectRoot
 * @param {string} agentName
 * @param {string} currentMainHead
 * @returns {boolean} true if a stale event was emitted
 */
function checkAndEmitStaleness(projectRoot, agentName, currentMainHead) {
  const metaPath = path.join(projectRoot, '.orchestray', 'state', 'worktree-meta', agentName + '.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (_e) {
    return false; // no baseline recorded — nothing to compare
  }
  if (!meta || typeof meta.main_tree_head_at_creation !== 'string' || !meta.main_tree_head_at_creation) {
    return false;
  }
  if (!currentMainHead || meta.main_tree_head_at_creation === currentMainHead) {
    return false; // not diverged
  }

  try {
    writeEvent(
      {
        type:                          'worktree_head_stale',
        schema_version:                1,
        agent_name:                    agentName,
        worktree_path:                 meta.worktree_path || null,
        main_tree_head_at_creation:    meta.main_tree_head_at_creation,
        main_tree_head_current:        currentMainHead,
        created_at:                    meta.created_at || null,
      },
      { cwd: projectRoot },
    );
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

/**
 * @param {string} projectRoot
 * @param {{nowMs?: number, force?: boolean}} [opts] force bypasses the
 *   debounce (tests only).
 * @returns {{
 *   ran: boolean,
 *   scanned: number,
 *   captured: number,
 *   captureFailed: number,
 *   staleDetected: number,
 *   elapsedMs: number,
 * }}
 */
function sweepDirtyWorktrees(projectRoot, opts) {
  const nowMs = (opts && typeof opts.nowMs === 'number') ? opts.nowMs : Date.now();
  const startedAt = Date.now();
  const EMPTY = { ran: false, scanned: 0, captured: 0, captureFailed: 0, staleDetected: 0, elapsedMs: 0 };

  const state = readSweepState(projectRoot);
  if (!(opts && opts.force) && (nowMs - state.last_sweep_ts) < MIN_SWEEP_INTERVAL_MS) {
    return Object.assign({}, EMPTY, { elapsedMs: Date.now() - startedAt });
  }

  const dirs = listWorktreeDirs(projectRoot);
  writeSweepState(projectRoot, nowMs);

  if (dirs.length === 0) {
    return Object.assign({}, EMPTY, { ran: true, elapsedMs: Date.now() - startedAt });
  }

  // Current main HEAD — computed once, reused for every worktree's M2 check.
  const headResult = git(projectRoot, ['rev-parse', 'HEAD']);
  const currentMainHead = headResult.status === 0 ? headResult.stdout : null;

  let captured = 0;
  let captureFailed = 0;
  let staleDetected = 0;

  for (const dir of dirs) {
    const statusResult = gitStatusPorcelain(dir.path);
    if (statusResult.status !== 0) continue; // unreadable — skip, don't guess

    if (statusResult.stdout) {
      const paths = changedPaths(statusResult.stdout);
      const newest = newestMtimeMs(dir.path, paths);
      const quiescent = newest !== null && (nowMs - newest) >= QUIESCENCE_MS;

      if (quiescent) {
        const filesChangedCount = countChangedFiles(statusResult.stdout);
        const orchestrationId = readOrchestrationId(dir.path);
        const commitMsg = [
          'wip(auto): dirty-worktree sweep captured orphaned edits',
          '',
          'Worktree: ' + dir.name,
          'Orchestration: ' + orchestrationId,
          'Files: ' + filesChangedCount + ' changed',
          'Generated-By: orchestray-dirty-worktree-sweep',
        ].join('\n');

        const result = commitWorktree(dir.path, commitMsg);
        if (result.ok) {
          captured++;
          logStderr('captured ' + filesChangedCount + ' file(s) as ' + result.commitSha + ' in worktree ' + dir.name);
          try {
            writeEvent(
              {
                type:                'dirty_worktree_captured',
                schema_version:      1,
                agent_name:          dir.name,
                worktree_path:       dir.path,
                orchestration_id:    orchestrationId,
                files_changed_count: filesChangedCount,
                commit_sha:          result.commitSha,
              },
              { cwd: projectRoot },
            );
          } catch (_e) { /* fail-open */ }
        } else {
          captureFailed++;
          logStderr('capture commit failed in ' + dir.name + ': ' + result.stderrExcerpt);
          try {
            writeEvent(
              {
                type:              'dirty_worktree_capture_failed',
                schema_version:    1,
                agent_name:        dir.name,
                worktree_path:     dir.path,
                orchestration_id:  orchestrationId,
                stderr_excerpt:    result.stderrExcerpt,
              },
              { cwd: projectRoot },
            );
          } catch (_e) { /* fail-open */ }
        }
      }
      // Not quiescent — an agent may still be mid-edit; skip this turn.
    }

    // M2 — independent of capture outcome above; a worktree can be both
    // clean AND stale (agent finished normally, main advanced since).
    if (checkAndEmitStaleness(projectRoot, dir.name, currentMainHead)) {
      staleDetected++;
    }
  }

  return {
    ran: true,
    scanned: dirs.length,
    captured,
    captureFailed,
    staleDetected,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = {
  sweepDirtyWorktrees,
  listWorktreeDirs,
  changedPaths,
  newestMtimeMs,
  checkAndEmitStaleness,
  commitWorktree,
  git,
  gitStatusPorcelain,
  QUIESCENCE_MS,
  MIN_SWEEP_INTERVAL_MS,
};
