#!/usr/bin/env node
'use strict';

/**
 * v2318-w3-q2-reviewer-git-diff-autoinject.test.js — Q2 auto-inject (v2.3.18 W3).
 *
 * validate-reviewer-git-diff.js used to hard-block a reviewer spawn whose
 * prompt lacked `## Git Diff` (FN-42, v2.2.15). Telemetry showed the escape
 * hatch (`reviewer_git_diff_audit_mode_accepted`) firing MORE often (23x)
 * than the block (15x) — the gate was mostly theater. v2.3.18 W3 Q2 converts
 * it to auto-inject: compute the diff with `git diff HEAD` and splice it into
 * the prompt via PreToolUse `updatedInput` (same pattern as
 * inject-delegation-delta.js), blocking ONLY when no diff can be produced at
 * all. Also verifies the bundled `spawn_id` fix (was null on 30/30 rows —
 * `event.tool_use_id` is the correct PreToolUse-time identifier).
 *
 * Uses a throwaway self-contained git repo fixture (never touches this
 * repo's own `.orchestray/audit/events.jsonl` or git tree — this session
 * runs alongside other concurrent developer processes in the same worktree).
 *
 * Runner: node --test bin/__tests__/v2318-w3-q2-reviewer-git-diff-autoinject.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'validate-reviewer-git-diff.js');
const NODE      = process.execPath;

function readEvents(root) {
  try {
    return fs.readFileSync(path.join(root, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function runHookSync(payload, cwd) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Build a throwaway git repo with one committed file and one uncommitted edit. */
function makeGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-q2-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  cp.execFileSync('git', ['init', '-q'], { cwd: dir });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  cp.execFileSync('git', ['add', '.'], { cwd: dir });
  cp.execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello world\n'); // uncommitted change
  return dir;
}

// ---------------------------------------------------------------------------
// Auto-inject success path
// ---------------------------------------------------------------------------

describe('reviewer prompt missing ## Git Diff → auto-inject (not block)', () => {
  let repo;
  beforeEach(() => { repo = makeGitFixture(); });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  test('injects a ## Git Diff section via updatedInput.prompt and exits 0', () => {
    const payload = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_test_q2_001',
      cwd: repo,
      tool_input: {
        subagent_type: 'reviewer',
        prompt: 'Review the recent changes.\n\n## Files to Review\n\n- file.txt\n',
      },
    };
    const { stdout, stderr, status } = runHookSync(payload, repo);
    assert.equal(status, 0, `hook must exit 0 (auto-inject, not block); stderr=${stderr}`);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.continue, true);
    const injectedPrompt = parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput
      ? parsed.hookSpecificOutput.updatedInput.prompt
      : null;
    assert.ok(injectedPrompt, 'updatedInput.prompt must be present');
    assert.match(injectedPrompt, /## Git Diff/, 'injected prompt must contain a ## Git Diff section');
    assert.match(injectedPrompt, /hello world/, 'injected diff must contain the actual uncommitted change');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');

    const events = readEvents(repo).filter(e => e.type === 'reviewer_git_diff_auto_injected');
    assert.equal(events.length, 1, 'exactly 1 reviewer_git_diff_auto_injected event');
    assert.equal(events[0].spawn_id, 'toolu_test_q2_001', 'spawn_id must resolve from tool_use_id (v2.3.18 fix)');
    assert.equal(events[0].source, 'full');
  });

  test('prompt WITH ## Git Diff already present is untouched (no injection, no event)', () => {
    const payload = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_test_q2_002',
      cwd: repo,
      tool_input: {
        subagent_type: 'reviewer',
        prompt: 'Review this.\n\n## Git Diff\n\n```diff\n+ hi\n```\n',
      },
    };
    const { stdout, status } = runHookSync(payload, repo);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined, 'no updatedInput when section already present');

    const events = readEvents(repo).filter(e => e.type === 'reviewer_git_diff_auto_injected');
    assert.equal(events.length, 0, 'no auto-inject event when the section was already present');
  });

  test('clean tree (no uncommitted changes) still injects a valid n/a marker, not a block', () => {
    cp.execFileSync('git', ['checkout', '--', 'file.txt'], { cwd: repo }); // discard the uncommitted edit
    const payload = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_test_q2_005',
      cwd: repo,
      tool_input: { subagent_type: 'reviewer', prompt: 'Review this.\n' },
    };
    const { stdout, status } = runHookSync(payload, repo);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    const injectedPrompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.match(injectedPrompt, /## Git Diff/);
  });
});

// ---------------------------------------------------------------------------
// Genuine failure path — not a git repo at all → still blocks.
// ---------------------------------------------------------------------------

describe('no diff producible at all → still blocks (only remaining block path)', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-q2-noninit-'));
    fs.mkdirSync(path.join(tmpRoot, '.orchestray', 'audit'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('non-git directory → block, exit 2', () => {
    const payload = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_test_q2_003',
      cwd: tmpRoot,
      tool_input: {
        subagent_type: 'reviewer',
        prompt: 'Review this.\n\n## Files to Review\n\n- foo.js\n',
      },
    };
    const { stdout, stderr, status } = runHookSync(payload, tmpRoot);
    assert.equal(status, 2, `hook must block when no diff can be produced at all; stderr=${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.continue, false);

    const events = readEvents(tmpRoot).filter(e => e.type === 'reviewer_git_diff_section_missing');
    assert.equal(events.length, 1, 'reviewer_git_diff_section_missing event must still be emitted on the block path');
    assert.equal(events[0].spawn_id, 'toolu_test_q2_003');
  });

  test('ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1 downgrades the genuine-failure block to warn', () => {
    const payload = {
      tool_name: 'Agent',
      tool_use_id: 'toolu_test_q2_004',
      cwd: tmpRoot,
      tool_input: {
        subagent_type: 'reviewer',
        prompt: 'Review this.\n',
      },
    };
    const r = cp.spawnSync(NODE, [HOOK_PATH], {
      input: JSON.stringify(payload),
      cwd: tmpRoot,
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED: '1' }),
    });
    assert.equal(r.status, 0, `kill switch must downgrade to warn; stderr=${r.stderr}`);
  });

  test('ORCHESTRAY_REVIEWER_GIT_DIFF_AUTOINJECT_DISABLED=1 restores legacy straight-block behaviour', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-q2-legacy-'));
    fs.mkdirSync(path.join(repo, '.orchestray', 'audit'), { recursive: true });
    cp.execFileSync('git', ['init', '-q'], { cwd: repo });
    try {
      const payload = {
        tool_name: 'Agent',
        tool_use_id: 'toolu_test_q2_006',
        cwd: repo,
        tool_input: { subagent_type: 'reviewer', prompt: 'Review this.\n' },
      };
      const r = cp.spawnSync(NODE, [HOOK_PATH], {
        input: JSON.stringify(payload),
        cwd: repo,
        encoding: 'utf8',
        timeout: 10000,
        env: Object.assign({}, process.env, { ORCHESTRAY_REVIEWER_GIT_DIFF_AUTOINJECT_DISABLED: '1' }),
      });
      // A repo with zero commits: `git diff HEAD` and `git diff` would normally
      // still work here, but auto-inject is disabled entirely, so the hook
      // never attempts it and falls straight to the legacy block.
      assert.equal(r.status, 2, `autoinject-disabled kill switch must restore legacy block; stderr=${r.stderr}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
