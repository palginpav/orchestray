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
 * BUG-8 parity: stale-lock reclaim now verifies the recorded PID is dead (ESRCH) before
 * unlinking. Falls back to mtime-only reclaim when the lock content is unreadable.
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
 * BUG-8 parity: check whether a probe lock file is stale. Reads the PID from
 * the lock content and verifies it is dead via process.kill(pid, 0). Falls back
 * to mtime-only threshold when the content is unreadable.
 *
 * @param {string} lp - Lock file path.
 * @returns {boolean} true if the lock is stale and safe to reclaim.
 */
function _isStale(lp) {
  try {
    const st = fs.statSync(lp);
    let holderPid = null;
    try {
      const content = fs.readFileSync(lp, 'utf8').trim();
      if (/^\d+$/.test(content)) holderPid = parseInt(content, 10);
    } catch (_e) { /* unreadable — fall back to mtime */ }

    if (holderPid !== null && holderPid !== process.pid) {
      try {
        process.kill(holderPid, 0);
        // PID alive → holder is live-but-slow → not stale.
        return false;
      } catch (killErr) {
        if (killErr && killErr.code === 'ESRCH') return true; // dead → stale
        // EPERM: exists but no permission to signal → treat as alive.
        return false;
      }
    }

    // Fallback: no readable PID — use mtime threshold.
    return Date.now() - st.mtimeMs > STALE_THRESHOLD_MS;
  } catch (_e) {
    // statSync failed (lock was just deleted) — treat as not stale.
    return false;
  }
}

/**
 * Check whether an advisory lock file can be acquired, then immediately release it.
 *
 * Uses the same stale-lock detection as _withAdvisoryLock (BUG-8 parity): if the
 * lock file exists, the holder PID is read from its content and verified dead via
 * process.kill(pid, 0) / ESRCH before reclaiming. Falls back to mtime-only check
 * (> STALE_THRESHOLD_MS) when the content is unreadable.
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
        // BUG-8 parity: verify PID liveness before falling back to mtime reclaim.
        if (_isStale(lockPath)) {
          try { fs.unlinkSync(lockPath); } catch (_e) {}
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

    // Successfully acquired — write PID (matches atomic-append.js convention) then
    // release immediately (this is a probe, not a payload lock).
    try { fs.writeFileSync(lockPath, String(process.pid), 'utf8'); } catch (_e) {}
    try { fs.closeSync(fd); } catch (_e) {}
    try { fs.unlinkSync(lockPath); } catch (_e) {}

    return true;
  }

  return false;
}

module.exports = { isLockAvailable };
