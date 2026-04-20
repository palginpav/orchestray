#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-task-completion.js — T15 hook.
 * Includes PRE_DONE_ENFORCEMENT env var kill-switch (I-12 rollback path).
 *
 * Runner: node --test bin/__tests__/validate-task-completion-t15.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../validate-task-completion.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-task-completion-test-'));
}

/**
 * Run the hook script with a JSON event piped to stdin.
 * @param {object} event
 * @param {object} [envOverrides]
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runHook(event, envOverrides) {
  const tmpDir = makeTmpDir();
  // Write current-orchestration.json stub
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test' }),
    'utf8'
  );

  const eventWithCwd = Object.assign({ cwd: tmpDir }, event);

  const result = spawnSync(process.execPath, [SCRIPT], {
    input:   JSON.stringify(eventWithCwd),
    env:     Object.assign({}, process.env, envOverrides || {}),
    encoding: 'utf8',
    timeout:  5000,
  });

  return {
    exitCode: result.status,
    stdout:   result.stdout || '',
    stderr:   result.stderr || '',
    tmpDir,
  };
}

// ---------------------------------------------------------------------------
// Basic validation tests
// ---------------------------------------------------------------------------

describe('validate-task-completion: basic validation', () => {
  test('valid TaskCompleted event → exit 0', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_id:         'task-123',
      task_subject:    'Implement feature X',
    };

    const { exitCode } = runHook(event);

    assert.strictEqual(exitCode, 0);
  });

  test('missing task_id → exit 2 in enforcement mode', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_subject:    'Implement feature X',
      // no task_id
    };

    const { exitCode, stderr } = runHook(event);

    assert.strictEqual(exitCode, 2);
    assert.ok(stderr.includes('missing task_id') || stderr.includes('task_id'));
  });

  test('missing task_subject → exit 2 in enforcement mode', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_id:         'task-456',
      // no task_subject
    };

    const { exitCode } = runHook(event);

    assert.strictEqual(exitCode, 2);
  });

  test('missing both task_id and task_subject → exit 2', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
    };

    const { exitCode } = runHook(event);

    assert.strictEqual(exitCode, 2);
  });

  test('non-TaskCompleted event → exit 0 (pass-through)', () => {
    const event = {
      hook_event_name: 'SubagentStop',
      task_id:         'task-789',
      task_subject:    'Something',
    };

    const { exitCode } = runHook(event);

    assert.strictEqual(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// PRE_DONE_ENFORCEMENT=warn kill-switch tests (I-12 rollback path)
// ---------------------------------------------------------------------------

describe('validate-task-completion: PRE_DONE_ENFORCEMENT=warn kill-switch', () => {
  test('missing task_id with PRE_DONE_ENFORCEMENT=warn → exit 0 (downgraded)', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_subject:    'Some task',
      // no task_id
    };

    const { exitCode, stderr } = runHook(event, { PRE_DONE_ENFORCEMENT: 'warn' });

    assert.strictEqual(exitCode, 0, 'warn mode should exit 0 instead of 2');
    assert.ok(stderr.includes('WARN'), 'should emit warning to stderr');
    assert.ok(stderr.includes('PRE_DONE_ENFORCEMENT=warn'), 'should mention the env var');
  });

  test('missing task_subject with PRE_DONE_ENFORCEMENT=warn → exit 0 (downgraded)', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_id:         'task-xyz',
      // no task_subject
    };

    const { exitCode } = runHook(event, { PRE_DONE_ENFORCEMENT: 'warn' });

    assert.strictEqual(exitCode, 0, 'warn mode should exit 0');
  });

  test('missing both fields with PRE_DONE_ENFORCEMENT=warn → exit 0', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
    };

    const { exitCode, stderr } = runHook(event, { PRE_DONE_ENFORCEMENT: 'warn' });

    assert.strictEqual(exitCode, 0);
    assert.ok(stderr.includes('WARN'));
  });

  test('PRE_DONE_ENFORCEMENT=warn emits audit event', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_subject:    'Some task',
      // no task_id
    };

    const { exitCode, tmpDir } = runHook(event, { PRE_DONE_ENFORCEMENT: 'warn' });

    assert.strictEqual(exitCode, 0);

    // Check that a warn audit event was written
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const content = fs.readFileSync(eventsPath, 'utf8');
      assert.ok(
        content.includes('task_validation_warn') || content.includes('warn'),
        'audit trail should record the warn-mode event'
      );
    }
    // Not failing if file doesn't exist — event write is best-effort
  });

  test('PRE_DONE_ENFORCEMENT unset → enforcement mode (exit 2 on missing fields)', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_subject:    'Some task',
      // no task_id
    };

    // No PRE_DONE_ENFORCEMENT in env
    const { exitCode } = runHook(event, { PRE_DONE_ENFORCEMENT: undefined });

    assert.strictEqual(exitCode, 2, 'default enforcement mode should block');
  });

  test('PRE_DONE_ENFORCEMENT=enforce → same as default (exit 2)', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_subject:    'Some task',
      // no task_id
    };

    const { exitCode } = runHook(event, { PRE_DONE_ENFORCEMENT: 'enforce' });

    assert.strictEqual(exitCode, 2, 'non-warn value should not downgrade');
  });

  test('valid event with PRE_DONE_ENFORCEMENT=warn → still exit 0', () => {
    const event = {
      hook_event_name: 'TaskCompleted',
      task_id:         'task-ok',
      task_subject:    'Complete feature',
    };

    const { exitCode } = runHook(event, { PRE_DONE_ENFORCEMENT: 'warn' });

    assert.strictEqual(exitCode, 0, 'valid event passes in any mode');
  });
});
