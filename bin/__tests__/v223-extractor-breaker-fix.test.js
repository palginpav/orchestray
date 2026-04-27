#!/usr/bin/env node
'use strict';

/**
 * v2.2.3 P0-3 — Pattern-extractor circuit-breaker cooldown auto-reset.
 *
 * Heals the v2.2.0 regression where a single trip persisted forever (the
 * sentinel had no expiry path). After this fix, a tripped sentinel
 * auto-resets once the configured cooldown has elapsed, and a
 * `learning_circuit_auto_reset` audit event fires so operators see the
 * recovery.
 *
 * Runner: node --test bin/__tests__/v223-extractor-breaker-fix.test.js
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
  DEFAULT_COOLDOWN_MS,
  HARD_COOLDOWN_CEILING_MS,
  _internal: {
    _counterPath,
    _sentinelPath,
    _writeCounterFile,
    _writeSentinel,
    _readSentinel,
    _autoResetIfCooldownExpired,
    _resolveCooldownMs,
  },
} = require('../_lib/learning-circuit-breaker.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-breaker-cooldown-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readAuditEvents() {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function writeStaleTripped(scope, ageMs, reason) {
  const sPath = _sentinelPath(tmpDir, scope);
  const cPath = _counterPath(tmpDir, scope);
  const trippedAt = new Date(Date.now() - ageMs).toISOString();
  _writeSentinel(sPath, { scope, count: 10, max: 10, trippedAt, reason: reason || 'quota_exceeded' });
  _writeCounterFile(cPath, {
    schema_version: 1,
    scope,
    count: 10,
    windowStart: trippedAt,
    trippedAt,
  });
  return trippedAt;
}

// ---------------------------------------------------------------------------
// Trip condition still increments correctly (regression guard)
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — trip condition still works', () => {
  test('counter increments and trips at max', () => {
    const scope = 'trip_increment';
    const max = 3;
    for (let i = 0; i < max; i++) {
      const r = checkAndIncrement({ scope, max, cwd: tmpDir });
      assert.equal(r.allowed, true, `step ${i+1} should be allowed`);
    }
    const tripped = checkAndIncrement({ scope, max, cwd: tmpDir });
    assert.equal(tripped.allowed, false);
    assert.equal(tripped.reason, 'tripped');
  });
});

// ---------------------------------------------------------------------------
// reset() clears counter
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — explicit reset still works', () => {
  test('reset() clears tripped sentinel and counter', () => {
    const scope = 'reset_scope';
    const max = 2;
    checkAndIncrement({ scope, max, cwd: tmpDir });
    checkAndIncrement({ scope, max, cwd: tmpDir });
    const beforeReset = checkAndIncrement({ scope, max, cwd: tmpDir });
    assert.equal(beforeReset.allowed, false);

    reset({ scope, cwd: tmpDir });
    assert.equal(isTripped({ scope, cwd: tmpDir }), false);

    const afterReset = checkAndIncrement({ scope, max, cwd: tmpDir });
    assert.equal(afterReset.allowed, true);
    assert.equal(afterReset.count, 1);
  });
});

// ---------------------------------------------------------------------------
// Cooldown auto-reset — checkAndIncrement fast path
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — cooldown auto-reset on checkAndIncrement', () => {
  test('sentinel younger than cooldown → still tripped', () => {
    const scope = 'fresh_trip';
    const cooldownMs = 60 * 60 * 1000; // 60 min
    writeStaleTripped(scope, 5 * 60 * 1000, 'quota_exceeded'); // 5 min old
    const r = checkAndIncrement({ scope, max: 10, cooldownMs, cwd: tmpDir });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'tripped');
    // Sentinel still on disk
    assert.ok(_readSentinel(_sentinelPath(tmpDir, scope)));
  });

  test('sentinel older than cooldown → auto-reset, request allowed', () => {
    const scope = 'expired_trip';
    const cooldownMs = 60 * 60 * 1000; // 60 min
    writeStaleTripped(scope, 90 * 60 * 1000, 'quota_exceeded'); // 90 min old
    const r = checkAndIncrement({ scope, max: 10, cooldownMs, cwd: tmpDir });
    assert.equal(r.allowed, true, 'should be allowed after cooldown');
    assert.equal(r.count, 1, 'fresh window starts at count=1');
    // Sentinel removed
    assert.equal(_readSentinel(_sentinelPath(tmpDir, scope)), null);
  });

  test('auto-reset emits learning_circuit_auto_reset audit event', () => {
    const scope = 'audit_emit';
    const cooldownMs = 30 * 60 * 1000; // 30 min
    const trippedAt = writeStaleTripped(scope, 60 * 60 * 1000, 'quota_exceeded'); // 60 min old

    checkAndIncrement({ scope, max: 10, cooldownMs, cwd: tmpDir });

    const events = readAuditEvents();
    const reset = events.find(e => e.type === 'learning_circuit_auto_reset');
    assert.ok(reset, 'learning_circuit_auto_reset event should be emitted');
    assert.equal(reset.scope, scope);
    assert.equal(reset.tripped_at, trippedAt);
    assert.equal(reset.cooldown_ms, cooldownMs);
    assert.equal(reset.prior_reason, 'quota_exceeded');
    assert.ok(reset.age_ms >= 60 * 60 * 1000);
    assert.equal(reset.schema_version, 1);
  });

  test('multiple stale sentinels each auto-reset independently', () => {
    const cooldownMs = 30 * 60 * 1000;
    writeStaleTripped('scope_a', 60 * 60 * 1000, 'quota_exceeded');
    writeStaleTripped('scope_b', 60 * 60 * 1000, 'counter_corrupt');

    const ra = checkAndIncrement({ scope: 'scope_a', max: 10, cooldownMs, cwd: tmpDir });
    const rb = checkAndIncrement({ scope: 'scope_b', max: 10, cooldownMs, cwd: tmpDir });

    assert.equal(ra.allowed, true);
    assert.equal(rb.allowed, true);

    const events = readAuditEvents();
    const resets = events.filter(e => e.type === 'learning_circuit_auto_reset');
    assert.equal(resets.length, 2);
    const reasons = resets.map(e => e.prior_reason).sort();
    assert.deepEqual(reasons, ['counter_corrupt', 'quota_exceeded']);
  });
});

// ---------------------------------------------------------------------------
// Cooldown auto-reset — isTripped read path
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — cooldown auto-reset on isTripped', () => {
  test('isTripped returns true while within cooldown', () => {
    const scope = 'is_tripped_fresh';
    writeStaleTripped(scope, 5 * 60 * 1000, 'quota_exceeded');
    assert.equal(
      isTripped({ scope, cwd: tmpDir, cooldownMs: 60 * 60 * 1000 }),
      true,
    );
  });

  test('isTripped returns false after cooldown elapsed', () => {
    const scope = 'is_tripped_expired';
    writeStaleTripped(scope, 90 * 60 * 1000, 'quota_exceeded');
    assert.equal(
      isTripped({ scope, cwd: tmpDir, cooldownMs: 60 * 60 * 1000 }),
      false,
    );
    // Sentinel cleared
    assert.equal(_readSentinel(_sentinelPath(tmpDir, scope)), null);
  });

  test('isTripped without cooldownMs uses 60-minute default', () => {
    const scope = 'is_tripped_default';
    writeStaleTripped(scope, 90 * 60 * 1000, 'quota_exceeded'); // 90 min old > 60 min default
    assert.equal(isTripped({ scope, cwd: tmpDir }), false, 'default cooldown should auto-reset');
  });

  test('isTripped emits audit event on auto-reset', () => {
    const scope = 'is_tripped_audit';
    writeStaleTripped(scope, 90 * 60 * 1000, 'counter_corrupt');
    isTripped({ scope, cwd: tmpDir, cooldownMs: 60 * 60 * 1000 });

    const events = readAuditEvents();
    const reset = events.find(e => e.type === 'learning_circuit_auto_reset');
    assert.ok(reset);
    assert.equal(reset.prior_reason, 'counter_corrupt');
  });
});

// ---------------------------------------------------------------------------
// Cooldown clamping
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — cooldown clamping', () => {
  test('_resolveCooldownMs returns default for missing/invalid', () => {
    assert.equal(_resolveCooldownMs(undefined), DEFAULT_COOLDOWN_MS);
    assert.equal(_resolveCooldownMs(null), DEFAULT_COOLDOWN_MS);
    assert.equal(_resolveCooldownMs(0), DEFAULT_COOLDOWN_MS);
    assert.equal(_resolveCooldownMs(-1000), DEFAULT_COOLDOWN_MS);
    assert.equal(_resolveCooldownMs(NaN), DEFAULT_COOLDOWN_MS);
    assert.equal(_resolveCooldownMs('60'), DEFAULT_COOLDOWN_MS);
  });

  test('_resolveCooldownMs accepts valid positive numbers', () => {
    assert.equal(_resolveCooldownMs(15 * 60 * 1000), 15 * 60 * 1000);
    assert.equal(_resolveCooldownMs(1), 1);
  });

  test('_resolveCooldownMs clamps above 24h ceiling', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    assert.equal(_resolveCooldownMs(week), HARD_COOLDOWN_CEILING_MS);
    // Infinity is not finite → falls back to default (treated as invalid).
    assert.equal(_resolveCooldownMs(Infinity), DEFAULT_COOLDOWN_MS);
  });

  test('hard ceiling enforced even if caller passes huge cooldown', () => {
    const scope = 'ceiling_test';
    // Sentinel 25h old, caller asks for 7-day cooldown → ceiling clamps at 24h → expired.
    writeStaleTripped(scope, 25 * 60 * 60 * 1000, 'quota_exceeded');
    const week = 7 * 24 * 60 * 60 * 1000;
    const r = checkAndIncrement({ scope, max: 10, cooldownMs: week, cwd: tmpDir });
    assert.equal(r.allowed, true, '24h ceiling should auto-reset 25h-old sentinel');
  });
});

// ---------------------------------------------------------------------------
// Counter-only trip (no sentinel) also honors cooldown
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — counter-only trip path', () => {
  test('isTripped auto-resets stale counter file even without sentinel', () => {
    const scope = 'counter_only';
    const cPath = _counterPath(tmpDir, scope);
    const trippedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    _writeCounterFile(cPath, {
      schema_version: 1,
      scope,
      count: 10,
      windowStart: trippedAt,
      trippedAt,
    });
    // No sentinel file — only counter shows tripped.

    assert.equal(
      isTripped({ scope, cwd: tmpDir, cooldownMs: 60 * 60 * 1000 }),
      false,
      'counter-only trip should also auto-reset',
    );

    const events = readAuditEvents();
    const reset = events.find(e => e.type === 'learning_circuit_auto_reset');
    assert.ok(reset);
    assert.equal(reset.prior_reason, 'counter_only');
  });
});

// ---------------------------------------------------------------------------
// _autoResetIfCooldownExpired direct contract
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-3 — _autoResetIfCooldownExpired contract', () => {
  test('returns expired:false for null/missing sentinel', () => {
    const r = _autoResetIfCooldownExpired(tmpDir, 'noop', null, 60 * 60 * 1000);
    assert.equal(r.expired, false);
  });

  test('returns expired:false for sentinel without trippedAt', () => {
    const r = _autoResetIfCooldownExpired(tmpDir, 'noop', { scope: 'x' }, 60 * 60 * 1000);
    assert.equal(r.expired, false);
  });

  test('returns expired:false for unparseable trippedAt', () => {
    const r = _autoResetIfCooldownExpired(
      tmpDir, 'noop', { trippedAt: 'not-a-date' }, 60 * 60 * 1000);
    assert.equal(r.expired, false);
  });
});
