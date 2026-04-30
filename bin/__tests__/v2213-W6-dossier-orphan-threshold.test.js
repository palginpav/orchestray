#!/usr/bin/env node
'use strict';

/**
 * v2.2.13 W6 — dossier orphan threshold escalator tests.
 *
 * Tests the `maybeEmitThreshold` function added to `bin/audit-dossier-orphan.js`
 * and the `dossier_orphan_threshold_exceeded` event it emits.
 *
 * 5 cases per mechanisation plan §5 W6 (P1-1 re-keyed on orchestration_id):
 *   Case 1: Single orphan for orch X → no threshold emit (count=1).
 *   Case 2: 5 orphans in same orch X → threshold emit fires once {count:5, threshold:5}.
 *   Case 3: 6th orphan in same orch X → emit does NOT fire again (count=6 ≠ threshold=5).
 *   Case 4: ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED=1 → no emit at any count.
 *   Case 5 (bonus): orch Y uses separate counter file; 5 orphans on Y → independent emit.
 *
 * Design: v2.2.13 mechanisation plan §5 W6; G-08.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const ORPHAN_MODULE = path.resolve(__dirname, '..', 'audit-dossier-orphan.js');
const { maybeEmitThreshold } = require(ORPHAN_MODULE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-W6-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
  return tmp;
}

function readEmittedEvents(cwd) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
  }
  return out;
}

function thresholdEvents(cwd) {
  return readEmittedEvents(cwd).filter((ev) => ev.type === 'dossier_orphan_threshold_exceeded');
}

function counterValue(cwd, orchId) {
  const counterPath = path.join(cwd, '.orchestray', 'state', `dossier-orphan-counter.${orchId}`);
  try {
    const raw = fs.readFileSync(counterPath, 'utf8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  } catch (_e) { return 0; }
}

// ---------------------------------------------------------------------------
// Case 1: Single orphan for orch X → no threshold emit (count=1)
// ---------------------------------------------------------------------------

describe('v2.2.13 W6 — Case 1: single orphan, no threshold emit', () => {
  test('one call to maybeEmitThreshold → counter=1, no dossier_orphan_threshold_exceeded emitted', () => {
    const cwd = makeTmpDir();
    const orchId = 'orch-threshold-case1';

    maybeEmitThreshold(cwd, orchId);

    assert.equal(counterValue(cwd, orchId), 1, 'counter should be 1 after one call');
    const events = thresholdEvents(cwd);
    assert.equal(events.length, 0, 'no threshold event should fire at count=1 (threshold=5)');
  });
});

// ---------------------------------------------------------------------------
// Case 2: 5 orphans in same orch X → threshold emit fires once
// ---------------------------------------------------------------------------

describe('v2.2.13 W6 — Case 2: 5 orphans → threshold emit fires once', () => {
  test('fifth call crosses threshold → emits dossier_orphan_threshold_exceeded once with correct fields', () => {
    const cwd = makeTmpDir();
    const orchId = 'orch-threshold-case2';

    // Calls 1-4: no emit
    for (let i = 0; i < 4; i++) {
      maybeEmitThreshold(cwd, orchId);
    }
    assert.equal(thresholdEvents(cwd).length, 0, 'no threshold event before reaching 5');

    // Call 5: should cross the threshold and emit
    maybeEmitThreshold(cwd, orchId);

    assert.equal(counterValue(cwd, orchId), 5, 'counter should be 5');
    const events = thresholdEvents(cwd);
    assert.equal(events.length, 1, 'exactly one threshold event emitted');
    assert.equal(events[0].orchestration_id, orchId, 'orchestration_id matches');
    assert.equal(events[0].count, 5, 'count field is 5');
    assert.equal(events[0].threshold, 5, 'threshold field is 5 (default)');
    assert.equal(events[0].schema_version, 1, 'schema_version is 1');
  });
});

// ---------------------------------------------------------------------------
// Case 3: 6th orphan in same orch X → emit does NOT fire again
// ---------------------------------------------------------------------------

describe('v2.2.13 W6 — Case 3: 6th orphan → no additional threshold emit', () => {
  test('sixth call (count=6 ≠ threshold=5) → threshold event NOT re-emitted', () => {
    const cwd = makeTmpDir();
    const orchId = 'orch-threshold-case3';

    // Drive counter to 5 (threshold emit fires)
    for (let i = 0; i < 5; i++) {
      maybeEmitThreshold(cwd, orchId);
    }
    assert.equal(thresholdEvents(cwd).length, 1, 'one emit at crossing');

    // 6th call: count=6, no new emit
    maybeEmitThreshold(cwd, orchId);

    assert.equal(counterValue(cwd, orchId), 6, 'counter is now 6');
    const events = thresholdEvents(cwd);
    assert.equal(events.length, 1, 'still only one threshold event — no re-emit at count=6');
  });
});

// ---------------------------------------------------------------------------
// Case 4: ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED=1 → no emit
// ---------------------------------------------------------------------------

describe('v2.2.13 W6 — Case 4: kill switch disables threshold emit', () => {
  test('ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED=1 → no emit even after 5+ orphans', () => {
    const cwd = makeTmpDir();
    const orchId = 'orch-threshold-case4';

    const prev = process.env.ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED;
    process.env.ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED = '1';
    try {
      for (let i = 0; i < 6; i++) {
        maybeEmitThreshold(cwd, orchId);
      }
    } finally {
      if (prev === undefined) {
        delete process.env.ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED;
      } else {
        process.env.ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED = prev;
      }
    }

    const events = thresholdEvents(cwd);
    assert.equal(events.length, 0, 'kill switch suppresses all threshold emits');
    // Counter file should not be written when kill switch is set (no-op early return)
    assert.equal(counterValue(cwd, orchId), 0, 'counter should remain 0 with kill switch active');
  });
});

// ---------------------------------------------------------------------------
// Case 5 (bonus): orch Y uses separate counter; independent threshold emit
// ---------------------------------------------------------------------------

describe('v2.2.13 W6 — Case 5: separate orchestrations use independent counters', () => {
  test('orch X and orch Y each have independent counters and independent threshold emits', () => {
    const cwd = makeTmpDir();
    const orchX = 'orch-threshold-case5-X';
    const orchY = 'orch-threshold-case5-Y';

    // Drive orch X to 3 (below threshold)
    for (let i = 0; i < 3; i++) {
      maybeEmitThreshold(cwd, orchX);
    }
    assert.equal(thresholdEvents(cwd).length, 0, 'no emit yet — orch X at count=3');

    // Drive orch Y to 5 (should emit for Y only)
    for (let i = 0; i < 5; i++) {
      maybeEmitThreshold(cwd, orchY);
    }

    const events = thresholdEvents(cwd);
    assert.equal(events.length, 1, 'exactly one threshold event — for orch Y only');
    assert.equal(events[0].orchestration_id, orchY, 'threshold event is for orch Y');
    assert.equal(events[0].count, 5);
    assert.equal(events[0].threshold, 5);

    // Counter files are independent
    assert.equal(counterValue(cwd, orchX), 3, 'orch X counter is 3 (independent)');
    assert.equal(counterValue(cwd, orchY), 5, 'orch Y counter is 5 (independent)');

    // Now drive orch X to 5 — should emit independently for X
    for (let i = 0; i < 2; i++) {
      maybeEmitThreshold(cwd, orchX);
    }

    const allEvents = thresholdEvents(cwd);
    assert.equal(allEvents.length, 2, 'now two threshold events — one per orchestration');
    const orchXEvent = allEvents.find((ev) => ev.orchestration_id === orchX);
    const orchYEvent = allEvents.find((ev) => ev.orchestration_id === orchY);
    assert.ok(orchXEvent, 'orch X threshold event present');
    assert.equal(orchXEvent.count, 5);
    assert.ok(orchYEvent, 'orch Y threshold event present');
    assert.equal(orchYEvent.count, 5);

    // Separate counter files exist on disk
    const counterFileX = path.join(cwd, '.orchestray', 'state', `dossier-orphan-counter.${orchX}`);
    const counterFileY = path.join(cwd, '.orchestray', 'state', `dossier-orphan-counter.${orchY}`);
    assert.ok(fs.existsSync(counterFileX), 'counter file for orch X exists');
    assert.ok(fs.existsSync(counterFileY), 'counter file for orch Y exists');
    assert.notEqual(counterFileX, counterFileY, 'counter file paths are distinct');
  });
});
