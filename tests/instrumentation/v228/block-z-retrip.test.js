#!/usr/bin/env node
'use strict';

/**
 * block-z-retrip.test.js — Item 6 (v2.2.8) Block-Z sentinel re-trip telemetry.
 *
 * Tests:
 *   T1. checkAndHandleBlockZRetrip: no-op when sentinel is PRESENT (normal trip, not re-trip).
 *   T2. checkAndHandleBlockZRetrip: no-op when no violations file exists.
 *   T3. checkAndHandleBlockZRetrip: no-op when latest violation is older than 60 s.
 *   T4. checkAndHandleBlockZRetrip: no-op when zone1 hash matches stored hash (no drift).
 *   T5. Re-trip detected: sentinel re-written, recovery counter incremented,
 *       block_z_sentinel_retripped event emitted.
 *   T6. After 3 re-trips within 1 hour: block_z_drift_unresolved emitted,
 *       permanent sentinel written.
 *   T7. kill switch cfg.block_z_enabled === false → no-op.
 *   T8. kill switch ORCHESTRAY_DISABLE_BLOCK_Z=1 → no-op.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const {
  checkAndHandleBlockZRetriп,
  loadBlockZRecovery,
  writeSentinel,
} = require(path.join(REPO_ROOT, 'bin', 'compose-block-a'));

// ---------------------------------------------------------------------------
// Test repo factory
// ---------------------------------------------------------------------------

function makeRepo(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-retrip-'));
  const state = path.join(dir, '.orchestray', 'state');
  const audit = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(state,  { recursive: true });
  fs.mkdirSync(audit,  { recursive: true });

  // Minimal zone-files for compose-block-a to not choke on require() calls
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# test\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'), '# hc\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'phase-contract.md'), '# pc\n');
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({
    block_a_zone_caching: { enabled: true },
    caching: { block_z: { enabled: true } },
  }));

  // current-orchestration.json so emitAuditEvent can find orch_id
  fs.writeFileSync(
    path.join(audit, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: opts.orchId || 'orch-test-001' })
  );

  if (opts.sentinelPresent) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(state, '.block-a-zone-caching-disabled'),
      JSON.stringify({ expires_at: expiresAt, quarantined: false })
    );
  }

  if (opts.violationTs) {
    const viol = { ts: new Date(opts.violationTs).toISOString(), expected_hash: opts.pinnedHash || 'aaa', actual_hash: 'bbb' };
    fs.writeFileSync(path.join(state, 'block-a-zone-violations.jsonl'), JSON.stringify(viol) + '\n');
  }

  if (opts.storedZone1Hash) {
    fs.writeFileSync(
      path.join(state, 'block-a-zones.json'),
      JSON.stringify({ zone1_hash: opts.storedZone1Hash, zone2_hash: 'z2', updated_at: new Date().toISOString() })
    );
  }

  return { dir, state, audit };
}

function readEvents(audit) {
  const eventsPath = path.join(audit, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

const CURRENT_HASH  = 'newhash123';
const STORED_HASH   = 'oldhash456';
const DEFAULT_CFG   = { block_z_enabled: true };

describe('Block-Z re-trip detection (Item 6, v2.2.8)', () => {

  test('T1: no-op when sentinel is already present', () => {
    const { dir, audit } = makeRepo({ sentinelPresent: true });
    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t1', DEFAULT_CFG);
    assert.strictEqual(result, false, 'should return false when sentinel active');
    const events = readEvents(audit);
    assert.strictEqual(events.filter(e => e.type === 'block_z_sentinel_retripped').length, 0);
  });

  test('T2: no-op when no violations file', () => {
    const { dir, audit } = makeRepo({});
    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t2', DEFAULT_CFG);
    assert.strictEqual(result, false);
    assert.strictEqual(readEvents(audit).filter(e => e.type === 'block_z_sentinel_retripped').length, 0);
  });

  test('T3: no-op when violation is older than 60s', () => {
    const oldTs = Date.now() - 120 * 1000; // 2 minutes ago
    const { dir, audit } = makeRepo({ violationTs: oldTs, storedZone1Hash: STORED_HASH });
    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t3', DEFAULT_CFG);
    assert.strictEqual(result, false);
    assert.strictEqual(readEvents(audit).filter(e => e.type === 'block_z_sentinel_retripped').length, 0);
  });

  test('T4: no-op when hashes match (no drift)', () => {
    const recentTs = Date.now() - 5 * 1000;
    const { dir, audit } = makeRepo({ violationTs: recentTs, storedZone1Hash: CURRENT_HASH });
    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t4', DEFAULT_CFG);
    assert.strictEqual(result, false);
  });

  test('T5: re-trip detected — sentinel re-written, counter incremented, event emitted', () => {
    const recentTs = Date.now() - 5 * 1000;
    const { dir, state, audit } = makeRepo({ violationTs: recentTs, storedZone1Hash: STORED_HASH });
    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t5', DEFAULT_CFG);
    assert.strictEqual(result, true, 'should return true on re-trip');

    // Sentinel re-written
    assert.ok(fs.existsSync(path.join(state, '.block-a-zone-caching-disabled')), 'sentinel should be re-written');

    // Counter incremented
    const rec = loadBlockZRecovery(state);
    assert.strictEqual(rec.count, 1);
    assert.ok(Array.isArray(rec.distinct_hashes));
    assert.ok(rec.distinct_hashes.includes(CURRENT_HASH));

    // Event emitted
    const events = readEvents(audit);
    const ev = events.find(e => e.type === 'block_z_sentinel_retripped');
    assert.ok(ev, 'block_z_sentinel_retripped should be emitted');
    assert.strictEqual(ev.recovery_attempts, 1);
    assert.strictEqual(ev.observed_hash, CURRENT_HASH);
    assert.ok(typeof ev.time_since_clear_ms === 'number');
  });

  test('T6: 3 trips within 1h → block_z_drift_unresolved emitted + permanent sentinel', () => {
    const recentTs = Date.now() - 3 * 1000;
    const { dir, state, audit } = makeRepo({ violationTs: recentTs, storedZone1Hash: STORED_HASH });

    // Seed the recovery counter so we're already at 2 within the window
    const firstTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    require(path.join(REPO_ROOT, 'bin', 'compose-block-a')).saveBlockZRecovery(state, {
      count: 2,
      first_attempt_ts: firstTs,
      distinct_hashes: ['hash1', 'hash2'],
    });

    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t6', DEFAULT_CFG);
    assert.strictEqual(result, true);

    // Permanent sentinel must exist
    assert.ok(
      fs.existsSync(path.join(state, '.block-a-zone-caching-disabled-permanent')),
      'permanent sentinel should be written'
    );

    const events = readEvents(audit);

    // block_z_sentinel_retripped should also fire
    const retrip = events.find(e => e.type === 'block_z_sentinel_retripped');
    assert.ok(retrip, 'block_z_sentinel_retripped should be emitted on 3rd trip');
    assert.strictEqual(retrip.recovery_attempts, 3);

    // block_z_drift_unresolved should fire
    const unresolved = events.find(e => e.type === 'block_z_drift_unresolved');
    assert.ok(unresolved, 'block_z_drift_unresolved should be emitted');
    assert.strictEqual(unresolved.recovery_attempts, 3);
    assert.strictEqual(unresolved.window_minutes, 60);
    assert.ok(Array.isArray(unresolved.distinct_hashes_seen));
    assert.ok(unresolved.distinct_hashes_seen.includes(CURRENT_HASH));
  });

  test('T7: kill switch cfg.block_z_enabled === false → no-op', () => {
    const recentTs = Date.now() - 3 * 1000;
    const { dir, audit } = makeRepo({ violationTs: recentTs, storedZone1Hash: STORED_HASH });
    const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t7', { block_z_enabled: false });
    assert.strictEqual(result, false);
    assert.strictEqual(readEvents(audit).filter(e => e.type === 'block_z_sentinel_retripped').length, 0);
  });

  test('T8: kill switch ORCHESTRAY_DISABLE_BLOCK_Z=1 → no-op', () => {
    const recentTs = Date.now() - 3 * 1000;
    const { dir, audit } = makeRepo({ violationTs: recentTs, storedZone1Hash: STORED_HASH });
    process.env.ORCHESTRAY_DISABLE_BLOCK_Z = '1';
    try {
      const result = checkAndHandleBlockZRetriп(dir, CURRENT_HASH, 'orch-t8', DEFAULT_CFG);
      assert.strictEqual(result, false);
    } finally {
      delete process.env.ORCHESTRAY_DISABLE_BLOCK_Z;
    }
  });

});
