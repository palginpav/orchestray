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
 */

const fs = require('fs');
const path = require('path');

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MS = 50;

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

module.exports = { atomicAppendJsonl };
