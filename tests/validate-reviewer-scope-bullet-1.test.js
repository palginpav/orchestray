#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.21 T7 W-CQ-6 — validate-reviewer-scope.js BULLET_PATH_THRESHOLD = 1.
 *
 * Prior threshold was 3; single-file and two-file scoped reviews were false-rejected.
 * Regression tests:
 * 1. Single-bullet `files:` list passes.
 * 2. Two-bullet list passes.
 * 3. Three-bullet list continues to pass (was already accepted).
 * 4. Zero bullets with no file marker still blocks (regression guard).
 * 5. `scope:` section continues to work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/validate-reviewer-scope.js');

function run(stdinData, env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env || {}),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function makePayload(promptBody, cwd) {
  return JSON.stringify({
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'reviewer',
      prompt: promptBody,
    },
    cwd: cwd || os.tmpdir(),
  });
}

// ---------------------------------------------------------------------------
// Single-bullet files: list passes (was false-rejected with threshold=3)
// ---------------------------------------------------------------------------

test('single-bullet files: list passes the scope validator', () => {
  const prompt = `files:
- bin/validate-reviewer-git-diff.js

## Dimensions to Apply
- correctness

## Git Diff
diff --git a/bin/validate-reviewer-git-diff.js
`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'single-file review should exit 0');
  assert.equal(output.continue, true, 'should continue: true');
});

// ---------------------------------------------------------------------------
// Two-bullet list passes
// ---------------------------------------------------------------------------

test('two-bullet path list passes the scope validator', () => {
  const prompt = `## Files to Review
- bin/validate-reviewer-git-diff.js
- tests/validate-reviewer-audit-mode.test.js
`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'two-file review should exit 0');
  assert.equal(output.continue, true);
});

// ---------------------------------------------------------------------------
// Three-bullet list continues to pass (regression guard)
// ---------------------------------------------------------------------------

test('three-bullet path list continues to pass (was already accepted)', () => {
  const prompt = `## Files to Review
- bin/validate-reviewer-git-diff.js
- bin/validate-reviewer-scope.js
- bin/validate-task-completion.js
`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'three-file review should exit 0');
  assert.equal(output.continue, true);
});

// ---------------------------------------------------------------------------
// Zero bullets + no file marker still blocks (regression guard)
// ---------------------------------------------------------------------------

test('prompt with no file markers and no bullets is still blocked', () => {
  const prompt = `## Dimensions to Apply
- correctness

## Git Diff
diff --git a/foo.js
+some change

Please review the overall approach.
`;
  const { status } = run(makePayload(prompt));
  assert.equal(status, 2, 'unbounded scope should still exit 2');
});

// ---------------------------------------------------------------------------
// scope: section continues to work
// ---------------------------------------------------------------------------

test('scope: section is still accepted', () => {
  const prompt = `scope: bin/validate-reviewer-git-diff.js
`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'scope: marker should exit 0');
  assert.equal(output.continue, true);
});

// ---------------------------------------------------------------------------
// files: header followed by backtick-wrapped single path passes
// ---------------------------------------------------------------------------

test('files: header with single backtick-wrapped path passes', () => {
  const prompt = `files:
- \`bin/validate-reviewer-git-diff.js\`
`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'backtick-wrapped single path should exit 0');
  assert.equal(output.continue, true);
});

// ---------------------------------------------------------------------------
// evaluateScope unit-level: threshold = 1 is exported constant check
// ---------------------------------------------------------------------------

test('evaluateScope returns scoped=true for a single bullet path', () => {
  const { evaluateScope } = require('../bin/validate-reviewer-scope');
  const prompt = `- src/foo.ts\n`;
  const result = evaluateScope(prompt);
  assert.equal(result.scoped, true, 'single bullet path is scoped');
  assert.ok(result.evidence.includes('bullet'), 'evidence mentions bullet');
});
