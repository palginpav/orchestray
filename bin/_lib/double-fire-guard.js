'use strict';

/**
 * double-fire-guard.js — Generalized file-backed dedup guard for double hook
 * registration (v2.2.8 Item 4 + Issue D).
 *
 * Tracks dedup keys in `.orchestray/state/<guardName>-dedup.jsonl` with a
 * configurable TTL. If the same dedup_key is seen from a different caller_path
 * within the TTL window, it is a double-fire event.
 *
 * Per-orchestration suppression: emit hook_double_fire_detected ONCE per
 * (orchestrationId, guardName, dedupKey) tuple. The suppression cache is a
 * module-scope Map — NOT per-spawn-scoped — so it persists across require()
 * calls within the same Node.js process. This is the Issue D fix: prior
 * per-file suppression only tracked "was it written to the journal?" which
 * did not survive process restarts and did not cover rapid same-process
 * double-fires without journal round-trips.
 *
 * Kill switch: ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1 bypasses guard entirely.
 *
 * Fail-safe: any I/O error → shouldFire = true (fail-open) so the hook is not
 * silently killed by a probe failure.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Module-scope suppression cache (Issue D fix: cross-spawn persistence).
// Key: "<orchestrationId>|<guardName>|<dedupKey>"
// Value: true (detected, suppressed)
// ---------------------------------------------------------------------------
const _suppressionCache = new Map();

/**
 * Build the module-scope suppression cache key.
 *
 * @param {string} orchestrationId
 * @param {string} guardName
 * @param {string} dedupKey
 * @returns {string}
 */
function suppressionKey(orchestrationId, guardName, dedupKey) {
  return orchestrationId + '|' + guardName + '|' + dedupKey;
}

// ---------------------------------------------------------------------------
// JSONL journal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the per-guard dedup JSONL file.
 *
 * @param {string} stateDir — path to `.orchestray/state/`
 * @param {string} guardName
 * @returns {string}
 */
function dedupFilePath(stateDir, guardName) {
  return path.join(stateDir, guardName + '-dedup.jsonl');
}

/**
 * Read and parse unexpired dedup entries from the JSONL file.
 * Returns an empty array on any I/O or parse error.
 *
 * @param {string} filePath
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {Array<{dedup_key: string, ts_ms: number, caller_path: string, orchestration_id?: string}>}
 */
function readActiveEntries(filePath, nowMs, ttlMs) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const out = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.dedup_key === 'string' && typeof entry.ts_ms === 'number') {
          if (nowMs - entry.ts_ms <= ttlMs) {
            out.push(entry);
          }
        }
      } catch (_e) { /* skip malformed lines */ }
    }
    return out;
  } catch (_e) {
    return [];
  }
}

/**
 * Rewrite the dedup file with only the active (unexpired) entries.
 * Keeps the file bounded; called before appending a new entry.
 *
 * @param {string} filePath
 * @param {Array<object>} activeEntries
 */
function rewriteActiveEntries(filePath, activeEntries) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const content = activeEntries.map(e => JSON.stringify(e)).join('\n') +
                    (activeEntries.length > 0 ? '\n' : '');
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (_e) { /* fail-open */ }
}

/**
 * Append a single new entry to the dedup file using O_APPEND for atomicity.
 *
 * @param {string} filePath
 * @param {object} entry
 */
function appendEntry(filePath, entry) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check for double-fire and register the current invocation.
 *
 * @param {object} params
 * @param {string}  params.guardName        — name of this guard (e.g. "compose-block-a")
 * @param {string}  params.dedupKey         — unique key for this event (e.g. "orchId:turnId:block_a")
 * @param {number}  [params.ttlMs]          — dedup window in ms (default: 60000)
 * @param {string}  params.stateDir         — path to `.orchestray/state/`
 * @param {string}  params.callerPath       — __filename of the calling hook script
 * @param {string}  [params.orchestrationId] — current orchestration_id for per-orch suppression
 * @returns {{
 *   shouldFire:       boolean,
 *   doubleFireEvent:  object|null
 * }}
 */
function requireGuard({ guardName, dedupKey, ttlMs, stateDir, callerPath, orchestrationId }) {
  // Kill switch: bypass entirely when env var set (diagnostic mode).
  if (process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD === '1') {
    return { shouldFire: true, doubleFireEvent: null };
  }

  try {
    if (!stateDir || typeof stateDir !== 'string') {
      return { shouldFire: true, doubleFireEvent: null };
    }
    if (!guardName || typeof guardName !== 'string') {
      return { shouldFire: true, doubleFireEvent: null };
    }

    const effectiveTtlMs = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : 60 * 1000;
    const filePath = dedupFilePath(stateDir, guardName);
    const nowMs = Date.now();
    const orchId = orchestrationId || 'unknown';

    // Read active (unexpired) entries
    const activeEntries = readActiveEntries(filePath, nowMs, effectiveTtlMs);

    // Sweep and rewrite to keep file bounded
    rewriteActiveEntries(filePath, activeEntries);

    // Check for same dedup_key with different caller_path within window
    const existing = activeEntries.find(
      e => e.dedup_key === dedupKey && e.caller_path !== callerPath
    );

    if (existing) {
      // Check module-scope suppression cache first (Issue D: cross-spawn persistence).
      const sk = suppressionKey(orchId, guardName, dedupKey);
      if (_suppressionCache.has(sk)) {
        // Already detected and reported for this orchestration — suppress silently.
        return { shouldFire: false, doubleFireEvent: null };
      }

      // Mark in module-scope cache so subsequent spawns in the same process don't re-report.
      _suppressionCache.set(sk, true);

      // Also record in the journal file for cross-process suppression.
      const suppressEntry = {
        dedup_key:            dedupKey,
        ts_ms:                nowMs,
        caller_path:          callerPath,
        orchestration_id:     orchId,
        double_fire_reported: true,
      };
      appendEntry(filePath, suppressEntry);

      const doubleFireEvent = {
        type:             'hook_double_fire_detected',
        event_type:       'hook_double_fire_detected',
        schema_version:   1,
        version:          1,
        timestamp:        new Date(nowMs).toISOString(),
        orchestration_id: orchId,
        guard_name:       guardName,
        dedup_key:        dedupKey,
        delta_ms:         nowMs - existing.ts_ms,
        first_caller:     existing.caller_path,
        second_caller:    callerPath,
      };

      return { shouldFire: false, doubleFireEvent };
    }

    // Also check journal for cross-process suppression of already-reported double fires.
    // If a journal entry has double_fire_reported: true for this (orchId, dedupKey), populate
    // the module-scope cache and suppress without re-emitting.
    const journalSuppressed = activeEntries.some(
      e => e.dedup_key === dedupKey &&
           e.orchestration_id === orchId &&
           e.double_fire_reported === true
    );
    if (journalSuppressed) {
      const sk = suppressionKey(orchId, guardName, dedupKey);
      _suppressionCache.set(sk, true);
      return { shouldFire: false, doubleFireEvent: null };
    }

    // No existing match — register this invocation
    const newEntry = {
      dedup_key:        dedupKey,
      ts_ms:            nowMs,
      caller_path:      callerPath,
      orchestration_id: orchId,
    };
    appendEntry(filePath, newEntry);

    return { shouldFire: true, doubleFireEvent: null };
  } catch (_e) {
    // Fail-open: if the guard itself errors, allow the hook to proceed
    return { shouldFire: true, doubleFireEvent: null };
  }
}

module.exports = { requireGuard };
