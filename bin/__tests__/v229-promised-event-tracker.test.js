#!/usr/bin/env node
'use strict';

/**
 * v229-promised-event-tracker.test.js — F3 part 1 acceptance test.
 *
 * Anti-regression contract:
 *   1. Synthetic shadow with one event marked dark for 8 days → tracker emits
 *      `event_promised_but_dark`.
 *   2. Same shadow with `feature_optional: true` (`f: 1` shadow flag) on that
 *      event → tracker silent.
 *   3. Marker debounce: two runs within 24h → only one emit per event-type.
 *   4. F2 archive integration: tracker reads from
 *      `.orchestray/history/<orch>/events.jsonl` correctly (a fire in the
 *      archive cancels the dark alarm).
 *   5. Kill switch `ORCHESTRAY_PROMISED_EVENT_TRACKER_DISABLED=1` short-circuits.
 *   6. Recent (≤ 7 days) registrations do NOT alarm.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const SCRIPT     = path.join(REPO_ROOT, 'bin', 'audit-promised-events.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-f3-tracker-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  // Empty live events.jsonl
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '');
  return dir;
}

/**
 * Write a synthetic event-schemas.shadow.json. Each entry is `{v,r,o[,f]}`.
 * `darkEvent` is an event-type with `f` undefined; `optionalEvent` carries
 * `f:1`.
 */
function writeShadow(dir, opts = {}) {
  const old = opts.oldGeneratedAt || '2026-01-01T00:00:00.000Z'; // 100+ days old
  const shadow = {
    _meta: {
      version: 1,
      source_hash: 'fakehash',
      generated_at: old,
      shadow_size_bytes: 100,
      event_count: Object.keys(opts.events || {}).length,
    },
    ...(opts.events || {}),
  };
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
    JSON.stringify(shadow),
  );
}

/**
 * Pre-stamp a registry so we can control "first_seen" precisely. firstSeenIso
 * is the ISO timestamp the test wants the tracker to consider as the
 * registration time for the listed event-types.
 */
function writeRegistry(dir, eventTypes, firstSeenIso) {
  const map = {};
  for (const t of eventTypes) map[t] = firstSeenIso;
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'state', 'promised-event-registry.json'),
    JSON.stringify({ event_types: map }, null, 2),
  );
}

function writeArchiveFire(dir, orchId, eventType) {
  const archDir = path.join(dir, '.orchestray', 'history', orchId);
  fs.mkdirSync(archDir, { recursive: true });
  const line = JSON.stringify({
    type:             eventType,
    version:          1,
    timestamp:        '2026-04-28T00:00:00.000Z',
    orchestration_id: orchId,
  });
  fs.writeFileSync(path.join(archDir, 'events.jsonl'), line + '\n');
}

function runScript(repoDir, env = {}) {
  return spawnSync('node', [SCRIPT], {
    cwd: repoDir,
    env: { ...process.env, ...env },
    input: JSON.stringify({ cwd: repoDir }),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function readEvents(dir) {
  const live = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(live)) return [];
  return fs.readFileSync(live, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function eightDaysAgoIso() {
  return new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
}

function oneDayAgoIso() {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.9 F3 — audit-promised-events.js', () => {
  test('emits event_promised_but_dark for an 8-day-dark event', () => {
    const dir = makeRepo();
    writeShadow(dir, { events: { my_dark_event: { v: 1, r: 1, o: 0 } } });
    writeRegistry(dir, ['my_dark_event'], eightDaysAgoIso());

    const r = runScript(dir);
    assert.equal(r.status, 0, `tracker exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const dark = events.filter((e) => e.type === 'event_promised_but_dark');
    assert.equal(dark.length, 1, `expected exactly one event_promised_but_dark, got ${dark.length}`);
    assert.equal(dark[0].event_type, 'my_dark_event');
    assert.equal(dark[0].total_fire_count, 0);
    assert.ok(dark[0].days_dark >= 7, `days_dark must be >= 7, got ${dark[0].days_dark}`);
  });

  test('feature_optional (f:1 shadow flag) suppresses the alarm', () => {
    const dir = makeRepo();
    writeShadow(dir, { events: { opt_in_event: { v: 1, r: 1, o: 0, f: 1 } } });
    writeRegistry(dir, ['opt_in_event'], eightDaysAgoIso());

    const r = runScript(dir);
    assert.equal(r.status, 0, `tracker exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const dark = events.filter((e) => e.type === 'event_promised_but_dark');
    assert.equal(dark.length, 0, 'feature_optional must suppress alarm');
  });

  test('24h debounce — two runs back-to-back emit only once', () => {
    const dir = makeRepo();
    writeShadow(dir, { events: { my_dark_event: { v: 1, r: 1, o: 0 } } });
    writeRegistry(dir, ['my_dark_event'], eightDaysAgoIso());

    const r1 = runScript(dir);
    assert.equal(r1.status, 0);
    const r2 = runScript(dir);
    assert.equal(r2.status, 0);

    const events = readEvents(dir);
    const dark = events.filter(
      (e) => e.type === 'event_promised_but_dark' && e.event_type === 'my_dark_event'
    );
    assert.equal(dark.length, 1, `debounce must hold; got ${dark.length} emits`);
  });

  test('F2 archive fire cancels the dark alarm', () => {
    const dir = makeRepo();
    writeShadow(dir, { events: { my_dark_event: { v: 1, r: 1, o: 0 } } });
    writeRegistry(dir, ['my_dark_event'], eightDaysAgoIso());
    writeArchiveFire(dir, 'orch-fire-1', 'my_dark_event');

    const r = runScript(dir);
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const dark = events.filter((e) => e.type === 'event_promised_but_dark');
    assert.equal(dark.length, 0, 'archive fire must cancel the alarm');
  });

  test('kill switch ORCHESTRAY_PROMISED_EVENT_TRACKER_DISABLED=1 short-circuits', () => {
    const dir = makeRepo();
    writeShadow(dir, { events: { my_dark_event: { v: 1, r: 1, o: 0 } } });
    writeRegistry(dir, ['my_dark_event'], eightDaysAgoIso());

    const r = runScript(dir, { ORCHESTRAY_PROMISED_EVENT_TRACKER_DISABLED: '1' });
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const dark = events.filter((e) => e.type === 'event_promised_but_dark');
    assert.equal(dark.length, 0, 'kill switch must suppress emit');
  });

  test('events younger than 7 days do NOT alarm', () => {
    const dir = makeRepo();
    writeShadow(dir, { events: { brand_new_event: { v: 1, r: 1, o: 0 } } });
    writeRegistry(dir, ['brand_new_event'], oneDayAgoIso());

    const r = runScript(dir);
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const dark = events.filter((e) => e.type === 'event_promised_but_dark');
    assert.equal(dark.length, 0, '<= 7-day registrations must not alarm');
  });
});
