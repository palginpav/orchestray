#!/usr/bin/env node
'use strict';

/**
 * v2219-inject-review-dimensions.test.js — RETIRED-HOOK regression tests
 * (v2.3.31 W8B).
 *
 * bin/inject-review-dimensions.js was superseded: it emitted `updatedInput`
 * as a sibling PreToolUse:Agent hook alongside validate-reviewer-dimensions.js,
 * but sibling `updatedInput` does not propagate (Claude Code platform
 * constraint — see validate-context-size-hint.js header comment for the same
 * defect class). The validator never observed the injection and blocked
 * every reviewer spawn lacking a hand-written block regardless.
 *
 * The classifier/injection behaviour this file used to test (backend
 * archetype, security-sensitive archetype, doc-only fallback, idempotency,
 * kill switches) now lives in bin/validate-reviewer-dimensions.js — see
 * tests/validate-reviewer-dimensions-autofill.test.js for the equivalent
 * coverage against the live implementation.
 *
 * This file now only asserts the retirement contract: the hook is an
 * unconditional no-op (`{ continue: true }`, exit 0) regardless of input,
 * and is no longer wired into hooks/hooks.json.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'inject-review-dimensions.js');
const NODE       = process.execPath;

function runHook(payload) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    parsedStdout: (() => {
      try { return r.stdout ? JSON.parse(r.stdout) : null; } catch (_e) { return null; }
    })(),
  };
}

describe('retired hook — unconditional no-op', () => {
  test('reviewer spawn without dimensions block → exit 0, continue only, no mutation', () => {
    const r = runHook({
      tool_name: 'Agent',
      cwd: REPO_ROOT,
      tool_input: { subagent_type: 'reviewer', prompt: '## Task\nReview the changes.\n' },
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);
    assert.deepEqual(r.parsedStdout, { continue: true }, 'no-op output is exactly {continue:true}');
  });

  test('non-Agent tool → still a no-op', () => {
    const r = runHook({ tool_name: 'Bash', cwd: REPO_ROOT, tool_input: {} });
    assert.equal(r.status, 0);
    assert.deepEqual(r.parsedStdout, { continue: true });
  });

  test('malformed stdin → still exits 0 (fail-open by construction)', () => {
    const r = cp.spawnSync(NODE, [HOOK_PATH], {
      input: 'not json at all',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
  });
});

describe('retired hook — unwired from hooks.json', () => {
  test('hooks/hooks.json no longer references inject-review-dimensions.js', () => {
    const hooksJson = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8');
    assert.ok(
      !hooksJson.includes('inject-review-dimensions.js'),
      'hooks.json must not wire the retired inject-review-dimensions.js hook'
    );
  });

  test('validate-reviewer-dimensions.js IS still wired (live implementation)', () => {
    const hooksJson = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8');
    assert.ok(
      hooksJson.includes('validate-reviewer-dimensions.js'),
      'hooks.json must still wire the live autofill implementation'
    );
  });
});
