#!/usr/bin/env node
'use strict';

/**
 * v2329-w6-inject-worktree-staleness.test.js — W6 hook unit tests (v2.3.29).
 *
 * Tests bin/inject-worktree-staleness.js (PreToolUse:Agent) in isolation by
 * spawning it as a child process against a real tmp git repo. Asserts:
 *   1. Dirty main tree + isolated spawn → prompt gets the staleness appendix
 *      with the correct HEAD short-sha and uncommitted count;
 *      worktree_staleness_injected event written.
 *   2. Clean main tree → no mutation; worktree_staleness_skipped(clean_tree).
 *   3. Non-isolated spawn (no isolation param, no frontmatter) → no mutation,
 *      no event at all (hook exits before measuring the tree).
 *   4. ORCHESTRAY_DISABLE_WORKTREE_STALENESS_WARN=1 → no mutation.
 *   5. Non-Agent tool_name → passthrough, no mutation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'inject-worktree-staleness.js');
const NODE      = process.execPath;

function git(cwd, args) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout;
}

function makeTmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2329-w6-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n', 'utf8');
  // Mirror the real repo's .gitignore: .orchestray/ is ignored, so hook side
  // effects (fixture harvest, audit writes) landing there during the hook's
  // own run must not pollute the `git status --porcelain` measurement under
  // test — matches production, where this repo's own .gitignore does the
  // same (see /.gitignore line 6).
  fs.writeFileSync(path.join(root, '.gitignore'), '.orchestray/\n', 'utf8');
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
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

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter((e) => e !== null);
}

const ORIG_PROMPT = '## Task\nImplement the thing.\n';

describe('W6 inject-worktree-staleness hook — dirty main tree, isolated spawn', () => {
  test('appends staleness warning with correct head + count; emits injected event', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'wip\n', 'utf8');
    const head = git(root, ['rev-parse', '--short', 'HEAD']).trim();

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', isolation: 'worktree', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);
    const out = r.parsedStdout;
    assert.ok(out.hookSpecificOutput, 'dirty + isolated spawn must produce updatedInput');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');

    const newPrompt = out.hookSpecificOutput.updatedInput.prompt;
    assert.ok(newPrompt.startsWith(ORIG_PROMPT), 'original prompt preserved at the start');
    assert.ok(newPrompt.includes('## Worktree Staleness Warning'));
    assert.ok(newPrompt.includes(head), 'includes the actual main-tree HEAD short-sha');
    assert.ok(newPrompt.includes('1 uncommitted/untracked path(s)'),
      'reports the correct uncommitted count');

    const evs = readEvents(root);
    const ev = evs.find((e) => e.type === 'worktree_staleness_injected');
    assert.ok(ev, 'worktree_staleness_injected event must be written');
    assert.equal(ev.agent_type, 'developer');
    assert.equal(ev.main_tree_head, head);
    assert.equal(ev.main_tree_uncommitted_count, 1);
  });
});

describe('W6 inject-worktree-staleness hook — clean main tree', () => {
  test('no prompt mutation; emits skipped(clean_tree)', () => {
    const root = makeTmpRepo();

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', isolation: 'worktree', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const out = r.parsedStdout;
    assert.equal(out.hookSpecificOutput, undefined, 'clean tree — no mutation');
    assert.equal(out.continue, true);

    const evs = readEvents(root);
    const ev = evs.find((e) => e.type === 'worktree_staleness_skipped');
    assert.ok(ev, 'worktree_staleness_skipped event must be written');
    assert.equal(ev.reason, 'clean_tree');
  });
});

describe('W6 inject-worktree-staleness hook — non-isolated spawn', () => {
  test('no mutation, no measurement, no event', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'wip\n', 'utf8');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const out = r.parsedStdout;
    assert.equal(out.hookSpecificOutput, undefined, 'un-isolated spawn — no mutation');
    assert.deepEqual(readEvents(root), [], 'no events for a non-isolated spawn');
  });
});

describe('W6 inject-worktree-staleness hook — kill switch', () => {
  test('ORCHESTRAY_DISABLE_WORKTREE_STALENESS_WARN=1 → no mutation', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'wip\n', 'utf8');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', isolation: 'worktree', prompt: ORIG_PROMPT },
    }, { env: { ORCHESTRAY_DISABLE_WORKTREE_STALENESS_WARN: '1' } });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);
  });
});

describe('W6 inject-worktree-staleness hook — non-Agent tool', () => {
  test('passthrough, no mutation', () => {
    const root = makeTmpRepo();
    const r = runHook({ tool_name: 'Read', cwd: root, tool_input: { file_path: 'x' } });
    assert.equal(r.status, 0);
    assert.deepEqual(r.parsedStdout, { continue: true });
  });
});
