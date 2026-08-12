#!/usr/bin/env node
'use strict';

/**
 * v2326-w15-worktree-remove-guard.test.js — W15 (v2.3.26) regression suite.
 *
 * Tests for bin/worktree-remove.js — the WorktreeRemove hook must never
 * destroy a worktree carrying uncommitted work (tracked OR untracked).
 * Root cause: the hook used to run `git worktree remove --force`
 * unconditionally on the assumption that an upstream SubagentStop hook had
 * already committed everything — an assumption that doesn't always hold
 * (kill switch, failed commit, hook-ordering race).
 *
 * Cases:
 *   1. Tracked modification present → worktree preserved, event emitted.
 *   2. Untracked file only present → worktree preserved, event emitted
 *      (this is the exact case that lost 11 files in the wild — a
 *      status check that only looked at tracked files would miss it).
 *   3. Clean worktree → removed normally (no regression).
 *   4. Hook always exits 0, including the internal-error path (missing
 *      agent name / worktree_path).
 *
 * Runner: node --test bin/__tests__/v2326-w15-worktree-remove-guard.test.js
 */

const { test, describe } = require('node:test');
const assert       = require('node:assert/strict');
const fs           = require('node:fs');
const os           = require('node:os');
const path         = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'bin', 'worktree-remove.js');
const NODE        = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a non-bare "master" git repo + a linked worktree, returning both
 * paths. The master repo has one initial commit so the worktree branch
 * exists. .orchestray is scaffolded and committed in the worktree so it
 * starts CLEAN (mirrors v2218-w1-worktree-auto-commit.test.js).
 *
 * @returns {{ masterDir: string, worktreeDir: string, base: string, cleanup: () => void }}
 */
function makeWorktreeSetup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2326-w15-'));

  const masterDir = path.join(base, 'master');
  fs.mkdirSync(masterDir, { recursive: true });

  const gitOpts = {
    cwd: masterDir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: base },
  };

  execSync('git init -b main', gitOpts);
  execSync('git config user.email test@local', gitOpts);
  execSync('git config user.name test', gitOpts);

  fs.writeFileSync(path.join(masterDir, 'README.md'), 'hello');
  execSync('git add -A', gitOpts);
  execSync('git commit -m "init"', gitOpts);

  const worktreeDir = path.join(base, 'worktree');
  execSync('git worktree add --detach "' + worktreeDir + '"', gitOpts);

  scaffoldOrchestray(worktreeDir, 'orch-w15-001');
  const wtOpts = { cwd: worktreeDir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: base } };
  execSync('git add -A', wtOpts);
  execSync('git -c user.email=orchestray@local -c user.name=orchestray-auto-commit commit -m "scaffold: orchestray audit dir"', wtOpts);

  return {
    masterDir,
    worktreeDir,
    base,
    cleanup: () => {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

/**
 * Create a minimal .orchestray/audit structure with a current-orchestration.json
 * so writeEvent can resolve orchestration_id.
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
 * Run the hook script with stdin JSON and env overrides.
 * @param {object} payload
 * @param {object} [envOverrides]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(payload, envOverrides = {}) {
  const r = spawnSync(NODE, [HOOK_SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  15000,
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Read and parse all event rows from events.jsonl under a project dir.
 * @param {string} projectDir
 * @returns {object[]}
 */
function readEvents(projectDir) {
  const eventsPath = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

/**
 * Is `dir` currently a registered git worktree of `masterDir`?
 * @param {string} masterDir
 * @param {string} worktreeDir
 * @returns {boolean}
 */
function worktreeStillRegistered(masterDir, worktreeDir) {
  const listResult = execSync('git worktree list --porcelain', { cwd: masterDir, encoding: 'utf8' });
  const normalized = path.resolve(worktreeDir);
  return listResult.split('\n').some((l) => l.startsWith('worktree ') && path.resolve(l.slice(9).trim()) === normalized);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2326 W15 — worktree-remove data-loss guard', () => {

  test('1. Tracked modification present → worktree preserved, event emitted', () => {
    const { masterDir, worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      // Modify a tracked file (checked out into the worktree from master HEAD)
      // without committing.
      fs.writeFileSync(path.join(worktreeDir, 'README.md'), 'edited by agent, not committed');

      const r = runHook({
        hook_event_name: 'WorktreeRemove',
        session_id: 'sess-track-1',
        cwd: masterDir,
        name: path.basename(worktreeDir),
        worktree_path: worktreeDir,
      });

      assert.equal(r.status, 0, 'hook must exit 0; stderr: ' + r.stderr.slice(0, 400));
      assert.ok(fs.existsSync(worktreeDir), 'worktree directory must still exist on disk');
      assert.ok(worktreeStillRegistered(masterDir, worktreeDir), 'worktree must still be registered with git');

      const events = readEvents(masterDir);
      const unmerged = events.filter((e) => e.type === 'worktree_changes_unmerged');
      assert.ok(unmerged.length >= 1, 'worktree_changes_unmerged must be emitted; got: ' + JSON.stringify(events.map((e) => e.type)));
      assert.ok(unmerged[0].changed_paths.some((p) => p.includes('README.md')), 'changed_paths must name README.md; got: ' + JSON.stringify(unmerged[0].changed_paths));
      assert.ok(unmerged[0].changed_count >= 1);
    } finally {
      cleanup();
    }
  });

  test('2. Untracked file only → worktree preserved, event emitted (the 11-file loss case)', () => {
    const { masterDir, worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      // A brand-new, never-added file — this is what --force silently destroyed.
      fs.writeFileSync(path.join(worktreeDir, 'agent-new-module.js'), 'module.exports = {};');

      const r = runHook({
        hook_event_name: 'WorktreeRemove',
        session_id: 'sess-untracked-1',
        cwd: masterDir,
        name: path.basename(worktreeDir),
        worktree_path: worktreeDir,
      });

      assert.equal(r.status, 0, 'hook must exit 0; stderr: ' + r.stderr.slice(0, 400));
      assert.ok(fs.existsSync(worktreeDir), 'worktree directory must still exist on disk');
      assert.ok(fs.existsSync(path.join(worktreeDir, 'agent-new-module.js')), 'untracked file must survive');
      assert.ok(worktreeStillRegistered(masterDir, worktreeDir), 'worktree must still be registered with git');

      const events = readEvents(masterDir);
      const unmerged = events.filter((e) => e.type === 'worktree_changes_unmerged');
      assert.ok(unmerged.length >= 1, 'worktree_changes_unmerged must be emitted for untracked-only dirt');
      assert.ok(unmerged[0].changed_paths.some((p) => p.includes('agent-new-module.js')),
        'changed_paths must name the untracked file; got: ' + JSON.stringify(unmerged[0].changed_paths));
    } finally {
      cleanup();
    }
  });

  test('3. Clean worktree → removed normally (no regression)', () => {
    const { masterDir, worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      const r = runHook({
        hook_event_name: 'WorktreeRemove',
        session_id: 'sess-clean-1',
        cwd: masterDir,
        name: path.basename(worktreeDir),
        worktree_path: worktreeDir,
      });

      assert.equal(r.status, 0, 'hook must exit 0; stderr: ' + r.stderr.slice(0, 400));
      assert.ok(!fs.existsSync(worktreeDir), 'clean worktree directory must be removed');
      assert.ok(!worktreeStillRegistered(masterDir, worktreeDir), 'worktree must be unregistered from git');

      const events = readEvents(masterDir);
      const unmerged = events.filter((e) => e.type === 'worktree_changes_unmerged');
      assert.equal(unmerged.length, 0, 'no worktree_changes_unmerged event for a clean removal');
    } finally {
      cleanup();
    }
  });

  test('4. Missing agent name and worktree_path → exit 0, no-op', () => {
    const r = runHook({ hook_event_name: 'WorktreeRemove', session_id: 'sess-noop-1' });
    assert.equal(r.status, 0, 'hook must exit 0 even with no name/path to act on');
    assert.match(r.stderr, /nothing to remove/i);
  });

  test('5. Worktree path already gone → exit 0, prune runs, no crash', () => {
    const { masterDir, worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      // Simulate a prior removal: delete the directory but leave git's
      // registration dangling (worktree-remove.js should just prune and exit).
      fs.rmSync(worktreeDir, { recursive: true, force: true });

      const r = runHook({
        hook_event_name: 'WorktreeRemove',
        session_id: 'sess-gone-1',
        cwd: masterDir,
        name: path.basename(worktreeDir),
        worktree_path: worktreeDir,
      });

      assert.equal(r.status, 0, 'hook must exit 0 when the worktree path no longer exists');
      assert.match(r.stderr, /already removed/i);
    } finally {
      cleanup();
    }
  });
});
