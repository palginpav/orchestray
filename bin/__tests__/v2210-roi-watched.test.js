#!/usr/bin/env node
'use strict';

/**
 * v2210-roi-watched.test.js — B6 acceptance tests.
 *
 * Verifies that pm-emit-state-watcher.checkOrchRoiPresence emits
 * orchestration_roi_missing when orchestration_roi is absent from the
 * orch slice at orch_complete.
 *
 * Tests:
 *   1. orch_complete WITH orchestration_roi in orch slice → 0 emits.
 *   2. orch_complete WITHOUT orchestration_roi in orch slice → 1 orchestration_roi_missing emit.
 *   3. ORCHESTRAY_ROI_WATCHED_DISABLED=1 → 0 emits.
 *
 * Runner: cd /home/palgin/orchestray && npm test -- --testPathPattern=v2210-roi-watched
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { checkOrchRoiPresence } = require(path.join(REPO_ROOT, 'bin', '_lib', 'pm-emit-state-watcher'));

const ORCH_ID = 'orch-20260429T062041Z-v2210-b6-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(eventsLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-b6-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({
      orchestration_id: ORCH_ID,
      started_at:       new Date().toISOString(),
      phase:            'execute',
    }),
  );

  // Write events.jsonl with provided lines.
  if (eventsLines && eventsLines.length > 0) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
      eventsLines.join('\n') + '\n',
    );
  }

  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/**
 * readLines injector — returns lines from an in-memory events.jsonl file,
 * so tests can control the orch slice without touching disk at the archive path.
 * Falls through to real fs for the live path.
 */
function makeReadLines(dir) {
  return function readLines(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').split('\n');
    } catch (_e) {
      return [];
    }
  };
}

function orchRoiEvent(orchId) {
  return JSON.stringify({
    version:          1,
    type:             'orchestration_roi',
    orchestration_id: orchId,
    timestamp:        new Date().toISOString(),
    total_cost_usd:   1.23,
    total_tasks:      5,
  });
}

function orchCompleteEvent(orchId) {
  return JSON.stringify({
    version:          1,
    type:             'orchestration_complete',
    orchestration_id: orchId,
    timestamp:        new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('B6: orchestration_roi presence check', () => {
  test('Test 1: orch_complete WITH orchestration_roi → 0 orchestration_roi_missing emits', () => {
    const events = [
      orchCompleteEvent(ORCH_ID),
      orchRoiEvent(ORCH_ID),
    ];
    const dir = makeRepo(events);

    // Ensure env kill switch is off.
    const saved = process.env.ORCHESTRAY_ROI_WATCHED_DISABLED;
    delete process.env.ORCHESTRAY_ROI_WATCHED_DISABLED;
    try {
      checkOrchRoiPresence(dir, ORCH_ID, makeReadLines(dir));
    } finally {
      if (saved !== undefined) process.env.ORCHESTRAY_ROI_WATCHED_DISABLED = saved;
    }

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 0,
      'should NOT emit orchestration_roi_missing when orchestration_roi is present');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Test 2: orch_complete WITHOUT orchestration_roi → 1 orchestration_roi_missing emit', () => {
    // Only orch_complete, no orchestration_roi.
    const events = [
      orchCompleteEvent(ORCH_ID),
    ];
    const dir = makeRepo(events);

    const saved = process.env.ORCHESTRAY_ROI_WATCHED_DISABLED;
    delete process.env.ORCHESTRAY_ROI_WATCHED_DISABLED;
    try {
      checkOrchRoiPresence(dir, ORCH_ID, makeReadLines(dir));
    } finally {
      if (saved !== undefined) process.env.ORCHESTRAY_ROI_WATCHED_DISABLED = saved;
    }

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 1,
      'should emit exactly 1 orchestration_roi_missing when orchestration_roi is absent');
    assert.strictEqual(emitted[0].orchestration_id, ORCH_ID,
      'orchestration_roi_missing should carry the correct orchestration_id');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Test 3: ORCHESTRAY_ROI_WATCHED_DISABLED=1 → 0 emits', () => {
    const events = [
      orchCompleteEvent(ORCH_ID),
      // No orchestration_roi — would normally trigger missing emit.
    ];
    const dir = makeRepo(events);

    const saved = process.env.ORCHESTRAY_ROI_WATCHED_DISABLED;
    process.env.ORCHESTRAY_ROI_WATCHED_DISABLED = '1';
    try {
      checkOrchRoiPresence(dir, ORCH_ID, makeReadLines(dir));
    } finally {
      if (saved !== undefined) {
        process.env.ORCHESTRAY_ROI_WATCHED_DISABLED = saved;
      } else {
        delete process.env.ORCHESTRAY_ROI_WATCHED_DISABLED;
      }
    }

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 0,
      'kill switch ORCHESTRAY_ROI_WATCHED_DISABLED=1 must suppress all emits');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
