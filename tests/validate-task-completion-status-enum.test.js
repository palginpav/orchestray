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

  test('accepts status:"success" without triggering a status block', () => {
    const { status, stderr } = run(makePayload('success'));
    // A "developer" agent on a hard tier is blocked (exit 2) if structured result is invalid.
    // If we get exit 2 it must NOT be because of the status field.
    if (status === 2) {
      assert.ok(
        !stderr.includes('"status"') && !stderr.toLowerCase().includes('missing: ["status"'),
        `"success" triggered a status block. stderr: ${stderr.slice(0, 300)}`
      );
    }
  });

  test('accepts status:"partial" without triggering a status block', () => {
    const { status, stderr } = run(makePayload('partial'));
    if (status === 2) {
      assert.ok(
        !stderr.includes('"status"') && !stderr.toLowerCase().includes('missing: ["status"'),
        `"partial" triggered a status block. stderr: ${stderr.slice(0, 300)}`
      );
    }
  });

  test('accepts status:"failure" without triggering a status block', () => {
    const { status, stderr } = run(makePayload('failure'));
    if (status === 2) {
      assert.ok(
        !stderr.includes('"status"') && !stderr.toLowerCase().includes('missing: ["status"'),
        `"failure" triggered a status block. stderr: ${stderr.slice(0, 300)}`
      );
    }
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
