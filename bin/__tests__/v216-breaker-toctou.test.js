#!/usr/bin/env node
'use strict';

/**
 * v216-breaker-toctou.test.js — T-02 Circuit breaker TOCTOU cross-process regression.
 *
 * The existing learning-circuit-breaker.test.js T-02 uses Promise.all in a single
 * Node.js process. Because Node is single-threaded and the breaker lock is
 * synchronous, same-process calls serialize naturally. This test is MORE AGGRESSIVE:
 * it spawns 3 actual worker threads (via worker_threads) to exercise REAL concurrent
 * execution.
 *
 * Design: §6.4 + W2-03 finding.
 *
 * Test contract:
 *   - Pre-fill counter to max - 1.
 *   - Spawn 3 worker threads, each calling checkAndIncrement simultaneously.
 *   - Wait for all 3.
 *   - Assert exactly 1 returned {allowed: true}, exactly 2 returned {allowed: false}.
 *   - Assert final counter file value equals max (not max+1 or max+2).
 *   - The sentinel file is written (breaker tripped) after the quota is exhausted.
 *
 * Uses worker_threads (Node 12+; this project requires Node 20+).
 *
 * Runner: node --test bin/__tests__/v216-breaker-toctou.test.js
 *
 * W11 adversarial validation suite.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const {
  checkAndIncrement,
  _internal: { _counterPath, _sentinelPath, _writeCounterFile },
} = require('../_lib/learning-circuit-breaker.js');

// ---------------------------------------------------------------------------
// Worker thread code — inline via workerData eval pattern
// ---------------------------------------------------------------------------

// When this module is loaded as a worker thread (not main thread),
// it runs the checkAndIncrement call and posts the result back.
if (!isMainThread) {
  // workerData: { scope, max, windowMs, cwd }
  const { scope, max, windowMs, cwd } = workerData;
  try {
    const { checkAndIncrement: check } = require(
      path.resolve(__dirname, '../_lib/learning-circuit-breaker.js')
    );
    const result = check({ scope, max, windowMs, cwd });
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err && err.message });
  }
}

// ---------------------------------------------------------------------------
// Helper: spawn a worker that calls checkAndIncrement with given opts.
// ---------------------------------------------------------------------------

function spawnBreakerWorker({ scope, max, windowMs, cwd }) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, {
      workerData: { scope, max, windowMs, cwd },
    });
    w.once('message', (msg) => {
      if (msg.ok) {
        resolve(msg.result);
      } else {
        reject(new Error('worker error: ' + msg.error));
      }
    });
    w.once('error', reject);
    w.once('exit', (code) => {
      if (code !== 0) reject(new Error('worker exited with code ' + code));
    });
  });
}

// Only define tests in the main thread.
if (isMainThread) {

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-toctou-t02-'));
    fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('T-02 — cross-process TOCTOU: 3 workers at count=max-1', () => {

    test('exactly 1 of 3 concurrent workers is allowed; final count equals max', async () => {
      const MAX = 10;
      const SCOPE = 'toctou_t02';
      const WINDOW_MS = 3_600_000; // 1 hour — prevents window roll during test

      // Pre-fill to max - 1 using the main-thread checkAndIncrement.
      for (let i = 0; i < MAX - 1; i++) {
        const r = checkAndIncrement({ scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir });
        assert.ok(r.allowed, `pre-fill step ${i + 1} should be allowed`);
      }

      // Verify pre-fill state.
      const cPath = _counterPath(tmpDir, SCOPE);
      const stateBefore = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      assert.equal(stateBefore.count, MAX - 1, 'pre-fill should reach max-1');

      // Spawn 3 workers simultaneously. They all see count = max-1 before the lock.
      const workerOpts = { scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir };
      const [r1, r2, r3] = await Promise.all([
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
      ]);

      const results = [r1, r2, r3];
      const allowedCount = results.filter(r => r.allowed === true).length;
      const blockedCount = results.filter(r => r.allowed === false).length;

      assert.equal(
        allowedCount, 1,
        `exactly 1 of 3 workers should be allowed; got ${allowedCount} allowed: ${JSON.stringify(results)}`
      );
      assert.equal(
        blockedCount, 2,
        `exactly 2 of 3 workers should be blocked; got ${blockedCount} blocked`
      );

      // Final counter must equal max (not max+1 or max+2).
      const stateAfter = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      assert.equal(
        stateAfter.count, MAX,
        `final counter must equal max (${MAX}), got ${stateAfter.count} — TOCTOU race detected`
      );
    });

    test('sentinel file is written after quota exhausted by cross-process race', async () => {
      const MAX = 5;
      const SCOPE = 'toctou_sentinel_t02';
      const WINDOW_MS = 3_600_000;

      // Pre-fill to max - 1.
      for (let i = 0; i < MAX - 1; i++) {
        checkAndIncrement({ scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir });
      }

      // Spawn 2 workers: one should trip the breaker.
      const workerOpts = { scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir };
      await Promise.all([
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
      ]);

      const sPath = _sentinelPath(tmpDir, SCOPE);
      assert.ok(
        fs.existsSync(sPath),
        'sentinel file must exist after quota is exhausted by concurrent workers'
      );

      const sentinel = JSON.parse(fs.readFileSync(sPath, 'utf8'));
      assert.ok(sentinel.trippedAt, 'sentinel must have trippedAt timestamp');
      assert.equal(sentinel.scope, SCOPE, 'sentinel must record scope');
    });

    test('subsequent calls after trip return allowed:false (tripped state persists)', async () => {
      const MAX = 3;
      const SCOPE = 'toctou_persist_t02';
      const WINDOW_MS = 3_600_000;

      // Fill to max using 3 sequential calls in main thread.
      for (let i = 0; i < MAX; i++) {
        checkAndIncrement({ scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir });
      }

      // Verify tripped state is visible to a new worker.
      const result = await spawnBreakerWorker({
        scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir,
      });
      assert.equal(
        result.allowed, false,
        'worker spawned after trip should see allowed:false'
      );
      const validTripReasons = ['tripped', 'counter_corrupt', 'lock_unavailable'];
      assert.ok(
        validTripReasons.includes(result.reason),
        `reason should indicate trip, got: ${result.reason}`
      );
    });

    test('two workers at count=0 with max=1: exactly one allowed', async () => {
      const MAX = 1;
      const SCOPE = 'toctou_max1_t02';
      const WINDOW_MS = 3_600_000;

      // No pre-fill — both workers start from count=0, max=1.
      const workerOpts = { scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir };
      const [ra, rb] = await Promise.all([
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
      ]);

      const allowedCount = [ra, rb].filter(r => r.allowed === true).length;
      assert.equal(
        allowedCount, 1,
        `with max=1 and 2 workers starting from 0, exactly 1 must be allowed; got ${allowedCount}: ${JSON.stringify([ra, rb])}`
      );

      // Counter must be exactly max=1.
      const cPath = _counterPath(tmpDir, SCOPE);
      if (fs.existsSync(cPath)) {
        const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
        assert.equal(
          state.count, MAX,
          `final count should be ${MAX}, got ${state.count}`
        );
      }
    });

    test('lock_unavailable reason does not result in silent over-counting', async () => {
      // Verify that when lock is unavailable (fail-closed), the result is
      // allowed:false, NOT allowed:true with a silent increment.
      // We test this by creating a situation where 5 workers race with max=2.
      const MAX = 2;
      const SCOPE = 'toctou_lock_t02';
      const WINDOW_MS = 3_600_000;

      const workerOpts = { scope: SCOPE, max: MAX, windowMs: WINDOW_MS, cwd: tmpDir };
      const results = await Promise.all([
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
        spawnBreakerWorker(workerOpts),
      ]);

      const allowedCount = results.filter(r => r.allowed === true).length;
      assert.ok(
        allowedCount <= MAX,
        `at most ${MAX} workers should be allowed; got ${allowedCount} — over-counting detected`
      );

      // Counter must never exceed max.
      const cPath = _counterPath(tmpDir, SCOPE);
      if (fs.existsSync(cPath)) {
        const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
        assert.ok(
          state.count <= MAX,
          `counter must not exceed max (${MAX}), got ${state.count}`
        );
      }
    });
  });
}
