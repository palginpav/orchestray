'use strict';

/**
 * kb-index-validator.js — structural validator (+ auto-repair) for
 * `.orchestray/kb/index.json`.
 *
 * v2.2.9 B-7.3 (W1 F-PM-26 mechanisation). The kb_write MCP tool already
 * holds index.json under an exclusive lock (see bin/mcp-server/tools/kb_write.js),
 * but agents armed with Write/Edit can bypass kb_write and append entries
 * directly. This validator runs as a PreToolUse:Edit/Write checkpoint AND
 * as a post-write integrity probe; on detected corruption it emits
 * `kb_index_invalid` and (in PreToolUse mode) exits 2.
 *
 * v2.2.15 FN-53: extended to enforce **bucket↔path-prefix consistency**. An
 * entry under `facts:` MUST have a path beginning with `facts/` or
 * `.orchestray/kb/facts/`; an entry under `artifacts:` MUST have a path
 * beginning with `artifacts/` or `.orchestray/kb/artifacts/`; same for
 * `decisions/`. W5-F2 found 7 artifacts mis-bucketed under `facts:`; this
 * mechanical check makes that drift impossible to ship.
 *
 * v2.3.18 D9: detection without repair converted a cosmetic index problem
 * into a hard block on all KB writes (same corruption persisted 25 days,
 * user hand-repaired it 3 times in one day). Added `repair(cwd)` for the
 * mechanically unambiguous cases only:
 *   - an entry whose `path` clearly names a *different* known bucket than
 *     the array it currently sits in → move it to the correct array.
 *   - exact-duplicate ids/slugs within one array → dedupe, keeping the
 *     entry with the newest `updated_at`/`created_at`; if neither duplicate
 *     carries a timestamp, dedupe only when the entries are byte-identical.
 * Anything else (unparseable JSON, non-object root, an entry whose path
 * matches no known bucket at all, duplicate ids with no way to break the
 * tie) is left alone and reported as still-ambiguous — repair() never
 * guesses.
 *
 * Public API:
 *   validate(cwd) -> { valid: boolean, reason: string|null, file_path }
 *   repair(cwd)   -> { repaired: boolean, reason: string|null, changes: [...], file_path }
 *
 * Validity rules (all must hold):
 *   1. file exists AND parses as JSON
 *   2. root is an object with a top-level `entries` array OR per-bucket arrays
 *      under `artifacts`/`facts`/`decisions`
 *   3. every entry is an object with at least { id, path } string fields
 *   4. every `path` string is relative (no leading "/", no ".." traversal)
 *   5. ids inside any single bucket are unique
 *   6. (FN-53) bucket name aligns with path prefix
 *
 * Fail-open contract: returns `{ valid: true }` if the file does not exist
 * (pre-write state is legitimately empty). Only structural corruption fails.
 */

const fs = require('fs');
const path = require('path');

const { _withAdvisoryLock, atomicWriteFile } = require('./atomic-append');

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const KNOWN_BUCKETS = ['artifacts', 'facts', 'decisions'];

/**
 * FN-53 — return true if `entryPath` is consistent with `bucketName`.
 *
 * Accepts both legacy short-form paths (`artifacts/foo.md`) and full-form
 * paths (`.orchestray/kb/artifacts/foo.md`). The canonical short suffix
 * directly under the bucket name is what we check.
 *
 * @param {string} entryPath
 * @param {string} bucketName
 * @returns {boolean}
 */
function pathMatchesBucket(entryPath, bucketName) {
  if (typeof entryPath !== 'string' || typeof bucketName !== 'string') return false;
  const shortPrefix = bucketName + '/';
  const longPrefix  = '.orchestray/kb/' + bucketName + '/';
  return entryPath.startsWith(shortPrefix) || entryPath.startsWith(longPrefix);
}

function _isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _entryKey(e) {
  return (typeof e.id === 'string' && e.id) || (typeof e.slug === 'string' && e.slug) || null;
}

function _validateEntries(entries, ids) {
  if (!Array.isArray(entries)) return 'entries_not_array';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!_isPlainObject(e)) return `entry_${i}_not_object`;
    const entryId = (typeof e.id === 'string' && e.id) || (typeof e.slug === 'string' && e.slug) || null; // v2.2.12: accept both for compat
    if (entryId && !ID_RE.test(entryId)) return `entry_${i}_bad_id`;
    if (typeof e.path !== 'string' || e.path.length === 0) return `entry_${i}_bad_path`;
    if (path.isAbsolute(e.path) || e.path.includes('..')) return `entry_${i}_path_unsafe`;
    const dedupeKey = entryId || e.path;
    if (ids.has(dedupeKey)) return `entry_${i}_duplicate_id_${dedupeKey}`;
    ids.add(dedupeKey);
  }
  return null;
}

/**
 * Validate an already-parsed index object. Shared by validate() (reads from
 * disk) and repair() (validates the in-memory repaired object before commit).
 *
 * @param {*} parsed
 * @returns {{valid: boolean, reason: string|null}}
 */
function _validateParsed(parsed) {
  if (!_isPlainObject(parsed)) {
    return { valid: false, reason: 'root_not_object' };
  }

  const ids = new Set();

  // Form 1: top-level entries[]
  if (Array.isArray(parsed.entries)) {
    const r = _validateEntries(parsed.entries, ids);
    if (r) return { valid: false, reason: r };
  }

  // Form 2: per-bucket arrays
  for (const bucket of KNOWN_BUCKETS) {
    if (!(bucket in parsed)) continue;
    if (!Array.isArray(parsed[bucket])) {
      return { valid: false, reason: `bucket_${bucket}_not_array` };
    }
    const bucketIds = new Set();
    const r = _validateEntries(parsed[bucket], bucketIds);
    if (r) return { valid: false, reason: r };

    // FN-53: bucket name must align with path prefix for every entry.
    for (let i = 0; i < parsed[bucket].length; i++) {
      const e = parsed[bucket][i];
      if (!_isPlainObject(e) || typeof e.path !== 'string') continue;
      if (!pathMatchesBucket(e.path, bucket)) {
        return {
          valid: false,
          reason: `bucket_${bucket}_path_mismatch_at_${i}_${e.path.slice(0, 80)}`,
        };
      }
    }
  }

  return { valid: true, reason: null };
}

/**
 * Validate the KB index.
 *
 * @param {string} cwd project root
 * @returns {{valid: boolean, reason: string|null, file_path: string}}
 */
function validate(cwd) {
  const filePath = path.join(cwd, '.orchestray', 'kb', 'index.json');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { valid: true, reason: null, file_path: filePath };
    }
    return { valid: false, reason: 'read_error', file_path: filePath };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return { valid: false, reason: 'parse_error', file_path: filePath };
  }

  const result = _validateParsed(parsed);
  return { valid: result.valid, reason: result.reason, file_path: filePath };
}

// ---------------------------------------------------------------------------
// repair() — D9 auto-repair for mechanically unambiguous corruption.
// ---------------------------------------------------------------------------

/**
 * Scan `parsed` for the two repairable corruption shapes and mutate it in
 * place. Returns as soon as it hits a case it cannot safely resolve — no
 * partial commit happens in that case (caller checks `ambiguousReason`).
 *
 * @param {object} parsed
 * @returns {{changes: Array<object>, ambiguousReason: string|null}}
 */
function _scanAndRepair(parsed) {
  const changes = [];

  // Structural pre-checks: an `entries`/bucket key present but not an array
  // is not something repair can infer a fix for.
  if ('entries' in parsed && !Array.isArray(parsed.entries)) {
    return { changes, ambiguousReason: 'entries_not_array' };
  }
  for (const bucket of KNOWN_BUCKETS) {
    if (bucket in parsed && !Array.isArray(parsed[bucket])) {
      return { changes, ambiguousReason: `bucket_${bucket}_not_array` };
    }
  }

  // Per-entry shape checks across every array — unrepairable if an entry
  // isn't a plain object, or has a malformed id or an unsafe path. We
  // cannot infer a correct value for those; they need a human.
  const arrayNames = ['entries', ...KNOWN_BUCKETS].filter((n) => Array.isArray(parsed[n]));
  for (const name of arrayNames) {
    const arr = parsed[name];
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (!_isPlainObject(e)) return { changes, ambiguousReason: `${name}_entry_${i}_not_object` };
      const key = _entryKey(e);
      if (key && !ID_RE.test(key)) return { changes, ambiguousReason: `${name}_entry_${i}_bad_id` };
      if (typeof e.path !== 'string' || e.path.length === 0) {
        return { changes, ambiguousReason: `${name}_entry_${i}_bad_path` };
      }
      if (path.isAbsolute(e.path) || e.path.includes('..')) {
        return { changes, ambiguousReason: `${name}_entry_${i}_path_unsafe` };
      }
    }
  }

  // Step 1: re-bucket entries whose path unambiguously names a *different*
  // known bucket than the array they currently sit in. `entries[]` has no
  // bucket concept, so it is left out of this pass.
  for (const bucket of KNOWN_BUCKETS) {
    const arr = parsed[bucket];
    if (!Array.isArray(arr)) continue;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (pathMatchesBucket(e.path, bucket)) continue; // already correctly filed
      const target = KNOWN_BUCKETS.find((b) => b !== bucket && pathMatchesBucket(e.path, b));
      if (!target) {
        // Path names no known bucket at all — genuinely ambiguous, name it exactly.
        return {
          changes,
          ambiguousReason:
            `bucket_${bucket}_path_mismatch_at_${i}_${e.path.slice(0, 80)}_matches_no_known_bucket`,
        };
      }
      arr.splice(i, 1);
      if (!Array.isArray(parsed[target])) parsed[target] = [];
      parsed[target].push(e);
      changes.push({ type: 'rebucket', id: _entryKey(e), from: bucket, to: target, path: e.path });
    }
  }

  // Step 2: dedupe exact-duplicate ids/slugs within each array, post-rebucket.
  for (const name of ['entries', ...KNOWN_BUCKETS]) {
    const arr = parsed[name];
    if (!Array.isArray(arr)) continue;

    const groups = new Map(); // dedupeKey -> [indexes]
    for (let i = 0; i < arr.length; i++) {
      const key = _entryKey(arr[i]) || arr[i].path;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }

    const toRemove = new Set();
    for (const [key, idxs] of groups) {
      if (idxs.length < 2) continue;

      const withTs = idxs.map((idx) => {
        const e = arr[idx];
        const rawTs = e.updated_at || e.created_at || null;
        const ms = rawTs ? Date.parse(rawTs) : NaN;
        return { idx, ms: Number.isNaN(ms) ? null : ms };
      });

      if (withTs.every((t) => t.ms !== null)) {
        let best = withTs[0];
        for (const t of withTs) if (t.ms > best.ms) best = t;
        for (const t of withTs) if (t.idx !== best.idx) toRemove.add(t.idx);
        changes.push({ type: 'dedupe_by_timestamp', array: name, id: key, kept_index: best.idx, dropped: idxs.length - 1 });
        continue;
      }

      // No timestamp to break the tie on at least one duplicate. Only safe
      // to resolve automatically if the entries are byte-identical — then
      // which copy survives carries no information loss.
      const allIdentical = idxs.every((idx) => JSON.stringify(arr[idx]) === JSON.stringify(arr[idxs[0]]));
      if (!allIdentical) {
        return {
          changes,
          ambiguousReason: `duplicate_id_${name}_${key}_no_timestamp_to_break_tie`,
        };
      }
      for (let k = 1; k < idxs.length; k++) toRemove.add(idxs[k]);
      changes.push({ type: 'dedupe_exact', array: name, id: key, kept_index: idxs[0], dropped: idxs.length - 1 });
    }

    if (toRemove.size > 0) {
      parsed[name] = arr.filter((_, idx) => !toRemove.has(idx));
    }
  }

  return { changes, ambiguousReason: null };
}

/**
 * Attempt to auto-repair `.orchestray/kb/index.json` in place. Only commits
 * when every detected issue was one of the two mechanically-unambiguous
 * shapes (see module doc) AND the repaired object re-validates clean.
 * Never partially commits — either the whole repair applies, or nothing
 * on disk changes.
 *
 * @param {string} cwd project root
 * @returns {{repaired: boolean, reason: string|null, changes: Array<object>, file_path: string}}
 */
function repair(cwd) {
  const filePath = path.join(cwd, '.orchestray', 'kb', 'index.json');

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { repaired: false, reason: 'no_index_file', changes: [], file_path: filePath };
    }
    return { repaired: false, reason: 'read_error', changes: [], file_path: filePath };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return { repaired: false, reason: 'parse_error', changes: [], file_path: filePath };
  }

  if (!_isPlainObject(parsed)) {
    return { repaired: false, reason: 'root_not_object', changes: [], file_path: filePath };
  }

  const scan = _scanAndRepair(parsed);
  if (scan.ambiguousReason) {
    return { repaired: false, reason: scan.ambiguousReason, changes: scan.changes, file_path: filePath };
  }
  if (scan.changes.length === 0) {
    // Nothing repair() knows how to fix — validate() must be failing for a
    // reason outside the two mechanical shapes handled here.
    return { repaired: false, reason: 'no_fixable_issues_found', changes: [], file_path: filePath };
  }

  const postCheck = _validateParsed(parsed);
  if (!postCheck.valid) {
    // Safety net: our fixes weren't sufficient — don't commit a still-broken index.
    return {
      repaired: false,
      reason: `post_repair_still_invalid_${postCheck.reason}`,
      changes: scan.changes,
      file_path: filePath,
    };
  }

  const lockPath = filePath + '.lock';
  const lockResult = _withAdvisoryLock(lockPath, () => {
    // Re-read under the lock — bail rather than clobber a concurrent writer
    // (e.g. a kb_write call) that changed the file since our initial read.
    let freshRaw;
    try {
      freshRaw = fs.readFileSync(filePath, 'utf8');
    } catch (_e) {
      return { ok: false, reason: 'read_error' };
    }
    if (freshRaw !== raw) {
      return { ok: false, reason: 'concurrent_modification' };
    }
    try {
      atomicWriteFile(filePath, JSON.stringify(parsed, null, 2) + '\n');
    } catch (err) {
      return { ok: false, reason: 'write_error_' + (err && err.message) };
    }
    return { ok: true };
  });

  if (lockResult && lockResult.skipped) {
    return { repaired: false, reason: 'lock_contention', changes: scan.changes, file_path: filePath };
  }
  if (!lockResult || !lockResult.ok) {
    return {
      repaired: false,
      reason: (lockResult && lockResult.reason) || 'commit_failed',
      changes: scan.changes,
      file_path: filePath,
    };
  }

  return { repaired: true, reason: null, changes: scan.changes, file_path: filePath };
}

module.exports = {
  validate,
  repair,
  pathMatchesBucket,
  ID_RE,
  KNOWN_BUCKETS,
};
