'use strict';

// NOTE: crashes while holding the lock leave an orphaned .lock file. The next
// caller self-heals: lockfiles older than 10 seconds are treated as stale,
// unlinked, and the lock is retried immediately.

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
 *   - Retries up to 10 times with 50ms sleeps if the lockfile already exists.
 *   - If all retries fail, falls back to a plain `fs.appendFileSync` and logs
 *     a warning to stderr so operators can see it in the hook log.
 *   - Always releases the lock in a `finally` block.
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
 */

const fs = require('fs');
const path = require('path');

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MS = 50;

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

function atomicAppendJsonl(filePath, eventObject) {
  const line = JSON.stringify(eventObject) + '\n';
  // Predictable `.lock` suffix is acceptable for a single-user local plugin:
  // the audit directory has the same trust boundary as the hook process.
  // Stale locks are recovered after 10 × 50ms timeout. If the plugin is ever
  // used on a shared filesystem or multi-user system, replace with
  // fs.mkdtempSync-based locking. Per T14 audit.
  const lockPath = filePath + '.lock';

  // Ensure the parent directory exists before attempting to open the lockfile.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_e) {
    // Swallow — the append below will surface any real permission issues.
  }

  let fd = null;
  let lockErr = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      lockErr = null;
      break;
    } catch (err) {
      lockErr = err;
      if (err && err.code === 'EEXIST') {
        // Stale-lock recovery: if the lockfile is older than 10 seconds
        // (two orders of magnitude above any legitimate append duration),
        // assume the previous holder crashed and reclaim it immediately.
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 10_000) {
            try { fs.unlinkSync(lockPath); } catch (_e) {}
            continue;
          }
        } catch (_e) {
          continue;
        }
        if (attempt < MAX_LOCK_ATTEMPTS - 1) {
          sleepMs(LOCK_BACKOFF_MS);
          continue;
        }
      } else {
        // Unexpected error (e.g. EACCES) — fall through to fallback.
        break;
      }
    }
  }

  if (fd === null) {
    // All retries exhausted (or non-EEXIST error). Fall back to non-atomic
    // append so the event is not lost. Do NOT recurse. Surface the underlying
    // error code so operators can distinguish contention from permission bugs.
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
    try {
      fs.closeSync(fd);
    } catch (_e) {
      // Swallow — we still need to try to unlink the lockfile.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error('[orchestray] failed to unlink lockfile: ' + err.message);
      }
    }
  }
}

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
 */
function atomicAppendJsonlIfAbsent(filePath, row, matchFn) {
  const lockPath = filePath + '.lock';

  // Ensure parent directory exists.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_e) { /* swallow */ }

  let fd = null;
  let lockErr = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      lockErr = null;
      break;
    } catch (err) {
      lockErr = err;
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 10_000) {
            try { fs.unlinkSync(lockPath); } catch (_e) {}
            continue;
          }
        } catch (_e) {
          continue;
        }
        if (attempt < MAX_LOCK_ATTEMPTS - 1) {
          sleepMs(LOCK_BACKOFF_MS);
          continue;
        }
      } else {
        break;
      }
    }
  }

  if (fd === null) {
    // Lock acquire failed — fall back to a plain non-atomic append so the
    // event is not lost.  The idempotency guarantee is weakened, but this
    // matches the fail-open philosophy throughout.
    console.error(
      '[orchestray] atomicAppendJsonlIfAbsent: lock acquire failed (' +
      ((lockErr && lockErr.code) || 'unknown') +
      '); falling back to non-atomic append for ' + filePath
    );
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n');
    return true;
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
    try { fs.closeSync(fd); } catch (_e) {}
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error('[orchestray] atomicAppendJsonlIfAbsent: failed to unlink lockfile: ' + err.message);
      }
    }
  }
}

module.exports = { atomicAppendJsonl, atomicAppendJsonlIfAbsent, MAX_JSONL_READ_BYTES };
