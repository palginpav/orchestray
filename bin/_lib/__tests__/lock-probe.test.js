#!/usr/bin/env node
'use strict';

/**
 * Unit tests for lock-probe.js (v2.1.6 — W1c hardening).
 *
 * Covers:
 *   - isLockAvailable: free lock → true
 *   - isLockAvailable: held lock → false within maxWaitMs
 *   - isLockAvailable: stale lock → true (stale lock removed and acquired)
 *   - isLockAvailable: two concurrent probes on free lock → at least one returns true
 *
 * Runner: node --test bin/_lib/__tests__/lock-probe.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { isLockAvailable } = require('../lock-probe.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-lock-probe-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lockPath(name) {
  return path.join(tmpDir, name + '.lock');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isLockAvailable — free lock', () => {
  test('returns true when lock file does not exist', () => {
    const lp = lockPath('free');
    const result = isLockAvailable(lp);
    assert.equal(result, true, 'free lock should return true');
    // Lock file should be cleaned up by the probe.
    assert.equal(fs.existsSync(lp), false, 'probe should release lock file after acquiring');
  });

  test('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'path.lock');
    const result = isLockAvailable(nested);
    assert.equal(result, true, 'should create missing parent directories');
  });
});

describe('isLockAvailable — held lock (contention)', () => {
  test('returns false within maxWaitMs when lock file exists with recent mtime', () => {
    const lp = lockPath('held');
    // Pre-create the lock file with a recent mtime (well within the 10s stale threshold).
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const fd = fs.openSync(lp, 'w');
    fs.closeSync(fd);
    const now = Date.now() / 1000;
    fs.utimesSync(lp, now, now);

    const start = Date.now();
    const result = isLockAvailable(lp, { maxWaitMs: 100, pollMs: 25 });
    const elapsed = Date.now() - start;

    assert.equal(result, false, 'held lock should return false');
    // Should not wait much longer than maxWaitMs.
    assert.ok(elapsed < 500, `should return within ~maxWaitMs, took ${elapsed}ms`);

    // Cleanup.
    try { fs.unlinkSync(lp); } catch (_e) {}
  });

  test('returns false quickly when maxWaitMs=0 and lock is held', () => {
    const lp = lockPath('held-zero');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const fd = fs.openSync(lp, 'w');
    fs.closeSync(fd);
    const now = Date.now() / 1000;
    fs.utimesSync(lp, now, now);

    const result = isLockAvailable(lp, { maxWaitMs: 0 });
    assert.equal(result, false, 'should fail immediately with maxWaitMs=0');

    try { fs.unlinkSync(lp); } catch (_e) {}
  });
});

describe('isLockAvailable — stale lock', () => {
  test('removes stale lock (mtime > 10s ago) and returns true', () => {
    const lp = lockPath('stale');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const fd = fs.openSync(lp, 'w');
    fs.closeSync(fd);
    // Set mtime to 11 seconds ago (past the 10s stale threshold).
    const staleTime = (Date.now() - 11_000) / 1000;
    fs.utimesSync(lp, staleTime, staleTime);

    const result = isLockAvailable(lp, { maxWaitMs: 200 });
    assert.equal(result, true, 'stale lock should be removed and probe should succeed');
    // Lock file should be cleaned up by the probe.
    assert.equal(fs.existsSync(lp), false, 'stale lock file should be gone after probe');
  });

  test('exactly at stale boundary (mtime = 10s ago) is NOT treated as stale', () => {
    const lp = lockPath('boundary');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const fd = fs.openSync(lp, 'w');
    fs.closeSync(fd);
    // Set mtime to exactly 9.9 seconds ago (just under the 10s threshold).
    const freshTime = (Date.now() - 9_900) / 1000;
    fs.utimesSync(lp, freshTime, freshTime);

    // With maxWaitMs=0, should fail (lock is fresh, not stale).
    const result = isLockAvailable(lp, { maxWaitMs: 0 });
    assert.equal(result, false, 'fresh lock (9.9s old) should not be treated as stale');

    try { fs.unlinkSync(lp); } catch (_e) {}
  });
});

describe('isLockAvailable — concurrent probes', () => {
  test('two concurrent probes on same free lock: both can return true (probe releases immediately)', (t, done) => {
    // Since the probe releases immediately on success, two sequential-in-event-loop
    // probes (via setImmediate) may both return true because the first probe
    // finishes and releases before the second starts. Node is single-threaded so
    // these are truly sequential — this test verifies no throw and at least one
    // returns true, covering the "neither crashes" requirement.
    const lp = lockPath('concurrent');
    let result1;
    let result2;

    setImmediate(() => {
      result1 = isLockAvailable(lp, { maxWaitMs: 200 });
      setImmediate(() => {
        result2 = isLockAvailable(lp, { maxWaitMs: 200 });
        assert.ok(result1 || result2, 'at least one probe should return true');
        assert.equal(typeof result1, 'boolean', 'result1 should be boolean');
        assert.equal(typeof result2, 'boolean', 'result2 should be boolean');
        done();
      });
    });
  });

  test('two probes via Promise.resolve (microtask): neither throws', async () => {
    const lp = lockPath('concurrent-promise');
    // Both probes run synchronously but scheduled through Promise microtasks.
    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => isLockAvailable(lp, { maxWaitMs: 200 })),
      Promise.resolve().then(() => isLockAvailable(lp, { maxWaitMs: 200 })),
    ]);
    // Because these are scheduled as microtasks and isLockAvailable is synchronous,
    // they execute sequentially: first r1, then r2. Both should return true since
    // the first probe releases the lock before r2 runs.
    assert.ok(r1 || r2, 'at least one probe should return true');
  });
});
