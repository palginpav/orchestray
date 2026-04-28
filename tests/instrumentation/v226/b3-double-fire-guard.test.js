'use strict';

/**
 * Test B3: Double-fire guard.
 *
 * Asserts:
 *   1. Same dedup_token from different callerPath within 100ms → shouldFire=false + doubleFireEvent non-null.
 *   2. After >100ms TTL: second invocation runs normally (shouldFire=true).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { checkDoubleFire } = require('../../../bin/_lib/tokenwright/double-fire-guard');

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-b3-dfg-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

// ---------------------------------------------------------------------------
// Test 1: same token, different caller → double-fire detected within TTL
// ---------------------------------------------------------------------------
test('B3-double-fire-guard: second call with same token+different caller returns shouldFire=false', (t) => {
  const tmpDir  = makeTmpDir(t);
  const stateDir = path.join(tmpDir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const dedupToken = 'developer:abc123:' + Date.now();
  const orchId     = 'orch-test-b3';

  // First call: register the token
  const first = checkDoubleFire({
    dedupToken,
    callerPath:       '/first/path/inject-tokenwright.js',
    stateDir,
    orchestrationId:  orchId,
  });
  assert.equal(first.shouldFire, true,  'first call must fire');
  assert.equal(first.doubleFireEvent, null, 'first call must not produce double-fire event');

  // Second call: same token, different caller path (simulates double hook registration)
  const second = checkDoubleFire({
    dedupToken,
    callerPath:       '/second/path/inject-tokenwright.js',
    stateDir,
    orchestrationId:  orchId,
  });
  assert.equal(second.shouldFire, false, 'second call must NOT fire');
  assert.ok(second.doubleFireEvent !== null, 'double-fire event must be present');
  assert.equal(second.doubleFireEvent.type, 'compression_double_fire_detected');
  assert.ok(second.doubleFireEvent.delta_ms >= 0, 'delta_ms must be non-negative');
  assert.equal(second.doubleFireEvent.first_caller,  '/first/path/inject-tokenwright.js');
  assert.equal(second.doubleFireEvent.second_caller, '/second/path/inject-tokenwright.js');
});

// ---------------------------------------------------------------------------
// Test 2: same token, same caller → NOT a double-fire (idempotent self-call)
// ---------------------------------------------------------------------------
test('B3-double-fire-guard: same token, same caller path does not trigger double-fire', (t) => {
  const tmpDir  = makeTmpDir(t);
  const stateDir = path.join(tmpDir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const dedupToken = 'developer:same-caller:' + Date.now();
  const callerPath = '/same/path/inject-tokenwright.js';
  const orchId     = 'orch-test-b3-same';

  const first = checkDoubleFire({ dedupToken, callerPath, stateDir, orchestrationId: orchId });
  assert.equal(first.shouldFire, true);

  const second = checkDoubleFire({ dedupToken, callerPath, stateDir, orchestrationId: orchId });
  // Same caller is not a double-fire
  assert.equal(second.doubleFireEvent, null, 'same caller must not produce double-fire event');
});

// ---------------------------------------------------------------------------
// Test 3: double-fire suppression after 60s TTL (simulated via stale journal file)
// ---------------------------------------------------------------------------
test('B3-double-fire-guard: expired entry does not prevent new registration', (t) => {
  const tmpDir  = makeTmpDir(t);
  const stateDir = path.join(tmpDir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const dedupToken = 'developer:expired:12345';
  const orchId     = 'orch-test-b3-expired';

  // Manually write an EXPIRED dedup entry (ts_ms = 2 minutes ago)
  const expiredEntry = {
    dedup_token:      dedupToken,
    ts_ms:            Date.now() - 2 * 60 * 1000,  // 2 minutes ago (> 60s TTL)
    caller_path:      '/first/path/inject-tokenwright.js',
    orchestration_id: orchId,
  };
  const dedupFile = path.join(stateDir, 'tokenwright-dedup.jsonl');
  fs.writeFileSync(dedupFile, JSON.stringify(expiredEntry) + '\n', 'utf8');

  // Now call from a "second" caller: the expired entry should be swept, so no double-fire
  const result = checkDoubleFire({
    dedupToken,
    callerPath:       '/second/path/inject-tokenwright.js',
    stateDir,
    orchestrationId:  orchId,
  });

  // The expired first-caller entry is gone, so this is a fresh registration
  assert.equal(result.shouldFire, true, 'fresh call after TTL expiry must fire');
  assert.equal(result.doubleFireEvent, null, 'no double-fire event expected after TTL expiry');
});
