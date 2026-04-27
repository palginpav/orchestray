#!/usr/bin/env node
'use strict';

/**
 * v221-cache-sentinel.test.js — W5 / B1 (W2)
 *
 * Tests the v2.2.1 self-healing cache sentinel + auto-rebaseline behavior
 * in `bin/validate-cache-invariant.js`.
 *
 * Cases covered (W5.md "B1 (W2)" section):
 *   1. Sentinel younger than TTL with active flag → still no-op,
 *      sentinel timestamp unchanged.
 *   2. Sentinel older than TTL with no current violation → sentinel
 *      deleted, compose runs, block_a_zone_composed event fires.
 *   3. Sentinel older than TTL with current violation → sentinel re-armed
 *      with fresh timestamp + trip counter incremented.
 *   4. Trip counter at threshold → cache_geometry_quarantined event fires
 *      AND sentinel persists past TTL (latched).
 *   5. Post-upgrade migration — covered in
 *      tests/v221-post-upgrade-migration.test.js (this file owns the
 *      runtime self-heal; that file owns the install-time sweep).
 *   6. Regression: simulate the 2026-04-27T05:26 condition — 5 violations
 *      within 60s with identical hash pair → exactly 1 deduped violation,
 *      sentinel NOT tripped.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..');
const VALIDATOR      = path.join(REPO_ROOT, 'bin', 'validate-cache-invariant.js');
const COMPOSE        = path.join(REPO_ROOT, 'bin', 'compose-block-a.js');
const STATE_REL      = path.join('.orchestray', 'state');
const SENTINEL_REL   = path.join(STATE_REL, '.block-a-zone-caching-disabled');
const VIOLATIONS_REL = path.join(STATE_REL, 'block-a-zone-violations.jsonl');
const ZONES_REL      = path.join(STATE_REL, 'block-a-zones.json');
const EVENTS_REL     = path.join('.orchestray', 'audit', 'events.jsonl');

const VALIDATOR_LIB = require(VALIDATOR);

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v221-cache-sentinel-'));
  fs.mkdirSync(path.join(dir, STATE_REL), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project Instructions\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'),
    '# Handoff Contract\n', 'utf8'
  );
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'test-orch', goal: 'test', constraints: [] }),
    'utf8'
  );
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function runCompose(dir, env = {}) {
  return spawnSync(process.execPath, [COMPOSE], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env),
  });
}

function runValidator(dir, env = {}) {
  return spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env),
  });
}

function readEvents(dir) {
  const p = path.join(dir, EVENTS_REL);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

function writeJsonSentinel(dir, body) {
  fs.writeFileSync(path.join(dir, SENTINEL_REL), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function readSentinelStat(dir) {
  return fs.statSync(path.join(dir, SENTINEL_REL));
}

describe('B1.1 — sentinel younger than TTL with active flag', () => {
  test('isSentinelActive returns true and validator stays a no-op (no events emitted)', () => {
    const dir = makeSandbox();
    try {
      // Compose to establish baseline zones
      runCompose(dir);
      // Mutate CLAUDE.md so a hash mismatch would otherwise be detected
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mutated\n', 'utf8');

      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      writeJsonSentinel(dir, {
        written_at:    new Date().toISOString(),
        expires_at:    future,
        reason:        'test_active',
        recovery_hint: 'n/a',
        trip_count:    1,
        quarantined:   false,
      });
      const mtimeBefore = readSentinelStat(dir).mtimeMs;

      assert.equal(VALIDATOR_LIB.isSentinelActive(dir), true,
        'isSentinelActive must report true when expires_at is in the future');

      const eventsBefore = readEvents(dir).length;
      const r = runValidator(dir);
      assert.equal(r.status, 0, 'validator must exit 0');

      // Validator should have early-exited; no new events emitted
      assert.equal(readEvents(dir).length, eventsBefore,
        'validator must NOT emit any new event when sentinel is active');
      const mtimeAfter = readSentinelStat(dir).mtimeMs;
      assert.equal(mtimeAfter, mtimeBefore,
        'sentinel mtime must be unchanged when validator early-exits on active sentinel');
    } finally { cleanup(dir); }
  });
});

describe('B1.2 — sentinel older than TTL with no current violation', () => {
  test('clearStaleSentinelIfAny unlinks the file and emits cache_sentinel_expired with reason ttl_expired', () => {
    const dir = makeSandbox();
    try {
      runCompose(dir);
      // Compose run wrote the events; now write a TTL-expired sentinel
      writeJsonSentinel(dir, {
        written_at:    new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        expires_at:    new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        reason:        'old',
        recovery_hint: 'expired',
        trip_count:    1,
        quarantined:   false,
      });
      assert.equal(VALIDATOR_LIB.isSentinelActive(dir), false,
        'expired sentinel must report inactive');

      const cleared = VALIDATOR_LIB.clearStaleSentinelIfAny(dir, { sentinel_ttl_hours: 24 });
      assert.equal(cleared, true, 'clearStaleSentinelIfAny must return true on TTL-expired sentinel');
      assert.equal(fs.existsSync(path.join(dir, SENTINEL_REL)), false,
        'sentinel file must be removed');

      const events  = readEvents(dir);
      const expired = events.find(e => e && e.type === 'cache_sentinel_expired');
      assert.ok(expired, 'cache_sentinel_expired event must be emitted');
      assert.equal(expired.reason, 'ttl_expired',
        'reason must be ttl_expired (not legacy_bare_string)');

      // After clearing, the next compose should run normally (no sentinel
      // means the early-exit doesn't fire) — block_a_zone_composed event
      // is the observable side effect.
      const composeResult = runCompose(dir);
      assert.equal(composeResult.status, 0);
      const composedAfter = readEvents(dir).filter(e => e && e.type === 'block_a_zone_composed');
      assert.ok(composedAfter.length >= 1,
        'compose must re-run after sentinel cleared (block_a_zone_composed event)');
    } finally { cleanup(dir); }
  });
});

describe('B1.3 — sentinel older than TTL with current violation', () => {
  test('writeSentinel re-arms with fresh expires_at and increments trip_count', () => {
    const dir = makeSandbox();
    try {
      writeJsonSentinel(dir, {
        written_at:    new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        expires_at:    new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        reason:        'prior',
        recovery_hint: 'old',
        trip_count:    1,
        quarantined:   false,
      });

      const result = VALIDATOR_LIB.writeSentinel(dir, { sentinel_ttl_hours: 24, quarantine_trip_threshold: 5 }, {
        reason: 're-armed-by-test',
      });
      assert.equal(result.trip_count, 2, 'trip_count must increment');
      assert.equal(result.quarantined, false,
        'must not be quarantined yet (threshold=5, count=2)');

      const body = JSON.parse(fs.readFileSync(path.join(dir, SENTINEL_REL), 'utf8'));
      assert.equal(body.trip_count, 2, 'persisted trip_count must be 2');
      assert.equal(body.quarantined, false);
      assert.ok(new Date(body.expires_at).getTime() > Date.now(),
        'persisted expires_at must be in the future (re-armed)');
      assert.equal(body.reason, 're-armed-by-test', 'reason must be the new reason');
    } finally { cleanup(dir); }
  });
});

describe('B1.4 — trip counter reaches threshold', () => {
  test('cache_geometry_quarantined event fires AND sentinel persists past TTL', () => {
    const dir = makeSandbox();
    try {
      // Pre-write a sentinel one short of threshold
      writeJsonSentinel(dir, {
        written_at:    new Date().toISOString(),
        expires_at:    new Date(Date.now() + 60 * 1000).toISOString(),
        reason:        'almost',
        recovery_hint: 'n/a',
        trip_count:    2,
        quarantined:   false,
      });

      const r = VALIDATOR_LIB.writeSentinel(dir, {
        sentinel_ttl_hours: 24,
        quarantine_trip_threshold: 3,
      }, { reason: 'tip-into-quarantine' });

      assert.equal(r.trip_count, 3, 'trip_count must reach threshold');
      assert.equal(r.quarantined, true, 'quarantined must be true at threshold');

      const body = JSON.parse(fs.readFileSync(path.join(dir, SENTINEL_REL), 'utf8'));
      assert.equal(body.quarantined, true,
        'persisted sentinel body must record quarantined: true');

      const events = readEvents(dir);
      const quar   = events.find(e => e && e.type === 'cache_geometry_quarantined');
      assert.ok(quar, 'cache_geometry_quarantined event must be emitted at threshold');
      assert.equal(quar.trip_count, 3);
      assert.equal(quar.threshold,  3);

      // Latched-past-TTL semantics: even if expires_at were in the past,
      // isSentinelActive must keep returning true once quarantined: true.
      writeJsonSentinel(dir, Object.assign({}, body, {
        expires_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      }));
      assert.equal(VALIDATOR_LIB.isSentinelActive(dir), true,
        'quarantined sentinel must remain active even past expires_at (latched)');
    } finally { cleanup(dir); }
  });
});

describe('B1.5 — bare-string sentinel self-expires on read (runtime self-heal)', () => {
  test('parseSentinelBody returns null for legacy bare-string and clearStaleSentinelIfAny emits legacy_bare_string', () => {
    const dir = makeSandbox();
    try {
      runCompose(dir);
      fs.writeFileSync(path.join(dir, SENTINEL_REL),
        'auto-disabled by validate-cache-invariant.js at 2026-04-27T05:26:14Z\n', 'utf8');

      assert.equal(VALIDATOR_LIB.parseSentinelBody('disabled'), null,
        'bare-string body must parse as null (treated as legacy)');
      assert.equal(VALIDATOR_LIB.isSentinelActive(dir), false,
        'bare-string sentinel must report INACTIVE');

      const cleared = VALIDATOR_LIB.clearStaleSentinelIfAny(dir, { sentinel_ttl_hours: 24 });
      assert.equal(cleared, true);
      const events  = readEvents(dir);
      const expired = events.find(e => e && e.type === 'cache_sentinel_expired');
      assert.ok(expired, 'cache_sentinel_expired event must be emitted');
      assert.equal(expired.reason, 'legacy_bare_string',
        'reason must be legacy_bare_string (NOT ttl_expired)');
    } finally { cleanup(dir); }
  });
});

describe('B1.6 — REGRESSION: 5 same-hash violations in 60s collapse to 1 (no false sentinel trip)', () => {
  // Reproduces the 2026-04-27T05:26:14 tuman incident: a single edit
  // produced 5 PreToolUse hits inside one second; the v2.2.0 validator
  // recorded all 5 as distinct violations and tripped the sentinel even
  // though only one logical edit happened. v2.2.1 W2 dedupes by
  // (expected_hash, actual_hash) within `dedupe_window_seconds`.
  test('5 calls with identical hash pair within 60s → 1 logged violation, sentinel NOT written', () => {
    const dir = makeSandbox();
    try {
      // Compose first to populate zones (per-file hashes too)
      runCompose(dir);
      // Mutate the schema shadow so drift is non-allowlisted (would
      // otherwise auto-rebaseline). Use a simple bypass: disable
      // auto-rebaseline so any drift counts.
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'config.json'),
        JSON.stringify({
          block_a_zone_caching: { invariant_violation_threshold_24h: 3 },
          caching: {
            cache_invariant_validator: {
              auto_rebaseline_enabled: false,
              dedupe_window_seconds:   60,
              sentinel_ttl_hours:      24,
              quarantine_trip_threshold: 3,
            },
          },
        }),
        'utf8'
      );

      // Mutate CLAUDE.md once — same hash pair will be observed 5 times
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mutation A\n', 'utf8');

      // Hammer the validator 5 times (simulating the 5 PreToolUse storm)
      for (let i = 0; i < 5; i++) {
        runValidator(dir);
      }

      // Read the violations log directly
      const violPath = path.join(dir, VIOLATIONS_REL);
      let lines = [];
      if (fs.existsSync(violPath)) {
        lines = fs.readFileSync(violPath, 'utf8').split('\n').filter(Boolean);
      }
      assert.equal(lines.length, 1,
        'dedupe must collapse 5 identical-hash-pair calls into 1 logged violation; got ' +
        lines.length);

      // The sentinel must NOT have been written (count=1 < threshold=3).
      assert.equal(fs.existsSync(path.join(dir, SENTINEL_REL)), false,
        'no sentinel must be written when dedupe collapses the storm to 1 violation');

      // Audit events must mark the second-onward emissions as deduped: true
      const broken = readEvents(dir).filter(e => e && e.type === 'cache_invariant_broken');
      assert.ok(broken.length >= 2,
        'cache_invariant_broken still emitted per call (deduped flag distinguishes)');
      const dedupedCount = broken.filter(e => e.deduped === true).length;
      assert.ok(dedupedCount >= 4,
        'at least 4 of the 5 emissions must carry deduped: true; got ' + dedupedCount);
    } finally { cleanup(dir); }
  });
});

describe('B1 — recordViolationAndCount unit behaviour', () => {
  test('returns deduped:true on identical hash pair within window', () => {
    const dir = makeSandbox();
    try {
      const a = VALIDATOR_LIB.recordViolationAndCount(dir, {
        expectedHash: 'aaaaaaaaaaaa', actualHash: 'bbbbbbbbbbbb', dedupeWindowSeconds: 60,
      });
      const b = VALIDATOR_LIB.recordViolationAndCount(dir, {
        expectedHash: 'aaaaaaaaaaaa', actualHash: 'bbbbbbbbbbbb', dedupeWindowSeconds: 60,
      });
      assert.equal(a.deduped, false, 'first call must not be deduped');
      assert.equal(b.deduped, true,  'second identical call must be deduped');
      assert.equal(b.count, 1, 'count must remain at 1 after dedupe');
    } finally { cleanup(dir); }
  });

  test('returns deduped:false on different hash pair', () => {
    const dir = makeSandbox();
    try {
      const a = VALIDATOR_LIB.recordViolationAndCount(dir, {
        expectedHash: 'aaaaaaaaaaaa', actualHash: 'bbbbbbbbbbbb', dedupeWindowSeconds: 60,
      });
      const b = VALIDATOR_LIB.recordViolationAndCount(dir, {
        expectedHash: 'aaaaaaaaaaaa', actualHash: 'cccccccccccc', dedupeWindowSeconds: 60,
      });
      assert.equal(a.deduped, false);
      assert.equal(b.deduped, false, 'different actual_hash must not dedupe');
      assert.equal(b.count, 2);
    } finally { cleanup(dir); }
  });
});

describe('B1 — auto-rebaseline path', () => {
  test('CLAUDE.md drift triggers cache_baseline_refreshed (NOT cache_invariant_broken)', () => {
    const dir = makeSandbox();
    try {
      runCompose(dir);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Edited\n', 'utf8');

      const r = runValidator(dir);
      assert.equal(r.status, 0);
      const events    = readEvents(dir);
      const refreshed = events.find(e => e && e.type === 'cache_baseline_refreshed');
      const broken    = events.find(e => e && e.type === 'cache_invariant_broken');
      assert.ok(refreshed,  'cache_baseline_refreshed must fire for editable-allowlist drift');
      assert.equal(broken, undefined, 'cache_invariant_broken must NOT fire for CLAUDE.md drift');
      assert.equal(refreshed.reason, 'editable_zone1_drift');
      assert.ok(refreshed.delta_files.includes('CLAUDE.md'));
    } finally { cleanup(dir); }
  });
});
