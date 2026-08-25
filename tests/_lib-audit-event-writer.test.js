#!/usr/bin/env node
'use strict';

/**
 * Smoke test for bin/_lib/audit-event-writer.js
 *
 * The shared helper is exercised end-to-end by both audit-event.test.js and
 * audit-team-event.test.js, so this file only verifies the direct API: when
 * invoked with a fake payload piped through a tiny harness, it writes a
 * well-formed JSON line to .orchestray/audit/events.jsonl.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HELPER = path.resolve(__dirname, '../bin/_lib/audit-event-writer.js');

// Tiny inline harness: load the helper and call it with known options.
const HARNESS_SRC = `
const writeAuditEvent = require(${JSON.stringify(HELPER)});
writeAuditEvent({
  type: 'smoke_event',
  mode: 'test',
  extraFieldsPicker: (p) => ({
    agent_id: p.agent_id || null,
    extra: 'literal-value',
  }),
});
`;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-writer-smoke-'));
}

function runHarness(stdinData) {
  const result = spawnSync(process.execPath, ['-e', HARNESS_SRC], {
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

describe('audit-event-writer smoke test', () => {

  test('appends a valid JSON line with expected fields', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    try {
      const payload = JSON.stringify({
        cwd: tmpDir,
        agent_id: 'agent-smoke',
      });
      const { stdout, status } = runHarness(payload);
      assert.equal(status, 0, 'helper should exit 0');
      assert.equal(JSON.parse(stdout.trim()).continue, true, 'stdout is { continue: true }');

      const jsonl = path.join(auditDir, 'events.jsonl');
      assert.ok(fs.existsSync(jsonl), 'events.jsonl should exist');

      const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(l => l && !l.includes('"audit_event_autofilled"') && !l.includes('"schema_unknown_type_warn"')); /* v2.2.15: filter P1-13; v2.3.33 W1: filter schema_unknown_type_warn — validation now actually runs for this tmpDir (falls back to code-relative schema), so unregistered test event types get an advisory row */
      assert.equal(lines.length, 1, 'exactly one line should be appended (excluding P1-13 autofill telemetry)');

      const event = JSON.parse(lines[0]);
      assert.equal(event.type, 'smoke_event');
      assert.equal(event.mode, 'test');
      assert.equal(event.agent_id, 'agent-smoke');
      assert.equal(event.extra, 'literal-value');
      assert.ok(event.timestamp, 'timestamp should be present');
      assert.equal(event.orchestration_id, 'unknown', 'default orchestration_id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('mode field is omitted when not supplied', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');

    const NO_MODE_HARNESS = `
      const writeAuditEvent = require(${JSON.stringify(HELPER)});
      writeAuditEvent({
        type: 'no_mode_event',
        extraFieldsPicker: (p) => ({ agent_id: p.agent_id || null }),
      });
    `;

    try {
      const payload = JSON.stringify({ cwd: tmpDir, agent_id: 'a' });
      const result = spawnSync(process.execPath, ['-e', NO_MODE_HARNESS], {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0);

      const lines = fs.readFileSync(path.join(auditDir, 'events.jsonl'), 'utf8')
        .split('\n').filter(l => l && !l.includes('"audit_event_autofilled"') && !l.includes('"schema_unknown_type_warn"')); /* v2.2.15: filter P1-13; v2.3.33 W1: filter schema_unknown_type_warn — validation now actually runs for this tmpDir (falls back to code-relative schema), so unregistered test event types get an advisory row */
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assert.equal(event.type, 'no_mode_event');
      assert.equal(event.mode, undefined, 'mode should be absent');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('resolves orchestration_id from current-orchestration.json', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-smoke-123' })
    );

    try {
      const payload = JSON.stringify({ cwd: tmpDir, agent_id: 'a' });
      const { status } = runHarness(payload);
      assert.equal(status, 0);

      const lines = fs.readFileSync(path.join(auditDir, 'events.jsonl'), 'utf8')
        .split('\n').filter(l => l && !l.includes('"audit_event_autofilled"') && !l.includes('"schema_unknown_type_warn"')); /* v2.2.15: filter P1-13; v2.3.33 W1: filter schema_unknown_type_warn — validation now actually runs for this tmpDir (falls back to code-relative schema), so unregistered test event types get an advisory row */
      const event = JSON.parse(lines[0]);
      assert.equal(event.orchestration_id, 'orch-smoke-123');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 and swallows errors on invalid stdin', () => {
    const { stdout, status } = runHarness('not json at all');
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout.trim()).continue, true);
  });

  // v2.3.20 event-registry reconciliation. This suite's own `smoke_event` /
  // `no_mode_event` rows are the exact shape that produced 6 rows each of
  // pollution per archived pre-D7 events.jsonl snapshot in
  // `.orchestray/history/*` (48 total across 8 archives — frozen there
  // permanently; D7, v2.3.18 W0, already prevents new pollution). This test
  // pins that the live PACKAGE_ROOT audit log specifically does not grow
  // when THIS file's harness runs, tying the generic D7 guard
  // (`bin/_lib/__tests__/audit-log-test-isolation.test.js`) to the concrete
  // smoke_event/no_mode_event emit path used above.
  test('smoke_event / no_mode_event harness writes never reach the live project audit log', () => {
    const { PACKAGE_ROOT } = require(HELPER)._testHooks;
    const liveEvents = path.join(PACKAGE_ROOT, '.orchestray', 'audit', 'events.jsonl');
    const before = fs.existsSync(liveEvents) ? fs.statSync(liveEvents).size : -1;

    const tmpDir = makeTmpDir();
    try {
      const payload = JSON.stringify({ cwd: tmpDir, agent_id: 'agent-smoke-d7' });
      const { status } = runHarness(payload);
      assert.equal(status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }

    const after = fs.existsSync(liveEvents) ? fs.statSync(liveEvents).size : -1;
    assert.equal(after, before, 'the live project audit log must not grow from a smoke_event harness run');
  });

});
