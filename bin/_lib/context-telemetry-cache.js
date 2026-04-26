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

// ---------------------------------------------------------------------------
// Lazy event emitter — never blocks if the audit gateway is unavailable.
// W11-fix F-W11-07: the staging cache is fail-open by contract, but a silent
// fail-open blinds operators to read-only filesystems / races. Emit a
// `staging_write_failed` event so the failure is visible without changing the
// fail-open behaviour. The emitter itself is wrapped in its own try/catch —
// even a broken audit pipeline must never block the spawn.
// ---------------------------------------------------------------------------

let _writeEvent = undefined;
function _emitStagingWriteFailed(projectDir, cachePath, op, err) {
  if (_writeEvent === undefined) {
    try {
      // eslint-disable-next-line global-require
      const mod = require('./audit-event-writer');
      _writeEvent = (mod && mod.writeEvent) || null;
    } catch (_e) {
      _writeEvent = null;
    }
  }
  if (typeof _writeEvent !== 'function') return;
  try {
    const code = (err && (err.code || (err.constructor && err.constructor.name))) || 'Error';
    const msgRaw = err && err.message ? String(err.message) : String(err);
    const message = msgRaw.length > 256 ? msgRaw.slice(0, 256) : msgRaw;
    _writeEvent({
      version:       1,
      type:          'staging_write_failed',
      cwd:           projectDir,
      cache_path:    cachePath,
      error_class:   code,
      error_message: message,
      op:            op,
    }, { cwd: projectDir });
  } catch (_e) { /* fail-open — emission itself can't fail */ }
}

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
  } catch (err) {
    // Missing-file is the steady-state pre-first-write condition; never warn
    // for it. Real read failures (permissions, partial decode) emit so the
    // operator can see the silent skeleton fallback.
    if (err && err.code !== 'ENOENT') {
      _emitStagingWriteFailed(projectDir, cachePath, 'read', err);
    }
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
  } catch (mkErr) {
    // mkdir failure is the canonical "read-only mount / permission denied"
    // signal that prevents every subsequent write. Emit and continue — the
    // tmp-write below will fail and we'll record that under op:"write".
    if (mkErr && mkErr.code !== 'EEXIST') {
      _emitStagingWriteFailed(projectDir, cachePath, 'write', mkErr);
    }
  }

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
      } catch (readErr) {
        if (readErr && readErr.code !== 'ENOENT') {
          _emitStagingWriteFailed(projectDir, cachePath, 'read', readErr);
        }
        current = _skeleton(null);
      }

      // Apply the update.
      let updated;
      try {
        updated = updaterFn(current);
      } catch (updErr) {
        process.stderr.write('[orchestray] context-telemetry-cache: updaterFn threw: ' + String(updErr) + '\n');
        _emitStagingWriteFailed(projectDir, cachePath, 'update', updErr);
        return;
      }

      if (!updated || typeof updated !== 'object') {
        process.stderr.write('[orchestray] context-telemetry-cache: updaterFn returned non-object; skipping write\n');
        _emitStagingWriteFailed(
          projectDir,
          cachePath,
          'update',
          new Error('updaterFn returned non-object')
        );
        return;
      }

      // Stamp the write time.
      updated.updated_at = new Date().toISOString();

      // Atomic write: tmp then rename.
      const serialized = JSON.stringify(updated, null, 2) + '\n';
      try {
        fs.writeFileSync(tmpPath, serialized, 'utf8');
      } catch (writeErr) {
        _emitStagingWriteFailed(projectDir, cachePath, 'write', writeErr);
        throw writeErr;
      }
      try {
        fs.renameSync(tmpPath, cachePath);
      } catch (renameErr) {
        _emitStagingWriteFailed(projectDir, cachePath, 'write', renameErr);
        throw renameErr;
      }
    });
  } catch (err) {
    const msg = '[orchestray] context-telemetry-cache: updateCache failed: ' + String(err);
    process.stderr.write(msg + '\n');
    // The inner write/rename catches above already emitted op:"write" for the
    // common read-only-fs case. Emit op:"update" only if the failure didn't
    // come from the write path (e.g., advisory-lock acquisition failed).
    if (err && err.code !== 'EACCES' && err.code !== 'EROFS' && err.code !== 'ENOSPC') {
      _emitStagingWriteFailed(projectDir, cachePath, 'update', err);
    }
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
