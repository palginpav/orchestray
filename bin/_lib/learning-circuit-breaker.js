'use strict';

/**
 * learning-circuit-breaker.js — Concurrency-safe per-scope extraction rate limiter.
 *
 * Implements the circuit breaker from v2.1.6 design §6.4:
 *   - State file: .orchestray/state/learning-breaker-{scope}.json
 *   - Read-modify-write wrapped in _withAdvisoryLock (F-02 fix)
 *   - Corrupt counter file → fail-closed (F-04 fix)
 *   - Separate sentinel file for trip state that survives counter deletion (F-04 fix)
 *   - Tripped sentinel: .orchestray/state/learning-breaker-{scope}.tripped
 *   - Shadow mode counts against the breaker (F-09: Haiku cost is real)
 *
 * v2.1.6 — W1 safety boundary.
 * v2.1.6 W1c — lock-probe replacement for stderr monkey-patch (W2-07 / Risk 2).
 *   _lockedRun now uses lock-probe.isLockAvailable() to detect lock contention
 *   before calling _withAdvisoryLock, instead of intercepting process.stderr.write.
 *   This removes the sync-only safety requirement and eliminates the cross-call
 *   contamination risk that would arise with async callers.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { writeEvent } = require('./audit-event-writer');
const { getCurrentOrchestrationFile } = require('./orchestration-state');
const { isLockAvailable } = require('./lock-probe');

// ---------------------------------------------------------------------------
// Breaker-specific lock constants
// ---------------------------------------------------------------------------

// Stale lock threshold: a lock file older than this is considered stale
// and is force-removed before retrying. Matches atomic-append.js convention.
const BREAKER_STALE_THRESHOLD_MS = 10_000; // 10 seconds

// Retry parameters for _withBreakerLock (exponential backoff).
const BREAKER_LOCK_MAX_RETRIES     = 20;
const BREAKER_LOCK_BASE_BACKOFF_MS = 25;
const BREAKER_LOCK_MAX_BACKOFF_MS  = 100;

const SCHEMA_VERSION = 1;
// Window for the rolling count (24 hours in ms)
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// v2.2.3 P0-3: cooldown auto-reset.
// Default cooldown if caller does not pass cooldownMs. Matches config-schema.js
// safety.circuit_breaker.cooldown_minutes_on_trip default (60 minutes).
// Hard ceiling at 24h ensures a stuck sentinel never persists past the rolling
// window: even with a misconfigured cooldown, the breaker self-heals daily.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;       // 60 minutes
const HARD_COOLDOWN_CEILING_MS = 24 * 60 * 60 * 1000; // 24h hard ceiling

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {string} scope
 * @returns {string}
 */
function _counterPath(cwd, scope) {
  return path.join(cwd, '.orchestray', 'state', `learning-breaker-${scope}.json`);
}

/**
 * @param {string} cwd
 * @param {string} scope
 * @returns {string}
 */
function _sentinelPath(cwd, scope) {
  return path.join(cwd, '.orchestray', 'state', `learning-breaker-${scope}.tripped`);
}

// ---------------------------------------------------------------------------
// Audit event emission
// ---------------------------------------------------------------------------

/**
 * Emit breaker_lock_contended when the lock probe detects unavailability.
 * Fail-open: never throws.
 *
 * W1c: replaced `fallback` field with `mechanism` ('lock_probe_failed') to
 * reflect the new probe-based detection instead of stderr interception.
 *
 * @param {string} cwd
 * @param {string} scope
 * @param {number} lockWaitMs
 */
function _emitLockContended(cwd, scope, lockWaitMs) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    writeEvent({
      timestamp: new Date().toISOString(),
      type: 'breaker_lock_contended',
      schema_version: 1,
      scope,
      mechanism: 'lock_probe_failed',
      wait_ms: lockWaitMs,
    }, { cwd });
  } catch (_e) {
    // Fail-open.
  }
}

/**
 * B4-04 fix: dedicated breaker lock that eliminates the TOCTOU carry-over from
 * the probe→_withAdvisoryLock gap.
 *
 * _withAdvisoryLock had a 10-retry fallback that ran fn() WITHOUT a lock on
 * exhaustion. Under cross-process contention, two callers could both probe free,
 * both exhaust retries, and both increment — defeating the cap. This primitive
 * removes that fallback entirely: it either acquires the lock or fails-closed.
 *
 * Algorithm:
 *   1. Try fs.openSync(lockPath, 'wx') — succeeds only if file does not exist.
 *   2. On failure (EEXIST): check mtime. If stale (> BREAKER_STALE_THRESHOLD_MS),
 *      force-remove and retry once. Otherwise back off and retry.
 *   3. After BREAKER_LOCK_MAX_RETRIES, return {allowed:false, reason:'lock_unavailable'}.
 *   4. On success, write own PID to the lock file (debugging aid), run fn(),
 *      release via fs.unlinkSync in finally.
 *
 * The lock-probe pre-check is kept as defense-in-depth + early observability:
 * it emits breaker_lock_contended sooner so operators see contention before
 * this primitive's retry loop runs.
 *
 * @param {string} lockPath
 * @param {Function} fn
 * @param {string} cwd
 * @param {string} scope
 * @param {object} [opts]
 * @param {number} [opts.lockMaxWaitMs] - Hard wall-clock limit; default ~1s.
 * @returns {*} fn() result, OR {allowed:false, reason:'lock_unavailable'} if lock fails
 */
function _withBreakerLock(lockPath, fn, cwd, scope, opts) {
  const maxWallMs = (opts && typeof opts.lockMaxWaitMs === 'number') ? opts.lockMaxWaitMs : 1000;
  const start = Date.now();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let attempts = 0;
  let staleTried = false;

  while (attempts < BREAKER_LOCK_MAX_RETRIES) {
    if (Date.now() - start > maxWallMs) break;

    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        // Unexpected error acquiring lock → fail-closed.
        return { allowed: false, reason: 'lock_unavailable', count: 0, max: 0 };
      }
      // Lock file exists — check for staleness.
      if (!staleTried) {
        try {
          const stat = fs.statSync(lockPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > BREAKER_STALE_THRESHOLD_MS) {
            fs.unlinkSync(lockPath);
            staleTried = true;
            continue; // Retry immediately after stale removal.
          }
        } catch (_statErr) {
          // If stat fails, the lock was likely removed by its owner concurrently — retry.
        }
      }
      // Back off with exponential growth capped at BREAKER_LOCK_MAX_BACKOFF_MS.
      const backoffMs = Math.min(BREAKER_LOCK_BASE_BACKOFF_MS * Math.pow(2, attempts), BREAKER_LOCK_MAX_BACKOFF_MS);
      // Synchronous sleep — the breaker contract is sync-only (no async callers).
      const deadline = Date.now() + backoffMs;
      while (Date.now() < deadline) { /* busy wait */ }
      attempts += 1;
      continue;
    }

    // Lock acquired — write PID for debugging, run fn, release in finally.
    try {
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      fd = null;
      return fn();
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) { /* swallow */ }
      }
      try { fs.unlinkSync(lockPath); } catch (_) { /* stale removal race — ok */ }
    }
  }

  // All retries exhausted — fail closed. No fallback to lockless execution.
  return { allowed: false, reason: 'lock_unavailable', count: 0, max: 0 };
}

/**
 * _lockedRun: probe-first, then dedicated breaker lock.
 *
 * The probe pre-check emits breaker_lock_contended early for observability.
 * The actual lock is held by _withBreakerLock which has no lockless fallback.
 *
 * @param {string} lockPath
 * @param {Function} fn
 * @param {string} cwd
 * @param {string} scope
 * @param {object} [opts]
 * @returns {*} fn() result, OR {allowed:false, reason:'lock_unavailable'} if lock fails
 */
function _lockedRun(lockPath, fn, cwd, scope, opts) {
  const start = Date.now();

  // Pre-check: probe the lock for early observability (defense-in-depth).
  // If the lock is unavailable, emit event and fail-closed immediately
  // without entering _withBreakerLock's retry loop.
  if (!isLockAvailable(lockPath, { maxWaitMs: 500 })) {
    _emitLockContended(cwd, scope, Date.now() - start);
    return { allowed: false, reason: 'lock_unavailable', count: 0, max: 0 };
  }

  // Probe succeeded — acquire the dedicated breaker lock (no lockless fallback).
  return _withBreakerLock(lockPath, fn, cwd, scope, opts);
}

// ---------------------------------------------------------------------------
// Counter file read / write helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the counter file.
 *
 * Returns null if the file does not exist (first-run → fresh init).
 * Throws a special 'CORRUPT' error if the file exists but cannot be parsed.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function _readCounterFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    const e = new Error('unreadable counter file: ' + (err && err.message));
    e.code = 'CORRUPT';
    throw e;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (_e) {
    const e = new Error('unparseable counter file');
    e.code = 'CORRUPT';
    throw e;
  }
}

/**
 * Write counter state atomically (tmp + rename).
 *
 * @param {string} filePath
 * @param {object} state
 */
function _writeCounterFile(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Sentinel file helpers
// ---------------------------------------------------------------------------

/**
 * Write the trip sentinel file.
 *
 * @param {string} sentinelPath
 * @param {object} info - { scope, count, max, trippedAt }
 */
function _writeSentinel(sentinelPath, info) {
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  const tmp = sentinelPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8');
  fs.renameSync(tmp, sentinelPath);
}

/**
 * Read the trip sentinel file. Returns null if not present.
 *
 * @param {string} sentinelPath
 * @returns {object|null}
 */
function _readSentinel(sentinelPath) {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cooldown helpers (v2.2.3 P0-3)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective cooldown in ms from caller opts.
 *
 * Precedence:
 *   1. Explicit `cooldownMs` (number, > 0) — clamped at HARD_COOLDOWN_CEILING_MS.
 *   2. DEFAULT_COOLDOWN_MS (60 minutes) — matches config-schema default.
 *
 * Negative / zero / non-numeric values fall back to the default. Values above
 * the hard ceiling are clamped down. Caller config may pass either ms or
 * minutes; this helper treats the input as milliseconds (callers convert).
 *
 * @param {number|undefined} cooldownMs
 * @returns {number}
 */
function _resolveCooldownMs(cooldownMs) {
  if (typeof cooldownMs !== 'number' || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return DEFAULT_COOLDOWN_MS;
  }
  if (cooldownMs > HARD_COOLDOWN_CEILING_MS) return HARD_COOLDOWN_CEILING_MS;
  return cooldownMs;
}

/**
 * Check whether a sentinel's cooldown has expired and clear it on disk if so.
 *
 * Returns:
 *   - { expired: true, ageMs }  → caller must treat the breaker as RESET (cooldown elapsed).
 *   - { expired: false, ageMs } → caller must treat the breaker as TRIPPED.
 *   - { expired: false, ageMs: 0 } when sentinel has no parseable trippedAt.
 *
 * Side effects on expiry:
 *   - Removes the sentinel file (best-effort; ENOENT is fine).
 *   - Removes the counter file too so the next caller starts a fresh window
 *     instead of inheriting the over-cap count from the previous window.
 *   - Emits `learning_circuit_auto_reset` audit event (fail-open).
 *
 * Fail-open: any unexpected error returns { expired: false, ageMs: 0 } (treat as still tripped).
 *
 * @param {string} cwd
 * @param {string} scope
 * @param {object} sentinel - parsed sentinel object with trippedAt
 * @param {number} cooldownMs
 * @returns {{ expired: boolean, ageMs: number }}
 */
function _autoResetIfCooldownExpired(cwd, scope, sentinel, cooldownMs) {
  if (!sentinel || !sentinel.trippedAt) return { expired: false, ageMs: 0 };

  const trippedAtMs = Date.parse(sentinel.trippedAt);
  if (!Number.isFinite(trippedAtMs)) return { expired: false, ageMs: 0 };

  const now = Date.now();
  const ageMs = now - trippedAtMs;
  if (ageMs < cooldownMs) return { expired: false, ageMs };

  // Cooldown expired — clear sentinel + counter, emit audit event.
  const sPath = _sentinelPath(cwd, scope);
  const cPath = _counterPath(cwd, scope);
  try { fs.unlinkSync(sPath); } catch (_e) { /* best-effort */ }
  try { fs.unlinkSync(cPath); } catch (_e) { /* best-effort */ }

  try {
    let orchId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (data.orchestration_id) orchId = data.orchestration_id;
    } catch (_e) { /* ignore */ }

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    writeEvent({
      timestamp: new Date().toISOString(),
      type: 'learning_circuit_auto_reset',
      schema_version: 1,
      orchestration_id: orchId,
      scope,
      tripped_at: sentinel.trippedAt,
      age_ms: ageMs,
      cooldown_ms: cooldownMs,
      prior_reason: sentinel.reason || 'unknown',
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  return { expired: true, ageMs };
}

// ---------------------------------------------------------------------------
// Emit learning_circuit_tripped event (fail-open)
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {string} scope
 * @param {string} reason
 * @param {object} [extra]
 */
function _emitCircuitTripped(cwd, scope, reason, extra) {
  try {
    let orchId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (data.orchestration_id) orchId = data.orchestration_id;
    } catch (_e) { /* ignore */ }

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    writeEvent(Object.assign({
      timestamp: new Date().toISOString(),
      type: 'learning_circuit_tripped',
      schema_version: 1,
      orchestration_id: orchId,
      scope,
      reason,
    }, extra || {}), { cwd });
  } catch (_e) {
    // Fail-open.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the circuit allows another extraction, then increment the counter.
 *
 * Atomic read-modify-write under _withBreakerLock (B4-04 fix: no lockless fallback).
 *
 * @param {object} opts
 * @param {string} opts.scope           - Breaker scope (e.g. 'extract_on_complete').
 * @param {number} opts.max             - Maximum allowed counts within windowMs.
 * @param {number} [opts.windowMs]      - Rolling window in ms. Defaults to 24h.
 * @param {string} [opts.cwd]           - Project root. Defaults to process.cwd().
 * @param {number} [opts.lockMaxWaitMs] - Wall-clock limit for lock acquisition. Default ~1s.
 * @param {number} [opts.cooldownMs]    - v2.2.3 P0-3: cooldown before auto-reset of a tripped sentinel.
 *                                        Defaults to 60 minutes (matches config-schema default).
 *                                        Clamped to a 24h hard ceiling so the breaker self-heals daily.
 * @returns {{ allowed: true, count: number, max: number }
 *          | { allowed: false, reason: 'tripped' | 'counter_corrupt' | 'lock_unavailable', count: number, max: number }}
 */
function checkAndIncrement({ scope, max, windowMs, cwd, lockMaxWaitMs, cooldownMs }) {
  const root       = cwd || process.cwd();
  const window     = windowMs != null ? windowMs : DEFAULT_WINDOW_MS;
  const cooldown   = _resolveCooldownMs(cooldownMs);
  const cPath      = _counterPath(root, scope);
  const sPath      = _sentinelPath(root, scope);
  const lockPath   = cPath + '.lock';

  // Fast path: check trip sentinel before acquiring the lock.
  // The sentinel persists independently of the counter file (F-04).
  // v2.2.3 P0-3: auto-reset if cooldown has elapsed since trip. Without this,
  // a sentinel persists forever until manual `reset()`, suppressing all
  // future extractions even after the trip cause is gone.
  const sentinel = _readSentinel(sPath);
  if (sentinel && sentinel.trippedAt) {
    const auto = _autoResetIfCooldownExpired(root, scope, sentinel, cooldown);
    if (!auto.expired) {
      return { allowed: false, reason: 'tripped', count: sentinel.count || 0, max };
    }
    // Cooldown elapsed — sentinel was cleared. Fall through to the locked
    // critical section, which will see no counter file and start a fresh window.
  }

  const lockOpts = lockMaxWaitMs != null ? { lockMaxWaitMs } : undefined;

  let outcome;
  try {
    outcome = _lockedRun(lockPath, () => {
      let state;
      try {
        state = _readCounterFile(cPath);
      } catch (err) {
        if (err.code === 'CORRUPT') {
          // F-04: corrupt file → fail-closed, write sentinel, do NOT self-heal.
          _writeSentinel(sPath, {
            scope,
            count: 0,
            max,
            trippedAt: new Date().toISOString(),
            reason: 'counter_corrupt',
          });
          _emitCircuitTripped(root, scope, 'counter_corrupt');
          return { allowed: false, reason: 'counter_corrupt', count: 0, max };
        }
        throw err;
      }

      // Missing file → fresh init (not a trip, not corrupt).
      if (state === null) {
        state = {
          schema_version: SCHEMA_VERSION,
          scope,
          count: 0,
          windowStart: new Date().toISOString(),
          trippedAt: null,
        };
      }

      // Roll the window if it has expired.
      const windowStart = state.windowStart ? new Date(state.windowStart).getTime() : 0;
      const now = Date.now();
      if (now - windowStart >= window) {
        state.count = 0;
        state.windowStart = new Date().toISOString();
        // Preserve schema_version.
        state.schema_version = SCHEMA_VERSION;
      }

      // Check against cap.
      if (state.count >= max) {
        // Trip the breaker.
        state.trippedAt = new Date().toISOString();
        _writeCounterFile(cPath, state);
        _writeSentinel(sPath, {
          scope,
          count: state.count,
          max,
          trippedAt: state.trippedAt,
          reason: 'quota_exceeded',
        });
        _emitCircuitTripped(root, scope, 'quota_exceeded', { count: state.count, max });
        return { allowed: false, reason: 'tripped', count: state.count, max };
      }

      // Allowed — increment.
      state.count += 1;
      state.trippedAt = null;
      _writeCounterFile(cPath, state);
      return { allowed: true, count: state.count, max };
    }, root, scope, lockOpts);
  } catch (err) {
    // Any unexpected error during the locked section → fail-closed.
    _emitCircuitTripped(root, scope, 'internal_error', { detail: err && err.message ? err.message.slice(0, 80) : 'unknown' });
    return { allowed: false, reason: 'tripped', count: 0, max };
  }

  return outcome;
}

/**
 * Read-only trip check without incrementing.
 *
 * v2.2.3 P0-3: callers may pass `cooldownMs` to honor cooldown auto-reset.
 * If a tripped sentinel has aged past the cooldown, the sentinel + counter
 * are cleared on disk and `false` is returned (treat as healed). When called
 * without `cooldownMs`, the default 60-minute cooldown applies — preserves
 * the legacy "stays tripped until reset()" only when callers explicitly pass
 * `cooldownMs: 0` or `cooldownMs: Infinity`-equivalent (negative values fall
 * back to default; pass a very large value to effectively disable auto-reset
 * up to the 24h hard ceiling).
 *
 * @param {object} opts
 * @param {string} opts.scope
 * @param {string} [opts.cwd]
 * @param {number} [opts.cooldownMs] - Cooldown before auto-reset (default 60 min, clamped at 24h).
 * @returns {boolean} true if the breaker is currently tripped (after cooldown auto-reset).
 */
function isTripped({ scope, cwd, cooldownMs }) {
  const root  = cwd || process.cwd();
  const cooldown = _resolveCooldownMs(cooldownMs);
  const sPath = _sentinelPath(root, scope);

  // Check sentinel file (F-04: persists independently of counter).
  const sentinel = _readSentinel(sPath);
  if (sentinel && sentinel.trippedAt) {
    const auto = _autoResetIfCooldownExpired(root, scope, sentinel, cooldown);
    if (!auto.expired) return true;
    // Sentinel auto-cleared. Fall through to counter check (which will be
    // ENOENT after the auto-reset cleanup).
  }

  // Also check counter file for consistency.
  try {
    const state = _readCounterFile(_counterPath(root, scope));
    if (state && state.trippedAt) {
      // Counter says tripped but sentinel did not — apply cooldown to counter
      // too. Build a synthetic sentinel-like object and reuse the helper so
      // the audit event still fires and both files end up cleared.
      const synth = { trippedAt: state.trippedAt, count: state.count, reason: 'counter_only' };
      const auto = _autoResetIfCooldownExpired(root, scope, synth, cooldown);
      if (!auto.expired) return true;
    }
  } catch (_e) {
    // Corrupt → treat as tripped.
    return true;
  }

  return false;
}

/**
 * Reset the circuit breaker for a scope (clears both counter and sentinel).
 *
 * Exposed for tests and future /orchestray:config repair (W10 wires the CLI).
 *
 * @param {object} opts
 * @param {string} opts.scope
 * @param {string} [opts.cwd]
 */
function reset({ scope, cwd }) {
  const root  = cwd || process.cwd();
  const cPath = _counterPath(root, scope);
  const sPath = _sentinelPath(root, scope);
  const lockPath = cPath + '.lock';

  _lockedRun(lockPath, () => {
    // Remove counter file.
    try { fs.unlinkSync(cPath); } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        // Non-ENOENT errors are swallowed (best-effort reset).
      }
    }

    // Remove sentinel file.
    try { fs.unlinkSync(sPath); } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        // Swallow.
      }
    }

    // Emit reset event (fail-open).
    try {
      let orchId = 'unknown';
      try {
        const orchFile = getCurrentOrchestrationFile(root);
        const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
        if (data.orchestration_id) orchId = data.orchestration_id;
      } catch (_e) { /* ignore */ }

      const auditDir = path.join(root, '.orchestray', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      writeEvent({
        timestamp: new Date().toISOString(),
        type: 'learning_circuit_reset',
        schema_version: 1,
        orchestration_id: orchId,
        scope,
      }, { cwd: root });
    } catch (_e) { /* fail-open */ }
  }, root, scope);
}

module.exports = {
  checkAndIncrement,
  isTripped,
  reset,
  // v2.2.3 P0-3: cooldown defaults (exported so callers + tests can reference).
  DEFAULT_COOLDOWN_MS,
  HARD_COOLDOWN_CEILING_MS,
  // Expose internals for tests.
  _internal: {
    _counterPath,
    _sentinelPath,
    _readCounterFile,
    _writeCounterFile,
    _writeSentinel,
    _readSentinel,
    _autoResetIfCooldownExpired,
    _resolveCooldownMs,
  },
};
