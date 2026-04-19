#!/usr/bin/env node
'use strict';

/**
 * Unit tests for learning-circuit-breaker.js (v2.1.6 — W1 safety boundary).
 *
 * Covers:
 *   - Basic increment: allowed until max
 *   - At max: allowed:false with reason 'tripped'
 *   - T-02 TOCTOU (F-02): concurrent calls at max-1 → exactly one allowed
 *   - Corrupt counter file → fail-closed
 *   - Tripped sentinel survives counter-file deletion (F-04)
 *   - reset() clears both counter and sentinel
 *
 * Runner: node --test bin/_lib/__tests__/learning-circuit-breaker.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  checkAndIncrement,
  isTripped,
  reset,
  _internal: { _counterPath, _sentinelPath, _writeCounterFile, _writeSentinel },
} = require('../learning-circuit-breaker.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-breaker-test-'));
  // Create the state directory.
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function opts(scope, max, windowMs) {
  return { scope, max: max || 10, windowMs: windowMs || (24 * 60 * 60 * 1000), cwd: tmpDir };
}

// ---------------------------------------------------------------------------
// Basic increment behavior
// ---------------------------------------------------------------------------

describe('checkAndIncrement — basic behavior', () => {
  test('first call is allowed with count=1', () => {
    const result = checkAndIncrement(opts('extract_on_complete', 10));
    assert.equal(result.allowed, true);
    assert.equal(result.count, 1);
    assert.equal(result.max, 10);
  });

  test('increments count on each allowed call', () => {
    for (let i = 1; i <= 5; i++) {
      const result = checkAndIncrement(opts('extract_on_complete', 10));
      assert.equal(result.allowed, true);
      assert.equal(result.count, i);
    }
  });

  test('allows up to max (inclusive boundary: max allowed = last allowed)', () => {
    const max = 3;
    for (let i = 0; i < max - 1; i++) {
      const r = checkAndIncrement(opts('small_scope', max));
      assert.equal(r.allowed, true);
    }
    // count = max - 1 before this call, should still be allowed (count becomes max)
    const last = checkAndIncrement(opts('small_scope', max));
    assert.equal(last.allowed, true);
    assert.equal(last.count, max);
  });

  test('trips at max+1 (count >= max → trip)', () => {
    const max = 3;
    // Fill to max
    for (let i = 0; i < max; i++) {
      checkAndIncrement(opts('trip_scope', max));
    }
    // Next call should be blocked
    const result = checkAndIncrement(opts('trip_scope', max));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'tripped');
  });

  test('subsequent calls after trip are all blocked', () => {
    const max = 2;
    checkAndIncrement(opts('block_scope', max));
    checkAndIncrement(opts('block_scope', max));
    // Tripped
    for (let i = 0; i < 5; i++) {
      const r = checkAndIncrement(opts('block_scope', max));
      assert.equal(r.allowed, false);
    }
  });
});

// ---------------------------------------------------------------------------
// T-02 TOCTOU (F-02): concurrent check-and-increment
// ---------------------------------------------------------------------------

describe('checkAndIncrement — T-02 TOCTOU concurrency test', () => {
  test('two concurrent calls at count=max-1 → exactly one allowed, final count=max', async () => {
    const max = 10;
    const scope = 'toctou_scope';

    // Pre-fill to max - 1
    for (let i = 0; i < max - 1; i++) {
      const r = checkAndIncrement(opts(scope, max));
      assert.equal(r.allowed, true, `pre-fill step ${i + 1} should be allowed`);
    }

    // Now run two concurrent calls — only one should succeed.
    // Using Promise.all simulates concurrent execution, though Node is single-threaded
    // and the advisory lock is synchronous. The important thing is that the lock
    // prevents both from reading count=max-1 and both succeeding.
    const [r1, r2] = await Promise.all([
      Promise.resolve(checkAndIncrement(opts(scope, max))),
      Promise.resolve(checkAndIncrement(opts(scope, max))),
    ]);

    // Exactly one should be allowed, one should be tripped.
    const allowedCount = [r1, r2].filter(r => r.allowed).length;
    const trippedCount = [r1, r2].filter(r => !r.allowed).length;

    assert.equal(allowedCount, 1, `exactly one of two concurrent calls should be allowed, got ${JSON.stringify([r1, r2])}`);
    assert.equal(trippedCount, 1, `exactly one of two concurrent calls should be blocked`);

    // Final count in state file should equal max (not max+1).
    const cPath = _counterPath(tmpDir, scope);
    const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(state.count, max, `final count should equal max (${max}), got ${state.count}`);
  });
});

// ---------------------------------------------------------------------------
// Corrupt counter file → fail-closed
// ---------------------------------------------------------------------------

describe('checkAndIncrement — corrupt counter file', () => {
  test('corrupt JSON → fail-closed (allowed:false)', () => {
    const scope = 'corrupt_scope';
    const cPath = _counterPath(tmpDir, scope);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, 'not valid json {{{', 'utf8');

    const result = checkAndIncrement(opts(scope, 10));
    assert.equal(result.allowed, false, 'corrupt file must cause fail-closed');
  });

  test('corrupt file → trip sentinel is written', () => {
    const scope = 'corrupt_sentinel_scope';
    const cPath = _counterPath(tmpDir, scope);
    const sPath = _sentinelPath(tmpDir, scope);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, 'not valid json', 'utf8');

    checkAndIncrement(opts(scope, 10));

    assert.ok(fs.existsSync(sPath), 'trip sentinel must be written on corrupt file');
    const sentinel = JSON.parse(fs.readFileSync(sPath, 'utf8'));
    assert.ok(sentinel.trippedAt, 'sentinel must have trippedAt');
  });

  test('truncated file → fail-closed', () => {
    const scope = 'truncated_scope';
    const cPath = _counterPath(tmpDir, scope);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, '{"schema_version": 1, "count":', 'utf8');

    const result = checkAndIncrement(opts(scope, 10));
    assert.equal(result.allowed, false);
  });

  test('empty file → fail-closed', () => {
    const scope = 'empty_scope';
    const cPath = _counterPath(tmpDir, scope);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, '', 'utf8');

    const result = checkAndIncrement(opts(scope, 10));
    assert.equal(result.allowed, false);
  });
});

// ---------------------------------------------------------------------------
// Tripped sentinel survives counter-file deletion (F-04)
// ---------------------------------------------------------------------------

describe('checkAndIncrement — F-04 sentinel persistence', () => {
  test('tripped sentinel survives counter-file deletion', () => {
    const max = 2;
    const scope = 'sentinel_scope';

    // Trip the breaker
    checkAndIncrement(opts(scope, max));
    checkAndIncrement(opts(scope, max));
    const tripped = checkAndIncrement(opts(scope, max));
    assert.equal(tripped.allowed, false, 'must be tripped');

    // Verify sentinel exists
    const sPath = _sentinelPath(tmpDir, scope);
    assert.ok(fs.existsSync(sPath), 'sentinel must exist after trip');

    // Delete the counter file (simulating external deletion or reset attempt)
    const cPath = _counterPath(tmpDir, scope);
    fs.unlinkSync(cPath);
    assert.ok(!fs.existsSync(cPath), 'counter file must be deleted');

    // Next call should still be blocked (sentinel persists)
    const result = checkAndIncrement(opts(scope, max));
    assert.equal(result.allowed, false, 'breaker must remain tripped after counter deletion');
  });

  test('isTripped returns true when sentinel exists', () => {
    const max = 1;
    const scope = 'istripped_scope';

    // Trip it
    checkAndIncrement(opts(scope, max));
    checkAndIncrement(opts(scope, max));

    assert.equal(isTripped({ scope, cwd: tmpDir }), true);
  });

  test('isTripped returns false when no trip', () => {
    const scope = 'not_tripped_scope';
    assert.equal(isTripped({ scope, cwd: tmpDir }), false);
  });
});

// ---------------------------------------------------------------------------
// reset() function
// ---------------------------------------------------------------------------

describe('reset — clears counter and sentinel', () => {
  test('reset clears both counter and sentinel files', () => {
    const max = 2;
    const scope = 'reset_scope';

    // Trip the breaker
    checkAndIncrement(opts(scope, max));
    checkAndIncrement(opts(scope, max));
    checkAndIncrement(opts(scope, max)); // trip

    const cPath = _counterPath(tmpDir, scope);
    const sPath = _sentinelPath(tmpDir, scope);

    assert.ok(fs.existsSync(sPath), 'sentinel must exist before reset');

    // Reset
    reset({ scope, cwd: tmpDir });

    assert.ok(!fs.existsSync(cPath), 'counter file must be removed after reset');
    assert.ok(!fs.existsSync(sPath), 'sentinel file must be removed after reset');
  });

  test('reset allows extraction to proceed again', () => {
    const max = 2;
    const scope = 'reset_allow_scope';

    // Trip
    for (let i = 0; i < max + 1; i++) {
      checkAndIncrement(opts(scope, max));
    }
    assert.equal(isTripped({ scope, cwd: tmpDir }), true);

    // Reset
    reset({ scope, cwd: tmpDir });

    assert.equal(isTripped({ scope, cwd: tmpDir }), false);

    // Should allow again
    const result = checkAndIncrement(opts(scope, max));
    assert.equal(result.allowed, true);
  });

  test('reset on non-existent scope is a no-op (no error)', () => {
    assert.doesNotThrow(() => {
      reset({ scope: 'nonexistent_scope_xyz', cwd: tmpDir });
    });
  });
});

// ---------------------------------------------------------------------------
// Window rolling
// ---------------------------------------------------------------------------

describe('checkAndIncrement — window rolling', () => {
  test('count resets after window expires', () => {
    const scope = 'window_scope';
    const max = 3;
    const shortWindow = 10; // 10ms window

    // Fill to max
    for (let i = 0; i < max; i++) {
      checkAndIncrement(opts(scope, max, shortWindow));
    }
    const tripped = checkAndIncrement(opts(scope, max, shortWindow));
    assert.equal(tripped.allowed, false);

    // We can't easily test time-based rolling in sync tests without mocking.
    // The window rolling logic is unit-tested by verifying the counter state.
    const cPath = _counterPath(tmpDir, scope);
    // Manually set the windowStart to the past to simulate expiry.
    const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    state.windowStart = new Date(Date.now() - shortWindow * 2).toISOString();
    state.trippedAt = null;
    state.count = max; // Still at max but window should roll
    fs.writeFileSync(cPath, JSON.stringify(state), 'utf8');

    // Also remove sentinel that was written on trip
    const sPath = _sentinelPath(tmpDir, scope);
    try { fs.unlinkSync(sPath); } catch (_e) {}

    // With window expired, count should reset to 0 and then increment to 1
    const result = checkAndIncrement(opts(scope, max, shortWindow));
    assert.equal(result.allowed, true, 'should allow after window expiry');
    assert.equal(result.count, 1, 'count should restart at 1 after window roll');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('checkAndIncrement — edge cases', () => {
  test('different scopes are independent', () => {
    const max = 2;

    // Fill scope A to max
    for (let i = 0; i < max; i++) {
      checkAndIncrement(opts('scope_a', max));
    }

    // scope B should still be fresh
    const result = checkAndIncrement(opts('scope_b', max));
    assert.equal(result.allowed, true);
    assert.equal(result.count, 1);
  });

  test('schema_version is written to counter file', () => {
    const scope = 'schema_scope';
    checkAndIncrement(opts(scope, 10));

    const cPath = _counterPath(tmpDir, scope);
    const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(state.schema_version, 1);
  });
});

// ---------------------------------------------------------------------------
// W2-03 / W1c: Lock-probe-based fail-closed (replaces stderr monkey-patch)
// ---------------------------------------------------------------------------

describe('checkAndIncrement — W2-03 lock-probe fail-closed', () => {
  test('returns {allowed:false, reason:lock_unavailable} when lock is held', () => {
    // Pre-create a fresh lock file (mtime = now) in the counter's lock path.
    // The lock-probe pre-check in _lockedRun will detect contention and return
    // fail-closed (no lockless fallback).
    const scope = 'lock_fallback_scope';
    const cPath = _counterPath(tmpDir, scope);
    const lockPath = cPath + '.lock';

    // Create the lock file as if another process holds it (recent mtime).
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const lockFd = fs.openSync(lockPath, 'w');
    fs.closeSync(lockFd);
    const now = Date.now() / 1000;
    fs.utimesSync(lockPath, now, now);

    // checkAndIncrement will run isLockAvailable() which times out,
    // then return {allowed:false, reason:'lock_unavailable'} without
    // touching the counter file.
    const result = checkAndIncrement(opts(scope, 10));

    // Counter file must be unchanged (no write happened under contention).
    const counterExists = fs.existsSync(cPath);
    assert.equal(counterExists, false, 'counter file must NOT be created when lock is unavailable');

    // Cleanup
    try { fs.unlinkSync(lockPath); } catch (_e) {}

    assert.equal(result.allowed, false, 'lock contention must return allowed:false');
    assert.equal(result.reason, 'lock_unavailable', 'reason must be lock_unavailable');
  });
});

// ---------------------------------------------------------------------------
// B4-04: _withBreakerLock — dedicated lock with no lockless fallback
// ---------------------------------------------------------------------------

describe('checkAndIncrement — B4-04 dedicated breaker lock', () => {
  test('pre-created fresh lock → {allowed:false, reason:lock_unavailable}', () => {
    // Create a fresh lock file (simulating a concurrent holder).
    const scope = 'b404_fresh_lock';
    const cPath = _counterPath(tmpDir, scope);
    const lockPath = cPath + '.lock';

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, 'w');
    fs.writeSync(fd, '12345'); // write a PID
    fs.closeSync(fd);
    // Set mtime to now (fresh — not stale).
    const nowSec = Date.now() / 1000;
    fs.utimesSync(lockPath, nowSec, nowSec);

    const result = checkAndIncrement({ ...opts(scope, 10), lockMaxWaitMs: 100 });
    assert.equal(result.allowed, false, 'fresh lock must cause fail-closed');
    assert.equal(result.reason, 'lock_unavailable');

    // Counter file must not have been created.
    assert.ok(!fs.existsSync(cPath), 'counter file must not be created under lock contention');

    try { fs.unlinkSync(lockPath); } catch (_) {}
  });

  test('stale lock (mtime > 10s ago) is force-removed and call succeeds', () => {
    const scope = 'b404_stale_lock';
    const cPath = _counterPath(tmpDir, scope);
    const lockPath = cPath + '.lock';

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Create lock file with mtime 11 seconds in the past (stale threshold is 10s).
    const fd = fs.openSync(lockPath, 'w');
    fs.closeSync(fd);
    const staleSec = (Date.now() - 11_000) / 1000;
    fs.utimesSync(lockPath, staleSec, staleSec);

    const result = checkAndIncrement(opts(scope, 10));
    assert.equal(result.allowed, true, 'stale lock should be force-removed and call should succeed');
    assert.equal(result.count, 1);

    // Lock file should be gone after the call.
    assert.ok(!fs.existsSync(lockPath), 'lock file must be released after call');
  });

  test('3 concurrent checkAndIncrement at count=max-1 → exactly 1 allowed, 2 denied; final count=max', async () => {
    const max = 3;
    const scope = 'b404_concurrent';

    // Pre-fill to max - 1.
    for (let i = 0; i < max - 1; i++) {
      const r = checkAndIncrement(opts(scope, max));
      assert.equal(r.allowed, true, `pre-fill step ${i + 1}`);
    }

    // Fire 3 concurrent calls — only 1 should be allowed (count becomes max),
    // the other 2 should be blocked.
    const [r1, r2, r3] = await Promise.all([
      Promise.resolve(checkAndIncrement(opts(scope, max))),
      Promise.resolve(checkAndIncrement(opts(scope, max))),
      Promise.resolve(checkAndIncrement(opts(scope, max))),
    ]);

    const results = [r1, r2, r3];
    const allowedCount = results.filter(r => r.allowed).length;
    assert.equal(allowedCount, 1,
      `exactly 1 of 3 concurrent calls should be allowed at max-1. Got: ${JSON.stringify(results)}`);

    const deniedCount = results.filter(r => !r.allowed).length;
    assert.equal(deniedCount, 2, 'exactly 2 should be denied');

    // Final count must be max (not max+1 or max+2).
    const cPath = _counterPath(tmpDir, scope);
    const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(state.count, max, `final count must equal max (${max}), got ${state.count}`);
  });
});
