#!/usr/bin/env node
'use strict';

/**
 * orchestray-loop.test.js — Item 10 (v2.2.8) /orchestray:loop tight-loop primitive.
 *
 * Tests:
 *   T1.  Smoke: completion-promise met — loop_completed(promise_met) emitted, state cleared.
 *   T2.  Smoke: max-iterations — re-spawn sentinel + loop_iteration at iter 9, then
 *        loop_completed(max_iterations) at iter 10.
 *   T3.  Smoke: cost-cap — loop_completed(cost_cap) when cost exceeds cap.
 *   T4.  Smoke: cancel sentinel (no loop.json) — passes through (continue: true).
 *   T5.  Kill switch: ORCHESTRAY_DISABLE_LOOP=1 — passes through.
 *   T6.  Kill switch: loop.enabled: false in config — passes through.
 *   T7.  Fail-open: malformed loop.json — passes through without throwing.
 *   T8.  Loop iteration increments iter_count and writes respawn sentinel.
 *   T9.  Status-line: [loop N/max] segment appended when loop.json present.
 *   T10. Status-line: no loop segment when loop.json absent.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Helper: create a minimal temp repo with required directory structure
// ---------------------------------------------------------------------------

function makeRepo(opts) {
  opts = opts || {};
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  // Write config.json (may be overridden by opts)
  const config = Object.assign({ event_schema_shadow: { enabled: false } }, opts.config || {});
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(config)
  );

  // Stub current-orchestration.json so writeEvent() doesn't crash
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: opts.orchId || 'orch-loop-test-001' })
  );

  // Optionally write loop.json
  if (opts.loopState) {
    fs.writeFileSync(
      path.join(stateDir, 'loop.json'),
      JSON.stringify(opts.loopState)
    );
  }

  return { dir, stateDir, auditDir };
}

/**
 * Collect emitted events from events.jsonl.
 * @param {string} auditDir
 * @returns {object[]}
 */
function readEvents(auditDir) {
  const eventsPath = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/**
 * Invoke loop-continue.js logic directly by requiring the module functions.
 * We test the exported helpers rather than spawning a child process to keep
 * tests fast and deterministic.
 *
 * Since loop-continue.js is a script (not a module with exports), we test via
 * subprocess invocation with controlled stdin and env.
 */
const { execFileSync, spawnSync } = require('node:child_process');
const LOOP_CONTINUE = path.join(REPO_ROOT, 'bin', 'loop-continue.js');

/**
 * Run loop-continue.js with a simulated SubagentStop payload.
 *
 * @param {object} opts
 * @param {string}  opts.cwd      - project dir
 * @param {object}  opts.payload  - stdin JSON payload
 * @param {object}  [opts.env]    - additional env vars
 * @returns {{ stdout: string, stderr: string, status: number, parsed: object }}
 */
function runHook(opts) {
  const result = spawnSync(
    process.execPath,
    [LOOP_CONTINUE],
    {
      input: JSON.stringify(opts.payload || { cwd: opts.cwd }),
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: opts.cwd }, opts.env || {}),
      encoding: 'utf8',
      timeout: 5000,
    }
  );
  let parsed = {};
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch (_e) {}
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status || 0,
    parsed,
  };
}

// ---------------------------------------------------------------------------
// T1: Completion promise met
// ---------------------------------------------------------------------------

describe('/orchestray:loop — loop-continue.js', () => {

  test('T1: completion promise in output → loop_completed(promise_met), state cleared', () => {
    const { dir, stateDir, auditDir } = makeRepo({
      loopState: {
        enabled: true,
        agent: 'developer',
        max_iterations: 10,
        completion_promise: 'TASK_COMPLETE',
        cost_cap_usd: 0.50,
        prompt: 'Fix the failing tests',
        iter_count: 2,
        cost_so_far: 0.06,
        orchestration_id: 'orch-loop-test-001',
      },
    });

    const result = runHook({
      cwd: dir,
      payload: {
        cwd: dir,
        output: 'All tests pass now. TASK_COMPLETE',
      },
    });

    // Hook must exit 0
    assert.strictEqual(result.status, 0);
    // Response must allow stop
    assert.strictEqual(result.parsed.continue, true);
    // loop.json must be cleared
    assert.strictEqual(fs.existsSync(path.join(stateDir, 'loop.json')), false);
    // loop_completed event must be emitted
    const events = readEvents(auditDir);
    const completed = events.find(e => e.type === 'loop_completed');
    assert.ok(completed, 'loop_completed event should be emitted');
    assert.strictEqual(completed.reason, 'promise_met');
    assert.strictEqual(completed.iter_count, 2);
  });

  // ---------------------------------------------------------------------------
  // T2: Max-iterations — re-spawn at iter 9, complete at iter 10
  // ---------------------------------------------------------------------------

  test('T2a: iter_count 8 of max 10 → re-spawn sentinel + loop_iteration', () => {
    const { dir, stateDir, auditDir } = makeRepo({
      loopState: {
        enabled: true,
        agent: 'developer',
        max_iterations: 10,
        completion_promise: 'TASK_COMPLETE',
        cost_cap_usd: 0.50,
        prompt: 'Fix the failing tests',
        iter_count: 8,
        cost_so_far: 0.24,
        orchestration_id: 'orch-loop-test-001',
      },
    });

    const result = runHook({
      cwd: dir,
      payload: {
        cwd: dir,
        output: 'Tests still failing.',
      },
    });

    assert.strictEqual(result.status, 0);
    // Should block stop (decision: block)
    assert.ok(result.parsed.decision === 'block', 'should block stop for re-spawn');
    // loop.json must be updated with iter_count = 9
    const loopState = JSON.parse(fs.readFileSync(path.join(stateDir, 'loop.json'), 'utf8'));
    assert.strictEqual(loopState.iter_count, 9);
    // loop-respawn.json must exist
    assert.ok(fs.existsSync(path.join(stateDir, 'loop-respawn.json')), 'respawn sentinel should exist');
    // loop_iteration event must be emitted
    const events = readEvents(auditDir);
    const iter = events.find(e => e.type === 'loop_iteration');
    assert.ok(iter, 'loop_iteration event should be emitted');
    assert.strictEqual(iter.iter_count, 9);
  });

  test('T2b: iter_count 9 of max 10 → loop_completed(max_iterations), state cleared', () => {
    const { dir, stateDir, auditDir } = makeRepo({
      loopState: {
        enabled: true,
        agent: 'developer',
        max_iterations: 10,
        completion_promise: 'TASK_COMPLETE',
        cost_cap_usd: 0.50,
        prompt: 'Fix the failing tests',
        iter_count: 9,
        cost_so_far: 0.27,
        orchestration_id: 'orch-loop-test-001',
      },
    });

    const result = runHook({
      cwd: dir,
      payload: {
        cwd: dir,
        output: 'Still failing.',
      },
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.parsed.continue, true);
    // loop.json must be cleared
    assert.strictEqual(fs.existsSync(path.join(stateDir, 'loop.json')), false);
    // loop_completed(max_iterations)
    const events = readEvents(auditDir);
    const completed = events.find(e => e.type === 'loop_completed');
    assert.ok(completed, 'loop_completed event should be emitted');
    assert.strictEqual(completed.reason, 'max_iterations');
  });

  // ---------------------------------------------------------------------------
  // T3: Cost cap
  // ---------------------------------------------------------------------------

  test('T3: cost_so_far + iter_cost >= cost_cap → loop_completed(cost_cap)', () => {
    const { dir, stateDir, auditDir } = makeRepo({
      loopState: {
        enabled: true,
        agent: 'developer',
        max_iterations: 10,
        completion_promise: 'TASK_COMPLETE',
        cost_cap_usd: 0.10,
        prompt: 'Fix the failing tests',
        iter_count: 3,
        cost_so_far: 0.09,
        orchestration_id: 'orch-loop-test-001',
      },
    });

    // The payload includes usage that will push cost over 0.10
    const result = runHook({
      cwd: dir,
      payload: {
        cwd: dir,
        output: 'Still failing.',
        usage: {
          input_tokens: 5000,    // 5K * $3/M = $0.015
          output_tokens: 1000,   // 1K * $15/M = $0.015 → total iter ≈ $0.030
        },
      },
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.parsed.continue, true);
    assert.strictEqual(fs.existsSync(path.join(stateDir, 'loop.json')), false);
    const events = readEvents(auditDir);
    const completed = events.find(e => e.type === 'loop_completed');
    assert.ok(completed, 'loop_completed event should be emitted');
    assert.strictEqual(completed.reason, 'cost_cap');
  });

  // ---------------------------------------------------------------------------
  // T4: No loop.json → pass through
  // ---------------------------------------------------------------------------

  test('T4: no loop.json → pass through (continue: true)', () => {
    const { dir } = makeRepo({});
    const result = runHook({
      cwd: dir,
      payload: { cwd: dir, output: 'Agent output' },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.parsed.continue, true);
  });

  // ---------------------------------------------------------------------------
  // T5: Kill switch env var
  // ---------------------------------------------------------------------------

  test('T5: ORCHESTRAY_DISABLE_LOOP=1 → pass through', () => {
    const { dir } = makeRepo({
      loopState: {
        enabled: true,
        agent: 'developer',
        max_iterations: 10,
        completion_promise: 'TASK_COMPLETE',
        cost_cap_usd: 0.50,
        prompt: 'Fix tests',
        iter_count: 2,
        cost_so_far: 0.06,
      },
    });

    const result = runHook({
      cwd: dir,
      payload: { cwd: dir, output: 'No promise here.' },
      env: { ORCHESTRAY_DISABLE_LOOP: '1' },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.parsed.continue, true);
  });

  // ---------------------------------------------------------------------------
  // T6: Kill switch config
  // ---------------------------------------------------------------------------

  test('T6: loop.enabled: false in config → pass through', () => {
    const { dir } = makeRepo({
      config: { loop: { enabled: false }, event_schema_shadow: { enabled: false } },
      loopState: {
        enabled: true,
        agent: 'developer',
        max_iterations: 10,
        completion_promise: 'TASK_COMPLETE',
        cost_cap_usd: 0.50,
        prompt: 'Fix tests',
        iter_count: 2,
        cost_so_far: 0.06,
      },
    });

    const result = runHook({
      cwd: dir,
      payload: { cwd: dir, output: 'No promise here.' },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.parsed.continue, true);
  });

  // ---------------------------------------------------------------------------
  // T7: Malformed loop.json → fail-open
  // ---------------------------------------------------------------------------

  test('T7: malformed loop.json → pass through without throwing', () => {
    const { dir, stateDir } = makeRepo({});
    fs.writeFileSync(path.join(stateDir, 'loop.json'), 'NOT JSON {{{{');
    const result = runHook({
      cwd: dir,
      payload: { cwd: dir, output: 'Some output' },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.parsed.continue, true);
  });

  // ---------------------------------------------------------------------------
  // T8: Loop iteration increments iter_count and writes respawn sentinel
  // ---------------------------------------------------------------------------

  test('T8: loop iteration writes correct iter_count and respawn sentinel', () => {
    const { dir, stateDir } = makeRepo({
      loopState: {
        enabled: true,
        agent: 'tester',
        max_iterations: 5,
        completion_promise: 'ALL_GREEN',
        cost_cap_usd: 1.00,
        prompt: 'Run tests',
        iter_count: 1,
        cost_so_far: 0.01,
        orchestration_id: 'orch-loop-test-001',
      },
    });

    runHook({
      cwd: dir,
      payload: { cwd: dir, output: 'Tests still failing.' },
    });

    // loop.json iter_count should be 2
    const loopState = JSON.parse(fs.readFileSync(path.join(stateDir, 'loop.json'), 'utf8'));
    assert.strictEqual(loopState.iter_count, 2);

    // respawn sentinel should reference correct agent and iter_count
    const respawn = JSON.parse(fs.readFileSync(path.join(stateDir, 'loop-respawn.json'), 'utf8'));
    assert.strictEqual(respawn.loop_active, true);
    assert.strictEqual(respawn.agent, 'tester');
    assert.strictEqual(respawn.iter_count, 2);
    assert.strictEqual(respawn.prompt, 'Run tests');
  });

});

// ---------------------------------------------------------------------------
// T9/T10: Status-line loop segment
// ---------------------------------------------------------------------------

describe('/orchestray:loop — statusline.js loop segment', () => {

  const STATUSLINE = path.join(REPO_ROOT, 'bin', 'statusline.js');

  /**
   * Run statusline.js with a fake payload and a prepared project dir.
   * @param {object} opts
   * @returns {string} stdout line
   */
  function runStatusline(opts) {
    const result = spawnSync(
      process.execPath,
      [STATUSLINE],
      {
        input: JSON.stringify(opts.payload || {}),
        env: Object.assign({}, process.env, {
          CLAUDE_PROJECT_DIR: opts.cwd,
        }),
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    return (result.stdout || '').trim();
  }

  test('T9: [loop N/max] appended to status line when loop.json present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-sl-'));
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ context_statusbar: { enabled: true } })
    );
    // Write a loop.json with iter_count: 3, max_iterations: 10
    fs.writeFileSync(
      path.join(stateDir, 'loop.json'),
      JSON.stringify({ enabled: true, iter_count: 3, max_iterations: 10 })
    );

    const line = runStatusline({ cwd: dir, payload: {} });
    assert.ok(line.includes('[loop 3/10]'), `expected [loop 3/10] in "${line}"`);
  });

  test('T10: no loop segment when loop.json absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-sl-noloop-'));
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ context_statusbar: { enabled: true } })
    );

    const line = runStatusline({ cwd: dir, payload: {} });
    assert.ok(!line.includes('[loop'), `expected no [loop in "${line}"`);
  });

});
