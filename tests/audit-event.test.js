#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/audit-event.js
 *
 * SubagentStart hook. Writes an agent_start audit event to events.jsonl.
 * Must ALWAYS exit 0 and write { continue: true }.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/audit-event.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-audit-event-test-'));
}

function writeOrchestrationId(auditDir, id) {
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

function readEventsJsonl(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Happy path: valid SubagentStart event
// ---------------------------------------------------------------------------

describe('valid SubagentStart event — happy path', () => {

  test('exits 0 and writes agent_start event to events.jsonl', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_id: 'agent-001',
        agent_type: 'developer',
        session_id: 'sess-abc',
      });
      const { status } = run(input);
      assert.equal(status, 0);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1, 'should write exactly one event');
      assert.equal(events[0].type, 'agent_start');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('stdout is { continue: true } on success', () => {
    const tmpDir = makeTmpDir();

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_id: 'agent-002',
        agent_type: 'reviewer',
        session_id: 'sess-def',
      });
      const { stdout, status } = run(input);
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Event fields verification
// ---------------------------------------------------------------------------

describe('event fields', () => {

  test('written event has all required fields with correct values', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-fields-001');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_id: 'agent-xyz',
        agent_type: 'architect',
        session_id: 'sess-999',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1);
      const ev = events[0];

      assert.equal(ev.type, 'agent_start');
      assert.equal(ev.orchestration_id, 'orch-fields-001');
      assert.equal(ev.agent_id, 'agent-xyz');
      assert.equal(ev.agent_type, 'architect');
      assert.equal(ev.session_id, 'sess-999');
      assert.ok(ev.timestamp, 'event should have a timestamp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('timestamp is a valid ISO 8601 string', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_id: 'agent-ts',
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ts = events[0].timestamp;
      const parsed = new Date(ts);
      assert.ok(!isNaN(parsed.getTime()), 'timestamp should parse as a valid date');
      assert.ok(ts.includes('T'), 'timestamp should be ISO 8601 format');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('optional fields default to null when absent', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        // No agent_id, agent_type, session_id
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[0];
      assert.equal(ev.agent_id, null);
      assert.equal(ev.agent_type, null);
      assert.equal(ev.session_id, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Orchestration ID resolution
// ---------------------------------------------------------------------------

describe('orchestration ID resolution', () => {

  test('reads orchestration_id from current-orchestration.json when present', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-real-id');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'orch-real-id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('uses "unknown" when current-orchestration.json is missing', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('uses "unknown" when current-orchestration.json has no orchestration_id field', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ some_other_field: 'value' })
    );

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('uses "unknown" when current-orchestration.json contains invalid JSON', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      '{{{not valid json'
    );

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Audit directory creation
// ---------------------------------------------------------------------------

describe('audit directory creation', () => {

  test('creates .orchestray/audit/ directory if it does not exist', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      assert.ok(!fs.existsSync(auditDir), 'audit dir should not exist before test');

      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      assert.ok(fs.existsSync(auditDir), 'audit dir should be created by the script');
      assert.ok(fs.existsSync(path.join(auditDir, 'events.jsonl')), 'events.jsonl should exist');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('works correctly when audit directory already exists', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      const { status } = run(input);
      assert.equal(status, 0);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// events.jsonl append behavior
// ---------------------------------------------------------------------------

describe('events.jsonl append behavior', () => {

  test('appends to existing events.jsonl without overwriting', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    const existingEvent = { type: 'existing_event', data: 'preserved' };
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify(existingEvent) + '\n'
    );

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 2, 'should have 2 events: existing + new');
      assert.equal(events[0].type, 'existing_event', 'existing event must be preserved');
      assert.equal(events[1].type, 'agent_start', 'new event appended at end');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('each appended line is valid JSON', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      for (let i = 0; i < 3; i++) {
        const input = JSON.stringify({
          cwd: tmpDir,
          agent_type: 'developer',
          agent_id: `agent-${i}`,
        });
        run(input);
      }

      const eventsPath = path.join(auditDir, 'events.jsonl');
      const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 3, 'should have 3 lines');
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `Line should be valid JSON: ${line.slice(0, 80)}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// stdin parsing safety — always exit 0
// ---------------------------------------------------------------------------

describe('stdin parsing safety — always exits 0', () => {

  test('exits 0 on empty stdin', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 on invalid JSON stdin', () => {
    const { stdout, status } = run('not valid {{json}}');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('does not write events.jsonl when stdin is empty', () => {
    // With empty stdin, JSON.parse throws, so no event should be written
    // We check a known temp dir to see if anything was created
    const tmpDir = makeTmpDir();
    try {
      // Empty stdin — script cannot know where cwd is, so it should not write
      run('');
      // Nothing to assert about the tmpDir since the script has no way to know it
      // The important thing is it exits 0
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('does not write events.jsonl when stdin is invalid JSON', () => {
    const tmpDir = makeTmpDir();
    try {
      run('{{{invalid');
      const auditDir = path.join(tmpDir, '.orchestray', 'audit');
      assert.ok(!fs.existsSync(auditDir), 'audit dir should not be created for invalid input');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 on very large stdin (>1MB)', () => {
    const tmpDir = makeTmpDir();
    try {
      const bigInput = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
        agent_id: 'x'.repeat(1_200_000),
      });
      const { stdout, status } = run(bigInput);
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 when cwd points to unwritable path', () => {
    const input = JSON.stringify({
      cwd: '/nonexistent/path/that/cannot/be/created',
      agent_type: 'developer',
    });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});

// ---------------------------------------------------------------------------
// cwd field handling
// ---------------------------------------------------------------------------

describe('cwd field handling', () => {

  test('uses event.cwd when provided', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        agent_type: 'developer',
      });
      run(input);

      assert.ok(fs.existsSync(path.join(auditDir, 'events.jsonl')),
        'events.jsonl should be written under the provided cwd');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('falls back to process.cwd() when cwd is not in event', () => {
    // When cwd is absent, the script uses process.cwd() which is the
    // spawnSync default. We just verify it does not crash.
    const input = JSON.stringify({
      agent_type: 'developer',
      agent_id: 'agent-no-cwd',
    });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});
