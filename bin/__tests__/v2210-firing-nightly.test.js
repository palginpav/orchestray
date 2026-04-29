#!/usr/bin/env node
'use strict';

/**
 * v2210-firing-nightly.test.js — F3 acceptance tests.
 *
 * Covers:
 *   1. Happy path: synthetic shadow (5 declared types) + events.jsonl with 2
 *      fires in the last 24h → emits 1 `event_activation_ratio` (ratio=0.4,
 *      numerator=2, denominator=5) and 3 `event_promised_but_dark` rows (one
 *      per dark type).
 *   2. Once-per-day guard: sentinel file blocks re-run on the same day (exit 0,
 *      no new emits).
 *   3. Kill switch: `ORCHESTRAY_FIRING_AUDIT_DISABLED=1` → exit 0 silently, no
 *      emits at all.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT    = path.join(REPO_ROOT, 'bin', 'audit-firing-nightly.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp repo directory with minimal structure.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-nightly-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  // Empty live events.jsonl to avoid ENOENT on a completely fresh repo.
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '');
  return dir;
}

/**
 * Write a minimal synthetic shadow JSON for the given set of event types.
 * eventDefs is an object `{ event_type: { v, r, o[, f] } }`.
 * If `f: 1` is present the event is feature_optional.
 */
function writeShadow(dir, eventDefs) {
  const shadow = {
    _meta: {
      version: 1,
      source_hash: 'fakehash',
      generated_at: '2026-01-01T00:00:00.000Z',
      shadow_size_bytes: 200,
      event_count: Object.keys(eventDefs).length,
    },
    ...eventDefs,
  };
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
    JSON.stringify(shadow),
  );
}

/**
 * Append one JSONL row to events.jsonl with the given event type and a
 * timestamp offset from now.
 *
 * @param {string} dir
 * @param {string} eventType
 * @param {number} msAgo - how many ms before now the event was emitted.
 */
function appendEvent(dir, eventType, msAgo) {
  const ts  = new Date(Date.now() - msAgo).toISOString();
  const row = JSON.stringify({ event: eventType, type: eventType, version: 1, timestamp: ts });
  fs.appendFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), row + '\n');
}

/**
 * Run the nightly-audit script against a given repo dir. Returns { status,
 * stdout, stderr, emittedEvents }.
 */
function runScript(dir, env = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT],
    {
      input: JSON.stringify({ cwd: dir }),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 10000,
    },
  );
  // Parse emitted events from the live events.jsonl.
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  let emittedEvents = [];
  try {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    emittedEvents = lines.map(l => {
      try { return JSON.parse(l); } catch (_e) { return null; }
    }).filter(Boolean);
  } catch (_e) { /* ok */ }

  return {
    status:        result.status,
    stdout:        result.stdout || '',
    stderr:        result.stderr || '',
    emittedEvents,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2210 F3 — audit-firing-nightly', () => {

  /**
   * Test 1: happy-path emits.
   *
   * Shadow: 5 event types (none feature_optional).
   * events.jsonl: type_a and type_b fired within the last hour.
   *               type_c fired 30 hours ago (outside 24h window).
   *               type_d and type_e never fired.
   *
   * Expected:
   *   - 1 × `event_activation_ratio` with numerator=2, denominator=5, ratio≈0.4, dark_count=3
   *   - 3 × `event_promised_but_dark` (type_c, type_d, type_e)
   */
  test('emits ratio summary and one dark row per dark type', () => {
    const dir = makeRepo();

    writeShadow(dir, {
      type_a: { v: 1, r: 1, o: 0 },
      type_b: { v: 1, r: 1, o: 0 },
      type_c: { v: 1, r: 1, o: 0 },
      type_d: { v: 1, r: 1, o: 0 },
      type_e: { v: 1, r: 1, o: 0 },
    });

    // type_a and type_b fired recently (within window).
    appendEvent(dir, 'type_a', 30 * 60 * 1000);     // 30 min ago
    appendEvent(dir, 'type_b', 60 * 60 * 1000);     // 1 hour ago
    // type_c fired outside the 24h window.
    appendEvent(dir, 'type_c', 30 * 60 * 60 * 1000); // 30 hours ago

    const { status, emittedEvents } = runScript(dir);
    assert.strictEqual(status, 0, 'script must exit 0');

    const ratioRows = emittedEvents.filter(e => e.event === 'event_activation_ratio' || e.type === 'event_activation_ratio');
    const darkRows  = emittedEvents.filter(e => e.event === 'event_promised_but_dark' || e.type === 'event_promised_but_dark');

    assert.strictEqual(ratioRows.length, 1, 'must emit exactly 1 event_activation_ratio row');

    const ratio = ratioRows[0];
    assert.strictEqual(ratio.numerator,   2,  'numerator should be 2');
    assert.strictEqual(ratio.denominator, 5,  'denominator should be 5');
    assert.ok(
      Math.abs(ratio.ratio - 0.4) < 0.001,
      `ratio should be ~0.4, got ${ratio.ratio}`,
    );
    assert.strictEqual(ratio.dark_count,   3,  'dark_count should be 3');
    assert.strictEqual(ratio.window_label, 'daily', 'window_label must be "daily"');

    assert.strictEqual(darkRows.length, 3, 'must emit exactly 3 event_promised_but_dark rows');

    const darkTypes = darkRows.map(r => r.event_type).sort();
    assert.deepStrictEqual(darkTypes, ['type_c', 'type_d', 'type_e'].sort(),
      'dark rows must cover the 3 non-fired types');
  });

  /**
   * Test 2: once-per-day guard.
   *
   * First run succeeds and writes the sentinel. Second run on the same day
   * exits 0 with no additional emits.
   */
  test('once-per-day guard: second run on same day is a no-op', () => {
    const dir = makeRepo();

    writeShadow(dir, {
      type_x: { v: 1, r: 1, o: 0 },
    });

    // First run — should emit and write sentinel.
    const first = runScript(dir);
    assert.strictEqual(first.status, 0, 'first run must exit 0');
    const firstRatioRows = first.emittedEvents.filter(
      e => e.event === 'event_activation_ratio' || e.type === 'event_activation_ratio',
    );
    assert.strictEqual(firstRatioRows.length, 1, 'first run must emit 1 ratio row');

    // Verify sentinel file was written.
    const { utcDateLabel, sentinelPath } = require(SCRIPT);
    const dateLabel  = utcDateLabel();
    const sentinel   = sentinelPath(dir, dateLabel);
    assert.ok(fs.existsSync(sentinel), 'sentinel file must exist after first run');

    // Second run — should be silent.
    const eventsBeforeSecondRun = first.emittedEvents.length;
    const second = runScript(dir);
    assert.strictEqual(second.status, 0, 'second run must exit 0');
    assert.strictEqual(
      second.emittedEvents.length, eventsBeforeSecondRun,
      'second run must not emit any new events',
    );
  });

  /**
   * Test 3: kill switch.
   *
   * When ORCHESTRAY_FIRING_AUDIT_DISABLED=1, the script exits 0 and emits
   * nothing at all, even with a valid shadow and live events.
   */
  test('kill switch ORCHESTRAY_FIRING_AUDIT_DISABLED=1 → silent exit', () => {
    const dir = makeRepo();

    writeShadow(dir, {
      type_z: { v: 1, r: 1, o: 0 },
    });
    appendEvent(dir, 'type_z', 60 * 1000); // 1 min ago

    const { status, emittedEvents } = runScript(dir, {
      ORCHESTRAY_FIRING_AUDIT_DISABLED: '1',
    });
    assert.strictEqual(status, 0, 'must exit 0 with kill switch');

    const newEmits = emittedEvents.filter(
      e => e.event === 'event_activation_ratio' || e.type === 'event_activation_ratio' ||
           e.event === 'event_promised_but_dark'  || e.type === 'event_promised_but_dark',
    );
    assert.strictEqual(newEmits.length, 0, 'kill switch must suppress all emits');
  });

  /**
   * Test 4: feature_optional types are excluded from denominator and dark list.
   *
   * Shadow: 3 normal + 2 feature_optional (f:1).
   * No fires at all.
   * Expected: ratio denominator=3, dark_count=3, and dark rows cover only the
   * 3 non-optional types.
   */
  test('feature_optional types are excluded from ratio and dark rows', () => {
    const dir = makeRepo();

    writeShadow(dir, {
      normal_a:   { v: 1, r: 1, o: 0 },
      normal_b:   { v: 1, r: 1, o: 0 },
      normal_c:   { v: 1, r: 1, o: 0 },
      optional_a: { v: 1, r: 1, o: 0, f: 1 },
      optional_b: { v: 1, r: 1, o: 0, f: 1 },
    });

    const { status, emittedEvents } = runScript(dir);
    assert.strictEqual(status, 0);

    const ratioRows = emittedEvents.filter(
      e => e.event === 'event_activation_ratio' || e.type === 'event_activation_ratio',
    );
    assert.strictEqual(ratioRows.length, 1);
    assert.strictEqual(ratioRows[0].denominator, 3,
      'feature_optional types must not count in denominator');
    assert.strictEqual(ratioRows[0].dark_count,  3);

    const darkRows = emittedEvents.filter(
      e => e.event === 'event_promised_but_dark' || e.type === 'event_promised_but_dark',
    );
    const darkTypes = darkRows.map(r => r.event_type);
    assert.ok(!darkTypes.includes('optional_a'), 'optional_a must not appear in dark rows');
    assert.ok(!darkTypes.includes('optional_b'), 'optional_b must not appear in dark rows');
  });
});
