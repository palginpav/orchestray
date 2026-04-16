'use strict';

/**
 * context-telemetry-cache.js — Atomic read/update/reset for the context-telemetry cache.
 *
 * Cache file: <projectDir>/.orchestray/state/context-telemetry.json
 * All writes use rename-over-tmp (POSIX atomic) under an advisory lock.
 *
 * Exported API:
 *   readCache(projectDir)              → cache object (skeleton on missing/corrupt)
 *   updateCache(projectDir, updaterFn) → void (fail-open)
 *   resetCache(projectDir, sessionId)  → void (fail-open)
 *
 * W3 / v2.0.19 Pillar B.
 */

const fs   = require('fs');
const path = require('path');
const { _withAdvisoryLock } = require('./atomic-append');

const SCHEMA_VERSION = 1;

/**
 * Return the absolute path to the cache file for a given project root.
 * @param {string} projectDir
 * @returns {string}
 */
function _cachePath(projectDir) {
  return path.join(projectDir, '.orchestray', 'state', 'context-telemetry.json');
}

/**
 * Return a fresh skeleton cache object for the given session.
 * @param {string|null} sessionId
 * @returns {object}
 */
function _skeleton(sessionId) {
  return {
    schema_version:  SCHEMA_VERSION,
    updated_at:      new Date().toISOString(),
    session_id:      sessionId || null,
    session: {
      model:          null,
      model_display:  null,
      context_window: 200000,
      tokens: {
        input:         0,
        output:        0,
        cache_read:    0,
        cache_creation: 0,
        total_prompt:  0,
      },
      last_turn_at: null,
    },
    active_subagents: [],
    last_error:       null,
  };
}

/**
 * Read the cache from disk. Returns the skeleton if the file is missing or corrupt.
 * Does NOT acquire the advisory lock — readers are inherently racy (single cache,
 * multi-hook writers). Callers that need a consistent read+write must use updateCache.
 *
 * @param {string} projectDir - Absolute project root.
 * @returns {object}
 */
function readCache(projectDir) {
  const cachePath = _cachePath(projectDir);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== SCHEMA_VERSION) {
      // Unknown schema version — return skeleton.
      return _skeleton(null);
    }
    return parsed;
  } catch (_e) {
    return _skeleton(null);
  }
}

/**
 * Atomically read-modify-write the cache.
 *
 * 1. Acquire advisory lock on <cache>.lock.
 * 2. Read existing cache (or skeleton on missing/corrupt).
 * 3. Call updaterFn(cache) — MUST return a new/modified cache object.
 * 4. Stamp updated_at.
 * 5. Write to <cache>.tmp, then rename to <cache> (atomic on POSIX).
 * 6. Release lock.
 *
 * Fail-open: any I/O error → write stderr warning, update last_error field (best-effort), return.
 *
 * @param {string}   projectDir - Absolute project root.
 * @param {Function} updaterFn  - (cache: object) => object
 */
function updateCache(projectDir, updaterFn) {
  const cachePath = _cachePath(projectDir);
  const lockPath  = cachePath + '.lock';
  const tmpPath   = cachePath + '.tmp';

  // Ensure the directory exists.
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  } catch (_e) { /* swallow */ }

  try {
    _withAdvisoryLock(lockPath, () => {
      // Read current state (or skeleton).
      let current;
      try {
        const raw = fs.readFileSync(cachePath, 'utf8');
        current = JSON.parse(raw);
        if (!current || typeof current !== 'object' || current.schema_version !== SCHEMA_VERSION) {
          current = _skeleton(null);
        }
      } catch (_e) {
        current = _skeleton(null);
      }

      // Apply the update.
      let updated;
      try {
        updated = updaterFn(current);
      } catch (updErr) {
        process.stderr.write('[orchestray] context-telemetry-cache: updaterFn threw: ' + String(updErr) + '\n');
        return;
      }

      if (!updated || typeof updated !== 'object') {
        process.stderr.write('[orchestray] context-telemetry-cache: updaterFn returned non-object; skipping write\n');
        return;
      }

      // Stamp the write time.
      updated.updated_at = new Date().toISOString();

      // Atomic write: tmp then rename.
      const serialized = JSON.stringify(updated, null, 2) + '\n';
      fs.writeFileSync(tmpPath, serialized, 'utf8');
      fs.renameSync(tmpPath, cachePath);
    });
  } catch (err) {
    const msg = '[orchestray] context-telemetry-cache: updateCache failed: ' + String(err);
    process.stderr.write(msg + '\n');
  }
}

/**
 * Reset the cache to a fresh skeleton for a new session.
 * Uses updateCache internally for atomicity.
 *
 * @param {string} projectDir - Absolute project root.
 * @param {string} sessionId  - New session ID.
 */
function resetCache(projectDir, sessionId) {
  // Write skeleton directly (bypassing updateCache's read step) by using updateCache
  // with an updater that ignores the old state.
  updateCache(projectDir, (_old) => _skeleton(sessionId));
}

module.exports = { readCache, updateCache, resetCache, _skeleton };
