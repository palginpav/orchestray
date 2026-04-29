#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-5-replan-budget.test.js — W2-5 replan budget guard acceptance tests.
 *
 * Tests checkReplanBudget() in bin/_lib/pm-emit-state-watcher.js:
 *   1. 4 w_item_redo_requested events + budget=3 → 1 replan_budget_exceeded emitted.
 *   2. 3 events + budget=3 → 0 emits (at threshold, not exceeded).
 *   3. 4 events, called twice → 1 emit (lock-file dedup).
 *   4. orch-A 4 events + orch-B 4 events → 2 emits (one per orch).
 *   5. Kill switch ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED=1 → 0 emits.
 *   6. replan_budget_exceeded appears in event-schemas.shadow.json.
 *
 * Runner: node --test bin/__tests__/v2211-w2-5-replan-budget.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const WATCHER_LIB  = path.join(REPO_ROOT, 'bin', '_lib', 'pm-emit-state-watcher.js');
const SHADOW_PATH  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');

const { checkReplanBudget } = require(WATCHER_LIB);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-w25-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history', orchId), { recursive: true });
  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/**
 * Build a readLines injector that returns the given event lines for any path.
 * Each event is a minimal w_item_redo_requested row.
 */
function makeReadLines(events) {
  return (_filePath) => events.map(e => JSON.stringify(e));
}

function makeRedoEvent(orchId) {
  return {
    type:             'w_item_redo_requested',
    orchestration_id: orchId,
    timestamp:        new Date().toISOString(),
    version:          1,
  };
}

function writeConfig(dir, cfg) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W2-5 — replan budget guard', () => {

  test('Test 1: 4 w_item_redo_requested events + budget=3 → 1 replan_budget_exceeded emitted', () => {
    const orchId = 'orch-w25-test1-' + Date.now();
    const dir    = makeRepo(orchId);
    writeConfig(dir, { replan_budget: 3 });

    const events = [
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
    ];

    checkReplanBudget(dir, orchId, makeReadLines(events));

    const emitted = readEvents(dir).filter(e => e.type === 'replan_budget_exceeded');
    assert.equal(emitted.length, 1, 'must emit exactly 1 replan_budget_exceeded');
    assert.equal(emitted[0].orchestration_id, orchId);
    assert.equal(emitted[0].replan_count, 4);
    assert.equal(emitted[0].replan_budget, 3);
    assert.equal(emitted[0].schema_version, 1);
    assert.equal(emitted[0].version, 1);
  });

  test('Test 2: 3 events + budget=3 → 0 emits (at threshold, not exceeded)', () => {
    const orchId = 'orch-w25-test2-' + Date.now();
    const dir    = makeRepo(orchId);
    writeConfig(dir, { replan_budget: 3 });

    const events = [
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
    ];

    checkReplanBudget(dir, orchId, makeReadLines(events));

    const emitted = readEvents(dir).filter(e => e.type === 'replan_budget_exceeded');
    assert.equal(emitted.length, 0, 'must emit 0 when count == budget (not exceeded)');
  });

  test('Test 3: 4 events for same orch, called twice → still 1 emit (lock-file dedup)', () => {
    const orchId = 'orch-w25-test3-' + Date.now();
    const dir    = makeRepo(orchId);
    writeConfig(dir, { replan_budget: 3 });

    const events = [
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
    ];
    const readLines = makeReadLines(events);

    checkReplanBudget(dir, orchId, readLines);
    checkReplanBudget(dir, orchId, readLines); // simulates second PM Stop fire

    const emitted = readEvents(dir).filter(e => e.type === 'replan_budget_exceeded');
    assert.equal(emitted.length, 1, 'lock-file dedup must suppress second emit');
  });

  test('Test 4: 4 events for orch-A + 4 for orch-B → 2 emits (one per orch)', () => {
    const orchA = 'orch-w25-test4a-' + Date.now();
    const orchB = 'orch-w25-test4b-' + Date.now();
    const dir   = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-w25-t4-'));
    fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'history', orchA), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'history', orchB), { recursive: true });
    writeConfig(dir, { replan_budget: 3 });

    const eventsA = [orchA, orchA, orchA, orchA].map(makeRedoEvent);
    const eventsB = [orchB, orchB, orchB, orchB].map(makeRedoEvent);

    // Each call only sees events for its own orchId because our makeReadLines
    // injector returns ALL lines, but checkReplanBudget filters by orchId.
    checkReplanBudget(dir, orchA, makeReadLines([...eventsA, ...eventsB]));
    checkReplanBudget(dir, orchB, makeReadLines([...eventsA, ...eventsB]));

    const emitted = readEvents(dir).filter(e => e.type === 'replan_budget_exceeded');
    assert.equal(emitted.length, 2, 'must emit once per orch');
    const orchIds = emitted.map(e => e.orchestration_id).sort();
    assert.deepEqual(orchIds, [orchA, orchB].sort());
  });

  test('Test 5: kill switch ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED=1 → 0 emits', () => {
    const orchId = 'orch-w25-test5-' + Date.now();
    const dir    = makeRepo(orchId);
    writeConfig(dir, { replan_budget: 3 });

    const events = [
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
      makeRedoEvent(orchId),
    ];

    const orig = process.env.ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED;
    process.env.ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED = '1';
    try {
      checkReplanBudget(dir, orchId, makeReadLines(events));
    } finally {
      if (orig === undefined) delete process.env.ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED;
      else process.env.ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED = orig;
    }

    const emitted = readEvents(dir).filter(e => e.type === 'replan_budget_exceeded');
    assert.equal(emitted.length, 0, 'kill switch must suppress all emits');
  });

  test('Test 6: replan_budget_exceeded appears in event-schemas.shadow.json', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    assert.ok(
      Object.prototype.hasOwnProperty.call(shadow, 'replan_budget_exceeded'),
      'replan_budget_exceeded must be a top-level key in event-schemas.shadow.json',
    );
    const entry = shadow.replan_budget_exceeded;
    // r = required-field count; schema has version, orchestration_id, replan_count,
    // replan_budget, schema_version = 5 required fields (plus timestamp injected = 6+).
    assert.ok(typeof entry.r === 'number' && entry.r >= 4,
      'replan_budget_exceeded must have r (required count) >= 4, got ' + entry.r);
  });

});
