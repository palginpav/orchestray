'use strict';

/**
 * shield-session-cache.js — Session-scoped read cache for the R14 dedup rule.
 *
 * Tracks every (file_path, offset, limit) triple that has been served by the
 * Read tool within a Claude Code agent session. Persists to a JSON file under
 * .orchestray/state/ so the cache survives hook restarts within the same session
 * (each hook invocation is a fresh process, so in-memory state is ephemeral).
 *
 * Cache file location: .orchestray/state/.shield-session-<session_id>.json
 *
 * Cache file format (JSON object):
 *   {
 *     "<path>\t<offset>\t<limit>": {
 *       "mtime": "<ISO string>",
 *       "turn":  <number>,
 *       "first_seen": "<ISO string>"
 *     },
 *     ...
 *   }
 *
 * Atomic writes: we read-then-write the entire JSON file under an advisory lock
 * (same pattern as atomic-append.js) to avoid partial-write corruption.
 *
 * Fail-open contract: any error in cache I/O must not block a legitimate Read.
 * All exported functions catch errors internally and return safe defaults.
 */

const fs = require('fs');
const path = require('path');

// Maximum bytes to read from the cache file before failing open.
const MAX_CACHE_BYTES = 2 * 1024 * 1024; // 2 MB

// Maximum number of entries in the cache before pruning the oldest half.
// Prevents unbounded growth when a session reads thousands of distinct files.
const MAX_CACHE_ENTRIES = 5000;

// Advisory lock timeout: if a .lock file is older than 10 s, treat as stale.
const LOCK_STALE_MS = 10_000;
const MAX_LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MS = 50;

/**
 * Build the cache file path for the given session.
 *
 * @param {string} cwd       - Project root directory (absolute path).
 * @param {string} sessionId - The session_id from the hook payload.
 * @returns {string} Absolute path to the cache JSON file.
 */
function cacheFilePath(cwd, sessionId) {
  const stateDir = path.join(cwd, '.orchestray', 'state');
  // Sanitize session_id: replace any path-separator characters so a malformed
  // session_id cannot cause a directory traversal.
  const safeId = String(sessionId || 'unknown').replace(/[/\\]/g, '_').slice(0, 128);
  return path.join(stateDir, '.shield-session-' + safeId + '.json');
}

/**
 * Build the canonical cache key for a Read call.
 *
 * @param {string}      filePath - Absolute (or relative) file path from the tool input.
 * @param {number|null} offset   - Line offset (null/undefined → 0).
 * @param {number|null} limit    - Line limit (null/undefined → 0, meaning "no limit").
 * @returns {string} Tab-separated triple "<path>\t<offset>\t<limit>".
 */
function buildCacheKey(filePath, offset, limit) {
  const o = (offset == null || offset === undefined) ? 0 : Number(offset);
  const l = (limit == null || limit === undefined) ? 0 : Number(limit);
  return filePath + '\t' + o + '\t' + l;
}

/**
 * Synchronous sleep for lock backoff.
 */
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin */ }
  }
}

/**
 * Acquire an advisory file lock.
 * Returns a file descriptor on success, or null if all retries fail.
 */
function acquireLock(lockPath) {
  // Ensure parent directory exists.
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (_e) {}

  let fd = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      return fd;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Stale-lock recovery
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch (_e) {}
            continue;
          }
        } catch (_e) { continue; }
        if (attempt < MAX_LOCK_ATTEMPTS - 1) {
          sleepMs(LOCK_BACKOFF_MS);
          continue;
        }
      } else {
        // Non-EEXIST error — give up immediately.
        break;
      }
    }
  }
  return null;
}

/**
 * Release an advisory file lock.
 */
function releaseLock(lockPath, fd) {
  try { if (fd !== null) fs.closeSync(fd); } catch (_e) {}
  try { fs.unlinkSync(lockPath); } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write('[orchestray] shield-session-cache: failed to unlink lockfile: ' + err.message + '\n');
    }
  }
}

/**
 * Read the cache JSON file, returning an empty object on any error.
 */
function readCacheFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_CACHE_BYTES) {
      process.stderr.write('[orchestray] shield-session-cache: cache file too large (' + stat.size + ' bytes); failing open\n');
      return {};
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_e) {
    // Missing, unreadable, or malformed — start fresh.
    return {};
  }
}

/**
 * Write the cache JSON file (must be called while holding the lock).
 */
function writeCacheFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

// NOTE: lookupCache reads without the advisory lock. A concurrent recordRead can
// race, causing a JSON parse failure that falls open to cache-miss (allow). This
// is intentional — lock contention on lookup would add latency to every Read call.

/**
 * Look up a cache entry for the given (path, offset, limit, mtime) quadruple.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} filePath
 * @param {number|null} offset
 * @param {number|null} limit
 * @param {string} currentMtime - ISO string of the file's current mtime.
 * @returns {{ hit: boolean, turn: number|null }} hit=true means the file was
 *   already read with the same mtime and no offset/limit change.
 *   hit=false means the read should be allowed through.
 */
function lookupCache(cwd, sessionId, filePath, offset, limit, currentMtime) {
  try {
    const cfPath = cacheFilePath(cwd, sessionId);
    const key = buildCacheKey(filePath, offset, limit);
    const cache = readCacheFile(cfPath);
    const entry = cache[key];
    if (!entry) return { hit: false, turn: null };
    // Invalidate if mtime changed (file was modified since last read).
    if (entry.mtime !== currentMtime) return { hit: false, turn: null };
    return { hit: true, turn: entry.turn };
  } catch (_e) {
    // Fail open on any unexpected error.
    return { hit: false, turn: null };
  }
}

/**
 * Record a cache entry for the given (path, offset, limit, mtime) quadruple.
 * Called after a Read is allowed through (first read of this triple).
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} filePath
 * @param {number|null} offset
 * @param {number|null} limit
 * @param {string} currentMtime - ISO string of the file's current mtime.
 * @param {number} turn         - Current turn number (from hook payload or 0).
 */
function recordRead(cwd, sessionId, filePath, offset, limit, currentMtime, turn) {
  const cfPath = cacheFilePath(cwd, sessionId);
  const lockPath = cfPath + '.lock';
  const fd = acquireLock(lockPath);
  if (fd === null) return; // all lock retries exhausted — skip cache write, fail open

  try {
    const cache = readCacheFile(cfPath);

    // Prune oldest half of entries when the cap is reached, to prevent unbounded
    // cache growth. Entries are sorted by first_seen timestamp (oldest first).
    const keys = Object.keys(cache);
    if (keys.length >= MAX_CACHE_ENTRIES) {
      const sorted = keys.sort((a, b) => {
        const ta = (cache[a] && cache[a].first_seen) || '';
        const tb = (cache[b] && cache[b].first_seen) || '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      const pruneCount = Math.floor(keys.length / 2);
      for (let i = 0; i < pruneCount; i++) {
        delete cache[sorted[i]];
      }
    }

    const key = buildCacheKey(filePath, offset, limit);
    const now = new Date().toISOString();
    cache[key] = {
      mtime: currentMtime,
      turn: turn || 0,
      first_seen: cache[key] ? cache[key].first_seen : now,
    };
    writeCacheFile(cfPath, cache);
  } catch (_e) {
    // Fail open — if we can't record, the next call will simply miss the cache
    // and be allowed through (correct but slightly less efficient).
    process.stderr.write('[orchestray] shield-session-cache: recordRead error: ' + ((_e && _e.message) || 'unknown error') + '\n');
  } finally {
    releaseLock(lockPath, fd);
  }
}

/**
 * Clear the session cache file (called on PreCompact).
 *
 * @param {string} cwd
 * @param {string} sessionId
 */
function clearSessionCache(cwd, sessionId) {
  try {
    const cfPath = cacheFilePath(cwd, sessionId);
    if (fs.existsSync(cfPath)) {
      fs.unlinkSync(cfPath);
    }
  } catch (_e) {
    // Fail open — if we can't clear the cache, the old entries will simply
    // cause false-positive dedup hits in the next context window.  That's
    // acceptable: the Pre-Compact signal is the safety valve, and if it fails
    // the worst outcome is a spurious "already read" hint to the agent.
    process.stderr.write('[orchestray] shield-session-cache: clearSessionCache error: ' + ((_e && _e.message) || 'unknown error') + '\n');
  }
}

module.exports = {
  cacheFilePath,
  buildCacheKey,
  lookupCache,
  recordRead,
  clearSessionCache,
};
