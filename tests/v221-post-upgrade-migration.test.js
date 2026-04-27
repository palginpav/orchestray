#!/usr/bin/env node
'use strict';

/**
 * v221-post-upgrade-migration.test.js — W5 / install-time self-heal
 *
 * Covers the four user-state matrices that W6 will audit:
 *
 *   (a) v2.1.x → v2.2.1     — no sentinel, no quarantine — must NO-OP
 *   (b) v2.2.0 fresh → v2.2.1 — no sentinel — must NO-OP
 *   (c) v2.2.0 stale-sentinel → v2.2.1 — bare-string sentinel must clear,
 *                                       v221_cache_sentinel_cleared event fires
 *   (d) v2.2.0 housekeeper-quarantined → v2.2.1 — housekeeper-quarantined
 *                                       file must clear,
 *                                       v221_housekeeper_quarantine_cleared event fires
 *
 * Each case:
 *   - Verifies the corresponding `v221_*_cleared` audit event is emitted
 *     EXACTLY ONCE on the first run.
 *   - Verifies ZERO `v221_*_cleared` events on the second run (idempotency
 *     via `.v221-self-heal-done` marker).
 *   - Verifies the `v221_self_heal_complete` event is emitted on the first
 *     run regardless of whether anything was cleared.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT       = path.resolve(__dirname, '..');
const SELF_HEAL_PATH  = path.join(REPO_ROOT, 'bin', 'v221-self-heal.js');
const STATE_REL       = path.join('.orchestray', 'state');
const CACHE_SENTINEL  = path.join(STATE_REL, '.block-a-zone-caching-disabled');
const HOUSEKEEPER     = path.join(STATE_REL, 'housekeeper-quarantined');
const DONE_MARKER     = path.join(STATE_REL, '.v221-self-heal-done');
const EVENTS_REL      = path.join('.orchestray', 'audit', 'events.jsonl');

// `bin/v221-self-heal.js` does not register any stdin listener at top
// level (it reads `process.argv[2]` only when invoked as main), so a
// plain `require()` is safe here.
const { runSelfHeal } = require(SELF_HEAL_PATH);

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v221-migration-'));
  fs.mkdirSync(path.join(dir, STATE_REL), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function readEvents(dir) {
  const p = path.join(dir, EVENTS_REL);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

function countEvents(dir, type) {
  return readEvents(dir).filter(e => e && e.type === type).length;
}

describe('Migration (a): v2.1.x → v2.2.1 — no sentinel, no quarantine', () => {
  test('first run: no v221_*_cleared events; v221_self_heal_complete fires once; second run: NO-OP', () => {
    const dir = makeSandbox();
    try {
      // Pre-state: nothing in state/. This mirrors a v2.1.x install.
      const r1 = runSelfHeal(dir);
      assert.equal(r1.ran, true, 'first run must execute');
      assert.equal(r1.cache_sentinel_cleared, false);
      assert.equal(r1.housekeeper_quarantine_cleared, false);

      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 0,
        'no cache sentinel was present → 0 v221_cache_sentinel_cleared events');
      assert.equal(countEvents(dir, 'v221_housekeeper_quarantine_cleared'), 0,
        'no housekeeper quarantine was present → 0 v221_housekeeper_quarantine_cleared events');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1,
        'v221_self_heal_complete must fire once on first run regardless');
      assert.equal(fs.existsSync(path.join(dir, DONE_MARKER)), true,
        '.v221-self-heal-done marker must be written for idempotency');

      // Second run: idempotent NO-OP
      const r2 = runSelfHeal(dir);
      assert.equal(r2.ran, false, 'second run must short-circuit on done marker');
      assert.equal(r2.reason, 'already_done');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1,
        'no additional v221_self_heal_complete event on second run');
    } finally { cleanup(dir); }
  });
});

describe('Migration (b): v2.2.0 fresh → v2.2.1 — no sentinel accumulated', () => {
  test('identical to (a): first run is observable but clears nothing; second run is NO-OP', () => {
    const dir = makeSandbox();
    try {
      const r1 = runSelfHeal(dir);
      assert.equal(r1.ran, true);
      assert.equal(r1.cache_sentinel_cleared, false,
        'no cache sentinel had accumulated yet → no clear');
      assert.equal(r1.housekeeper_quarantine_cleared, false,
        'no housekeeper quarantine had accumulated yet → no clear');

      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 0);
      assert.equal(countEvents(dir, 'v221_housekeeper_quarantine_cleared'), 0);
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1);

      const r2 = runSelfHeal(dir);
      assert.equal(r2.ran, false);
    } finally { cleanup(dir); }
  });
});

describe('Migration (c): v2.2.0 stale-sentinel → v2.2.1', () => {
  test('bare-string cache sentinel cleared exactly once; v221_cache_sentinel_cleared fires once; second run NO-OP', () => {
    const dir = makeSandbox();
    try {
      // Pre-state: legacy v2.2.0 bare-string cache sentinel
      fs.writeFileSync(
        path.join(dir, CACHE_SENTINEL),
        'auto-disabled by validate-cache-invariant.js at 2026-04-27T05:26:14Z\n',
        'utf8'
      );
      assert.equal(fs.existsSync(path.join(dir, CACHE_SENTINEL)), true);

      // First run
      const r1 = runSelfHeal(dir);
      assert.equal(r1.ran, true);
      assert.equal(r1.cache_sentinel_cleared, true,
        'bare-string cache sentinel must be cleared');
      assert.equal(r1.housekeeper_quarantine_cleared, false);

      assert.equal(fs.existsSync(path.join(dir, CACHE_SENTINEL)), false,
        'cache sentinel file must be removed from disk');
      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 1,
        'v221_cache_sentinel_cleared must fire EXACTLY ONCE on first run');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1);

      const cleared = readEvents(dir).find(e =>
        e && e.type === 'v221_cache_sentinel_cleared');
      assert.ok(cleared.previous_body,
        'v221_cache_sentinel_cleared must record previous_body for forensics');
      assert.match(cleared.previous_body, /auto-disabled/,
        'previous_body must include the bare-string content');

      // Second run: idempotent — sentinel already cleared, done marker present
      const r2 = runSelfHeal(dir);
      assert.equal(r2.ran, false, 'second run must short-circuit on done marker');
      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 1,
        'v221_cache_sentinel_cleared must NOT fire on second run (idempotent)');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1,
        'v221_self_heal_complete must NOT re-fire on second run');
    } finally { cleanup(dir); }
  });

  test('JSON sentinel with future expires_at and quarantined:false is preserved (still active)', () => {
    const dir = makeSandbox();
    try {
      // Pre-state: a fresh v2.2.1 active JSON sentinel (not stale)
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const body = {
        written_at:    new Date().toISOString(),
        expires_at:    future,
        reason:        'invariant_threshold_exceeded',
        recovery_hint: 'auto-clears in 24h',
        trip_count:    1,
        quarantined:   false,
      };
      fs.writeFileSync(path.join(dir, CACHE_SENTINEL),
        JSON.stringify(body, null, 2) + '\n', 'utf8');

      const r = runSelfHeal(dir);
      assert.equal(r.cache_sentinel_cleared, false,
        'fresh JSON sentinel must NOT be cleared by self-heal');
      assert.equal(fs.existsSync(path.join(dir, CACHE_SENTINEL)), true,
        'fresh JSON sentinel must remain on disk');
      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 0,
        'no v221_cache_sentinel_cleared event when sentinel is fresh');
    } finally { cleanup(dir); }
  });

  test('JSON sentinel with quarantined:true is preserved (latched)', () => {
    const dir = makeSandbox();
    try {
      // Quarantined sentinel — even past expires_at, must NOT be cleared.
      const past = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const body = {
        written_at:    past,
        expires_at:    past,
        reason:        'invariant_threshold_exceeded',
        recovery_hint: 'manual',
        trip_count:    7,
        quarantined:   true,
      };
      fs.writeFileSync(path.join(dir, CACHE_SENTINEL),
        JSON.stringify(body, null, 2) + '\n', 'utf8');

      const r = runSelfHeal(dir);
      assert.equal(r.cache_sentinel_cleared, false,
        'quarantined JSON sentinel must NOT be cleared even past expires_at');
      assert.equal(fs.existsSync(path.join(dir, CACHE_SENTINEL)), true,
        'quarantined sentinel file must remain on disk (latched)');
    } finally { cleanup(dir); }
  });
});

describe('Migration (d): v2.2.0 housekeeper-quarantined → v2.2.1', () => {
  test('bare-string housekeeper quarantine cleared exactly once; v221_housekeeper_quarantine_cleared fires once', () => {
    const dir = makeSandbox();
    try {
      // Pre-state: legacy v2.2.0 housekeeper-quarantined bare-string sentinel
      fs.writeFileSync(path.join(dir, HOUSEKEEPER),
        'quarantined by audit-housekeeper-drift.js: agent_file_missing\n', 'utf8');
      assert.equal(fs.existsSync(path.join(dir, HOUSEKEEPER)), true);

      const r1 = runSelfHeal(dir);
      assert.equal(r1.ran, true);
      assert.equal(r1.housekeeper_quarantine_cleared, true,
        'housekeeper quarantine must be cleared on first run');
      assert.equal(r1.cache_sentinel_cleared, false);

      assert.equal(fs.existsSync(path.join(dir, HOUSEKEEPER)), false,
        'housekeeper-quarantined file must be removed from disk');
      assert.equal(countEvents(dir, 'v221_housekeeper_quarantine_cleared'), 1,
        'v221_housekeeper_quarantine_cleared must fire EXACTLY ONCE');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1);

      const cleared = readEvents(dir).find(e =>
        e && e.type === 'v221_housekeeper_quarantine_cleared');
      assert.ok(cleared.previous_body,
        'v221_housekeeper_quarantine_cleared must record previous_body for forensics');

      // Second run: idempotent
      const r2 = runSelfHeal(dir);
      assert.equal(r2.ran, false);
      assert.equal(countEvents(dir, 'v221_housekeeper_quarantine_cleared'), 1,
        'no second-run emission (idempotent via done marker)');
    } finally { cleanup(dir); }
  });

  test('JSON housekeeper sentinel with preserve:true or future keep_until is preserved', () => {
    const dir = makeSandbox();
    try {
      // Future keep_until → preserve
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      fs.writeFileSync(path.join(dir, HOUSEKEEPER),
        JSON.stringify({ reason: 'sha_only', keep_until: future }), 'utf8');

      const r = runSelfHeal(dir);
      assert.equal(r.housekeeper_quarantine_cleared, false,
        'JSON sentinel with future keep_until must NOT be cleared');
      assert.equal(fs.existsSync(path.join(dir, HOUSEKEEPER)), true,
        'JSON sentinel with future keep_until must remain on disk');
    } finally { cleanup(dir); }
  });
});

describe('Migration: combined scenario — both sentinels present', () => {
  test('first run clears both; both events fire exactly once; second run NO-OP', () => {
    const dir = makeSandbox();
    try {
      fs.writeFileSync(path.join(dir, CACHE_SENTINEL), 'disabled\n', 'utf8');
      fs.writeFileSync(path.join(dir, HOUSEKEEPER),    'quarantined\n', 'utf8');

      const r1 = runSelfHeal(dir);
      assert.equal(r1.cache_sentinel_cleared, true);
      assert.equal(r1.housekeeper_quarantine_cleared, true);
      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 1);
      assert.equal(countEvents(dir, 'v221_housekeeper_quarantine_cleared'), 1);
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1);

      const r2 = runSelfHeal(dir);
      assert.equal(r2.ran, false);
      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 1,
        'no second-run cache emission');
      assert.equal(countEvents(dir, 'v221_housekeeper_quarantine_cleared'), 1,
        'no second-run housekeeper emission');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 1,
        'no second-run completion emission');
    } finally { cleanup(dir); }
  });
});

describe('Migration: done-marker idempotency edge cases', () => {
  test('done marker pre-existing → first runSelfHeal call is a NO-OP (no events emitted)', () => {
    const dir = makeSandbox();
    try {
      fs.writeFileSync(path.join(dir, DONE_MARKER), '{"already":true}\n', 'utf8');
      // Even with a stale sentinel present, the done marker wins.
      fs.writeFileSync(path.join(dir, CACHE_SENTINEL), 'disabled\n', 'utf8');

      const r = runSelfHeal(dir);
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'already_done');
      assert.equal(countEvents(dir, 'v221_cache_sentinel_cleared'), 0,
        'pre-existing done marker must short-circuit before any clearing');
      assert.equal(countEvents(dir, 'v221_self_heal_complete'), 0,
        'pre-existing done marker must short-circuit completion event');
      assert.equal(fs.existsSync(path.join(dir, CACHE_SENTINEL)), true,
        'cache sentinel must be untouched (idempotency wins)');
    } finally { cleanup(dir); }
  });
});
