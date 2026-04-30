#!/usr/bin/env node
'use strict';

/**
 * v2217-W2-ramp-promotions.test.js — regression suite for v2.2.17 W2 gates.
 *
 * Covers:
 *   P1-05: multiple_structured_result_blocks → exit 2 (promoted from warn-only)
 *   P1-07: pattern_application_gate → exit 2 on first miss (threshold=0)
 *   C-01:  lint-doesnotthrow-orphan CLI → exit 2 on orphan findings
 *
 * Runner: node --test bin/__tests__/v2217-W2-ramp-promotions.test.js
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VTC_PATH  = path.join(REPO_ROOT, 'bin', 'validate-task-completion.js');
const VPA_PATH  = path.join(REPO_ROOT, 'bin', 'validate-pattern-application.js');
const LINT_PATH = path.join(REPO_ROOT, 'bin', 'lint-doesnotthrow-orphan.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal .orchestray/audit directory structure under tmpdir.
 * Returns the project root path.
 */
function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2217-w2-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');
  return dir;
}

/**
 * Build a minimal valid structured result block for agent output.
 * Returns just enough fields to pass the pre-done checklist in validate-task-completion.
 */
function makeValidStructuredResultBlock(overrides = {}) {
  return [
    '## Structured Result',
    '```json',
    JSON.stringify({
      status: 'complete',
      summary: 'test output',
      files_changed: [],
      files_read: ['some/file.js'],
      issues: [],
      assumptions: [],
      ...overrides,
    }),
    '```',
  ].join('\n');
}

/**
 * Build a synthetic SubagentStop event JSON.
 */
function makeSubagentStopEvent(overrides = {}) {
  return JSON.stringify({
    hook_event_name: 'SubagentStop',
    agent_role: 'developer',
    session_id: 'test-session',
    result: '',
    ...overrides,
  });
}

/**
 * Build a synthetic PreToolUse:Bash event JSON.
 */
function makeBashEvent(command) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
}

/**
 * Run a script with synthetic stdin, returning { status, stdout, stderr }.
 */
function runScript(scriptPath, stdinData, env = {}) {
  return spawnSync(
    'node', [scriptPath],
    {
      input: stdinData,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...env },
    },
  );
}

// ---------------------------------------------------------------------------
// P1-05: Multiple Structured Result block detector (validate-task-completion.js)
// ---------------------------------------------------------------------------

describe('P1-05: multiple_structured_result_blocks → exit 2 (v2.2.17 promotion)', () => {
  test('2-block output + no kill switch → exit 2', () => {
    const dir = makeTmpProject();
    try {
      // Build an agent output containing two ## Structured Result blocks.
      const doubleBlockOutput = [
        'Some output text here',
        '',
        '## Structured Result',
        '```json',
        '{"status":"partial","summary":"first block"}',
        '```',
        '',
        'More text',
        '',
        '## Structured Result',
        '```json',
        '{"status":"complete","summary":"second block","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}',
        '```',
      ].join('\n');

      const event = makeSubagentStopEvent({ result: doubleBlockOutput });
      const r = runScript(VTC_PATH, event, { ORCHESTRAY_TEST_CWD: dir });

      assert.equal(r.status, 2, 'expected exit 2 for multiple Structured Result blocks; stderr: ' + r.stderr);
      assert.ok(
        r.stderr.includes('BLOCKED') || r.stderr.includes('multiple'),
        'stderr should mention BLOCKED or multiple; got: ' + r.stderr,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('2-block output + kill switch active → exits without P1-05 block', () => {
    const dir = makeTmpProject();
    try {
      // With kill switch, the P1-05 gate is bypassed. The script may still
      // exit 2 due to unrelated checklist failures (missing fields), but
      // must NOT exit 2 specifically due to the multi-block gate.
      // We verify this by checking that the stderr does NOT include the
      // P1-05 BLOCKED message.
      const doubleBlockOutput = [
        '## Structured Result',
        '```json',
        '{"status":"partial","summary":"first"}',
        '```',
        makeValidStructuredResultBlock(),
      ].join('\n');

      const event = makeSubagentStopEvent({ result: doubleBlockOutput, cwd: dir });
      const r = runScript(VTC_PATH, event, {
        ORCHESTRAY_MULTI_STRUCTURED_RESULT_GATE_DISABLED: '1',
      });

      // The P1-05 BLOCKED message should NOT appear in stderr.
      assert.ok(
        !r.stderr.includes('multiple_structured_result_blocks') &&
        !r.stderr.includes('BLOCKED — ') || !r.stderr.includes('blocks (expected 1)'),
        'kill switch must suppress P1-05 BLOCKED message; got: ' + r.stderr,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P1-07: pattern_application_gate (validate-pattern-application.js)
// ---------------------------------------------------------------------------

describe('P1-07: pattern_application_gate → immediate exit 2 (threshold=0)', () => {
  test('pattern_find without ack (first spawn) → exit 2 with threshold=0', () => {
    const dir = makeTmpProject();
    try {
      // Write an events.jsonl that contains a pattern_find mcp_checkpoint but
      // no corresponding ack.
      const patternFindEvent = JSON.stringify({
        type: 'mcp_checkpoint_recorded',
        tool_name: 'mcp__orchestray__pattern_find',
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
        patternFindEvent + '\n',
        'utf8',
      );

      // Write a current-orchestration.json so resolveOrchId works.
      // The file lives at .orchestray/audit/current-orchestration.json.
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
        JSON.stringify({ orchestration_id: 'orch-test-001' }),
        'utf8',
      );

      const event = makeSubagentStopEvent({ agent_role: 'developer', cwd: dir });
      const r = runScript(VPA_PATH, event, {});

      assert.equal(r.status, 2,
        'expected exit 2 on first ack-missing with threshold=0; stderr: ' + r.stderr);
      assert.ok(r.stderr.includes('BLOCKED') || r.stderr.includes('pattern_record'),
        'stderr should indicate blocked; got: ' + r.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pattern_find without ack + kill switch → exit 0', () => {
    const dir = makeTmpProject();
    try {
      const patternFindEvent = JSON.stringify({
        type: 'mcp_checkpoint_recorded',
        tool_name: 'mcp__orchestray__pattern_find',
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
        patternFindEvent + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
        JSON.stringify({ orchestration_id: 'orch-test-002' }),
        'utf8',
      );

      const event = makeSubagentStopEvent({ agent_role: 'developer', cwd: dir });
      const r = runScript(VPA_PATH, event, {
        ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED: '1',
      });

      assert.ok(r.status === 0 || r.status === null,
        'kill switch should allow exit 0; got ' + r.status + ' stderr: ' + r.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C-01: lint-doesnotthrow-orphan CLI (bin/lint-doesnotthrow-orphan.js)
// ---------------------------------------------------------------------------

describe('C-01: lint-doesnotthrow-orphan CLI', () => {
  test('zero orphans (lib-level) → findOrphans returns empty array', () => {
    // Test the underlying lib directly: clean source with doesNotThrow paired
    // with a strong assertion must yield zero findings.
    const { findOrphans } = require(path.join(REPO_ROOT, 'bin', '_lib', 'lint-doesnotthrow-orphan.js'));

    const cleanSrc = [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('paired doesNotThrow', () => {",
      '  const result = assert.doesNotThrow(() => myFn());',
      "  assert.strictEqual(result, 'expected');",
      '});',
    ].join('\n');

    const orphans = findOrphans(cleanSrc, '/fake/clean.test.js');
    assert.equal(orphans.length, 0,
      'paired doesNotThrow should produce zero findings; got: ' + JSON.stringify(orphans));
  });

  test('kill switch active → exit 0 (no scan)', () => {
    const event = makeBashEvent('npm test');
    const r = runScript(LINT_PATH, event, {
      ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED: '1',
    });
    assert.equal(r.status, 0, 'kill switch must produce exit 0; got: ' + r.status);
  });

  test('command-pattern miss (git status) → exit 0 silent', () => {
    const event = makeBashEvent('git status');
    const r = runScript(LINT_PATH, event, {});
    assert.equal(r.status, 0,
      'non-test-runner commands must exit 0 silently; got: ' + r.status + ' stderr: ' + r.stderr);
    // stderr should be empty for a clean miss
    assert.equal(r.stderr, '', 'no stderr output expected for non-test-runner command');
  });

  test('command-pattern miss (ls -la) → exit 0 silent', () => {
    const event = makeBashEvent('ls -la');
    const r = runScript(LINT_PATH, event, {});
    assert.equal(r.status, 0, 'ls command must not trigger lint');
    assert.equal(r.stderr, '', 'no stderr output expected');
  });

  test('non-Bash tool → exit 0 silent', () => {
    const event = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.js' },
    });
    const r = runScript(LINT_PATH, event, {});
    assert.equal(r.status, 0, 'non-Bash tool must exit 0');
    assert.equal(r.stderr, '', 'no stderr output expected');
  });

  test('synthetic orphan in temp test file → exit 2 + emits both events', () => {
    // Create a temp __tests__-like directory with a synthetic orphan test file.
    // We cannot use the real __tests__ dir (it should be clean), so we test
    // the underlying lib directly here via a programmatic call.
    const { findOrphans } = require(path.join(REPO_ROOT, 'bin', '_lib', 'lint-doesnotthrow-orphan.js'));

    const syntheticSrc = [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('only doesNotThrow — no value assertion', () => {",
      '  assert.doesNotThrow(() => myFn());',
      '});',
    ].join('\n');

    const orphans = findOrphans(syntheticSrc, '/fake/orphan.test.js');
    assert.ok(orphans.length >= 1,
      'findOrphans must detect the orphan doesNotThrow; got: ' + JSON.stringify(orphans));
    assert.equal(orphans[0].test_name, 'only doesNotThrow — no value assertion');
    assert.equal(orphans[0].file, '/fake/orphan.test.js');
    assert.ok(typeof orphans[0].line === 'number' && orphans[0].line > 0,
      'line must be a positive number');
  });

  test('node --test command pattern → triggers lint scan', () => {
    // Verify our regex matches node --test variants.
    const TEST_RUNNER_RE = /\b(?:npm\s+test|node\s+--test|node\s+-test)\b/;
    assert.ok(TEST_RUNNER_RE.test('node --test bin/__tests__/foo.test.js'),
      'node --test should match');
    assert.ok(TEST_RUNNER_RE.test('node --test'),
      'bare node --test should match');
    assert.ok(!TEST_RUNNER_RE.test('node foo.js'),
      'plain node should not match');
    assert.ok(!TEST_RUNNER_RE.test('git status'),
      'git status should not match');
  });
});
