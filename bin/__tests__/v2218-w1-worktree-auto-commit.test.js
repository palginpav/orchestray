#!/usr/bin/env node
'use strict';

/**
 * v2218-w1-worktree-auto-commit.test.js — W1 v2.2.18 regression suite.
 *
 * Tests for bin/auto-commit-worktree-on-subagent-stop.js — the SubagentStop
 * hook that auto-commits dirty linked worktrees so agent edits are never lost.
 *
 * Cases:
 *   1. Dirty worktree → auto-commit appears with correct subject and trailer.
 *   2. Clean worktree → no commit, no event.
 *   3. Non-worktree cwd → early exit, no commit, no event.
 *   4. Kill switch env var → exit 0 with no git invocation.
 *   5. event.cwd null → exit 0 with stderr notice.
 *
 * Runner: node --test bin/__tests__/v2218-w1-worktree-auto-commit.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert       = require('node:assert/strict');
const fs           = require('node:fs');
const os           = require('node:os');
const path         = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'bin', 'auto-commit-worktree-on-subagent-stop.js');
const NODE        = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a non-bare "master" git repo + a linked worktree, returning both paths.
 * The master repo has one initial commit so the worktree branch exists.
 *
 * @returns {{ masterDir: string, worktreeDir: string, cleanup: () => void }}
 */
function makeWorktreeSetup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-w1-'));

  // 1. Init a non-bare master repo.
  const masterDir = path.join(base, 'master');
  fs.mkdirSync(masterDir, { recursive: true });

  // Use -c flags on each git call to avoid relying on global git config.
  const gitOpts = {
    cwd: masterDir,
    encoding: 'utf8',
    // Suppress git hints in stderr (avoids noise in test output).
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: base },
  };

  execSync('git init -b main', gitOpts);
  execSync('git config user.email test@local', gitOpts);
  execSync('git config user.name test', gitOpts);

  fs.writeFileSync(path.join(masterDir, 'README.md'), 'hello');
  execSync('git add -A', gitOpts);
  execSync('git commit -m "init"', gitOpts);

  // 2. Add a linked worktree on a new branch.
  const worktreeDir = path.join(base, 'worktree');
  execSync('git worktree add -b wt-branch "' + worktreeDir + '"', gitOpts);

  // 3. Scaffold .orchestray in the worktree so writeEvent has a valid path,
  //    then commit those files so the worktree starts CLEAN.
  scaffoldOrchestray(worktreeDir, 'orch-wt-001');
  const wtOpts = { cwd: worktreeDir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: base } };
  execSync('git add -A', wtOpts);
  execSync('git -c user.email=orchestray@local -c user.name=orchestray-auto-commit commit -m "scaffold: orchestray audit dir"', wtOpts);

  return {
    masterDir,
    worktreeDir,
    cleanup: () => {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

/**
 * Create a minimal .orchestray/audit structure under a directory,
 * with a current-orchestration.json so writeEvent can resolve it.
 *
 * @param {string} dir
 * @param {string} [orchId]
 */
function scaffoldOrchestray(dir, orchId = 'test-orch-001') {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

/**
 * Build a SubagentStop hook event payload.
 * @param {object} overrides
 * @returns {string} JSON string
 */
function makeEvent(overrides = {}) {
  return JSON.stringify({
    hook_event_name: 'SubagentStop',
    agent_role: 'developer',
    session_id: 'sess-123',
    ...overrides,
  });
}

/**
 * Run the hook script with optional stdin and env overrides.
 * @param {string} stdinData
 * @param {object} envOverrides
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(stdinData, envOverrides = {}) {
  const r = spawnSync(NODE, [HOOK_SCRIPT], {
    input:    stdinData,
    encoding: 'utf8',
    timeout:  15000,
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Read and parse all event rows from events.jsonl.
 * @param {string} projectDir
 * @returns {object[]}
 */
function readEvents(projectDir) {
  const eventsPath = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

/**
 * Get the most recent git log entry for a repo.
 * @param {string} dir
 * @returns {{ subject: string, body: string }}
 */
function gitLog(dir) {
  try {
    const subject = execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }).trim();
    const body    = execSync('git log -1 --format=%b', { cwd: dir, encoding: 'utf8' }).trim();
    return { subject, body };
  } catch (_e) {
    return { subject: '', body: '' };
  }
}

/**
 * Count commits on the current branch.
 * @param {string} dir
 * @returns {number}
 */
function countCommits(dir) {
  try {
    return parseInt(
      execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim(),
      10
    );
  } catch (_e) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2218 W1 — worktree auto-commit on SubagentStop', () => {

  test('1. Dirty worktree → auto-commit with correct subject and trailer', () => {
    const { worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      // Write a new file so the worktree is dirty.
      fs.writeFileSync(path.join(worktreeDir, 'agent-output.txt'), 'data from agent');

      const commitsBefore = countCommits(worktreeDir);

      const r = runHook(makeEvent({ cwd: worktreeDir, agent_role: 'developer', session_id: 'sess-xyz' }));

      assert.equal(r.status, 0, 'hook must exit 0; stderr: ' + r.stderr.slice(0, 400));

      const commitsAfter = countCommits(worktreeDir);
      assert.equal(commitsAfter, commitsBefore + 1, 'exactly one new commit expected');

      const log = gitLog(worktreeDir);
      assert.match(log.subject, /^wip\(auto\):/, 'subject must start with wip(auto):');
      assert.ok(log.body.includes('Generated-By: orchestray-auto-commit-worktree'),
        'body must include Generated-By trailer; got: ' + log.body);
      assert.ok(log.body.includes('Agent: developer'), 'body must include Agent: developer');

    } finally {
      cleanup();
    }
  });

  test('2. Clean worktree → no commit, no event emitted', () => {
    const { worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      // Worktree is clean (no edits after makeWorktreeSetup).
      const commitsBefore = countCommits(worktreeDir);

      const r = runHook(makeEvent({ cwd: worktreeDir }));

      assert.equal(r.status, 0, 'hook must exit 0');
      assert.equal(countCommits(worktreeDir), commitsBefore, 'no new commit on clean worktree');

      const events = readEvents(worktreeDir);
      const autoCommitEvents = events.filter(e =>
        e.type === 'worktree_auto_commit_emitted' || e.type === 'worktree_auto_commit_failed'
      );
      assert.equal(autoCommitEvents.length, 0, 'no worktree_auto_commit events on clean worktree');

    } finally {
      cleanup();
    }
  });

  test('3. Non-worktree cwd (master tree) → no commit, no event', () => {
    const { masterDir, cleanup } = makeWorktreeSetup();
    try {
      // Scaffold .orchestray in master tree so writeEvent has somewhere to write.
      scaffoldOrchestray(masterDir, 'orch-master-003');

      // Write a dirty file in the master tree.
      fs.writeFileSync(path.join(masterDir, 'stray.txt'), 'stray content');

      const commitsBefore = countCommits(masterDir);

      const r = runHook(makeEvent({ cwd: masterDir }));

      assert.equal(r.status, 0, 'hook must exit 0');
      assert.equal(countCommits(masterDir), commitsBefore, 'master tree must not be auto-committed');

      const events = readEvents(masterDir);
      const autoCommitEvents = events.filter(e =>
        e.type === 'worktree_auto_commit_emitted' || e.type === 'worktree_auto_commit_failed'
      );
      assert.equal(autoCommitEvents.length, 0, 'no worktree_auto_commit events for master tree');

    } finally {
      cleanup();
    }
  });

  test('4. Kill switch env var ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED=1 → exit 0, no commit', () => {
    const { worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      fs.writeFileSync(path.join(worktreeDir, 'dirty.txt'), 'dirty');

      const commitsBefore = countCommits(worktreeDir);

      const r = runHook(
        makeEvent({ cwd: worktreeDir }),
        { ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED: '1' }
      );

      assert.equal(r.status, 0, 'hook must exit 0 when kill switch is set');
      assert.equal(countCommits(worktreeDir), commitsBefore, 'kill switch must prevent commit');

    } finally {
      cleanup();
    }
  });

  test('5. event.cwd absent → exit 0 with stderr notice, no commit', () => {
    const { worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      fs.writeFileSync(path.join(worktreeDir, 'dirty2.txt'), 'dirty2');

      const commitsBefore = countCommits(worktreeDir);

      // Pass event without cwd field.
      const r = runHook(JSON.stringify({ hook_event_name: 'SubagentStop', agent_role: 'developer' }));

      assert.equal(r.status, 0, 'hook must exit 0 when cwd is absent');
      assert.match(r.stderr, /absent/, 'stderr should mention absent cwd');
      assert.equal(countCommits(worktreeDir), commitsBefore, 'no commit when cwd is absent');

    } finally {
      cleanup();
    }
  });

});
