#!/usr/bin/env node
'use strict';

/**
 * r-documenter-event.test.js — coverage for R-DOCUMENTER-EVENT (W5, v2.1.17).
 *
 * R-DOCUMENTER-EVENT adds a "Documenter spawn frequency" rollup to the
 * /orchestray:analytics surface. The rollup filters EXISTING `agent_start`
 * events by `agent_type === "documenter"` (no new event type, analytics-only)
 * to gate v2.1.16 R-AUTODOC-OFF's success metric: documenter spawns drop to
 * ~0 except on explicit /orchestray:document invocations.
 *
 * Tests:
 *   1. SKILL.md surface check: the new rollup section is present, references
 *      the R-DOCUMENTER-EVENT id, names v2.1.17, references `agent_start`
 *      filtering by `agent_type=documenter`, and shows the 7d / 30d windows.
 *   2. Rollup-logic correctness: a synthetic events.jsonl fixture with
 *      5 documenter `agent_start` events and 10 non-documenter `agent_start`
 *      events over a 30-day window — the rollup function must (a) count
 *      exactly 5 documenter spawns, (b) ignore the other agent_types, and
 *      (c) compute the per-day rate as count / window_days.
 *
 * Runner: node --test tests/r-documenter-event.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SKILL_FILE = path.join(ROOT, 'skills', 'orchestray:analytics', 'SKILL.md');

// ---------------------------------------------------------------------------
// Test 1 — SKILL.md surface check
// ---------------------------------------------------------------------------

describe('R-DOCUMENTER-EVENT — analytics SKILL.md surface', () => {
  let body;
  test('SKILL.md is readable', () => {
    body = fs.readFileSync(SKILL_FILE, 'utf8');
    assert.ok(body.length > 0, 'SKILL.md must be non-empty');
  });

  test('SKILL.md includes a section titled for the documenter rollup', () => {
    // Title naming v2.1.17 R-DOCUMENTER-EVENT (per W5 acceptance criterion).
    assert.match(body, /Documenter spawn frequency/i,
      'SKILL.md must include a "Documenter spawn frequency" rollup section');
    assert.ok(body.includes('R-DOCUMENTER-EVENT'),
      'SKILL.md must reference R-DOCUMENTER-EVENT identifier');
    assert.ok(body.includes('v2.1.17'),
      'SKILL.md must reference v2.1.17 in the rollup title');
  });

  test('SKILL.md describes the agent_type=documenter filter on agent_start', () => {
    // Single-source-of-truth: the rollup must clearly document its filter
    // criteria so a reader can audit what is being counted.
    assert.ok(body.includes('agent_start'),
      'SKILL.md must reference the agent_start event type for the filter');
    assert.match(body, /agent_type.*documenter|documenter.*agent_type/i,
      'SKILL.md must document the agent_type === "documenter" filter');
  });

  test('SKILL.md displays a per-day rate over a rolling window', () => {
    // Per the W5 brief: "shows count + per-day rate over the last N days".
    assert.match(body, /per day|per-day/i,
      'SKILL.md must mention a per-day rate for documenter spawns');
    assert.ok(body.includes('7') && body.includes('30'),
      'SKILL.md must display 7-day and 30-day windows for the rate');
  });

  test('SKILL.md ties the rollup to R-AUTODOC-OFF success measurement', () => {
    // The whole point of R-DOCUMENTER-EVENT is to make R-AUTODOC-OFF
    // (v2.1.16) measurable. If this link breaks, future readers won't
    // understand why the rollup exists.
    assert.ok(body.includes('R-AUTODOC-OFF') || body.includes('auto_document'),
      'SKILL.md must reference R-AUTODOC-OFF or the auto_document flag');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Rollup logic correctness against a synthetic fixture
// ---------------------------------------------------------------------------

/**
 * Mirror implementation of the Rollup E logic specified in SKILL.md.
 * Kept locally in the test so we exercise the documented contract directly:
 * filter agent_start by agent_type === 'documenter', count over a window,
 * divide by window_days for the per-day rate.
 */
function computeDocumenterRollup(events, { now, windowDays }) {
  const lowerBound = new Date(now).getTime() - windowDays * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const ev of events) {
    if (ev.type !== 'agent_start') continue;
    if (ev.agent_type !== 'documenter') continue;
    const ts = new Date(ev.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts < lowerBound) continue;
    count += 1;
  }
  return { count, perDay: count / windowDays };
}

function buildFixture() {
  // Use a fixed reference "now" so the test is deterministic.
  const now = '2026-04-26T12:00:00.000Z';
  const baseMs = new Date(now).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const events = [];

  // 5 documenter spawns spread across days 1..5 (well inside any window).
  for (let i = 1; i <= 5; i += 1) {
    events.push({
      type: 'agent_start',
      orchestration_id: `orch-doc-${i}`,
      timestamp: new Date(baseMs - i * dayMs).toISOString(),
      agent_type: 'documenter',
      model_used: 'haiku',
      task_id: `t-doc-${i}`,
      phase: 'document',
    });
  }

  // 10 non-documenter spawns — must be ignored by the rollup.
  const otherTypes = [
    'developer', 'developer', 'developer',
    'architect', 'architect',
    'reviewer', 'reviewer',
    'tester',
    'pm',
    'researcher',
  ];
  for (let i = 0; i < otherTypes.length; i += 1) {
    events.push({
      type: 'agent_start',
      orchestration_id: `orch-other-${i}`,
      timestamp: new Date(baseMs - (i + 1) * dayMs).toISOString(),
      agent_type: otherTypes[i],
      model_used: 'sonnet',
      task_id: `t-other-${i}`,
      phase: 'implement',
    });
  }

  // A non-`agent_start` event that mentions documenter — must NOT be counted.
  events.push({
    type: 'agent_stop',
    orchestration_id: 'orch-doc-1',
    timestamp: new Date(baseMs - dayMs).toISOString(),
    agent_type: 'documenter',
  });

  // An old documenter spawn outside even the 30-day window — must NOT be
  // counted in the 30-day rollup, and must NOT be counted in the 7-day
  // rollup either.
  events.push({
    type: 'agent_start',
    orchestration_id: 'orch-doc-old',
    timestamp: new Date(baseMs - 60 * dayMs).toISOString(),
    agent_type: 'documenter',
    model_used: 'haiku',
  });

  return { events, now };
}

function writeFixtureFile(events) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r-doc-event-'));
  const file = path.join(tmp, 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('R-DOCUMENTER-EVENT — rollup logic against synthetic fixture', () => {
  const { events, now } = buildFixture();

  test('synthetic fixture writes and reads back as JSONL', () => {
    const file = writeFixtureFile(events);
    const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
    const parsed = raw.map((l) => JSON.parse(l));
    assert.equal(parsed.length, events.length,
      'all fixture events must round-trip through the JSONL file');
  });

  test('30-day window counts exactly 5 documenter spawns', () => {
    const { count, perDay } = computeDocumenterRollup(events, { now, windowDays: 30 });
    assert.equal(count, 5,
      'rollup must count exactly the 5 documenter agent_start events in the 30-day window (and ignore the 60-day-old one)');
    assert.equal(perDay, 5 / 30,
      'per-day rate must equal count / window_days');
  });

  test('7-day window counts exactly 5 documenter spawns (all within last 5 days)', () => {
    const { count, perDay } = computeDocumenterRollup(events, { now, windowDays: 7 });
    assert.equal(count, 5,
      'all 5 documenter spawns are within the last 5 days, so the 7-day count is 5');
    assert.equal(perDay, 5 / 7,
      'per-day rate must equal count / window_days');
  });

  test('rollup ignores non-documenter agent_types', () => {
    // Sanity: there are 10 non-documenter agent_start events in the fixture.
    // If the filter were buggy, the count would be 15.
    const nonDocCount = events.filter(
      (e) => e.type === 'agent_start' && e.agent_type !== 'documenter',
    ).length;
    assert.equal(nonDocCount, 10,
      'fixture must contain exactly 10 non-documenter agent_start events');
    const { count } = computeDocumenterRollup(events, { now, windowDays: 365 });
    // 5 in-window + 1 out-of-window (60-day) = 6 total; 365-day window
    // should pick up both — but still not the 10 non-documenter spawns
    // and not the agent_stop.
    assert.equal(count, 6,
      '365-day window picks up all 6 documenter agent_start events but no others');
  });

  test('rollup ignores non-agent_start events even when agent_type=documenter', () => {
    // The fixture contains an `agent_stop` for a documenter — counting it
    // would inflate the spawn rate. Verify it is excluded.
    const onlyAgentStops = events.filter(
      (e) => e.type === 'agent_stop' && e.agent_type === 'documenter',
    );
    assert.equal(onlyAgentStops.length, 1,
      'fixture must contain the documenter agent_stop probe');
    const { count } = computeDocumenterRollup(
      onlyAgentStops,
      { now, windowDays: 30 },
    );
    assert.equal(count, 0,
      'rollup must NOT count agent_stop events even when agent_type=documenter');
  });

  test('rollup returns 0 cleanly when no documenter spawns exist', () => {
    const otherOnly = events.filter(
      (e) => !(e.type === 'agent_start' && e.agent_type === 'documenter'),
    );
    const { count, perDay } = computeDocumenterRollup(otherOnly, { now, windowDays: 30 });
    assert.equal(count, 0, 'no documenter spawns -> count is 0');
    assert.equal(perDay, 0, 'no documenter spawns -> per-day rate is 0');
  });
});
