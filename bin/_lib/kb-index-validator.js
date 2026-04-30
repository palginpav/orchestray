'use strict';

/**
 * kb-index-validator.js — structural validator for `.orchestray/kb/index.json`.
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
 * Public API:
 *   validate(cwd) -> { valid: boolean, reason: string|null, file_path }
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

  if (!_isPlainObject(parsed)) {
    return { valid: false, reason: 'root_not_object', file_path: filePath };
  }

  const ids = new Set();

  // Form 1: top-level entries[]
  if (Array.isArray(parsed.entries)) {
    const r = _validateEntries(parsed.entries, ids);
    if (r) return { valid: false, reason: r, file_path: filePath };
  }

  // Form 2: per-bucket arrays
  for (const bucket of KNOWN_BUCKETS) {
    if (!(bucket in parsed)) continue;
    if (!Array.isArray(parsed[bucket])) {
      return { valid: false, reason: `bucket_${bucket}_not_array`, file_path: filePath };
    }
    const bucketIds = new Set();
    const r = _validateEntries(parsed[bucket], bucketIds);
    if (r) return { valid: false, reason: r, file_path: filePath };

    // FN-53: bucket name must align with path prefix for every entry.
    for (let i = 0; i < parsed[bucket].length; i++) {
      const e = parsed[bucket][i];
      if (!_isPlainObject(e) || typeof e.path !== 'string') continue;
      if (!pathMatchesBucket(e.path, bucket)) {
        return {
          valid: false,
          reason: `bucket_${bucket}_path_mismatch_at_${i}_${e.path.slice(0, 80)}`,
          file_path: filePath,
        };
      }
    }
  }

  return { valid: true, reason: null, file_path: filePath };
}

module.exports = {
  validate,
  pathMatchesBucket,
  ID_RE,
  KNOWN_BUCKETS,
};
