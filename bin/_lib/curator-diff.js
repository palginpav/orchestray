'use strict';

/**
 * curator-diff.js — Dirty-set computation for `curate --diff` incremental mode (H6, v2.1.4).
 *
 * Design: .orchestray/kb/artifacts/v214-curate-diff-design.md
 *
 * A pattern is "dirty" (needs re-curation) if ANY of these signals fire:
 *   1. Stamp-absent  — never curated, or stamp was stripped (undo / share / manual edit).
 *   2. Body-hash drift — body changed since last stamp.
 *   3. Stale stamp — stamp.at older than diff_cutoff_days.
 *   4. Rollback-touched — pattern's action_id appears in a rolled-back tombstone in the active window.
 *   5. Merge-lineage uncertainty — pattern has merged_from: frontmatter but the tombstone
 *      window can no longer undo the merge (pruned from the active window).
 *
 * No mtime signals — see design §1 for rationale.
 *
 * No side effects on require. Export is a clean API.
 */

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const os     = require('node:os');

// ---------------------------------------------------------------------------
// Helpers: lazy-require to avoid circular deps at load time
// ---------------------------------------------------------------------------

function _fm() {
  return require('../mcp-server/lib/frontmatter.js');
}

function _recentlyCurated() {
  return require('./curator-recently-curated.js');
}

function _degradedJournal() {
  return require('./degraded-journal.js');
}

// ---------------------------------------------------------------------------
// computeBodyHash
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of the pattern body after stripping frontmatter.
 *
 * We hash the raw body bytes without any normalisation (see design §1
 * "edited-but-same-content" note — whitespace-only edits ARE real edits
 * from the operator's perspective).
 *
 * Frontmatter is excluded because stamp keys live there and change on every
 * curate — including them would make every pattern permanently dirty.
 *
 * @param {string} absPath
 * @returns {string|null}  sha256 hex, or null if unreadable
 */
function computeBodyHash(absPath) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const fm      = _fm();
    const parsed  = fm.parse(content);
    // If no frontmatter, hash the entire file content as the body.
    const body    = parsed.hasFrontmatter ? parsed.body : content;
    return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run counter (per-project, stored in ~/.orchestray/state/curator-diff-run-counter.json)
// ---------------------------------------------------------------------------

/**
 * Increment the per-project --diff run counter and return the post-increment value.
 * Writes atomically (tmp + rename). On any error, resets to 1 (treat as first run).
 *
 * @param {string} runCounterPath — absolute path to the counter JSON file
 * @returns {number}  post-increment run count
 */
function incrementRunCounter(runCounterPath) {
  try {
    fs.mkdirSync(path.dirname(runCounterPath), { recursive: true });
  } catch (_) {}

  let count = 0;
  try {
    const raw  = fs.readFileSync(runCounterPath, 'utf8');
    const data = JSON.parse(raw);
    if (Number.isInteger(data && data.run_count) && data.run_count >= 0) {
      count = data.run_count;
    }
    // On parse failure or unexpected type, count stays 0 — treated as no prior runs.
  } catch (_) {
    // File absent or unparseable — start from 0.
  }

  const next    = count + 1;
  const payload = JSON.stringify({ run_count: next });
  const tmp     = runCounterPath + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, runCounterPath);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_2) {}
    // Counter file write failed — still return the intended next value so
    // the run proceeds; next run will see stale count but that's harmless.
  }

  return next;
}

// ---------------------------------------------------------------------------
// collectRolledBackActionIds  — signal 4
// ---------------------------------------------------------------------------

/**
 * Collect all action_ids that are present in the active tombstones file AND
 * have been rolled back. These action_ids correspond to patterns that need
 * re-evaluation.
 *
 * @param {string} tombstonesPath  absolute path to tombstones.jsonl
 * @returns {Set<string>}  set of rolled-back action_ids
 */
function collectRolledBackActionIds(tombstonesPath) {
  const result = new Set();
  try {
    const raw   = fs.readFileSync(tombstonesPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && row.rolled_back_at && row.action_id) {
          result.add(String(row.action_id));
        }
      } catch (_) {
        // Malformed line — skip.
      }
    }
  } catch (_) {
    // Absent or unreadable tombstone file — no rolled-back ids.
  }
  return result;
}

// ---------------------------------------------------------------------------
// isPatternMergeLinage  — signal 5
// ---------------------------------------------------------------------------

/**
 * Returns true if the pattern's frontmatter contains a `merged_from` key,
 * indicating it was created by a merge operation.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
function isPatternMergeLineage(absPath) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const fm      = _fm();
    const parsed  = fm.parse(content);
    if (!parsed.hasFrontmatter) return false;
    const mf = parsed.frontmatter.merged_from;
    // merged_from present and non-null/non-empty indicates merge lineage.
    if (mf === null || mf === undefined || mf === '') return false;
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// isDirty — per-pattern dirty check
// ---------------------------------------------------------------------------

/**
 * Determine if a single pattern file is in the dirty set.
 *
 * @param {{
 *   absPath:          string,
 *   cutoffDays:       number,
 *   now:              Date,
 *   rolledBackIds:    Set<string>,
 * }} opts
 * @returns {{ dirty: boolean, reason: string }}
 *   reason is one of: "stamp_absent" | "body_hash_drift" | "stale_stamp" |
 *   "rollback_touched" | "merge_lineage" | "clean"
 */
function isDirty(opts) {
  const { absPath, cutoffDays, now, rolledBackIds } = opts;

  // Signal 1 & "corrupt stamp fallback": readStamp returns null if absent or partial.
  let stamp;
  try {
    stamp = _recentlyCurated().readStamp(absPath);
  } catch (_) {
    stamp = null;
  }

  if (stamp === null) {
    return { dirty: true, reason: 'stamp_absent' };
  }

  // Detect corrupt stamp: stamp object exists but key fields are missing/garbled.
  // Treat as stamp_absent (fail-open) and journal the event.
  const hasAt       = stamp.at && typeof stamp.at === 'string' && stamp.at.length > 0;
  const hasBodyHash = stamp.body_sha256 && typeof stamp.body_sha256 === 'string';

  if (!hasAt) {
    // Missing primary stamp key — corrupt.
    _journalCorrupt(absPath);
    return { dirty: true, reason: 'stamp_absent' };
  }

  // Signal 2: body-hash drift.
  if (hasBodyHash) {
    const currentHash = computeBodyHash(absPath);
    if (currentHash === null) {
      // Cannot compute hash — treat as dirty (fail-open).
      _journalHashFailed(absPath);
      return { dirty: true, reason: 'stamp_absent' };
    }
    if (currentHash !== stamp.body_sha256) {
      return { dirty: true, reason: 'body_hash_drift' };
    }
  } else {
    // No hash in stamp (pre-H6 stamp or partial) — treat as stamp_absent.
    _journalCorrupt(absPath);
    return { dirty: true, reason: 'stamp_absent' };
  }

  // Signal 3: stale stamp (age-based re-evaluation).
  if (cutoffDays > 0) {
    try {
      const stampMs  = new Date(stamp.at).getTime();
      const nowMs    = now.getTime();
      const ageDays  = (nowMs - stampMs) / (1000 * 60 * 60 * 24);
      if (!isNaN(ageDays) && ageDays > cutoffDays) {
        return { dirty: true, reason: 'stale_stamp' };
      }
    } catch (_) {
      // Malformed stamp.at — fall through to other checks.
    }
  }

  // Signal 4: rollback-touched (backstop for tombstone paths that strip stamp).
  // applyRollback already strips the stamp via stripRecentlyCurated, so signal (1)
  // catches this in practice. This check is a belt-and-suspenders backstop.
  if (rolledBackIds.size > 0 && stamp.action_id) {
    if (rolledBackIds.has(String(stamp.action_id))) {
      return { dirty: true, reason: 'rollback_touched' };
    }
  }

  // Signal 5: merge-lineage uncertainty.
  if (isPatternMergeLineage(absPath)) {
    return { dirty: true, reason: 'merge_lineage' };
  }

  return { dirty: false, reason: 'clean' };
}

// ---------------------------------------------------------------------------
// Degraded-journal helpers (fire-and-forget, never throw)
// ---------------------------------------------------------------------------

function _journalCorrupt(absPath) {
  try {
    const slug = path.basename(absPath, '.md');
    _degradedJournal().recordDegradation({
      kind:     'curator_diff_cursor_corrupt',
      severity: 'warn',
      detail:   { slug, dedup_key: 'curator_diff_cursor_corrupt|' + slug },
    });
  } catch (_) {}
}

function _journalHashFailed(absPath) {
  try {
    const slug = path.basename(absPath, '.md');
    _degradedJournal().recordDegradation({
      kind:     'curator_diff_hash_compute_failed',
      severity: 'warn',
      detail:   { slug, dedup_key: 'curator_diff_hash_compute_failed|' + slug },
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// computeDirtySet
// ---------------------------------------------------------------------------

// TODO(v2.1.5): promote to curator.diff_forced_full_every if telemetry justifies
const FORCED_FULL_SWEEP_EVERY = 10;

/**
 * Compute the dirty set for a --diff run.
 *
 * @param {{
 *   patternsDir:          string,    — absolute path to .orchestray/patterns/
 *   cutoffDays:           number,    — curator.diff_cutoff_days
 *   runCounterPath?:      string,    — path to run-counter file (default: ~/.orchestray/state/...)
 *   forceFull?:           boolean,   — override: treat all patterns as dirty
 *   activeTombstonesPath: string,    — absolute path to tombstones.jsonl
 *   now?:                 Date,      — override for tests; defaults to new Date()
 * }} opts
 * @returns {{
 *   dirty:        string[],    — absolute paths of dirty patterns
 *   clean:        string[],    — absolute paths of clean patterns
 *   corpus_size:  number,
 *   breakdown: {
 *     stamp_absent:     number,
 *     body_hash_drift:  number,
 *     stale_stamp:      number,
 *     rollback_touched: number,
 *     merge_lineage:    number,
 *     forced_full:      number,  // all files bucketed here on forced-full runs (signals not evaluated)
 *   },
 *   forced_full:  boolean,
 * }}
 */
function computeDirtySet(opts) {
  const {
    patternsDir,
    cutoffDays,
    activeTombstonesPath,
    forceFull: forcedFull = false,
    now: nowOverride,
  } = opts;

  const now = nowOverride || new Date();

  const dirty  = [];
  const clean  = [];
  const breakdown = {
    stamp_absent:     0,
    body_hash_drift:  0,
    stale_stamp:      0,
    rollback_touched: 0,
    merge_lineage:    0,
    forced_full:      0,
  };

  // Enumerate pattern files.
  let files = [];
  try {
    const entries = fs.readdirSync(patternsDir);
    files = entries
      .filter(e => e.endsWith('.md'))
      .map(e => path.join(patternsDir, e));
  } catch (_) {
    // Empty or non-existent patterns dir — return empty result.
    return { dirty: [], clean: [], corpus_size: 0, breakdown, forced_full: false };
  }

  if (files.length === 0) {
    return { dirty: [], clean: [], corpus_size: 0, breakdown, forced_full: false };
  }

  // Determine if this run is a forced full sweep.
  const runCounterPath = opts.runCounterPath || path.join(
    os.homedir(), '.orchestray', 'state', 'curator-diff-run-counter.json'
  );
  const runCount  = incrementRunCounter(runCounterPath);
  const isForcedFull = forcedFull || (runCount % FORCED_FULL_SWEEP_EVERY === 0);

  if (isForcedFull) {
    try {
      _degradedJournal().recordDegradation({
        kind:     'curator_diff_forced_full_triggered',
        severity: 'info',
        detail:   { run_counter: runCount, dedup_key: 'curator_diff_forced_full|' + runCount },
      });
    } catch (_) {}
  }

  // Collect rolled-back action IDs for signal 4.
  const rolledBackIds = collectRolledBackActionIds(activeTombstonesPath);

  for (const absPath of files) {
    if (isForcedFull) {
      dirty.push(absPath);
      breakdown.forced_full++;
      continue;
    }

    let result;
    try {
      result = isDirty({ absPath, cutoffDays, now, rolledBackIds });
    } catch (_) {
      // Unexpected error — fail-open: treat as dirty.
      result = { dirty: true, reason: 'stamp_absent' };
    }

    if (result.dirty) {
      dirty.push(absPath);
      if (result.reason === 'stamp_absent')     breakdown.stamp_absent++;
      if (result.reason === 'body_hash_drift')  breakdown.body_hash_drift++;
      if (result.reason === 'stale_stamp')      breakdown.stale_stamp++;
      if (result.reason === 'rollback_touched') breakdown.rollback_touched++;
      if (result.reason === 'merge_lineage')    breakdown.merge_lineage++;
    } else {
      clean.push(absPath);
    }
  }

  return {
    dirty,
    clean,
    corpus_size: files.length,
    breakdown,
    forced_full: isForcedFull,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  computeDirtySet,
  incrementRunCounter,
  computeBodyHash,
  // Exported for tests:
  _internal: {
    isDirty,
    isPatternMergeLineage,
    collectRolledBackActionIds,
    FORCED_FULL_SWEEP_EVERY,
  },
};
