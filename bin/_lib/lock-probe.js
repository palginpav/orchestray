'use strict';

/**
 * lock-probe.js — non-intrusive advisory lock availability check.
 *
 * Replaces the stderr-monkey-patch in learning-circuit-breaker.js (W2-07 / Risk 2).
 * Uses the same lock-file convention as _withAdvisoryLock (lockPath, 'wx' open flag,
 * 10×50ms retry, 10_000ms stale threshold) but without running any payload function.
 * Returns a boolean: true if a lock file can be acquired, false if contention persists.
 *
 * v2.1.6 — W1c hardening (Risk 2 closure: _lockedRun stderr monkey-patch replacement).
 *
 * Design: Option B from W2-03 reviewer finding — clean probe primitive that matches
 * _withAdvisoryLock's retry/stale-recovery semantics without touching atomic-append.js.
 */

const fs   = require('node:fs');
const path = require('node:path');

// Must match _withAdvisoryLock in atomic-append.js exactly.
const MAX_LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MS   = 50;
const STALE_THRESHOLD_MS = 10_000;

/**
 * Synchronous sleep helper — matches atomic-append.js implementation.
 *
 * @param {number} ms
 */
function _sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Check whether an advisory lock file can be acquired, then immediately release it.
 *
 * Uses the same stale-lock detection as _withAdvisoryLock: if the lock file exists
 * and its mtime is older than STALE_THRESHOLD_MS (10s), the stale lock is removed
 * and the probe retries. This matches the stale-recovery semantics in atomic-append.js.
 *
 * Calling this function has a very brief side effect: it creates and immediately
 * deletes the lock file on success. Two concurrent probes on the same path may
 * both succeed because each probe releases the file immediately; the real
 * serialization happens at the payload level inside _withAdvisoryLock. The probe
 * is used only to detect the case where contention is so severe that even a probe
 * cannot acquire the lock within maxWaitMs — in that case, the circuit breaker
 * returns fail-closed.
 *
 * @param {string} lockPath - Path of the advisory lock file to probe.
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs=500] - Total time to wait across all retry attempts.
 *   Defaults to 500ms (= MAX_LOCK_ATTEMPTS × LOCK_BACKOFF_MS in _withAdvisoryLock).
 * @param {number} [opts.pollMs=50] - Backoff interval between retries. Defaults to 50ms.
 * @returns {boolean} true if lock can be acquired (no lasting contention), false otherwise.
 */
function isLockAvailable(lockPath, { maxWaitMs = 500, pollMs = LOCK_BACKOFF_MS } = {}) {
  // Ensure parent directory exists (matches _withAdvisoryLock behaviour).
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (_e) { /* swallow — if dir creation fails, the open below will fail and we return false */ }

  const deadline = Date.now() + maxWaitMs;

  // Compute maximum number of attempts from maxWaitMs / pollMs (plus initial attempt).
  const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fd = null;
    try {
      // 'wx': create exclusively — fails with EEXIST if file already exists.
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Lock file exists — check if it is stale.
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > STALE_THRESHOLD_MS) {
            // Stale lock — remove it and retry immediately.
            try { fs.unlinkSync(lockPath); } catch (_e) {}
            continue;
          }
        } catch (_e) {
          // stat failed (race — file removed between openSync and statSync).
          // Treat as gone and retry immediately.
          continue;
        }

        // Fresh lock held by another process. Wait and retry if time remains.
        if (Date.now() < deadline && attempt < maxAttempts - 1) {
          _sleepMs(pollMs);
          continue;
        }
        // Timed out.
        return false;
      }
      // Other open error (e.g. EPERM, ENOENT for missing ancestor) → not available.
      return false;
    }

    // Successfully acquired — release immediately (this is a probe, not a payload lock).
    try {
      fs.closeSync(fd);
    } catch (_e) {}
    try {
      fs.unlinkSync(lockPath);
    } catch (_e) {}

    return true;
  }

  return false;
}

module.exports = { isLockAvailable };
