#!/usr/bin/env node
'use strict';

/**
 * audit-log-test-isolation.test.js — D7 (v2.3.18 W0).
 *
 * The unit suite used to append into the LIVE project audit log: 184
 * `state_file_corrupt` rows carrying `/tmp/.../orchestray-*-test-*` paths, 46
 * `multiple_structured_result_blocks` stamped `session_id: v2217-ramp-test`,
 * 23 `task_validation_failed` rows with no session at all — all of them in
 * `/home/palgin/orchestray/.orchestray/audit/events.jsonl`. That contamination
 * misdirected a whole evidence-driven prioritisation pass.
 *
 * These tests are the regression fence: under the test harness, a write that
 * would land on this package's own events.jsonl goes to a sandbox log instead.
 *
 * Runner: node --test bin/_lib/__tests__/audit-log-test-isolation.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const auditEventWriter = require('../audit-event-writer.js');
const { writeEvent } = auditEventWriter;
const {
  resolveEventsPath,
  testRedirectFor,
  sandboxEventsPath,
  PACKAGE_ROOT,
} = auditEventWriter._testHooks;

const LIVE_EVENTS = path.join(PACKAGE_ROOT, '.orchestray', 'audit', 'events.jsonl');

/** Size of the live log, or -1 when it does not exist. */
function liveSize() {
  try { return fs.statSync(LIVE_EVENTS).size; } catch (_e) { return -1; }
}

describe('D7: test-context writes never reach the live project audit log', () => {
  test('the harness sets the gate env vars', () => {
    assert.equal(process.env.ORCHESTRAY_TEST, '1');
    assert.ok(process.env.ORCHESTRAY_TEST_EVENTS_PATH, 'setup.js must pin a sandbox log path');
  });

  test('resolveEventsPath redirects the live project log to the sandbox', () => {
    const resolved = resolveEventsPath(PACKAGE_ROOT);
    assert.notEqual(path.resolve(resolved), LIVE_EVENTS);
    assert.equal(resolved, sandboxEventsPath());
  });

  test('an explicit eventsPath override pointing at the live log is redirected too', () => {
    assert.equal(resolveEventsPath(PACKAGE_ROOT, LIVE_EVENTS), sandboxEventsPath());
  });

  test('a caller-supplied temp cwd is left alone — the correct pattern still works', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-d7-'));
    try {
      const resolved = resolveEventsPath(tmp);
      assert.equal(resolved, path.join(tmp, '.orchestray', 'audit', 'events.jsonl'));
      assert.equal(testRedirectFor(resolved), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an explicit temp eventsPath override is left alone', () => {
    const tmp = path.join(os.tmpdir(), 'orchestray-d7-explicit.jsonl');
    assert.equal(resolveEventsPath(PACKAGE_ROOT, tmp), tmp);
  });

  test('writeEvent with no cwd does NOT grow the live events.jsonl', () => {
    const before = liveSize();
    // This is exactly the shape that produced the 184 contaminated rows: no
    // cwd, so resolveSafeCwd falls back to process.cwd() == the repo root.
    for (let i = 0; i < 5; i++) {
      writeEvent({
        event_type: 'state_file_corrupt',
        type: 'state_file_corrupt',
        schema_version: 1,
        version: 1,
        timestamp: new Date().toISOString(),
        path: '/tmp/orchestray-audit-event-test-d7/state.json',
        reason: 'syntax_error',
      });
    }
    assert.equal(liveSize(), before, 'the live audit log must not grow during tests');
  });

  test('the redirected writes actually landed in the sandbox log', () => {
    const sandbox = sandboxEventsPath();
    assert.ok(fs.existsSync(sandbox), 'sandbox log should exist after the previous test');
    const lines = fs.readFileSync(sandbox, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
  });

  test('outside the test harness the live path is returned unchanged', () => {
    const savedTest = process.env.ORCHESTRAY_TEST;
    const savedNode = process.env.NODE_ENV;
    delete process.env.ORCHESTRAY_TEST;
    delete process.env.NODE_ENV;
    try {
      assert.equal(testRedirectFor(LIVE_EVENTS), null);
      assert.equal(path.resolve(resolveEventsPath(PACKAGE_ROOT)), LIVE_EVENTS);
    } finally {
      if (savedTest !== undefined) process.env.ORCHESTRAY_TEST = savedTest;
      if (savedNode !== undefined) process.env.NODE_ENV = savedNode;
    }
  });
});
