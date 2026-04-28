'use strict';

/**
 * double-fire-guard.js — File-backed dedup guard for double hook registration (W4 §B3 / event 6).
 *
 * Tracks dedup tokens in `.orchestray/state/tokenwright-dedup.jsonl` with a
 * 60-second TTL. If the same dedup_token is seen from a different caller_path
 * within the TTL window, it is a double-fire event.
 *
 * Also enforces per-orchestration suppression: once a double-fire event has been
 * detected for a given orchestration_id + dedup_token, subsequent detections are
 * suppressed (one event per pair per orchestration).
 *
 * Fail-safe: all I/O wrapped in try/catch. On any error, defaults to shouldFire: true
 * (fail-open) so the hook is not silently killed by a probe failure.
 */

const fs   = require('fs');
const path = require('path');

/** TTL for dedup entries in milliseconds. */
const DEDUP_TTL_MS = 60 * 1000;

/**
 * Resolve the path to the dedup JSONL file.
 *
 * @param {string} stateDir — path to `.orchestray/state/`
 * @returns {string}
 */
function dedupFilePath(stateDir) {
  return path.join(stateDir, 'tokenwright-dedup.jsonl');
}

/**
 * Read and parse unexpired dedup entries from the JSONL file.
 * Returns an empty array on any I/O or parse error.
 *
 * @param {string} filePath
 * @param {number} nowMs
 * @returns {Array<{dedup_token: string, ts_ms: number, caller_path: string, orchestration_id?: string}>}
 */
function readActiveEntries(filePath, nowMs) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const out = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.dedup_token === 'string' && typeof entry.ts_ms === 'number') {
          if (nowMs - entry.ts_ms <= DEDUP_TTL_MS) {
            out.push(entry);
          }
        }
      } catch (_e) { /* skip malformed */ }
    }
    return out;
  } catch (_e) {
    return [];
  }
}

/**
 * Rewrite the dedup file with only the active (unexpired) entries.
 * Used to sweep stale entries before appending, to keep the file bounded.
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

/**
 * Check for double-fire and register the current invocation.
 *
 * @param {object} params
 * @param {string}  params.dedupToken      — unique token for this spawn (e.g., "agent_type:spawn_key:ts")
 * @param {string}  params.callerPath      — __filename of the calling hook script
 * @param {string}  params.stateDir        — path to `.orchestray/state/`
 * @param {string}  [params.orchestrationId] — current orchestration_id for per-orch suppression
 * @returns {{
 *   shouldFire:       boolean,
 *   doubleFireEvent:  object|null
 * }}
 */
function checkDoubleFire({ dedupToken, callerPath, stateDir, orchestrationId }) {
  try {
    if (!stateDir || typeof stateDir !== 'string') {
      return { shouldFire: true, doubleFireEvent: null };
    }

    const filePath = dedupFilePath(stateDir);
    const nowMs    = Date.now();

    // Read active (unexpired) entries
    const activeEntries = readActiveEntries(filePath, nowMs);

    // Sweep and rewrite to keep file bounded
    rewriteActiveEntries(filePath, activeEntries);

    // Check for same dedup_token with different caller_path
    const existing = activeEntries.find(
      e => e.dedup_token === dedupToken && e.caller_path !== callerPath
    );

    if (existing) {
      // Check per-orchestration suppression: only emit once per orchestration_id + dedup_token
      const orchId = orchestrationId || 'unknown';
      const alreadySuppressed = activeEntries.some(
        e => e.dedup_token === dedupToken &&
             e.caller_path === callerPath &&
             e.orchestration_id === orchId &&
             e.double_fire_reported === true
      );

      if (alreadySuppressed) {
        // Still suppress the second fire but don't emit another event
        return { shouldFire: false, doubleFireEvent: null };
      }

      // Mark this detection in the dedup file to suppress future events
      const suppressEntry = {
        dedup_token:          dedupToken,
        ts_ms:                nowMs,
        caller_path:          callerPath,
        orchestration_id:     orchId,
        double_fire_reported: true,
      };
      appendEntry(filePath, suppressEntry);

      const doubleFireEvent = {
        type:             'compression_double_fire_detected',
        event_type:       'compression_double_fire_detected',
        schema_version:   1,
        version:          1,
        timestamp:        new Date(nowMs).toISOString(),
        orchestration_id: orchId,
        dedup_token:      dedupToken,
        delta_ms:         nowMs - existing.ts_ms,
        first_caller:     existing.caller_path,
        second_caller:    callerPath,
      };

      return { shouldFire: false, doubleFireEvent };
    }

    // No existing match — register this invocation
    const newEntry = {
      dedup_token:      dedupToken,
      ts_ms:            nowMs,
      caller_path:      callerPath,
      orchestration_id: orchestrationId || 'unknown',
    };
    appendEntry(filePath, newEntry);

    return { shouldFire: true, doubleFireEvent: null };
  } catch (_e) {
    // Fail-open: if the guard itself errors, allow the hook to proceed
    return { shouldFire: true, doubleFireEvent: null };
  }
}

module.exports = { checkDoubleFire };
