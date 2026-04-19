'use strict';

/**
 * curator-tombstone.js — Tombstone infrastructure for the pattern curator.
 *
 * Responsibilities
 * ----------------
 *   1. Maintain `.orchestray/curator/tombstones.jsonl` as the active rolling
 *      window of the last N curator runs (N = curator.tombstone_retention_runs,
 *      default 3).
 *   2. On each new run start (`startRun`): if tombstones.jsonl contains rows
 *      from a prior run, extract the OLDEST run's rows into the archive dir, prune
 *      archives beyond the retention window, then begin accepting new rows.
 *   3. Provide rollback: `undoLast` reverses all actions from the most-recent run;
 *      `undoById` reverses a single action anywhere in the last N runs.
 *   4. All writes are atomic: write to `.tmp`, then `rename`.
 *
 * Tombstone schema (one JSON object per line)
 * -------------------------------------------
 * {
 *   "ts":                   "<ISO8601>",
 *   "orch_id":              "curator-<ISO-seconds-Z>",       // unique per run
 *   "action_id":            "<orch_id>-a<NN>",              // unique per action
 *   "action":               "promote" | "merge" | "deprecate" | "unshare",
 *   "inputs": [
 *     {
 *       "slug":             "<pattern-slug>",
 *       "path":             "<relative path>",
 *       "content_sha256":   "<hex>",
 *       "content_snapshot": "<full file content>"
 *     }
 *   ],
 *   "output": {
 *     "path":           "<destination path>",
 *     "action_summary": "<human-readable>"
 *   },
 *   "user_rollback_command": "/orchestray:learn undo <action_id>",
 *   "rolled_back_at":        null | "<ISO8601>",
 *   "rolled_back_by":        null | "undo-last" | "undo" | "clear-tombstones",
 *
 *   // Optional — v2.1.2+. Old tombstones without this field remain valid.
 *   // Consumers MUST treat this as possibly-absent and fall back to
 *   // output.action_summary for the human-readable summary when missing.
 *   "rationale": {
 *     "schema_version": 1,
 *     "one_line": "<short prose — same substance as action_summary>",
 *     "signals": {
 *       "confidence":         <number 0-1>,
 *       "decayed_confidence": <number 0-1>,
 *       "times_applied":      <integer>,
 *       "age_days":           <integer>,
 *       "category":           "<string>",
 *       "skip_penalty":       <number>,       // promote / deprecate
 *       "deprecation_score":  <number|null>,  // deprecate only
 *       "similarity_score":   <number|null>,  // merge only (Jaccard hat from H3 shortlist
 *                                              //   or LLM self-estimate on fallback path)
 *       // v2.1.4+: four similarity parameters recorded on every merge tombstone so
 *       // that future diff/reconcile logic can reproduce results.  Absent on v2.1.3
 *       // tombstones — consumers MUST treat all four fields as possibly-absent.
 *       "similarity_method":    <string|null>, // "minhash" (only valid value in v2.1.4)
 *       "similarity_threshold": <number|null>, // Jaccard threshold used (0.6)
 *       "similarity_k":         <number|null>, // shingle size (5)
 *       "similarity_m":         <number|null>  // MinHash permutations (128)
 *     },
 *     "guardrails_checked":        ["G3-...", ...],   // guardrail IDs checked
 *     "considered_alternatives":   ["..."],           // rejected alternatives (≤5)
 *     "adversarial_re_read":       { "passed": true, "missing": [], "contradicted": [] }, // merge only
 *     "notes":                     "<LLM-generated rationale, not a formal proof.>"
 *   }
 * }
 *
 * rationale rules (v2.1.2)
 * -------------------------
 * - rationale is OPTIONAL. All consumers must tolerate its absence.
 * - schema_version starts at 1. Readers encountering schema_version > 1 fields
 *   they do not recognise MUST ignore them (forward-compat).
 * - Size budget: ≤ 4 KB per action (soft advisory). If exceeded, truncate
 *   considered_alternatives first, then notes.
 * - Per-action shape:
 *     promote:    signals include confidence, decayed_confidence, times_applied,
 *                 age_days, category, skip_penalty. No deprecation_score,
 *                 similarity_score, or adversarial_re_read.
 *     merge:      all promote signals + similarity_score.
 *                 v2.1.4+: also similarity_method, similarity_threshold, similarity_k,
 *                 similarity_m (absent on v2.1.3 tombstones — additive, not required).
 *                 adversarial_re_read MUST be present and MUST report passed: true.
 *     deprecate:  all promote signals + deprecation_score.
 *                 considered_alternatives lists close-call patterns not deprecated.
 *     unshare:    rationale optional; if present, one_line alone is sufficient.
 *
 * Archive policy
 * --------------
 * Active file:  .orchestray/curator/tombstones.jsonl  (rolling N-run window)
 * Archive dir:  .orchestray/curator/tombstones-archive/<orch_id>.jsonl
 *
 * At startRun(), if tombstones.jsonl already contains rows AND the active file
 * has N distinct orch_ids, the oldest run's rows are moved to the archive dir.
 * Archives beyond the last (N-1) runs (i.e., older than the oldest run in the
 * new active window) are pruned. Discovery message emitted to stderr when pruned.
 *
 * Atomic writes
 * -------------
 * Every write goes through tmp → rename so a crash mid-write cannot produce a
 * partial tombstones.jsonl that corrupts the rollback path.
 *
 * No new npm dependencies. Uses only Node.js stdlib.
 *
 * B8 (v2.1.0) — see .orchestray/kb/artifacts/2100c-curator-design-v2.md §5.
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { loadCuratorConfig } = require('./config-schema.js');

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Return the project root from environment, cwd, or explicit override.
 * Tests can inject via the `projectRoot` option on each call.
 *
 * @param {string|null|undefined} projectRootOverride
 * @returns {string}
 */
function resolveProjectRoot(projectRootOverride) {
  if (projectRootOverride) return projectRootOverride;
  // Tests may set ORCHESTRAY_PROJECT_ROOT; production uses cwd.
  return process.env.ORCHESTRAY_PROJECT_ROOT || process.cwd();
}

/**
 * Return the .orchestray/curator/ directory, creating it if needed.
 *
 * @param {string} projectRoot
 * @returns {string} Absolute path.
 */
function getCuratorDir(projectRoot) {
  const dir = path.join(projectRoot, '.orchestray', 'curator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Return the archive sub-directory, creating it if needed.
 *
 * @param {string} curatorDir
 * @returns {string} Absolute path.
 */
function getArchiveDir(curatorDir) {
  const dir = path.join(curatorDir, 'tombstones-archive');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Active tombstones file path. */
function activePath(curatorDir) {
  return path.join(curatorDir, 'tombstones.jsonl');
}

/** Archive file path for a given run. */
function archivePath(archiveDir, orchId) {
  return path.join(archiveDir, orchId + '.jsonl');
}

// ---------------------------------------------------------------------------
// JSON-Lines helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-Lines file into an array of objects.
 * Returns [] if the file is absent or unreadable.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = raw.split('\n').filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines — tolerate partial writes on prior crashes.
    }
  }
  return rows;
}

/**
 * Write an array of objects as a JSON-Lines file atomically.
 * Write to `.tmp` then rename.
 *
 * @param {string} filePath
 * @param {object[]} rows
 */
function writeJsonlAtomic(filePath, rows) {
  const content = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Append a single object to a JSON-Lines file atomically.
 * Reads the existing file first, appends, then writes atomically.
 *
 * @param {string} filePath
 * @param {object} row
 */
function appendJsonlAtomic(filePath, row) {
  const existing = readJsonl(filePath);
  existing.push(row);
  writeJsonlAtomic(filePath, existing);
}

// ---------------------------------------------------------------------------
// Rollback helpers
// ---------------------------------------------------------------------------

/**
 * Reverse a single tombstone action by restoring the file content snapshot(s).
 * Tolerates tombstones whose output has already been removed (idempotent).
 *
 * Post-restore, unconditionally calls stripRecentlyCurated() on each restored
 * path (H4 v2.1.3). The snapshot is pre-action content; the stamp was written
 * post-snapshot. Restoring the snapshot already erases the stamp for merge/deprecate.
 * For promote, the snapshot may not contain the stamp (only the stamp was written),
 * so the explicit strip is belt-and-suspenders for that case.
 *
 * @param {object} tombstone - A single tombstone row.
 */
function applyRollback(tombstone) {
  if (!tombstone || !Array.isArray(tombstone.inputs)) return;

  // Lazy-require to avoid circular deps; safe because this module is loaded
  // after curator-recently-curated.js during normal operation.
  let stripRecentlyCurated;
  try {
    stripRecentlyCurated = require('./curator-recently-curated.js').stripRecentlyCurated;
  } catch (_) {
    stripRecentlyCurated = null;
  }

  for (const input of tombstone.inputs) {
    if (!input.path || input.content_snapshot === undefined) continue;
    // Resolve path: if relative, resolve from cwd. Tests should use absolute paths.
    const absPath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(input.path);

    // Ensure parent dir exists (e.g., pattern was in a dir that was deleted)
    const dir = path.dirname(absPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
      // Ignore — either already exists or unrecoverable.
    }

    const tmp = absPath + '.tombstone-restore.tmp';
    try {
      fs.writeFileSync(tmp, input.content_snapshot, 'utf8');
      fs.renameSync(tmp, absPath);
    } catch (err) {
      // Emit but do not throw — best-effort rollback.
      try {
        process.stderr.write(
          '[orchestray] curator-tombstone: rollback failed for ' + absPath +
          ': ' + (err && err.message) + '\n'
        );
      } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      continue; // skip strip if restore failed
    }

    // H4: strip recently_curated_* stamp from the restored file (belt-and-suspenders).
    // Rationale: snapshot is pre-action content; stamp was written post-snapshot.
    // Restoring naturally removes the stamp for merge/deprecate; for promote the
    // local file only received the stamp (no body change), so explicit strip needed.
    if (stripRecentlyCurated) {
      try { stripRecentlyCurated(absPath); } catch (_) { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Monotone counter to guarantee uniqueness when multiple runs start in the same millisecond. */
let _runIdCounter = 0;

/**
 * Generate a curator run ID based on the current ISO timestamp (millisecond precision)
 * plus a monotone counter suffix to guarantee uniqueness within the process.
 * Format: `curator-<ISO-ms>Z-<N>` (e.g., `curator-2026-04-17T15:30:00.123Z-1`)
 *
 * The counter suffix ensures two calls in the same millisecond produce distinct IDs.
 * The ISO prefix preserves the lexicographic ordering invariant undoLast() relies on.
 *
 * @returns {string}
 */
function generateRunId() {
  _runIdCounter += 1;
  return 'curator-' + new Date().toISOString() + '-' + _runIdCounter;
}

/**
 * Start a new curator run.
 *
 * Responsibilities:
 *   1. Load retention config (N).
 *   2. Read the current active tombstones.jsonl.
 *   3. If it contains rows from a prior run AND we have ≥ N distinct orch_ids,
 *      extract the oldest run's rows to the archive dir.
 *   4. Prune archive files for runs beyond the last (N-1) orch_ids.
 *   5. Return the new run's runId (a new unique orch_id for this run).
 *
 * @param {{ projectRoot?: string }} [options]
 * @returns {string} runId — unique ID for this curator run.
 */
function startRun(options) {
  const projectRoot = resolveProjectRoot(options && options.projectRoot);
  const curatorDir  = getCuratorDir(projectRoot);
  const archiveDir  = getArchiveDir(curatorDir);
  const activeFP    = activePath(curatorDir);

  // Load retention config.
  let retentionN = 3;
  try {
    const cfg = loadCuratorConfig(projectRoot);
    if (Number.isInteger(cfg.tombstone_retention_runs) && cfg.tombstone_retention_runs >= 1) {
      retentionN = cfg.tombstone_retention_runs;
    }
  } catch (_) {
    // Fall back to default.
  }

  // Read existing rows.
  const existing = readJsonl(activeFP);

  if (existing.length > 0) {
    // Collect distinct run IDs in insertion order.
    const orchIds = [];
    const seenIds = new Set();
    for (const row of existing) {
      if (row.orch_id && !seenIds.has(row.orch_id)) {
        seenIds.add(row.orch_id);
        orchIds.push(row.orch_id);
      }
    }

    // If we already have ≥ N distinct runs, archive the oldest and prune.
    if (orchIds.length >= retentionN) {
      const oldestId = orchIds[0];
      const oldestRows = existing.filter(r => r.orch_id === oldestId);
      const remainingRows = existing.filter(r => r.orch_id !== oldestId);

      // Write archive file for the oldest run.
      const archiveFP = archivePath(archiveDir, oldestId);
      try {
        writeJsonlAtomic(archiveFP, oldestRows);
      } catch (err) {
        try {
          process.stderr.write(
            '[orchestray] curator-tombstone: archive write failed for ' + oldestId +
            ': ' + (err && err.message) + '\n'
          );
        } catch (_) {}
      }

      // Rewrite active file without the oldest run's rows.
      writeJsonlAtomic(activeFP, remainingRows);

      // Prune archives older than the last (retentionN - 1) orch_ids (the ones
      // still in the active window after this archive).  The active window after
      // archiving contains orchIds[1..N-1] plus the new run we are about to start.
      // We keep archives for exactly orchIds[1..N-1]; orchIds[0] was just written
      // (keep it); anything older than orchIds[1] is purged.
      const keepIds = new Set(orchIds.slice(1)); // ids still in active window
      keepIds.add(oldestId); // we JUST archived this one — keep it

      let archiveFiles;
      try {
        archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
      } catch (_) {
        archiveFiles = [];
      }
      for (const archiveFile of archiveFiles) {
        const archiveRunId = archiveFile.replace(/\.jsonl$/, '');
        if (!keepIds.has(archiveRunId)) {
          // Prune this archive.
          try {
            fs.unlinkSync(path.join(archiveDir, archiveFile));
            process.stderr.write(
              '[orchestray] Archived curator run ' + archiveRunId + ' pruned. ' +
              'Recovery is manual: see `.orchestray/curator/tombstones-archive/` for historical runs.\n'
            );
          } catch (_) {
            // Best-effort.
          }
        }
      }
    }
  }

  return generateRunId();
}

/**
 * Write a single tombstone row for an in-progress curator run.
 *
 * Must be called AFTER the corresponding action succeeds (W1 ordering).
 * If the action failed, do not call writeTombstone — there is nothing to undo.
 *
 * @param {string} runId - Run ID from startRun().
 * @param {object} tombstone - Tombstone data (must include at least `action`, `inputs[]`, `slug`).
 * @param {{ projectRoot?: string }} [options]
 * @returns {string} action_id — unique ID for this specific action.
 */
function writeTombstone(runId, tombstone, options) {
  const projectRoot = resolveProjectRoot(options && options.projectRoot);
  const curatorDir  = getCuratorDir(projectRoot);
  const activeFP    = activePath(curatorDir);

  // Compute an action_id: count existing rows for this run and zero-pad a serial.
  const existing = readJsonl(activeFP);
  const runRows  = existing.filter(r => r.orch_id === runId);
  const serial   = String(runRows.length + 1).padStart(3, '0');
  const actionId = runId + '-a' + serial;

  const row = Object.assign(
    {
      ts:                   new Date().toISOString(),
      orch_id:              runId,
      action_id:            actionId,
      rolled_back_at:       null,
      rolled_back_by:       null,
      user_rollback_command: '/orchestray:learn undo ' + actionId,
    },
    tombstone,
    {
      // Ensure these are always set from our computed values, not caller overrides.
      orch_id:    runId,
      action_id:  actionId,
    }
  );

  appendJsonlAtomic(activeFP, row);

  return actionId;
}

/**
 * Reverse all actions from the most-recent curator run.
 *
 * Reads the active tombstones.jsonl, finds the highest orch_id (lexicographically
 * — the timestamp format ensures this equals the most-recent run), applies rollback
 * for each action in reverse order, marks each as rolled-back, then rewrites the
 * active file.
 *
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ runId: string, count: number }} Summary of what was reversed.
 */
function undoLast(options) {
  const projectRoot = resolveProjectRoot(options && options.projectRoot);
  const curatorDir  = getCuratorDir(projectRoot);
  const activeFP    = activePath(curatorDir);

  const rows = readJsonl(activeFP);
  if (rows.length === 0) {
    return { runId: null, count: 0 };
  }

  // Find the most-recent run (highest orch_id — lexicographic order works because
  // the format is curator-<ISO-seconds-Z> which is lexicographically monotone).
  const orchIds = Array.from(new Set(rows.map(r => r.orch_id).filter(Boolean)));
  orchIds.sort(); // ascending; most recent is last
  const latestOrchId = orchIds[orchIds.length - 1];

  const now = new Date().toISOString();
  let reversedCount = 0;

  // Reverse in reverse-insertion order for correctness (last action first).
  const runRows = rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.orch_id === latestOrchId && !row.rolled_back_at);

  for (let i = runRows.length - 1; i >= 0; i--) {
    const { row, idx } = runRows[i];
    applyRollback(row);
    rows[idx] = Object.assign({}, row, {
      rolled_back_at: now,
      rolled_back_by: 'undo-last',
    });
    reversedCount++;
  }

  writeJsonlAtomic(activeFP, rows);

  return { runId: latestOrchId, count: reversedCount };
}

/**
 * Reverse a single action by its action_id.
 *
 * Searches the active tombstones.jsonl and archive files for the last N runs.
 * When found, applies rollback and marks the tombstone as rolled-back (does NOT
 * delete it — redo support in v2.1.x requires the row to remain present).
 *
 * @param {string} actionId - The action_id to reverse (e.g., "curator-2026...Z-a001").
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ found: boolean, action_id: string, source: "active"|"archive"|null }}
 */
function undoById(actionId, options) {
  const projectRoot = resolveProjectRoot(options && options.projectRoot);
  const curatorDir  = getCuratorDir(projectRoot);
  const archiveDir  = getArchiveDir(curatorDir);
  const activeFP    = activePath(curatorDir);

  const now = new Date().toISOString();

  // Search active file first.
  const activeRows = readJsonl(activeFP);
  const activeIdx  = activeRows.findIndex(r => r.action_id === actionId);
  if (activeIdx !== -1) {
    const target = activeRows[activeIdx];
    if (!target.rolled_back_at) {
      applyRollback(target);
    }
    activeRows[activeIdx] = Object.assign({}, target, {
      rolled_back_at: now,
      rolled_back_by: 'undo',
    });
    writeJsonlAtomic(activeFP, activeRows);
    return { found: true, action_id: actionId, source: 'active' };
  }

  // Search archive files.
  let archiveFiles;
  try {
    archiveFiles = fs.readdirSync(archiveDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()        // ascending; most recent archive last
      .reverse();    // search most-recent archive first
  } catch (_) {
    archiveFiles = [];
  }

  for (const archiveFile of archiveFiles) {
    const archiveFP  = path.join(archiveDir, archiveFile);
    const archiveRows = readJsonl(archiveFP);
    const archiveIdx  = archiveRows.findIndex(r => r.action_id === actionId);
    if (archiveIdx !== -1) {
      const target = archiveRows[archiveIdx];
      if (!target.rolled_back_at) {
        applyRollback(target);
      }
      archiveRows[archiveIdx] = Object.assign({}, target, {
        rolled_back_at: now,
        rolled_back_by: 'undo',
      });
      writeJsonlAtomic(archiveFP, archiveRows);
      return { found: true, action_id: actionId, source: 'archive' };
    }
  }

  return { found: false, action_id: actionId, source: null };
}

/**
 * Remove all current tombstones (active + all archives).
 *
 * This is a hard reset of the rollback history. Callers should prompt for
 * interactive confirmation before invoking this.
 *
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ deleted_files: string[] }}
 */
function clearTombstones(options) {
  const projectRoot = resolveProjectRoot(options && options.projectRoot);
  const curatorDir  = getCuratorDir(projectRoot);
  const archiveDir  = getArchiveDir(curatorDir);
  const activeFP    = activePath(curatorDir);

  const deleted = [];

  // Delete active file.
  try {
    fs.unlinkSync(activeFP);
    deleted.push(activeFP);
  } catch (_) {
    // File may not exist — that's fine.
  }

  // Delete all archive files.
  let archiveFiles;
  try {
    archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
  } catch (_) {
    archiveFiles = [];
  }
  for (const archiveFile of archiveFiles) {
    const fp = path.join(archiveDir, archiveFile);
    try {
      fs.unlinkSync(fp);
      deleted.push(fp);
    } catch (_) {
      // Best-effort.
    }
  }

  return { deleted_files: deleted };
}

/**
 * List tombstones for display.
 *
 * @param {{ projectRoot?: string, include_archive?: boolean, only_run_id?: string }} [options]
 * @returns {{ rows: object[], run_ids: string[] }}
 */
function listTombstones(options) {
  const projectRoot   = resolveProjectRoot(options && options.projectRoot);
  const includeArchive = (options && options.include_archive) !== false; // default true
  const onlyRunId     = options && options.only_run_id;

  const curatorDir = getCuratorDir(projectRoot);
  const archiveDir = getArchiveDir(curatorDir);
  const activeFP   = activePath(curatorDir);

  let rows = readJsonl(activeFP);

  if (includeArchive) {
    let archiveFiles;
    try {
      archiveFiles = fs.readdirSync(archiveDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort();
    } catch (_) {
      archiveFiles = [];
    }
    for (const archiveFile of archiveFiles) {
      const archiveFP = path.join(archiveDir, archiveFile);
      rows = rows.concat(readJsonl(archiveFP));
    }
  }

  if (onlyRunId) {
    rows = rows.filter(r => r.orch_id === onlyRunId);
  }

  const runIds = Array.from(new Set(rows.map(r => r.orch_id).filter(Boolean)));
  runIds.sort();

  return { rows, run_ids: runIds };
}

module.exports = {
  generateRunId,
  startRun,
  writeTombstone,
  undoLast,
  undoById,
  clearTombstones,
  listTombstones,
  // Exported for tests.
  _internal: {
    readJsonl,
    writeJsonlAtomic,
    appendJsonlAtomic,
    activePath,
    archivePath,
    getCuratorDir,
    getArchiveDir,
  },
};
