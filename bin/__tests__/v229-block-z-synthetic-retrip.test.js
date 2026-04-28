#!/usr/bin/env node
'use strict';

/**
 * v2.2.9 — Block-Z synthetic-retrip CI smoke test.
 *
 * Simulates zone1-hash drift causing the block_z sentinel to auto-clear
 * and re-trip. Verifies:
 *   1. A single drift event emits `block_z_sentinel_retripped`.
 *   2. After 3 retrips within the 1-hour window, `block_z_drift_unresolved`
 *      fires and a permanent-disable sentinel is written.
 *   3. `checkAndHandleBlockZRetriп` returns `false` when no violations file
 *      exists (fail-open guard).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkAndHandleBlockZRetriп,
  loadBlockZRecovery,
  writeSentinel,
} = require('../../bin/compose-block-a');

const STATE_DIR = path.join('.orchestray', 'state');
const AUDIT_DIR = path.join('.orchestray', 'audit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v229-blkz-'));
}

function setupStateDir(cwd) {
  fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
  fs.mkdirSync(path.join(cwd, AUDIT_DIR), { recursive: true });
}

/**
 * Write a single violation record into block-a-zone-violations.jsonl.
 * `tsOffset` is the age in ms (positive = older than now).
 */
function writeViolation(cwd, opts = {}) {
  const {
    actualHash = 'aabbcc112233',
    expectedHash = 'ddeeff445566',
    tsOffset = 0, // ms older than now (0 = just now)
  } = opts;
  const ts = new Date(Date.now() - tsOffset).toISOString();
  const line = JSON.stringify({
    ts,
    actual_hash: actualHash,
    expected_hash: expectedHash,
  });
  const file = path.join(cwd, STATE_DIR, 'block-a-zone-violations.jsonl');
  fs.appendFileSync(file, line + '\n', 'utf8');
}

function readEventsJsonl(cwd) {
  const file = path.join(cwd, AUDIT_DIR, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v229 Block-Z synthetic-retrip', () => {

  test('returns false when violations file is absent (fail-open guard)', () => {
    const cwd = makeTmp();
    try {
      setupStateDir(cwd);
      // No violations file — must return false without throwing.
      const result = checkAndHandleBlockZRetriп(cwd, 'somehash', 'orch-001', {});
      assert.equal(result, false, 'must return false when no violations file exists');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('single drift retrip emits block_z_sentinel_retripped', () => {
    const cwd = makeTmp();
    try {
      setupStateDir(cwd);
      // Write a very recent violation (5 seconds ago — within 60-second window).
      writeViolation(cwd, { tsOffset: 5_000 });

      const result = checkAndHandleBlockZRetriп(cwd, 'newHashABC', 'orch-test-1', {});
      assert.equal(result, true, 'should detect retrip and return true');

      const events = readEventsJsonl(cwd);
      const retripped = events.filter(e => e.type === 'block_z_sentinel_retripped');
      assert.equal(retripped.length, 1, 'exactly one block_z_sentinel_retripped event must fire');
      assert.equal(retripped[0].orchestration_id, 'orch-test-1');
      assert.ok(typeof retripped[0].recovery_attempts === 'number');

      // drift_unresolved must NOT fire on the first retrip.
      const unresolved = events.filter(e => e.type === 'block_z_drift_unresolved');
      assert.equal(unresolved.length, 0, 'block_z_drift_unresolved must NOT fire on first retrip');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('3 retrips within 1 hour cause block_z_drift_unresolved to fire', () => {
    const cwd = makeTmp();
    try {
      setupStateDir(cwd);

      const orchId = 'orch-drift-escalation';
      // Each call simulates a new compose-block-a run that re-detects drift.
      // We need to clear the sentinel between calls (the sentinel blocks re-trip).

      for (let i = 0; i < 3; i++) {
        // Clear sentinel so each call can proceed.
        const sentinelPath = path.join(cwd, STATE_DIR, '.block-a-zone-caching-disabled');
        if (fs.existsSync(sentinelPath)) fs.unlinkSync(sentinelPath);

        // Each call needs a fresh recent violation.
        writeViolation(cwd, { tsOffset: 2_000 * (i + 1), actualHash: `hash-${i}` });

        checkAndHandleBlockZRetriп(cwd, `current-hash-${i}`, orchId, {});
      }

      const events = readEventsJsonl(cwd);

      const retripped = events.filter(e => e.type === 'block_z_sentinel_retripped');
      assert.equal(retripped.length, 3, '3 block_z_sentinel_retripped events must fire (one per retrip)');

      const unresolved = events.filter(e => e.type === 'block_z_drift_unresolved');
      assert.equal(unresolved.length, 1, 'exactly one block_z_drift_unresolved must fire at 3 retrips');
      assert.equal(unresolved[0].recovery_attempts, 3);
      assert.ok(Array.isArray(unresolved[0].distinct_hashes_seen));

      // Permanent sentinel file must be written.
      const permPath = path.join(cwd, STATE_DIR, '.block-a-zone-caching-disabled-permanent');
      assert.ok(fs.existsSync(permPath), 'permanent sentinel must be written after 3 retrips');
      const perm = JSON.parse(fs.readFileSync(permPath, 'utf8'));
      assert.equal(perm.quarantined, true);
      assert.equal(perm.reason, 'block_z_drift_unresolved');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

});
