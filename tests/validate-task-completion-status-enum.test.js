#!/usr/bin/env node
'use strict';

/**
 * Regression test for E1: status enum validation in validate-task-completion.js.
 *
 * Verifies that the validator rejects any status value outside the enum
 * {"success","partial","failure"} declared in handoff-contract.md:27.
 *
 * The specific motivating case: status:"complete" slipped through T5/T7/T8
 * because the check was typeof+non-empty only, not enum-membership.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../bin/validate-task-completion.js');

function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

/**
 * Build a TaskCompleted hook payload with the structured result embedded as a
 * ## Structured Result ```json block in the `output` field (the extraction path
 * used by validate-task-completion.js:464-478).
 */
function makePayload(statusValue) {
  const structured = {
    status: statusValue,
    summary: 'test summary for enum validation',
    files_changed: [],
    files_read: [],
    issues: [],
    assumptions: [],
    // developer role-schema fields (bin/_lib/role-schemas.js:27-33).
    // Without these, validate-task-completion exits 2 on a developer payload
    // for ROLE-SCHEMA reasons — not status-enum reasons. Including them
    // ensures the test truly isolates the status-enum check.
    self_check_passed: true,
    tests_added_or_existing: 'no test changes — enum-validator regression fixture',
  };
  const output = [
    'Agent completed task.',
    '',
    '## Structured Result',
    '```json',
    JSON.stringify(structured, null, 2),
    '```',
  ].join('\n');

  return {
    hook: 'TaskCompleted',
    subagent_type: 'developer',
    task_id: 'T-test-enum-E1',
    task_subject: 'status enum regression test',
    cwd: os.tmpdir(),
    output,
  };
}

describe('E1 regression — status enum validation', () => {

  test('rejects status:"complete" — the malformed value that slipped through T5/T7/T8', () => {
    const { status, stderr } = run(makePayload('complete'));
    // The validator must not return exit 0 silently for "complete".
    // Any non-zero exit OR a stderr mention of "status" is acceptable evidence of rejection.
    const isRejected = status !== 0 || stderr.toLowerCase().includes('status');
    assert.ok(
      isRejected,
      `Expected status:"complete" to be rejected (non-zero exit or status error in stderr), ` +
      `got exit ${status}. stderr: ${stderr.slice(0, 300)}`
    );
  });

  // T11 N1 fix: assert exit 0 directly for valid enum values rather than
  // conditionally checking only when status===2. Without this, a broken
  // validator that exits 1 unconditionally would pass these acceptance tests.
  test('accepts status:"success" with exit code 0', () => {
    const { status, stderr } = run(makePayload('success'));
    assert.strictEqual(
      status, 0,
      `"success" should produce exit 0, got exit ${status}. stderr: ${stderr.slice(0, 300)}`
    );
  });

  test('accepts status:"partial" with exit code 0', () => {
    const { status, stderr } = run(makePayload('partial'));
    assert.strictEqual(
      status, 0,
      `"partial" should produce exit 0, got exit ${status}. stderr: ${stderr.slice(0, 300)}`
    );
  });

  test('accepts status:"failure" with exit code 0', () => {
    const { status, stderr } = run(makePayload('failure'));
    assert.strictEqual(
      status, 0,
      `"failure" should produce exit 0, got exit ${status}. stderr: ${stderr.slice(0, 300)}`
    );
  });

  test('rejects empty string status', () => {
    const { status, stderr } = run(makePayload(''));
    const isRejected = status !== 0 || stderr.toLowerCase().includes('status');
    assert.ok(isRejected, `Empty string status should be rejected, got exit ${status}`);
  });

  test('rejects status:"SUCCESS" (enum is case-sensitive)', () => {
    const { status, stderr } = run(makePayload('SUCCESS'));
    const isRejected = status !== 0 || stderr.toLowerCase().includes('status');
    assert.ok(isRejected, `Uppercase "SUCCESS" should be rejected, got exit ${status}`);
  });

});
