#!/usr/bin/env node
'use strict';

/**
 * bare-event-key-detect-and-repair.test.js — end-to-end integration test
 * tying together the two halves of the bare-`event`-key class:
 *
 *   detect  — bin/audit-pm-emit-coverage.js's computeMisshapenEmits
 *   repair  — bin/_lib/normalize-bare-event-rows.js (this feature)
 *
 * Reproduces the real-world shape found live on 2026-08-08 (46 rows across 4
 * types: task_completed x30, orchestration_start x8, verify_fix_attempt x5,
 * orchestration_complete x3 — see .orchestray/kb/decisions/
 * bare-event-key-hand-appends.md) at a smaller scale, and asserts:
 *   1. the detector reports every row before repair runs (closing the
 *      "correctness-scanner" rubric item mechanically, not just by trusting
 *      the existing v2321-misshapen-emit-scan.test.js suite);
 *   2. the repair fixes every row and the detector then reports zero.
 *
 * Runner: node --test bin/_lib/__tests__/bare-event-key-detect-and-repair.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { computeMisshapenEmits } = require('../../audit-pm-emit-coverage');
const { repairBareEventRows }   = require('../normalize-bare-event-rows');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-event-detect-repair-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function eventsPath() {
  return path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
}

// Mirrors the real breakdown at 1/10 scale: 3 task_completed, 1
// orchestration_start (kept below 2 so nothing here relies on any ratio
// floor), all belonging to orchestrations that are no longer "current" —
// exactly the shape that made an early draft of the scanner blind (see its
// design note).
function realWorldShapedRows() {
  return [
    { event: 'task_completed', orchestration_id: 'orch-old-1', timestamp: '2026-07-25T00:00:00Z' },
    { event: 'task_completed', orchestration_id: 'orch-old-1', timestamp: '2026-07-25T01:00:00Z' },
    { event: 'task_completed', orchestration_id: 'orch-old-2', timestamp: '2026-08-06T00:00:00Z' },
    { event: 'orchestration_start', orchestration_id: 'orch-old-2', timestamp: '2026-08-06T00:00:00Z' },
    { event: 'verify_fix_attempt', orchestration_id: 'orch-old-3', timestamp: '2026-08-07T00:00:00Z' },
    { event: 'orchestration_complete', orchestration_id: 'orch-old-1', timestamp: '2026-07-25T02:00:00Z' },
  ];
}

describe('bare-event-key: detect then repair, end to end', () => {
  test('detector finds every real-world-shaped row; repair fixes them; detector then finds zero', () => {
    const rows = realWorldShapedRows();
    fs.writeFileSync(eventsPath(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // 1. Detect — same function bin/audit-pm-emit-coverage.js's scanMisshapenEmits
    // calls. No active orchestration required (global scan).
    const before = computeMisshapenEmits(tmpDir);
    assert.equal(before.counts.task_completed, 3);
    assert.equal(before.counts.orchestration_start, 1);
    assert.equal(before.counts.verify_fix_attempt, 1);
    assert.equal(before.counts.orchestration_complete, 1);
    const totalDetected = Object.values(before.counts).reduce((a, b) => a + b, 0);
    assert.equal(totalDetected, 6, 'detector must see every bare-event row before repair');

    // 2. Repair.
    const repairResult = repairBareEventRows(tmpDir);
    assert.equal(repairResult.summary.backfilled, 6);
    assert.equal(repairResult.summary.totalLines, 6, 'no row dropped by repair');

    // 3. Detect again — must now be zero, and the underlying row count must
    // be unchanged (backfill renames the key in place, it does not add or
    // remove rows).
    const after = computeMisshapenEmits(tmpDir);
    const totalAfter = Object.values(after.counts).reduce((a, b) => a + b, 0);
    assert.equal(totalAfter, 0, 'nothing left for the detector to find after repair');

    // repairBareEventRows appends one bare_event_key_repaired audit row of its
    // own AFTER the backfill completes — that row is new observability, not
    // part of the backfilled set, and is excluded from the "6 original rows
    // unchanged" check below.
    const finalLines = fs.readFileSync(eventsPath(), 'utf8').split('\n').filter(Boolean);
    const finalEvents = finalLines.map((l) => JSON.parse(l));
    const repairedNotice = finalEvents.filter((e) => e.type === 'bare_event_key_repaired');
    assert.equal(repairedNotice.length, 1, 'exactly one bare_event_key_repaired notice appended');
    const originalRows = finalEvents.filter((e) => e.type !== 'bare_event_key_repaired');
    assert.equal(originalRows.length, 6, 'row count of the original 6 rows unchanged by repair');
    for (const parsed of originalRows) {
      assert.ok(parsed.type, 'every row now carries type: ' + JSON.stringify(parsed));
      assert.equal(parsed.event, undefined, 'no row still carries a bare event key: ' + JSON.stringify(parsed));
    }
  });
});
