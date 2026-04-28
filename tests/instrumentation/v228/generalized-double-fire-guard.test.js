'use strict';

/**
 * Test v2.2.8 Item 4 + Issue D: Generalized double-fire guard.
 *
 * Verifies:
 *   1. requireGuard: first call fires (shouldFire=true), second from different
 *      caller within TTL is caught (shouldFire=false, doubleFireEvent populated).
 *   2. requireGuard: same caller is NOT caught (same-process re-entry is allowed).
 *   3. Issue D: module-scope suppression cache persists across calls — 3rd call
 *      with same (orchId, guardName, dedupKey) is suppressed without re-emitting
 *      the event (doubleFireEvent=null on 3rd call).
 *   4. Tokenwright backward compat: checkDoubleFire shim returns same shape.
 *   5. Kill switch: ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1 bypasses guard.
 *   6. Fail-open: missing stateDir returns shouldFire=true.
 *   7. Guard is per-guardName: separate guards don't interfere.
 *   8. TTL: entries older than ttlMs are expired and treated as new.
 *   9. compose-block-a: requireGuard is wired (require() succeeds, no missing dep).
 *  10. inject-delegation-delta: same.
 *  11. emit-routing-outcome: same.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const GUARD_MODULE   = path.join(__dirname, '../../../bin/_lib/double-fire-guard.js');
const TW_GUARD       = path.join(__dirname, '../../../bin/_lib/tokenwright/double-fire-guard.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v228-dfg-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  });
  return dir;
}

/**
 * Clear the module-scope suppression cache between tests by re-requiring
 * the module (delete from require.cache). This is necessary because the
 * in-memory cache intentionally persists within a process.
 */
function freshRequireGuard() {
  delete require.cache[require.resolve(GUARD_MODULE)];
  return require(GUARD_MODULE).requireGuard;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. first call fires (shouldFire=true)', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const result = requireGuard({
    guardName:       'test-guard',
    dedupKey:        'orch-a:sess-1:test',
    ttlMs:           60000,
    stateDir,
    callerPath:      '/a/hook.js',
    orchestrationId: 'orch-a',
  });
  assert.equal(result.shouldFire, true);
  assert.equal(result.doubleFireEvent, null);
});

test('2. second call from different caller is caught (shouldFire=false, event populated)', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const params = { guardName: 'test-guard', dedupKey: 'orch-b:sess-1:test', ttlMs: 60000, stateDir, orchestrationId: 'orch-b' };

  requireGuard({ ...params, callerPath: '/install-a/hook.js' });
  const r2 = requireGuard({ ...params, callerPath: '/install-b/hook.js' });

  assert.equal(r2.shouldFire, false);
  assert.ok(r2.doubleFireEvent !== null, 'doubleFireEvent should be populated');
  assert.equal(r2.doubleFireEvent.type, 'hook_double_fire_detected');
  assert.equal(r2.doubleFireEvent.guard_name, 'test-guard');
  assert.equal(r2.doubleFireEvent.dedup_key, 'orch-b:sess-1:test');
  assert.equal(r2.doubleFireEvent.first_caller, '/install-a/hook.js');
  assert.equal(r2.doubleFireEvent.second_caller, '/install-b/hook.js');
  assert.ok(typeof r2.doubleFireEvent.delta_ms === 'number');
  assert.equal(r2.doubleFireEvent.orchestration_id, 'orch-b');
  assert.equal(r2.doubleFireEvent.schema_version, 1);
  assert.equal(r2.doubleFireEvent.version, 1);
  assert.ok(typeof r2.doubleFireEvent.timestamp === 'string');
});

test('3. Issue D: 3rd call suppressed via module-scope cache (no re-emit)', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const params = { guardName: 'test-guard', dedupKey: 'orch-c:sess-1:test', ttlMs: 60000, stateDir, orchestrationId: 'orch-c' };

  requireGuard({ ...params, callerPath: '/install-a/hook.js' }); // first — fires
  const r2 = requireGuard({ ...params, callerPath: '/install-b/hook.js' }); // second — caught, event emitted
  const r3 = requireGuard({ ...params, callerPath: '/install-b/hook.js' }); // third — caught, NO event re-emit

  assert.equal(r2.shouldFire, false);
  assert.ok(r2.doubleFireEvent !== null, '2nd should have doubleFireEvent');

  assert.equal(r3.shouldFire, false);
  assert.equal(r3.doubleFireEvent, null, '3rd should be suppressed without re-emitting event (Issue D)');
});

test('4. same caller is NOT caught (same install, different invocation)', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const params = { guardName: 'test-guard', dedupKey: 'orch-d:sess-1:test', ttlMs: 60000, stateDir, callerPath: '/same/hook.js', orchestrationId: 'orch-d' };

  requireGuard(params); // first
  const r2 = requireGuard(params); // same caller — should still fire
  // Same caller path: not a double-fire (could be legitimate second turn, different session).
  // The guard only fires on different caller_path within TTL.
  assert.equal(r2.shouldFire, true, 'same caller should still fire');
});

test('5. Tokenwright backward compat: checkDoubleFire shim', (t) => {
  // Clear both modules from cache for isolation
  delete require.cache[require.resolve(GUARD_MODULE)];
  delete require.cache[require.resolve(TW_GUARD)];

  const { checkDoubleFire } = require(TW_GUARD);
  const stateDir = makeTmpDir(t);

  const r1 = checkDoubleFire({ dedupToken: 'tok-1', callerPath: '/a.js', stateDir, orchestrationId: 'orch-tw' });
  assert.equal(r1.shouldFire, true);
  assert.equal(r1.doubleFireEvent, null);

  const r2 = checkDoubleFire({ dedupToken: 'tok-1', callerPath: '/b.js', stateDir, orchestrationId: 'orch-tw' });
  assert.equal(r2.shouldFire, false);
  assert.ok(r2.doubleFireEvent !== null);
  // guard_name should be 'tokenwright' for backward compat
  assert.equal(r2.doubleFireEvent.guard_name, 'tokenwright');
  assert.equal(r2.doubleFireEvent.dedup_key, 'tok-1');
});

test('6. Kill switch: ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1 bypasses guard', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const saved = process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD;
  process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD;
    else process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD = saved;
  });

  // First call to register
  requireGuard({ guardName: 'test-guard', dedupKey: 'orch-ks:sess-1:test', ttlMs: 60000, stateDir, callerPath: '/a/hook.js', orchestrationId: 'orch-ks' });
  // Second call from different caller with kill switch on
  const r = requireGuard({ guardName: 'test-guard', dedupKey: 'orch-ks:sess-1:test', ttlMs: 60000, stateDir, callerPath: '/b/hook.js', orchestrationId: 'orch-ks' });
  assert.equal(r.shouldFire, true, 'kill switch should bypass guard');
});

test('7. Fail-open: missing stateDir returns shouldFire=true', (t) => {
  const requireGuard = freshRequireGuard();
  const r = requireGuard({ guardName: 'test-guard', dedupKey: 'key', ttlMs: 60000, stateDir: null, callerPath: '/a.js', orchestrationId: 'orch-x' });
  assert.equal(r.shouldFire, true, 'null stateDir should fail-open');
});

test('8. Guards are isolated by guardName — separate guards do not interfere', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const baseParams = { dedupKey: 'orch-e:sess-1:shared', ttlMs: 60000, stateDir, orchestrationId: 'orch-e' };

  requireGuard({ ...baseParams, guardName: 'guard-alpha', callerPath: '/a/hook.js' });
  requireGuard({ ...baseParams, guardName: 'guard-beta',  callerPath: '/a/hook.js' });

  const rAlpha = requireGuard({ ...baseParams, guardName: 'guard-alpha', callerPath: '/b/hook.js' });
  const rBeta  = requireGuard({ ...baseParams, guardName: 'guard-beta',  callerPath: '/b/hook.js' });

  // Both should be caught independently; their journals are separate files.
  assert.equal(rAlpha.shouldFire, false, 'guard-alpha should catch duplicate');
  assert.equal(rBeta.shouldFire,  false, 'guard-beta should catch duplicate independently');
  assert.equal(rAlpha.doubleFireEvent.guard_name, 'guard-alpha');
  assert.equal(rBeta.doubleFireEvent.guard_name,  'guard-beta');
});

test('9. TTL: expired entries are treated as new (no double-fire detection after TTL)', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);
  const journalFile = path.join(stateDir, 'test-guard-dedup.jsonl');
  fs.mkdirSync(stateDir, { recursive: true });

  // Write an expired entry manually (ts_ms = 10 minutes ago)
  const oldEntry = JSON.stringify({
    dedup_key:        'orch-f:sess-1:test',
    ts_ms:            Date.now() - 10 * 60 * 1000, // 10 min ago
    caller_path:      '/a/hook.js',
    orchestration_id: 'orch-f',
  });
  fs.writeFileSync(journalFile, oldEntry + '\n', 'utf8');

  // Now call with TTL=60s: the old entry is expired, so this fires as first
  const r = requireGuard({
    guardName:       'test-guard',
    dedupKey:        'orch-f:sess-1:test',
    ttlMs:           60 * 1000,
    stateDir,
    callerPath:      '/b/hook.js',  // different caller, but entry is expired
    orchestrationId: 'orch-f',
  });
  assert.equal(r.shouldFire, true, 'expired entries should not trigger double-fire');
});

test('10. Wiring check: compose-block-a.js requires double-fire-guard', () => {
  const hookPath = path.join(__dirname, '../../../bin/compose-block-a.js');
  const src = fs.readFileSync(hookPath, 'utf8');
  assert.ok(src.includes("require('./_lib/double-fire-guard')"), 'compose-block-a.js must require double-fire-guard');
  assert.ok(src.includes('requireGuard'), 'compose-block-a.js must call requireGuard');
});

test('11. Wiring check: inject-delegation-delta.js requires double-fire-guard', () => {
  const hookPath = path.join(__dirname, '../../../bin/inject-delegation-delta.js');
  const src = fs.readFileSync(hookPath, 'utf8');
  assert.ok(src.includes("require('./_lib/double-fire-guard')"), 'inject-delegation-delta.js must require double-fire-guard');
  assert.ok(src.includes('requireGuard'), 'inject-delegation-delta.js must call requireGuard');
});

test('12. Wiring check: emit-routing-outcome.js requires double-fire-guard', () => {
  const hookPath = path.join(__dirname, '../../../bin/emit-routing-outcome.js');
  const src = fs.readFileSync(hookPath, 'utf8');
  assert.ok(src.includes("require('./_lib/double-fire-guard')"), 'emit-routing-outcome.js must require double-fire-guard');
  assert.ok(src.includes('requireGuard'), 'emit-routing-outcome.js must call requireGuard');
});

test('13. journal: dedup file is created with correct format', (t) => {
  const requireGuard = freshRequireGuard();
  const stateDir = makeTmpDir(t);

  requireGuard({ guardName: 'my-guard', dedupKey: 'k1', ttlMs: 60000, stateDir, callerPath: '/a.js', orchestrationId: 'orch-g' });

  const journalPath = path.join(stateDir, 'my-guard-dedup.jsonl');
  assert.ok(fs.existsSync(journalPath), 'journal file should be created');
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'should have one entry');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.dedup_key, 'k1');
  assert.equal(entry.caller_path, '/a.js');
  assert.equal(entry.orchestration_id, 'orch-g');
  assert.ok(typeof entry.ts_ms === 'number');
});
