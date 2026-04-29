#!/usr/bin/env node
'use strict';

/**
 * v2210-verify-fix-watcher.test.js — B1 acceptance tests.
 *
 * Verifies that pm-emit-state-watcher auto-emits verify_fix_pass /
 * verify_fix_fail when task YAML verify_fix.status transitions to
 * resolved / escalated.
 *
 * Tests:
 *   1. status: resolved  → 1 verify_fix_pass event with correct task_id
 *   2. status: escalated → 1 verify_fix_fail event with correct task_id
 *   3. status: open      → 0 emits
 *   4. ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED=1 → 0 emits
 *   5. Same task YAML, status unchanged → 0 emits (idempotency)
 *
 * Runner: cd /home/palgin/orchestray && npm test -- --testPathPattern=v2210-verify-fix-watcher
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER   = path.join(REPO_ROOT, 'bin', 'pm-emit-state-watcher.js');

const ORCH_ID = 'orch-20260429T062041Z-v2210-b1-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-b1-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'tasks'), { recursive: true });

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({
      orchestration_id: ORCH_ID,
      started_at:       new Date().toISOString(),
      phase:            'execute',
    }),
  );

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

function makeTaskYaml(status, opts = {}) {
  const round       = opts.round || 2;
  const errorCount  = opts.error_count != null ? opts.error_count : 1;
  return [
    '---',
    'task_id: task-5',
    'status: completed',
    'verify_fix:',
    `  status: ${status}`,
    '  round_history:',
    `    - round: ${round}`,
    `      reviewer_issues: ${errorCount}`,
    '---',
    '',
    '# Task 5',
  ].join('\n');
}

function runWatcher(dir, relPath, env = {}) {
  const payload = {
    cwd:             dir,
    hook_event_name: 'PostToolUse',
    tool_name:       'Write',
    tool_input: {
      file_path: path.join(dir, relPath),
    },
    tool_response: { success: true },
    session_id:    'test-sess-b1',
  };
  return spawnSync('node', [WATCHER], {
    cwd:      dir,
    env:      { ...process.env, ...env },
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  8000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.10 B1 — verify-fix watcher', () => {

  test('case 1: verify_fix.status: resolved → 1 verify_fix_pass event with task_id', () => {
    const dir      = makeRepo();
    const relPath  = '.orchestray/state/tasks/task-5.yaml';
    const fullPath = path.join(dir, relPath);

    fs.writeFileSync(fullPath, makeTaskYaml('resolved', { round: 2 }));

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const pass = events.filter(e => e.type === 'verify_fix_pass');
    assert.equal(pass.length, 1, 'must emit exactly 1 verify_fix_pass event');
    assert.equal(pass[0].task_id, 'task-5', 'task_id must match filename stem');
    assert.equal(pass[0].source, 'state_watcher_backstop');
    assert.equal(typeof pass[0].round, 'number');
    assert.equal(typeof pass[0].rounds_total, 'number');
  });

  test('case 2: verify_fix.status: escalated → 1 verify_fix_fail event with task_id', () => {
    const dir      = makeRepo();
    const relPath  = '.orchestray/state/tasks/task-5.yaml';
    const fullPath = path.join(dir, relPath);

    fs.writeFileSync(fullPath, makeTaskYaml('escalated', { round: 3, error_count: 2 }));

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const fail = events.filter(e => e.type === 'verify_fix_fail');
    assert.equal(fail.length, 1, 'must emit exactly 1 verify_fix_fail event');
    assert.equal(fail[0].task_id, 'task-5', 'task_id must match filename stem');
    assert.equal(fail[0].source, 'state_watcher_backstop');
    assert.equal(typeof fail[0].round, 'number');
    assert.equal(typeof fail[0].remaining_errors, 'number');
  });

  test('case 3: verify_fix.status: open → 0 emits', () => {
    const dir      = makeRepo();
    const relPath  = '.orchestray/state/tasks/task-5.yaml';
    const fullPath = path.join(dir, relPath);

    fs.writeFileSync(fullPath, makeTaskYaml('open'));

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const vfEvents = events.filter(e =>
      e.type === 'verify_fix_pass' || e.type === 'verify_fix_fail'
    );
    assert.equal(vfEvents.length, 0, 'must emit 0 verify_fix events for status=open');
  });

  test('case 4: ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED=1 → 0 emits', () => {
    const dir      = makeRepo();
    const relPath  = '.orchestray/state/tasks/task-5.yaml';
    const fullPath = path.join(dir, relPath);

    fs.writeFileSync(fullPath, makeTaskYaml('resolved'));

    const r = runWatcher(dir, relPath, { ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED: '1' });
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const vfEvents = events.filter(e =>
      e.type === 'verify_fix_pass' || e.type === 'verify_fix_fail'
    );
    assert.equal(vfEvents.length, 0, 'kill-switch must suppress all verify_fix emits');
  });

  test('case 5: same task YAML written twice with same status → 0 emits on second write (idempotency)', () => {
    const dir      = makeRepo();
    const relPath  = '.orchestray/state/tasks/task-5.yaml';
    const fullPath = path.join(dir, relPath);
    const yaml     = makeTaskYaml('resolved');

    // First write — should emit.
    fs.writeFileSync(fullPath, yaml);
    const r1 = runWatcher(dir, relPath);
    assert.equal(r1.status, 0, `first run exit=${r1.status} stderr=${r1.stderr}`);

    const afterFirst = readEvents(dir).filter(e => e.type === 'verify_fix_pass');
    assert.equal(afterFirst.length, 1, 'first write must emit 1 verify_fix_pass');

    // Second write — identical content, same status. Must NOT re-emit.
    fs.writeFileSync(fullPath, yaml);
    const r2 = runWatcher(dir, relPath);
    assert.equal(r2.status, 0, `second run exit=${r2.status} stderr=${r2.stderr}`);

    const afterSecond = readEvents(dir).filter(e => e.type === 'verify_fix_pass');
    assert.equal(afterSecond.length, 1, 'second write must NOT produce another verify_fix_pass (idempotent)');
  });

});
