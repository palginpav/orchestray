#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-task-completion.js
 *
 * TaskCompleted hook. Blocks (exit 2) if task_id or task_subject is missing.
 * Otherwise writes an audit event and exits 0.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/validate-task-completion.js');

function run(stdinData) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function parseOutput(stdout) {
  return JSON.parse(stdout.trim());
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-validate-test-'));
}

function readEventsJsonl(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Validation gate: blocking on missing required fields
// ---------------------------------------------------------------------------

describe('validation gate — blocking on missing fields', () => {

  test('exits 2 and blocks when task_id is missing', () => {
    const input = JSON.stringify({
      task_subject: 'Implement auth',
      cwd: os.tmpdir(),
    });
    const { status, stderr } = run(input);
    assert.equal(status, 2, 'should exit 2 when task_id is absent');
    assert.ok(stderr.includes('task_id'), 'stderr should mention the missing field');
  });

  test('exits 2 and blocks when task_subject is missing', () => {
    const input = JSON.stringify({
      task_id: 'task-001',
      cwd: os.tmpdir(),
    });
    const { status, stderr } = run(input);
    assert.equal(status, 2, 'should exit 2 when task_subject is absent');
    assert.ok(stderr.includes('task_subject'), 'stderr should mention the missing field');
  });

  test('exits 2 and blocks when both task_id and task_subject are missing', () => {
    const input = JSON.stringify({ cwd: os.tmpdir() });
    const { status, stderr } = run(input);
    assert.equal(status, 2, 'should exit 2 when both fields are absent');
    assert.ok(stderr.length > 0, 'should write error to stderr');
  });

  test('exits 2 when task_id is empty string', () => {
    const input = JSON.stringify({
      task_id: '',
      task_subject: 'Implement auth',
      cwd: os.tmpdir(),
    });
    const { status } = run(input);
    assert.equal(status, 2, 'empty string task_id should be treated as missing (falsy)');
  });

  test('exits 2 when task_subject is empty string', () => {
    const input = JSON.stringify({
      task_id: 'task-001',
      task_subject: '',
      cwd: os.tmpdir(),
    });
    const { status } = run(input);
    assert.equal(status, 2, 'empty string task_subject should be treated as missing (falsy)');
  });

  test('exits 2 when task_id is null', () => {
    const input = JSON.stringify({
      task_id: null,
      task_subject: 'Implement auth',
      cwd: os.tmpdir(),
    });
    const { status } = run(input);
    assert.equal(status, 2, 'null task_id should be treated as missing (falsy)');
  });

  test('writes a task_validation_failed audit event (but no task_completed) when validation fails', () => {
    // FIX-2: rejection must leave a debug trail in events.jsonl before exit(2).
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({ cwd: tmpDir }); // missing both fields
      run(input);
      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1, 'exactly one rejection event should be logged');
      const ev = events[0];
      assert.equal(ev.type, 'task_validation_failed');
      assert.ok(ev.reason.includes('task_id') || ev.reason.includes('task_subject'),
        'reason should identify which field is missing');
      assert.ok(Array.isArray(ev.payload_keys), 'payload_keys must be an array');
      // No task_completed event — only the rejection.
      assert.ok(!events.some(e => e.type === 'task_completed'),
        'no task_completed event should exist on rejection path');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('rejection event logs only top-level key NAMES, not values', () => {
    // Team task payloads may contain sensitive task content; values must never
    // be persisted in the audit trail.
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const sensitive = 'SECRET_API_KEY=sk-abc123-do-not-leak';
      const input = JSON.stringify({
        cwd: tmpDir,
        // Missing task_id → rejection path
        task_subject: '', // empty → falsy → rejection
        confidential_field: sensitive,
        another_secret: sensitive,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1);
      const raw = fs.readFileSync(path.join(auditDir, 'events.jsonl'), 'utf8');
      assert.ok(!raw.includes(sensitive),
        'rejection audit event must NOT contain payload values');
      assert.ok(raw.includes('confidential_field'),
        'rejection audit event should contain the top-level key name');
      assert.ok(raw.includes('another_secret'),
        'rejection audit event should contain the top-level key name');
      // payload_keys content is a list of strings
      assert.ok(events[0].payload_keys.includes('confidential_field'));
      assert.ok(events[0].payload_keys.includes('another_secret'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('rejection event uses orchestration_id from current-orchestration.json', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-reject-001' })
    );

    try {
      run(JSON.stringify({ cwd: tmpDir }));
      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'orch-reject-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('stderr contains "rejected" when validation fails', () => {
    const input = JSON.stringify({ task_id: 'x' }); // missing task_subject
    const { stderr } = run(input);
    assert.ok(stderr.toLowerCase().includes('rejected') || stderr.toLowerCase().includes('missing'),
      'stderr should describe why task completion was rejected');
  });

});

// ---------------------------------------------------------------------------
// hook_event_name sanity check (FIX-2)
// ---------------------------------------------------------------------------

describe('non-TaskCompleted events pass through without validation', () => {

  test('event with hook_event_name != "TaskCompleted" skips validation and exits 0', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    try {
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: tmpDir,
        // Intentionally missing task_id/task_subject — but the hook_event_name
        // guard must fire first.
      });
      const { stdout, status } = run(input);
      assert.equal(status, 0, 'non-TaskCompleted event must exit 0');
      assert.equal(parseOutput(stdout).continue, true);
      // No rejection event should be appended — validation was skipped.
      assert.ok(!fs.existsSync(path.join(auditDir, 'events.jsonl')),
        'no rejection event should be logged for non-TaskCompleted events');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('event with hook_event_name === "TaskCompleted" still validates', () => {
    const tmpDir = makeTmpDir();
    try {
      const input = JSON.stringify({
        hook_event_name: 'TaskCompleted',
        cwd: tmpDir,
        // Missing task_id/task_subject → should still exit 2
      });
      const { status } = run(input);
      assert.equal(status, 2, 'TaskCompleted with missing fields must still block');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Happy path: valid event
// ---------------------------------------------------------------------------

describe('valid task completion', () => {

  test('exits 0 when both task_id and task_subject are present', () => {
    const tmpDir = makeTmpDir();
    try {
      const input = JSON.stringify({
        task_id: 'task-001',
        task_subject: 'Implement authentication',
        cwd: tmpDir,
      });
      const { status } = run(input);
      assert.equal(status, 0, 'should exit 0 for valid task completion');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('stdout is { continue: true } on success', () => {
    const tmpDir = makeTmpDir();
    try {
      const input = JSON.stringify({
        task_id: 'task-001',
        task_subject: 'Write tests',
        cwd: tmpDir,
      });
      const { stdout, status } = run(input);
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('writes task_completed audit event on success', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        task_id: 'task-abc',
        task_subject: 'Refactor data layer',
        task_description: 'Move DB logic to service layer',
        teammate_name: 'developer',
        team_name: 'alpha',
        session_id: 'sess-xyz',
        cwd: tmpDir,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.equal(ev.type, 'task_completed');
      assert.equal(ev.mode, 'teams');
      assert.equal(ev.task_id, 'task-abc');
      assert.equal(ev.task_subject, 'Refactor data layer');
      assert.equal(ev.task_description, 'Move DB logic to service layer');
      assert.equal(ev.teammate_name, 'developer');
      assert.equal(ev.team_name, 'alpha');
      assert.equal(ev.session_id, 'sess-xyz');
      assert.ok(ev.timestamp, 'event should have timestamp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('uses "unknown" orchestration_id when current-orchestration.json is missing', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        task_id: 'task-001',
        task_subject: 'Build feature',
        cwd: tmpDir,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('reads orchestration_id from current-orchestration.json when present', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-task-001' })
    );

    try {
      const input = JSON.stringify({
        task_id: 'task-001',
        task_subject: 'Deploy service',
        cwd: tmpDir,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'orch-task-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('optional fields default to null when absent', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        task_id: 'task-minimal',
        task_subject: 'Minimal task',
        cwd: tmpDir,
        // No task_description, teammate_name, team_name, session_id
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[0];
      assert.equal(ev.task_description, null);
      assert.equal(ev.teammate_name, null);
      assert.equal(ev.team_name, null);
      assert.equal(ev.session_id, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// stdin parsing safety
// ---------------------------------------------------------------------------

describe('stdin parsing safety', () => {

  test('exits 0 on empty stdin (safe fallback — does not crash)', () => {
    // With empty stdin, JSON.parse('') throws → caught → exits 0
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 on invalid JSON stdin (safe fallback)', () => {
    const { stdout, status } = run('not valid {{json}}');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 on very large stdin (>1MB)', () => {
    const bigInput = JSON.stringify({
      task_id: 'task-large',
      task_subject: 'x'.repeat(1_200_000),
      cwd: os.tmpdir(),
    });
    const { stdout, status } = run(bigInput);
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});

// ---------------------------------------------------------------------------
// Concurrent-write note: two hooks fire for TaskCompleted
// ---------------------------------------------------------------------------
// NOTE: According to hooks.json, TaskCompleted fires BOTH validate-task-completion.js
// AND collect-agent-metrics.js. Both append to events.jsonl. Since fs.appendFileSync
// is not atomic at the OS level for concurrent writes, two simultaneous completions
// could interleave bytes. This is a known limitation documented as an issue.
