#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/reassign-idle-teammate.js
 *
 * TeammateIdle hook. Logs the event, then checks task-graph.md for pending
 * tasks. If found, exits 2 to block stopping. If none, exits 0.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/reassign-idle-teammate.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-idle-test-'));
}

function writeTaskGraph(tmpDir, content) {
  const stateDir = path.join(tmpDir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'task-graph.md'), content);
}

// ---------------------------------------------------------------------------
// Exit codes and blocking behavior
// ---------------------------------------------------------------------------

describe('blocking behavior when pending tasks exist', () => {

  test('exits 2 and blocks when task-graph.md has unchecked checkbox "- [ ]"', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '## Tasks\n- [x] Done task\n- [ ] Pending task\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir, session_id: 'sess-001' });
      const { status, stderr } = run(input);
      assert.equal(status, 2, 'should exit 2 to block idle teammate when pending tasks remain');
      assert.ok(stderr.length > 0, 'should write message to stderr explaining why blocked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 2 when task-graph.md contains "status: pending"', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '## Task 1\nstatus: pending\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 2, 'should exit 2 for status: pending');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 2 when task-graph.md contains "status: not started"', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '## Task 2\nstatus: not started\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 2, 'should exit 2 for status: not started');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 2 for "Status: Pending" (case insensitive)', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '## Task\nStatus: Pending\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 2, 'pending detection should be case-insensitive');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('stderr message contains the task-graph path when blocking', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '- [ ] one pending task\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status, stderr } = run(input);
      assert.equal(status, 2);
      assert.ok(stderr.includes('task-graph'), 'stderr should mention task-graph file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('stdout is { continue: false } when blocking', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '- [ ] pending work\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { stdout, status } = run(input);
      assert.equal(status, 2);
      const out = parseOutput(stdout);
      assert.equal(out.continue, false, 'should output { continue: false } when blocking');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

describe('allow behavior when no pending tasks', () => {

  test('exits 0 when all tasks are checked "- [x]"', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '## Tasks\n- [x] Task A\n- [x] Task B\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 0, 'should exit 0 when all tasks complete');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 when task-graph.md does not exist', () => {
    const tmpDir = makeTmpDir();
    // No task-graph.md

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 0, 'should exit 0 when task-graph.md is absent');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 when task-graph.md is empty', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 0, 'should exit 0 on empty task graph');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 when task-graph.md only has completed statuses', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '## Tasks\nstatus: complete\nstatus: done\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 0, 'should exit 0 when all statuses are non-pending');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('stdout is { continue: true } when not blocking', () => {
    const tmpDir = makeTmpDir();
    // No task-graph.md

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { stdout, status } = run(input);
      assert.equal(status, 0);
      const out = parseOutput(stdout);
      assert.equal(out.continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

describe('audit logging', () => {

  test('always writes teammate_idle event to events.jsonl regardless of outcome', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    // Scenario: pending tasks (will exit 2)
    writeTaskGraph(tmpDir, '- [ ] pending task\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir, session_id: 'sess-idle' });
      run(input); // exits 2, but should still write event

      const eventsPath = path.join(auditDir, 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), 'events.jsonl should exist even when blocking');
      const events = fs.readFileSync(eventsPath, 'utf8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'teammate_idle');
      assert.equal(events[0].mode, 'teams');
      assert.equal(events[0].session_id, 'sess-idle');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('teammate_idle event has timestamp and orchestration_id fields', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-idle-001' }));

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      run(input);

      const eventsPath = path.join(auditDir, 'events.jsonl');
      const events = fs.readFileSync(eventsPath, 'utf8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      const ev = events[0];
      assert.ok(ev.timestamp, 'event should have timestamp');
      assert.equal(ev.orchestration_id, 'orch-idle-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// stdin parsing safety
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DEF-3: task-graph.md size cap
// ---------------------------------------------------------------------------

describe('task-graph.md size cap (DEF-3)', () => {

  test('skips reassignment check and exits 0 when task-graph.md exceeds 1 MB', () => {
    const tmpDir = makeTmpDir();
    // Build a task-graph.md > 1 MB that ALSO contains pending-task markers.
    // Without the size cap, the hook would detect pending tasks and exit 2.
    // With the cap, the hook should skip the scan and exit 0.
    const pendingMarker = '- [ ] pending task line\n';
    // 1.1 MB worth of pending markers
    const body = pendingMarker.repeat(Math.ceil(1_200_000 / pendingMarker.length));
    writeTaskGraph(tmpDir, body);

    try {
      const taskGraphPath = path.join(tmpDir, '.orchestray', 'state', 'task-graph.md');
      assert.ok(fs.statSync(taskGraphPath).size > 1_048_576,
        'test setup: task-graph.md should exceed 1 MB');

      const input = JSON.stringify({ cwd: tmpDir });
      const { stdout, stderr, status } = run(input);

      assert.equal(status, 0,
        'should exit 0 (not 2) when task-graph.md exceeds the cap, even with pending markers');
      assert.equal(parseOutput(stdout).continue, true,
        'should emit { continue: true } when cap is hit');
      assert.ok(
        stderr.includes('task-graph.md exceeds 1 MB') ||
        stderr.toLowerCase().includes('exceeds 1 mb') ||
        stderr.toLowerCase().includes('skipping reassignment'),
        `stderr should warn about the cap: ${stderr}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('does NOT skip the check when task-graph.md is under 1 MB', () => {
    const tmpDir = makeTmpDir();
    writeTaskGraph(tmpDir, '- [ ] small pending task\n');

    try {
      const input = JSON.stringify({ cwd: tmpDir });
      const { status } = run(input);
      assert.equal(status, 2,
        'small task-graph should still be scanned and blocked when pending');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

describe('stdin parsing safety', () => {

  test('exits 0 on empty stdin (safe fallback)', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 on invalid JSON stdin (safe fallback)', () => {
    const { stdout, status } = run('{{not json}}');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 on missing cwd field (uses process.cwd())', () => {
    // No cwd → process.cwd() used; task-graph.md likely absent → exit 0
    const { stdout, status } = run(JSON.stringify({}));
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});
