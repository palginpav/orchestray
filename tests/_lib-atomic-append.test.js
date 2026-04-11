#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/atomic-append.js — the shared JSONL atomic-append helper.
 *
 * Covers:
 *   1. Concurrent append test — 20 parallel child_process workers each append
 *      one JSONL line. Verifies all 20 lines land, each parses cleanly, and
 *      no lines are truncated or interleaved.
 *   2. Fallback path — pre-create the .lock file so all retries fail. Verify
 *      the event is still appended (via the non-atomic fallback) and that
 *      stderr captures the 'lock acquire failed' warning.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HELPER = path.resolve(__dirname, '../bin/_lib/atomic-append.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-atomic-append-'));
}

// Inline worker program: requires the helper and appends ONE line, then exits.
// The event object is passed via env vars so the worker invocation is short.
const WORKER_SRC = `
'use strict';
const { atomicAppendJsonl } = require(${JSON.stringify(HELPER)});
const filePath = process.env.ORCH_FILE;
const workerId = process.env.ORCH_WORKER_ID;
// Build a large-ish payload to exceed PIPE_BUF (4096 bytes), which is the
// whole point of the lockfile — atomic O_APPEND is only guaranteed for small
// writes.
const bigString = 'x'.repeat(6000);
atomicAppendJsonl(filePath, {
  worker_id: workerId,
  timestamp: new Date().toISOString(),
  payload: bigString,
});
`;

describe('atomic-append', () => {

  test('20 concurrent child processes produce exactly 20 valid JSON lines', async () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'events.jsonl');

    try {
      // Spawn 20 workers in parallel. We use child_process.spawn (async) and
      // wait for all exits via Promise.all.
      const { spawn } = require('node:child_process');
      const WORKER_COUNT = 20;
      const procs = [];
      for (let i = 0; i < WORKER_COUNT; i++) {
        const p = spawn(process.execPath, ['-e', WORKER_SRC], {
          env: {
            ...process.env,
            ORCH_FILE: filePath,
            ORCH_WORKER_ID: String(i),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        procs.push(new Promise((resolve, reject) => {
          let stderr = '';
          p.stderr.on('data', (d) => { stderr += d.toString(); });
          p.on('exit', (code) => {
            if (code !== 0) {
              reject(new Error(`worker ${i} exited ${code}: ${stderr}`));
            } else {
              resolve({ workerId: i, stderr });
            }
          });
          p.on('error', reject);
        }));
      }

      await Promise.all(procs);

      // Inspect the output file.
      assert.ok(fs.existsSync(filePath), 'events.jsonl should exist');
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      assert.equal(lines.length, WORKER_COUNT,
        `expected exactly ${WORKER_COUNT} lines, got ${lines.length}`);

      const seenWorkerIds = new Set();
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (e) {
          assert.fail(`line did not parse as JSON: ${line.slice(0, 120)}...`);
        }
        assert.ok(obj.worker_id !== undefined, 'worker_id must be present');
        assert.ok(obj.timestamp, 'timestamp must be present');
        assert.equal(obj.payload.length, 6000, 'payload must not be truncated');
        seenWorkerIds.add(obj.worker_id);
      }
      assert.equal(seenWorkerIds.size, WORKER_COUNT,
        'all worker ids should be distinct and accounted for');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('fallback path: pre-existing .lock file forces non-atomic append with stderr warning', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'events.jsonl');
    const lockPath = filePath + '.lock';

    // Pre-create the lockfile so all 10 retries fail.
    fs.writeFileSync(lockPath, '');

    // Use an inline harness that requires the helper and makes one call,
    // capturing stderr.
    const HARNESS_SRC = `
      'use strict';
      const { atomicAppendJsonl } = require(${JSON.stringify(HELPER)});
      atomicAppendJsonl(${JSON.stringify(filePath)}, { type: 'fallback_test', value: 42 });
    `;

    try {
      const result = spawnSync(process.execPath, ['-e', HARNESS_SRC], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 0, `helper should exit 0; stderr=${result.stderr}`);

      // Verify the fallback warning is on stderr.
      assert.ok(
        result.stderr.includes('lock acquire failed'),
        `stderr should contain 'lock acquire failed'; got: ${result.stderr}`
      );
      assert.ok(
        result.stderr.includes('falling back to non-atomic append'),
        `stderr should mention fallback; got: ${result.stderr}`
      );

      // Verify the event was still written via the fallback path.
      assert.ok(fs.existsSync(filePath), 'events.jsonl should still exist');
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      assert.equal(lines.length, 1, 'exactly one line should be appended');
      const obj = JSON.parse(lines[0]);
      assert.equal(obj.type, 'fallback_test');
      assert.equal(obj.value, 42);
    } finally {
      // The function does NOT unlink a lockfile it did not create, so clean
      // it up manually.
      try { fs.unlinkSync(lockPath); } catch (_e) { /* swallow */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// atomicAppendJsonlIfAbsent — idempotency and size-cap (B1 + B3)
// ---------------------------------------------------------------------------

describe('atomicAppendJsonlIfAbsent', () => {

  test('appends row when file is absent, returns true', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'events.jsonl');
    try {
      const { atomicAppendJsonlIfAbsent } = require(HELPER);
      const row = { type: 'test_event', id: 'abc' };
      const result = atomicAppendJsonlIfAbsent(filePath, row, () => false);
      assert.equal(result, true, 'should return true when appending');
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), row);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not append when matchFn returns true for existing row', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'events.jsonl');
    try {
      const { atomicAppendJsonlIfAbsent } = require(HELPER);
      const existing = { type: 'pattern_record_skipped', orchestration_id: 'orch-1' };
      fs.writeFileSync(filePath, JSON.stringify(existing) + '\n');

      const row = { type: 'pattern_record_skipped', orchestration_id: 'orch-1' };
      const result = atomicAppendJsonlIfAbsent(
        filePath, row,
        (ev) => ev && ev.type === 'pattern_record_skipped' && ev.orchestration_id === 'orch-1'
      );
      assert.equal(result, false, 'should return false when already present');
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 1, 'file must still have exactly one line');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('running script twice emits exactly one event (idempotency via atomicAppendJsonlIfAbsent)', () => {
    // Inline harness that calls atomicAppendJsonlIfAbsent twice — simulates two
    // sequential PreCompact invocations. The second call acquires the lock
    // after the first has written and released it, and sees the existing row.
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'events.jsonl');
    const HARNESS_SRC = `
      'use strict';
      const { atomicAppendJsonlIfAbsent } = require(${JSON.stringify(HELPER)});
      const fp = ${JSON.stringify(filePath)};
      const row = { type: 'pattern_record_skipped', orchestration_id: 'orch-idem' };
      const match = (ev) => ev && ev.type === 'pattern_record_skipped' && ev.orchestration_id === 'orch-idem';
      atomicAppendJsonlIfAbsent(fp, row, match);
      atomicAppendJsonlIfAbsent(fp, row, match);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', HARNESS_SRC], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, `harness exited ${result.status}: ${result.stderr}`);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 1, 'exactly one event must be written after two calls');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('B3: oversize file triggers stderr warning and returns false (no append)', () => {
    // Use MAX_JSONL_READ_BYTES_OVERRIDE env var to set a tiny cap (100 bytes),
    // then write a file just over that threshold. The helper must warn + return false.
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, 'events.jsonl');
    const CAP = 100;
    // Write a file slightly larger than the cap
    fs.writeFileSync(filePath, 'x'.repeat(CAP + 1));
    const HARNESS_SRC = `
      'use strict';
      const { atomicAppendJsonlIfAbsent } = require(${JSON.stringify(HELPER)});
      const fp = ${JSON.stringify(filePath)};
      const result = atomicAppendJsonlIfAbsent(fp, { type: 'should_not_appear' }, () => false);
      process.stdout.write(JSON.stringify({ result }) + '\\n');
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', HARNESS_SRC], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, MAX_JSONL_READ_BYTES_OVERRIDE: String(CAP) },
      });
      assert.equal(result.status, 0);
      assert.ok(
        result.stderr.includes('file too large'),
        `stderr must mention 'file too large'; got: ${result.stderr}`
      );
      const out = JSON.parse(result.stdout.trim());
      assert.equal(out.result, false, 'must return false on oversize file');
      // File must not have had the new row appended
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(!content.includes('should_not_appear'), 'row must not be appended to oversized file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
