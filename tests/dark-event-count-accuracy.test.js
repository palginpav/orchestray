'use strict';

/**
 * dark-event-count-accuracy.test.js — regression test for the inflated
 * dark-event count (307 vs. genuinely-dark 108, measured 2026-08-08).
 *
 * The bug: computeDarkEvents() counted distinct event_types that HAD a
 * `event_promised_but_dark` row within the last 30 days, not types that ARE
 * dark right now. A type flagged dark once and later started firing kept
 * counting until its flag row aged past 30 days. Fix: computeDarkEvents()
 * reads a freshly-overwritten snapshot (`promised-event-dark-state.last-run.json`)
 * that audit-promised-events.js recomputes from scratch on every run, instead
 * of accumulating historical `event_promised_but_dark` rows.
 *
 * Run: node --require ./tests/helpers/setup.js --test tests/dark-event-count-accuracy.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');

const ROOT   = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'dark-event-banner.js');

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-event-accuracy-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function writeState(dir, { darkTypes = [], candidateCount = 331, generatedAt } = {}) {
  const file = path.join(dir, '.orchestray', 'state', 'promised-event-dark-state.last-run.json');
  fs.writeFileSync(file, JSON.stringify({
    generated_at:    generatedAt || new Date().toISOString(),
    candidate_count: candidateCount,
    dark_types:      darkTypes,
    truncated:       false,
  }, null, 2));
}

describe('computeDarkEvents reflects current reality, not a historical flag', () => {
  test('a type flagged dark in the past but absent from the fresh snapshot does not count', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();

    // Fresh snapshot: only 2 types are genuinely dark right now.
    writeState(dir, {
      darkTypes: [
        { event_type: 'agent_max_turns_violation', days_dark: 101, total_fire_count: 0 },
        { event_type: 'agent_mcp_grounding_missing', days_dark: 101, total_fire_count: 0 },
      ],
    });

    // Stale historical signal for a THIRD type that has since started firing —
    // this row must be ignored entirely; the fresh snapshot is authoritative.
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath, JSON.stringify({
      type: 'event_promised_but_dark', version: 1,
      event_type: 'now_firing_event', days_dark: 20, total_fire_count: 0,
      timestamp: new Date().toISOString(),
    }) + '\n');

    const result = computeDarkEvents(dir, Date.now());
    assert.equal(result.totalDark, 2, 'only the fresh snapshot count must be reported');
    assert.ok(!result.darkTypes.some(d => d.event_type === 'now_firing_event'),
      'a type absent from the fresh snapshot must not appear, regardless of old events.jsonl rows');
  });
});
