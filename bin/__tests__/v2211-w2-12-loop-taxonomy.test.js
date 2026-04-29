#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-12-loop-taxonomy.test.js — W2-12 loop_completed loop_kind tests.
 *
 * Tests that loop-continue.js passes loop_kind on every loop_completed emit:
 *   1. Default loop (no loop_kind in state) → loop_completed has loop_kind: "orch".
 *   2. State carries loop_kind: "verify_fix" → loop_completed has loop_kind: "verify_fix".
 *   3. Kill switch ORCHESTRAY_LOOP_KIND_DISAMBIGUATION_DISABLED=1 → loop_kind absent.
 *   4. Max-iterations termination also carries loop_kind: "orch".
 *   5. Cost-cap termination also carries loop_kind: "orch".
 *   6. Promise-met termination carries loop_kind from state.
 *
 * Runner: node --test bin/__tests__/v2211-w2-12-loop-taxonomy.test.js
 *
 * Strategy: directly exercise the emitEvent path by calling the run() internals
 * via a synthetic state file + dummy payload. We spy on emitted events via the
 * events.jsonl file in a temp repo.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-w212-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8',
  );
  return dir;
}

function writeLoopState(dir, state) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'state', 'loop.json'),
    JSON.stringify(state),
    'utf8',
  );
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
 * Drive loop-continue.js run() function via synthesized stdin payload.
 * We isolate by spawning a child process with the relevant env + state files.
 */
function runLoopContinue(dir, orchId, payload, env) {
  const { spawnSync } = require('node:child_process');
  const script = path.join(REPO_ROOT, 'bin', 'loop-continue.js');

  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(Object.assign({ cwd: dir }, payload)),
    env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1' }, env || {}),
    encoding: 'utf8',
    timeout: 5000,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W2-12 — loop_completed loop_kind taxonomy', () => {

  test('Test 1: orch loop (default) → loop_completed has loop_kind: "orch"', () => {
    const orchId = 'orch-w212-t1-' + Date.now();
    const dir    = makeRepo(orchId);

    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     3,
      cost_cap_usd:       1.00,
      iter_count:         0,
      cost_so_far:        0,
      // no loop_kind → defaults to "orch"
    });

    // Trigger max_iterations path: iter_count (0) + 1 = 1 >= max_iterations (1)
    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     1,
      cost_cap_usd:       1.00,
      iter_count:         0,
      cost_so_far:        0,
    });

    runLoopContinue(dir, orchId, {}, {});

    const events = readEvents(dir);
    const completed = events.filter(e => e.type === 'loop_completed');
    assert.equal(completed.length, 1, 'must emit exactly 1 loop_completed');
    assert.equal(completed[0].loop_kind, 'orch', 'loop_kind must be "orch" by default');
  });

  test('Test 2: verify_fix loop → loop_completed has loop_kind: "verify_fix"', () => {
    const orchId = 'orch-w212-t2-' + Date.now();
    const dir    = makeRepo(orchId);

    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     1,
      cost_cap_usd:       1.00,
      iter_count:         0,
      cost_so_far:        0,
      loop_kind:          'verify_fix',
    });

    runLoopContinue(dir, orchId, {}, {});

    const events = readEvents(dir);
    const completed = events.filter(e => e.type === 'loop_completed');
    assert.equal(completed.length, 1, 'must emit exactly 1 loop_completed');
    assert.equal(completed[0].loop_kind, 'verify_fix', 'loop_kind must be "verify_fix" from state');
  });

  test('Test 3: kill switch ORCHESTRAY_LOOP_KIND_DISAMBIGUATION_DISABLED=1 → loop_kind absent', () => {
    const orchId = 'orch-w212-t3-' + Date.now();
    const dir    = makeRepo(orchId);

    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     1,
      cost_cap_usd:       1.00,
      iter_count:         0,
      cost_so_far:        0,
    });

    runLoopContinue(dir, orchId, {}, {
      ORCHESTRAY_LOOP_KIND_DISAMBIGUATION_DISABLED: '1',
    });

    const events = readEvents(dir);
    const completed = events.filter(e => e.type === 'loop_completed');
    assert.equal(completed.length, 1, 'must emit exactly 1 loop_completed');
    assert.ok(!('loop_kind' in completed[0]), 'loop_kind must be absent when kill switch is set');
  });

  test('Test 4: cost-cap termination also carries loop_kind: "orch"', () => {
    const orchId = 'orch-w212-t4-' + Date.now();
    const dir    = makeRepo(orchId);

    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     100,
      cost_cap_usd:       0.00, // cost cap is 0 → immediately exceeded
      iter_count:         0,
      cost_so_far:        0,
    });

    runLoopContinue(dir, orchId, {}, {});

    const events = readEvents(dir);
    const completed = events.filter(e => e.type === 'loop_completed');
    assert.equal(completed.length, 1, 'must emit exactly 1 loop_completed');
    assert.equal(completed[0].reason, 'cost_cap', 'termination reason must be cost_cap');
    assert.equal(completed[0].loop_kind, 'orch', 'loop_kind must be "orch" on cost-cap termination');
  });

  test('Test 5: promise-met termination carries loop_kind from state', () => {
    const orchId = 'orch-w212-t5-' + Date.now();
    const dir    = makeRepo(orchId);

    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     100,
      cost_cap_usd:       100.00,
      iter_count:         0,
      cost_so_far:        0,
      loop_kind:          'verify_fix',
    });

    // Pass output containing the completion promise
    runLoopContinue(dir, orchId, { output: 'done TASK_COMPLETE here' }, {});

    const events = readEvents(dir);
    const completed = events.filter(e => e.type === 'loop_completed');
    assert.equal(completed.length, 1, 'must emit exactly 1 loop_completed');
    assert.equal(completed[0].reason, 'promise_met', 'termination reason must be promise_met');
    assert.equal(completed[0].loop_kind, 'verify_fix', 'loop_kind must be "verify_fix" from state on promise-met');
  });

  test('Test 6: max-iterations termination carries loop_kind: "orch"', () => {
    const orchId = 'orch-w212-t6-' + Date.now();
    const dir    = makeRepo(orchId);

    writeLoopState(dir, {
      enabled:            true,
      orchestration_id:   orchId,
      agent:              'developer',
      completion_promise: 'TASK_COMPLETE',
      max_iterations:     1,
      cost_cap_usd:       100.00,
      iter_count:         0,
      cost_so_far:        0,
      // no loop_kind → defaults to "orch"
    });

    runLoopContinue(dir, orchId, { output: 'no completion signal here' }, {});

    const events = readEvents(dir);
    const completed = events.filter(e => e.type === 'loop_completed');
    assert.equal(completed.length, 1, 'must emit exactly 1 loop_completed');
    assert.equal(completed[0].reason, 'max_iterations', 'termination reason must be max_iterations');
    assert.equal(completed[0].loop_kind, 'orch', 'loop_kind must be "orch" on max-iterations termination');
  });

});
