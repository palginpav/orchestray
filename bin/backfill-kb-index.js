#!/usr/bin/env node
'use strict';

/**
 * backfill-kb-index.js — one-shot data repair for `.orchestray/kb/index.json`.
 *
 * Per .orchestray/kb/artifacts/v2330-kb-index-drift-diagnosis.md Finding 4:
 * 684/825 on-disk KB `.md` files are indexed in neither of the two
 * `index.json` schemas (per-bucket `artifacts[]`/`facts[]`/`decisions[]`
 * written by `kb_write.js`, and flat `entries[]` written by
 * `redirect-kb-write.js`). Diagnosis Finding 4 also establishes this is a
 * "never indexed" backlog, not "indexed then lost" — no writer ever deletes
 * an entry for a file that still exists, so a straight union-diff-backfill
 * is safe.
 *
 * This script:
 *   1. Globs `.orchestray/kb/{artifacts,facts,decisions}/*.md` (top-level
 *      only — matches the non-recursive scope kb_search/kb_resource already
 *      use; nested subdirectories are a separate, tracked gap — see
 *      Recommendation R1 in the diagnosis doc).
 *   2. Computes the UNION of both index schemas (a file indexed in either
 *      array counts as indexed) by normalising every entry's `path` field
 *      to the canonical `.orchestray/kb/<bucket>/<file>.md` form.
 *   3. For every on-disk file indexed in NEITHER array, appends a new entry
 *      to the per-bucket array (the richer, locked schema — see rationale
 *      below) with only the fields we can actually determine: `id` (from
 *      filename), `path` (canonical), `title` (from the file's first H1),
 *      `created_at` (from file mtime). `author`, `topic`, and
 *      `orchestration_id` are omitted — never guessed. A field guessed from
 *      context is worse than an absent field.
 *   4. Writes atomically (tmp + rename) under the same `index.json.lock`
 *      advisory lock the other two writers use (`_withAdvisoryLock` from
 *      `bin/_lib/atomic-append.js` — no second lock implementation).
 *
 * Schema choice: the per-bucket array (artifacts[]/facts[]/decisions[]) is
 * used for backfilled entries, per the dispatch's explicit steer — it is
 * the richer shape and the one the locked, schema-enforced `kb_write` MCP
 * tool writes into. The flat `entries[]` schema is left untouched by this
 * script (existing entries there are not moved or modified).
 *
 * Dry-run by default. Pass --write to actually persist changes.
 *
 * CLI:
 *   node bin/backfill-kb-index.js [--write] [cwd]
 *   node bin/backfill-kb-index.js --write --kb-dir <path> --index-path <path>
 *     (--kb-dir / --index-path are test-only overrides so this script never
 *     needs to touch the live index during development.)
 *
 * Fail-closed: if the advisory lock cannot be acquired, no write happens
 * and the script exits non-zero.
 */

const fs = require('fs');
const path = require('path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { _withAdvisoryLock } = require('./_lib/atomic-append');

const KB_BUCKETS = ['artifacts', 'facts', 'decisions'];
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Derive a title from the file's first H1 line, or null if none found. */
function deriveTitle(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const first = raw.split('\n').find((l) => l.trim().length > 0);
    if (first && first.trim().startsWith('# ')) {
      return first.trim().slice(2).trim();
    }
  } catch (_e) { /* fall through */ }
  return null;
}

/** Derive a safe id from a filename ("foo-bar.md" -> "foo-bar"). */
function deriveId(fileName) {
  const base = fileName.replace(/\.md$/i, '');
  return ID_RE.test(base) ? base : null;
}

/**
 * Normalise an index entry's `path` field to the canonical
 * ".orchestray/kb/<bucket>/<file>" form so entries written in either the
 * short form ("<bucket>/<file>") or already-canonical form compare equal.
 */
function normalisePath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) return null;
  const p = entryPath.replace(/\\/g, '/');
  if (p.startsWith('.orchestray/kb/')) return p;
  for (const bucket of KB_BUCKETS) {
    if (p.startsWith(bucket + '/')) return '.orchestray/kb/' + p;
  }
  // Unrecognised shape — return as-is so it still participates in the union
  // (better to over-count "indexed" than risk a duplicate entry).
  return p;
}

/** Collect the set of canonical paths already indexed, across both schemas. */
function collectIndexedPaths(indexObj) {
  const set = new Set();
  if (indexObj && Array.isArray(indexObj.entries)) {
    for (const e of indexObj.entries) {
      const n = normalisePath(e && e.path);
      if (n) set.add(n);
    }
  }
  for (const bucket of KB_BUCKETS) {
    if (indexObj && Array.isArray(indexObj[bucket])) {
      for (const e of indexObj[bucket]) {
        const n = normalisePath(e && e.path);
        if (n) set.add(n);
      }
    }
  }
  return set;
}

/** Top-level-only glob of *.md under a bucket dir (matches kb_search's scope). */
function listBucketFiles(kbDir, bucket) {
  const dir = path.join(kbDir, bucket);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_e) {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isFile();
      } catch (_e) {
        return false;
      }
    })
    .sort();
}

/**
 * Compute the backfill plan: files present on disk but not indexed in
 * either schema, with the entry that would be added for each.
 */
function computePlan(kbDir, indexObj) {
  const indexedPaths = collectIndexedPaths(indexObj);
  const plan = [];
  const skipped = [];

  for (const bucket of KB_BUCKETS) {
    const files = listBucketFiles(kbDir, bucket);
    for (const fileName of files) {
      const canonicalPath = '.orchestray/kb/' + bucket + '/' + fileName;
      if (indexedPaths.has(canonicalPath)) continue;

      const absPath = path.join(kbDir, bucket, fileName);
      const id = deriveId(fileName);
      if (!id) {
        skipped.push({ path: canonicalPath, reason: 'id_unsafe' });
        continue;
      }

      const entry = { id, path: canonicalPath };
      const title = deriveTitle(absPath);
      if (title) entry.title = title;
      try {
        const st = fs.statSync(absPath);
        entry.created_at = new Date(st.mtimeMs).toISOString();
      } catch (_e) { /* omit created_at if mtime unavailable */ }

      plan.push({ bucket, entry });
    }
  }

  return { plan, skipped };
}

/**
 * Apply the plan to an in-memory index object (mutates and returns it).
 * Re-checks id-collision within each bucket (defensive — should not happen
 * given the path-based diff, but an id could theoretically collide with an
 * existing entry that has a different path).
 */
function applyPlan(indexObj, plan) {
  const applied = [];
  const conflicts = [];
  for (const { bucket, entry } of plan) {
    if (!Array.isArray(indexObj[bucket])) indexObj[bucket] = [];
    const bucketArr = indexObj[bucket];
    const collision = bucketArr.some((e) => e && e.id === entry.id);
    if (collision) {
      conflicts.push({ bucket, entry });
      continue;
    }
    bucketArr.push(entry);
    applied.push({ bucket, entry });
  }
  return { applied, conflicts };
}

function loadIndex(indexPath) {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('index.json root is not an object');
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { version: '1.0', created_at: new Date().toISOString(), entries: [] };
    }
    throw err;
  }
}

/**
 * Run the backfill against a given project root.
 *
 * @param {object} opts
 * @param {string} opts.cwd - project root
 * @param {boolean} opts.write - if true, persist changes; otherwise dry-run
 * @param {string} [opts.kbDir] - override KB dir (test-only)
 * @param {string} [opts.indexPath] - override index.json path (test-only)
 * @returns {{applied: Array, conflicts: Array, skipped: Array, wrote: boolean, lockSkipped: boolean}}
 */
function run(opts) {
  const cwd = opts.cwd || process.cwd();
  const kbDir = opts.kbDir || path.join(cwd, '.orchestray', 'kb');
  const indexPath = opts.indexPath || path.join(kbDir, 'index.json');
  const write = !!opts.write;

  if (!write) {
    // Dry-run: read-only, no lock needed.
    const indexObj = loadIndex(indexPath);
    const { plan, skipped } = computePlan(kbDir, indexObj);
    return { applied: [], planned: plan, conflicts: [], skipped, wrote: false, lockSkipped: false };
  }

  const lockPath = indexPath + '.lock';
  const result = _withAdvisoryLock(lockPath, () => {
    const indexObj = loadIndex(indexPath);
    const { plan, skipped } = computePlan(kbDir, indexObj);
    const { applied, conflicts } = applyPlan(indexObj, plan);

    if (applied.length === 0) {
      return { applied, planned: plan, conflicts, skipped, wrote: false, lockOutcome: 'ran' };
    }

    const tmpPath = indexPath + '.tmp.' + process.pid;
    try {
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(indexObj, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, indexPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_e) {}
      throw err;
    }

    return { applied, planned: plan, conflicts, skipped, wrote: true, lockOutcome: 'ran' };
  });

  // Note: `result.skipped` (a possibly-empty array of unsafe-id files from
  // computePlan) must NOT be confused with _withAdvisoryLock's own
  // `{ skipped: true }` sentinel for lock-acquire failure — check the
  // `lockOutcome` marker set only by our own callback instead of an
  // ambiguous truthy/array check (an empty array is truthy in JS).
  if (!result || result.lockOutcome !== 'ran') {
    return { applied: [], planned: [], conflicts: [], skipped: [], wrote: false, lockSkipped: true };
  }
  const { lockOutcome, ...rest } = result;
  return { ...rest, lockSkipped: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const kbDirIdx = args.indexOf('--kb-dir');
  const indexPathIdx = args.indexOf('--index-path');
  const kbDir = kbDirIdx !== -1 ? args[kbDirIdx + 1] : undefined;
  const indexPath = indexPathIdx !== -1 ? args[indexPathIdx + 1] : undefined;
  const positional = args.find((a, i) => {
    if (a.startsWith('-')) return false;
    if (kbDirIdx !== -1 && i === kbDirIdx + 1) return false;
    if (indexPathIdx !== -1 && i === indexPathIdx + 1) return false;
    return true;
  });
  const cwd = resolveSafeCwd(positional || process.cwd());

  let result;
  try {
    result = run({ cwd, write, kbDir, indexPath });
  } catch (err) {
    process.stderr.write('[orchestray] backfill-kb-index: ' + (err && err.message) + '\n');
    process.exit(1);
  }

  if (result.lockSkipped) {
    process.stderr.write('[orchestray] backfill-kb-index: lock contention — no changes made, retry later.\n');
    process.exit(1);
  }

  const mode = write ? 'WRITE' : 'DRY-RUN';
  process.stdout.write('[orchestray] backfill-kb-index (' + mode + ')\n');
  process.stdout.write('  candidates: ' + result.planned.length + '\n');
  if (result.skipped.length > 0) {
    process.stdout.write('  skipped (unsafe id): ' + result.skipped.length + '\n');
    for (const s of result.skipped) process.stdout.write('    - ' + s.path + ' (' + s.reason + ')\n');
  }
  if (result.conflicts && result.conflicts.length > 0) {
    process.stdout.write('  id conflicts (not applied): ' + result.conflicts.length + '\n');
    for (const c of result.conflicts) process.stdout.write('    - ' + c.bucket + '/' + c.entry.id + '\n');
  }
  for (const p of result.planned) {
    const marker = write ? (result.applied.some((a) => a.entry.path === p.entry.path) ? '+' : 'x') : '?';
    process.stdout.write('  [' + marker + '] ' + p.bucket + ': ' + p.entry.path + '\n');
  }
  if (!write) {
    process.stdout.write('\nDry-run only — no changes written. Re-run with --write to apply.\n');
  } else {
    process.stdout.write('\nApplied ' + result.applied.length + ' new entr' + (result.applied.length === 1 ? 'y' : 'ies') + '.\n');
  }
  process.exit(0);
}

module.exports = {
  run,
  computePlan,
  collectIndexedPaths,
  normalisePath,
  deriveId,
  deriveTitle,
  listBucketFiles,
};
