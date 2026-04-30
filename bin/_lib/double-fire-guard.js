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
 * v2.2.15 FN-47: when the same dedup_key has fired >FN47_FIRE_THRESHOLD times
 * within a tight delta_ms window in the same session, the guard now ALSO
 * skips the second-caller path entirely (returning shouldFire=false) and
 * stages a one-shot SessionStart warning sentinel
 * `.orchestray/state/double-fire-warn-pending.json` that bin/release-manager/
 * dual-install-parity-check.js (and any other SessionStart consumer) can
 * surface to the operator. Per `feedback_update_both_installs.md` the user
 * must ALWAYS see this when both installs are racing — silent dedup is the
 * v2.2.6 footgun this finding closes.
 *
 * Kill switches:
 *   - ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1 — full bypass (legacy).
 *   - ORCHESTRAY_DOUBLE_FIRE_SKIP_GATE_DISABLED=1 — disables the FN-47 skip
 *     branch (counter still ticks; SessionStart warn still stages; no skip).
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

// ---------------------------------------------------------------------------
// FN-47 — fast-fire skip threshold.
// When the SAME dedup_key has been observed >FN47_FIRE_THRESHOLD times within
// a delta_ms < FN47_DELTA_MS_MAX window (per orchestration), we stop
// pretending one fire is correct: skip the second-caller path entirely AND
// stage a one-shot SessionStart warning sentinel.
// ---------------------------------------------------------------------------
const FN47_FIRE_THRESHOLD = 5;
const FN47_DELTA_MS_MAX   = 100;

/**
 * Stage a one-shot SessionStart warning by writing the sentinel file
 * `.orchestray/state/double-fire-warn-pending.json`. Idempotent — overwrites
 * with the latest payload. Failures are silent (fail-open).
 *
 * @param {string} stateDir
 * @param {object} payload
 */
function stageSessionStartWarn(stateDir, payload) {
  try {
    const path = require('path');
    const fs   = require('fs');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'double-fire-warn-pending.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  } catch (_e) { /* fail-open */ }
}

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
      const deltaMs = nowMs - existing.ts_ms;

      // FN-47 (v2.2.15): count how many times this dedup_key has fired in
      // this orchestration with delta_ms<FN47_DELTA_MS_MAX. If we exceed the
      // threshold the install pair is racing for real — skip the second-caller
      // path and stage a SessionStart warning.
      const fastFireCount = activeEntries.filter(
        e => e.dedup_key === dedupKey &&
             e.orchestration_id === orchId &&
             typeof e.ts_ms === 'number' &&
             nowMs - e.ts_ms <= FN47_DELTA_MS_MAX * FN47_FIRE_THRESHOLD * 4
      ).length;

      const skipDisabled = process.env.ORCHESTRAY_DOUBLE_FIRE_SKIP_GATE_DISABLED === '1';

      // FN-47 spec wording: ">5 dedup_key repeats AND delta_ms<100" — strict
      // greater-than threshold (was `>=` in the initial impl; W9 F-6 corrects).
      if (fastFireCount > FN47_FIRE_THRESHOLD && deltaMs < FN47_DELTA_MS_MAX && !skipDisabled) {
        // Stage a one-shot SessionStart warning regardless of suppression cache state.
        stageSessionStartWarn(stateDir, {
          version:           1,
          ts_ms:             nowMs,
          guard_name:        guardName,
          dedup_key:         dedupKey,
          orchestration_id:  orchId,
          fast_fire_count:   fastFireCount,
          delta_ms:          deltaMs,
          first_caller:      existing.caller_path,
          second_caller:     callerPath,
          message:           'Double-fire racing detected: install pair is firing the same hook ' +
                             'rapidly. See feedback_update_both_installs.md — ensure /orchestray:update ' +
                             'updated BOTH the global (~/.claude/) and local (.claude/) installs.',
        });
      }

      // Check module-scope suppression cache (Issue D: cross-spawn persistence).
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
        delta_ms:         deltaMs,
        first_caller:     existing.caller_path,
        second_caller:    callerPath,
        fast_fire_count:  fastFireCount,
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

module.exports = {
  requireGuard,
  // FN-47 exports for testability.
  stageSessionStartWarn,
  FN47_FIRE_THRESHOLD,
  FN47_DELTA_MS_MAX,
};
