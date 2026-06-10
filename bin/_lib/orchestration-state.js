'use strict';

/**
 * Shared constant and helper for the current-orchestration marker file.
 *
 * The path `.orchestray/audit/current-orchestration.json` was hardcoded in
 * 7+ hook scripts. Centralising it here means a single change propagates
 * everywhere (W8 fix).
 */

const fs   = require('fs');
const path = require('path');

/** Relative path from project root to the orchestration marker file. */
const CURRENT_ORCHESTRATION_FILE = path.join('.orchestray', 'audit', 'current-orchestration.json');

/**
 * Resolve the absolute path to the current-orchestration.json marker.
 *
 * @param {string} cwd - Absolute path to the project root (already validated).
 * @returns {string} Absolute path to the marker file.
 */
function getCurrentOrchestrationFile(cwd) {
  return path.join(cwd, CURRENT_ORCHESTRATION_FILE);
}

/** Absolute path to the live state directory. */
function getStateDir(cwd) {
  return path.join(cwd, '.orchestray', 'state');
}

/** Absolute path to the per-run task ledger directory. */
function getTasksDir(cwd) {
  return path.join(getStateDir(cwd), 'tasks');
}

/** Absolute path to the free-form orchestration.md state file. */
function getOrchestrationMdPath(cwd) {
  return path.join(getStateDir(cwd), 'orchestration.md');
}

/** Absolute path to the resilience dossier. */
function getDossierPath(cwd) {
  return path.join(getStateDir(cwd), 'resilience-dossier.json');
}

/**
 * C3 (v2.3.10): normalise the free-form orchestration.md status vocabulary to
 * the canonical dossier-schema enum.
 *
 * orchestration.md is hand-authored and has historically carried `complete`
 * (status) and `closed` (phase), neither of which is in the dossier schema
 * allowlist (`completed` for status, `complete` for phase). The mismatch made
 * `buildDossier` serialise status/phase to null, which defeated the injector's
 * `status === 'completed'` stale-skip (resilience F3). We accept the terminal
 * synonyms here so the canonical value reaches the schema.
 *
 * @param {string|null|undefined} status - Raw status value from frontmatter.
 * @returns {string|null} Canonical status, or the input unchanged when no map applies.
 */
function normalizeOrchStatus(status) {
  if (typeof status !== 'string' || status.length === 0) return status == null ? null : status;
  const v = status.trim().toLowerCase();
  // Terminal synonyms → canonical `completed`.
  if (v === 'complete' || v === 'closed' || v === 'done' || v === 'completed') return 'completed';
  return status;
}

/**
 * C3 (v2.3.10): normalise the free-form orchestration.md phase vocabulary to the
 * canonical dossier-schema phase enum. `closed` (a terminal marker authored in
 * orchestration.md) maps to the schema's terminal `complete` phase.
 *
 * @param {string|null|undefined} phase - Raw phase value from frontmatter.
 * @returns {string|null} Canonical phase, or the input unchanged when no map applies.
 */
function normalizeOrchPhase(phase) {
  if (typeof phase !== 'string' || phase.length === 0) return phase == null ? null : phase;
  const v = phase.trim().toLowerCase();
  if (v === 'closed' || v === 'complete' || v === 'completed' || v === 'done') return 'complete';
  return phase;
}

/**
 * C1 (v2.3.10): archive-then-clear the live task ledger + orchestration.md +
 * dossier for a finished/superseded run, so the NEXT run does not inherit stale
 * `pending_task_ids`. Never throws (best-effort, fail-open) — state hygiene must
 * not block init/complete.
 *
 * Files are MOVED into `.orchestray/history/<orchId>/state-snapshot/` (rename
 * where possible, copy+unlink across devices) so nothing is destroyed; only the
 * live path is emptied.
 *
 * @param {string} cwd     - Project root (absolute).
 * @param {string} orchId  - Orchestration id the snapshot is filed under.
 * @returns {{ archived: string[], cleared_tasks: number, errors: string[] }}
 */
function archiveAndClearLiveState(cwd, orchId) {
  const result = { archived: [], cleared_tasks: 0, errors: [] };
  const safeOrch = (typeof orchId === 'string' && /^[a-zA-Z0-9_.-]+$/.test(orchId))
    ? orchId
    : 'unknown';
  const snapshotDir = path.join(cwd, '.orchestray', 'history', safeOrch, 'state-snapshot');

  let snapshotReady = false;
  const ensureSnapshot = () => {
    if (snapshotReady) return true;
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      snapshotReady = true;
      return true;
    } catch (e) {
      result.errors.push(`mkdir snapshot: ${e.message}`);
      return false;
    }
  };

  // Move one file into the snapshot dir; fall back to copy+unlink across devices.
  const moveInto = (srcAbs, destName) => {
    if (!_safeExists(srcAbs)) return;
    if (!ensureSnapshot()) return;
    const dest = path.join(snapshotDir, destName);
    try {
      fs.renameSync(srcAbs, dest);
      result.archived.push(destName);
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        try {
          fs.copyFileSync(srcAbs, dest);
          fs.unlinkSync(srcAbs);
          result.archived.push(destName);
        } catch (e2) {
          result.errors.push(`move ${destName}: ${e2.message}`);
        }
      } else {
        result.errors.push(`move ${destName}: ${e.message}`);
      }
    }
  };

  // 1. Task ledger: archive each .md, then remove the (now-empty) live dir tree.
  const tasksDir = getTasksDir(cwd);
  try {
    if (_safeExists(tasksDir)) {
      const entries = fs.readdirSync(tasksDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const parent = entry.parentPath || entry.path;
        const full = path.join(parent, entry.name);
        const rel = path.relative(tasksDir, full).replace(/[\\/]/g, '__');
        moveInto(full, `tasks__${rel}`);
        result.cleared_tasks += 1;
      }
      // Remove the live tasks dir entirely so a glob-all walk finds nothing.
      try { fs.rmSync(tasksDir, { recursive: true, force: true }); } catch (e) {
        result.errors.push(`rm tasks dir: ${e.message}`);
      }
    }
  } catch (e) {
    result.errors.push(`scan tasks: ${e.message}`);
  }

  // 2. orchestration.md + dossier — archive and remove from the live path.
  moveInto(getOrchestrationMdPath(cwd), 'orchestration.md');
  moveInto(getDossierPath(cwd), 'resilience-dossier.json');

  return result;
}

/**
 * C4 (v2.3.10): prune orphaned per-run task ledgers / state-snapshot dirs older
 * than `maxAgeMs`. Used as a belt-and-suspenders sweep for live `state/tasks/`
 * leftovers that escaped init/complete cleanup. Never throws.
 *
 * @param {string} cwd       - Project root (absolute).
 * @param {number} maxAgeMs  - Files older than this (by mtime) are removed.
 * @returns {{ pruned: number, errors: string[] }}
 */
function pruneOrphanedTaskState(cwd, maxAgeMs) {
  const result = { pruned: 0, errors: [] };
  const tasksDir = getTasksDir(cwd);
  const cutoff = Date.now() - (Number.isFinite(maxAgeMs) ? maxAgeMs : 0);
  try {
    if (!_safeExists(tasksDir)) return result;
    const entries = fs.readdirSync(tasksDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent = entry.parentPath || entry.path;
      const full = path.join(parent, entry.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          result.pruned += 1;
        }
      } catch (e) {
        result.errors.push(`prune ${entry.name}: ${e.message}`);
      }
    }
  } catch (e) {
    result.errors.push(`scan tasks: ${e.message}`);
  }
  return result;
}

function _safeExists(p) {
  try { return fs.existsSync(p); } catch (_e) { return false; }
}

module.exports = {
  CURRENT_ORCHESTRATION_FILE,
  getCurrentOrchestrationFile,
  getStateDir,
  getTasksDir,
  getOrchestrationMdPath,
  getDossierPath,
  normalizeOrchStatus,
  normalizeOrchPhase,
  archiveAndClearLiveState,
  pruneOrphanedTaskState,
};
