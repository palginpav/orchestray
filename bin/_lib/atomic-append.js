'use strict';

// NOTE: crashes while holding the lock leave an orphaned .lock file. The next
// caller self-heals: the lock file records the holder's PID so reclaim first
// verifies the PID is dead (ESRCH) before unlinking. Falls back to mtime-only
// reclaim (>10 s) when the lock content is unreadable.

/**
 * Atomic JSONL append helper.
 *
 * Linux guarantees atomic O_APPEND only for writes smaller than PIPE_BUF
 * (4096 bytes). Team events or agent_stop events with large payloads can
 * exceed that threshold, so concurrent hook invocations
 * (e.g. SubagentStop + TaskCompleted firing simultaneously) could interleave
 * JSONL lines in .orchestray/audit/events.jsonl.
 *
 * This helper serializes writes via an advisory lockfile:
 *   - Attempts to create `<filePath>.lock` using O_EXCL (`fs.openSync(..., 'wx')`).
 *   - Writes the holder's PID into the lock file for stale-reclaim verification.
 *   - Retries up to 10 times with 50ms sleeps if the lockfile already exists.
 *   - If all retries fail, falls back to a plain `fs.appendFileSync` and logs
 *     a warning to stderr so operators can see it in the hook log.
 *   - Always releases the lock in a `finally` block.
 *
 * BUG-7 tightening: the fail-open fallback is kept for atomicAppendJsonl
 * (plain single-line appends where O_APPEND atomicity covers <PIPE_BUF rows).
 * For atomicAppendJsonlIfAbsent (idempotency) and _withAdvisoryLock (full RMW),
 * contention at max-retries skips the operation with a stderr warning rather
 * than running unlocked, preserving correctness invariants.
 *
 * BUG-8 fix: lock reclaim verifies the recorded PID is dead before unlink.
 *
 * Exports:
 *   atomicAppendJsonl(filePath, eventObject)
 *     Unconditionally append one JSON line to filePath under the advisory lock.
 *
 *   atomicAppendJsonlIfAbsent(filePath, row, matchFn)
 *     Acquire the same advisory lock, read the file (up to MAX_JSONL_READ_BYTES),
 *     parse each line as JSON, and call matchFn(parsed) for each.  If any line
 *     satisfies matchFn, release the lock and return false (row already present,
 *     not appended).  If no line matches, append the row under the lock and
 *     return true.  Fail-open on malformed JSON lines (skip) and on a missing
 *     file (treat as no-match, append).  On oversize file (> MAX_JSONL_READ_BYTES)
 *     emit a stderr warning and return false (fail-open: do not double-append).
 *     On lock-acquire failure: skip the op (fail-closed) and emit stderr warning.
 *
 *   _withAdvisoryLock(lockPath, fn)
 *     Acquire advisory lock, run fn() synchronously, release.
 *     On lock-acquire failure: skip fn (fail-closed) and emit stderr warning.
 *     Returns { skipped: true } when fn() was not called; otherwise fn()'s value.
 *
 *   atomicWriteFile(filePath, content)
 *     Write content atomically via tmp+rename. No lock — use _withAdvisoryLock
 *     around the caller when cross-process serialization is also required.
 */

const fs = require('fs');
const path = require('path');

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MS = 50;
// Stale threshold: mtime fallback when PID can't be read from the lock file.
const STALE_LOCK_MS = 10_000;

/**
 * Maximum number of bytes read from a JSONL file before failing open.
 * Mirrors the 2.0.11 stdin cap philosophy (T14 audit I14 / A2 LOW-1).
 * Override in tests via the MAX_JSONL_READ_BYTES_OVERRIDE environment variable.
 */
const MAX_JSONL_READ_BYTES = process.env.MAX_JSONL_READ_BYTES_OVERRIDE
  ? Number(process.env.MAX_JSONL_READ_BYTES_OVERRIDE)
  : 10 * 1024 * 1024;

function sleepMs(ms) {
  try {
    // Atomics.wait is stdlib in Node 20 and gives a true synchronous sleep
    // without burning CPU.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    // Fallback busy-wait if Atomics/SharedArrayBuffer is unavailable.
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin */ }
  }
}

/**
 * BUG-8: Check whether a lock file is stale. Reads the PID from the lock
 * content and verifies it is dead. Falls back to mtime-only check when the
 * content is unreadable or not a valid PID.
 *
 * @param {string} lockPath
 * @returns {boolean} true if the lock is stale and safe to reclaim
 */
function _isLockStale(lockPath) {
  try {
    const st = fs.statSync(lockPath);
    // Read the PID from the lock file content.
    let holderPid = null;
    try {
      const content = fs.readFileSync(lockPath, 'utf8').trim();
      if (/^\d+$/.test(content)) holderPid = parseInt(content, 10);
    } catch (_e) { /* unreadable — fall back to mtime */ }

    if (holderPid !== null && holderPid !== process.pid) {
      // Verify the recorded PID is dead.
      try {
        process.kill(holderPid, 0);
        // PID is alive → not stale (holder is live-but-slow).
        return false;
      } catch (killErr) {
        if (killErr && killErr.code === 'ESRCH') {
          // PID not found → holder is dead → stale, safe to reclaim.
          return true;
        }
        // EPERM: PID exists but we lack permissions to signal it → treat as alive.
        return false;
      }
    }

    // Fallback: no readable PID — use mtime threshold.
    return Date.now() - st.mtimeMs > STALE_LOCK_MS;
  } catch (_e) {
    // statSync failed (e.g. lock was just deleted) — treat as not stale.
    return false;
  }
}

/**
 * Shared lock-acquire loop. Returns { fd, lockErr } where fd is non-null on success.
 * Writes the holder's PID into the lock file for stale-reclaim verification.
 */
function _acquireLockFd(lockPath) {
  let fd = null;
  let lockErr = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      lockErr = null;
      // BUG-8: write PID so stale-reclaim can verify liveness.
      try { fs.writeFileSync(lockPath, String(process.pid), 'utf8'); } catch (_e) {}
      break;
    } catch (err) {
      lockErr = err;
      if (err && err.code === 'EEXIST') {
        // Stale-lock recovery (BUG-8): verify via PID liveness, fallback to mtime.
        if (_isLockStale(lockPath)) {
          try { fs.unlinkSync(lockPath); } catch (_e) {}
          continue;
        }
        if (attempt < MAX_LOCK_ATTEMPTS - 1) {
          sleepMs(LOCK_BACKOFF_MS);
          continue;
        }
      } else {
        // Unexpected error (e.g. EACCES) — fall through to caller.
        break;
      }
    }
  }
  return { fd, lockErr };
}

/**
 * Release: close + unlink the lock fd.
 */
function _releaseLockFd(fd, lockPath, label) {
  try { fs.closeSync(fd); } catch (_e) {}
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write('[orchestray] ' + label + ': failed to unlink lockfile: ' + err.message + '\n');
    }
  }
}

// ---------------------------------------------------------------------------
// atomicAppendJsonl — fail-open (plain append) on lock failure (liveness).
// ---------------------------------------------------------------------------

function atomicAppendJsonl(filePath, eventObject) {
  const line = JSON.stringify(eventObject) + '\n';
  // Predictable `.lock` suffix is acceptable for a single-user local plugin.
  const lockPath = filePath + '.lock';

  // Ensure the parent directory exists before attempting to open the lockfile.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_e) {
    // Swallow — the append below will surface any real permission issues.
  }

  const { fd, lockErr } = _acquireLockFd(lockPath);

  if (fd === null) {
    // All retries exhausted (or non-EEXIST error). Fall back to non-atomic
    // append so the event is not lost. Do NOT recurse. Surface the underlying
    // error code so operators can distinguish contention from permission bugs.
    // BUG-7: keep fail-open here — plain single-line appends are safe via
    // O_APPEND atomicity for <PIPE_BUF payloads.
    console.error(
      '[orchestray] lock acquire failed (' +
      ((lockErr && lockErr.code) || 'unknown') +
      '); falling back to non-atomic append for ' + filePath
    );
    fs.appendFileSync(filePath, line);
    return;
  }

  try {
    fs.appendFileSync(filePath, line);
  } finally {
    _releaseLockFd(fd, lockPath, 'atomicAppendJsonl');
  }
}

// ---------------------------------------------------------------------------
// atomicAppendJsonlIfAbsent — fail-closed on lock failure (idempotency).
// ---------------------------------------------------------------------------

/**
 * Acquire the advisory lock for filePath, read the file line-by-line
 * (up to MAX_JSONL_READ_BYTES), and append `row` only if no existing line
 * satisfies `matchFn`.
 *
 * @param {string}   filePath - Target JSONL file
 * @param {Object}   row      - Event object to conditionally append
 * @param {Function} matchFn  - (parsedLine: Object) => boolean
 * @returns {boolean} true if the row was appended, false if already present
 *                    (or if the file was too large — fail-open, no append)
 *                    false if lock could not be acquired (fail-closed, skip)
 */
function atomicAppendJsonlIfAbsent(filePath, row, matchFn) {
  const lockPath = filePath + '.lock';

  // Ensure parent directory exists.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_e) { /* swallow */ }

  const { fd, lockErr } = _acquireLockFd(lockPath);

  if (fd === null) {
    // BUG-7: fail-closed for idempotency paths. Appending without the lock
    // would defeat the dedup guarantee. Emit a warning and skip the operation.
    process.stderr.write(
      '[orchestray] atomicAppendJsonlIfAbsent: lock acquire failed (' +
      ((lockErr && lockErr.code) || 'unknown') +
      '); skipping append (lock_contention_skipped) for ' + filePath + '\n'
    );
    return false;
  }

  try {
    // --- Size guard (A2 LOW-1) ---
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_JSONL_READ_BYTES) {
        process.stderr.write(
          '[orchestray] atomicAppendJsonlIfAbsent: file too large (' +
          stat.size + ' bytes > ' + MAX_JSONL_READ_BYTES + '); skipping read\n'
        );
        // Fail-open: do not append (avoid double-write on oversized file).
        return false;
      }
    } catch (statErr) {
      if (statErr && statErr.code !== 'ENOENT') {
        // Unexpected stat error — treat as missing file (no-match, append).
      }
      // ENOENT: file missing → no existing row can match → fall through to append.
    }

    // --- Read existing content inside the lock ---
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (_e) {
      // Missing or unreadable — treat as no-match, append.
    }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_e) {
        continue; // Malformed line — skip silently (fail-open)
      }
      if (matchFn(parsed)) {
        // Already present — do not append.
        return false;
      }
    }

    // Not found — append under the lock.
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n');
    return true;
  } finally {
    _releaseLockFd(fd, lockPath, 'atomicAppendJsonlIfAbsent');
  }
}

// ---------------------------------------------------------------------------
// _withAdvisoryLock — fail-closed for RMW paths (BUG-7).
// ---------------------------------------------------------------------------

/**
 * Acquire the advisory lock on `lockPath`, run `fn()` synchronously, then
 * release the lock. Returns the value returned by fn().
 *
 * BUG-7 fix: if the lock cannot be acquired, fn() is NOT called (fail-closed).
 * Returns { skipped: true } in that case and emits a stderr warning with
 * 'lock_contention_skipped'. This preserves correctness for RMW callers
 * (context-telemetry-cache, spawn-requests drain, config writes).
 *
 * Contrast with atomicAppendJsonl (fail-open) which is safe because
 * O_APPEND atomicity covers <PIPE_BUF single-line appends.
 *
 * @param {string}   lockPath - Path for the advisory lock file (e.g. "<target>.lock")
 * @param {Function} fn       - Zero-argument synchronous function to run under the lock.
 * @returns {*} Return value of fn(), or { skipped: true } if lock not acquired.
 */
function _withAdvisoryLock(lockPath, fn) {
  // Ensure parent directory exists.
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (_e) { /* swallow */ }

  const { fd, lockErr } = _acquireLockFd(lockPath);

  if (fd === null) {
    // BUG-7: fail-closed — do not run fn() without the lock for RMW operations.
    process.stderr.write(
      '[orchestray] _withAdvisoryLock: lock acquire failed (' +
      ((lockErr && lockErr.code) || 'unknown') +
      ') for ' + lockPath + '; skipping fn (lock_contention_skipped)\n'
    );
    return { skipped: true };
  }

  try {
    return fn();
  } finally {
    _releaseLockFd(fd, lockPath, '_withAdvisoryLock');
  }
}

// ---------------------------------------------------------------------------
// atomicWriteFile — tmp+rename for tear-free file rewrites (BUG-3 helper).
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath` atomically using a pid-stamped tmp file and
 * fs.renameSync. Readers always see either the old or new complete content.
 *
 * Does NOT acquire an advisory lock — wrap with _withAdvisoryLock when
 * cross-process serialization is also required (e.g. config.json writes).
 *
 * @param {string} filePath - Destination path
 * @param {string} content  - Content to write
 */
function atomicWriteFile(filePath, content) {
  const tmp = filePath + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) {}
    throw err;
  }
}

module.exports = {
  atomicAppendJsonl,
  atomicAppendJsonlIfAbsent,
  _withAdvisoryLock,
  atomicWriteFile,
  MAX_JSONL_READ_BYTES,
};
