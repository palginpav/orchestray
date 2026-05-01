#!/usr/bin/env node
'use strict';

/**
 * promised-event-tracker-population.test.js — F-05 fix acceptance tests.
 *
 * Verifies that audit-firing-nightly.js:
 *   1. Populates promised-event-tracker.last-run.json with 30-day fire counts
 *      before running dark detection.
 *   2. Emits event_promised_but_dark for event types with count=0 over the
 *      30-day window.
 *   3. Is idempotent: running twice produces the same tracker contents.
 *   4. Does not emit event_promised_but_dark for types that fired in the window.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT    = path.join(REPO_ROOT, 'bin', 'audit-firing-nightly.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f05-tracker-pop-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  // Start with an empty events.jsonl so the script doesn't fail on missing file.
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '');
  return dir;
}

/**
 * Write a minimal event-schemas.shadow.json. Each key in `events` is an
 * event type with value `{v,r,o[,f]}`. `f:1` marks feature_optional.
 */
function writeShadow(dir, events) {
  const shadow = {
    _meta: {
      version:          1,
      source_hash:      'testhash',
      generated_at:     '2026-01-01T00:00:00.000Z',
      shadow_size_bytes: 100,
      event_count:      Object.keys(events).length,
    },
    ...events,
  };
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
    JSON.stringify(shadow),
  );
}

/**
 * Write fixture events to events.jsonl. Each entry in `events` is
 * `{ type, timestamp }`.
 */
function writeEvents(dir, events) {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
    lines + '\n',
  );
}

/**
 * Read the tracker file and return its parsed contents, or null if missing.
 */
function readTracker(dir) {
  const file = path.join(dir, '.orchestray', 'state', 'promised-event-tracker.last-run.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * Read emitted events from events.jsonl, parse them, and return the array.
 * Filters out the fixture events written BEFORE the script run by comparing
 * types against known fixture types.
 */
function readEmittedEvents(dir) {
  const live = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(live)) return [];
  return fs.readFileSync(live, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Run the nightly audit script in dry-run-compatible mode via spawnSync.
 * The sentinel is bypassed by using a fresh tmpdir each time (no existing lock).
 */
function runScript(dir, env = {}) {
  return spawnSync('node', [SCRIPT], {
    cwd:      dir,
    env:      { ...process.env, ...env },
    input:    JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout:  20_000,
  });
}

/** ISO timestamp N days in the past */
function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

/** ISO timestamp N days in the future (within the 30d window) */
function recentIso() {
  return new Date(Date.now() - 1 * 3600 * 1000).toISOString();  // 1 hour ago
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F-05 fix — promised-event-tracker population by audit-firing-nightly.js', () => {

  test('tracker file is created with event_types map after one nightly run', () => {
    const dir = makeRepo();
    writeShadow(dir, {
      my_event_a: { v: 1, r: 1, o: 0 },
      my_event_b: { v: 1, r: 1, o: 0 },
    });
    // events.jsonl has one recent fire of my_event_a.
    writeEvents(dir, [
      { type: 'my_event_a', version: 1, timestamp: recentIso() },
    ]);

    const r = runScript(dir);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const tracker = readTracker(dir);
    assert.ok(tracker !== null, 'tracker file must be written');
    assert.ok(tracker.event_types && typeof tracker.event_types === 'object',
      'tracker must have event_types map');
    assert.ok(tracker.window_days === 30, `window_days must be 30, got ${tracker.window_days}`);
    assert.ok(typeof tracker.generated_at === 'string', 'generated_at must be a string');

    // my_event_a fired once; my_event_b never fired.
    assert.ok(tracker.event_types['my_event_a'] >= 1,
      `my_event_a count must be >= 1, got ${tracker.event_types['my_event_a']}`);
    assert.equal(tracker.event_types['my_event_b'], 0,
      'my_event_b must have count=0');
  });

  test('all registered event types appear in tracker (even those that never fired)', () => {
    const dir = makeRepo();
    const eventTypes = {};
    for (let i = 0; i < 10; i++) {
      eventTypes[`event_type_${i}`] = { v: 1, r: 1, o: 0 };
    }
    writeShadow(dir, eventTypes);
    // No events in events.jsonl.

    const r = runScript(dir);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const tracker = readTracker(dir);
    assert.ok(tracker !== null, 'tracker must be written');

    const keys = Object.keys(tracker.event_types);
    // All 10 registered types must appear.
    for (let i = 0; i < 10; i++) {
      const t = `event_type_${i}`;
      assert.ok(t in tracker.event_types, `${t} must be in tracker`);
      assert.equal(tracker.event_types[t], 0, `${t} count must be 0`);
    }
    assert.ok(keys.length >= 10, `tracker must have >= 10 keys, got ${keys.length}`);
  });

  test('events outside the 30-day window are NOT counted', () => {
    const dir = makeRepo();
    writeShadow(dir, {
      old_event: { v: 1, r: 1, o: 0 },
    });
    // Fire from 31 days ago — outside the 30-day window.
    writeEvents(dir, [
      { type: 'old_event', version: 1, timestamp: daysAgoIso(31) },
    ]);

    const r = runScript(dir);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const tracker = readTracker(dir);
    assert.ok(tracker !== null, 'tracker must be written');
    assert.equal(tracker.event_types['old_event'], 0,
      'event from 31 days ago must not count toward 30-day window');
  });

  test('event_promised_but_dark emitted for dark types (zero 24h fires) with 30d count enrichment', () => {
    const dir = makeRepo();
    writeShadow(dir, {
      dark_event:    { v: 1, r: 1, o: 0 },
      alive_event:   { v: 1, r: 1, o: 0 },
      stale_event:   { v: 1, r: 1, o: 0 },  // fired 5 days ago (in 30d window, not 24h)
    });
    // alive_event fired in the last hour (within 24h window).
    // stale_event fired 5 days ago (in 30d window but outside 24h).
    // dark_event never fired.
    writeEvents(dir, [
      { type: 'alive_event', version: 1, timestamp: recentIso() },
      { type: 'stale_event', version: 1, timestamp: daysAgoIso(5) },
    ]);

    const r = runScript(dir);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const allEvents = readEmittedEvents(dir);
    const darkEmits = allEvents.filter((e) => e.type === 'event_promised_but_dark');

    // alive_event must NOT appear (fired in 24h window).
    const darkTypes = darkEmits.map((e) => e.event_type);
    assert.ok(!darkTypes.includes('alive_event'),
      'alive_event must NOT appear in event_promised_but_dark (it fired recently)');

    // dark_event must appear with total_fire_count=0.
    assert.ok(darkTypes.includes('dark_event'),
      `dark_event must be in event_promised_but_dark emits, got: ${JSON.stringify(darkTypes)}`);
    const darkEventRow = darkEmits.find((e) => e.event_type === 'dark_event');
    assert.equal(darkEventRow.total_fire_count, 0, 'dark_event total_fire_count must be 0');

    // stale_event is dark in 24h window but alive in 30d window — still emitted
    // as dark (24h detection), but total_fire_count reflects the 30d count.
    assert.ok(darkTypes.includes('stale_event'),
      'stale_event must appear (dark in 24h window even if it fired 5 days ago)');
    const staleRow = darkEmits.find((e) => e.event_type === 'stale_event');
    assert.ok(staleRow.total_fire_count >= 1,
      `stale_event total_fire_count must be >= 1 (30d enrichment), got ${staleRow.total_fire_count}`);
  });

  test('event_promised_but_dark NOT emitted for feature_optional (f:1) event types', () => {
    const dir = makeRepo();
    writeShadow(dir, {
      optional_dark: { v: 1, r: 1, o: 0, f: 1 },  // feature_optional
    });
    // No events.

    const r = runScript(dir);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const allEvents = readEmittedEvents(dir);
    const darkEmits = allEvents.filter((e) => e.type === 'event_promised_but_dark');
    assert.equal(darkEmits.length, 0,
      'feature_optional event types must never emit event_promised_but_dark');
  });

  test('idempotent: running twice produces same tracker contents', () => {
    const dir = makeRepo();
    writeShadow(dir, {
      ev_x: { v: 1, r: 1, o: 0 },
      ev_y: { v: 1, r: 1, o: 0 },
    });
    writeEvents(dir, [
      { type: 'ev_x', version: 1, timestamp: recentIso() },
      { type: 'ev_x', version: 1, timestamp: recentIso() },
    ]);

    // First run.
    const r1 = runScript(dir);
    assert.equal(r1.status, 0, `run1 exit=${r1.status} stderr=${r1.stderr}`);
    const tracker1 = readTracker(dir);

    // Remove the day sentinel so the second run is not blocked by the once-per-day guard.
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.readdirSync(stateDir)
      .filter((f) => f.startsWith('firing-audit-day-'))
      .forEach((f) => fs.unlinkSync(path.join(stateDir, f)));

    // Second run.
    const r2 = runScript(dir);
    assert.equal(r2.status, 0, `run2 exit=${r2.status} stderr=${r2.stderr}`);
    const tracker2 = readTracker(dir);

    assert.deepEqual(tracker1.event_types, tracker2.event_types,
      'tracker event_types must be identical on re-run');
    assert.equal(tracker1.window_days, tracker2.window_days,
      'tracker window_days must be identical on re-run');
  });

  test('tracker is written even when events.jsonl is empty', () => {
    const dir = makeRepo();
    writeShadow(dir, {
      registered_type: { v: 1, r: 1, o: 0 },
    });
    // events.jsonl is empty (written as '' by makeRepo).

    const r = runScript(dir);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);

    const tracker = readTracker(dir);
    assert.ok(tracker !== null, 'tracker must be written even with empty events.jsonl');
    assert.equal(tracker.event_types['registered_type'], 0,
      'count must be 0 when events.jsonl is empty');
  });

  test('kill switch ORCHESTRAY_FIRING_AUDIT_DISABLED=1 prevents tracker write', () => {
    const dir = makeRepo();
    writeShadow(dir, { ev_z: { v: 1, r: 1, o: 0 } });

    const r = runScript(dir, { ORCHESTRAY_FIRING_AUDIT_DISABLED: '1' });
    assert.equal(r.status, 0, 'must exit 0 with kill switch');

    const tracker = readTracker(dir);
    assert.equal(tracker, null, 'tracker must NOT be written when kill switch is active');
  });

});
