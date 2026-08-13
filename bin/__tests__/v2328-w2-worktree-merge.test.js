#!/usr/bin/env node
'use strict';

/**
 * v2328-w2-worktree-merge.test.js — v2.3.28 W2 regression suite.
 *
 * Tests for bin/_lib/worktree-merge.js and the bin/worktree-merge.js CLI
 * wrapper. See `.orchestray/kb/decisions/v2328-scope-locked.md` §W2.
 *
 * Cases:
 *   1. Clean base, tracked + untracked changes → merge succeeds (patch
 *      applied, file copied), main tree gets the content.
 *   2. Stale base, no file overlap → merge proceeds with a warning (never
 *      silently reverts main's newer work — D6 scenario, safe half).
 *   3. Stale base, GENUINE 3-way conflict (same file changed on both sides
 *      since the base) → refused entirely, main tree untouched. The
 *      never-before-exercised case the brief calls out explicitly.
 *   4. Untracked-only worktree changes (V3I/D2 case) → copied cleanly when
 *      no collision; refused when the path already exists in main.
 *   5. No baseline recorded (worktree-meta missing) → hard refusal, not a
 *      best-effort skip.
 *   6. status command is read-only and reports safe_to_merge correctly.
 *   7. CLI exit codes: 0 clean merge, 2 conflict refusal, 1 resolution error.
 *
 * Runner: node --test bin/__tests__/v2328-w2-worktree-merge.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI       = path.join(REPO_ROOT, 'bin', 'worktree-merge.js');
const NODE      = process.execPath;

const {
  computeMergePlan,
  executeMerge,
  classifyChanges,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'worktree-merge.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitOpts(cwd, homeDir) {
  return { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: homeDir } };
}

/**
 * Build a master repo + a linked worktree, with a worktree-meta baseline
 * recorded (mirrors what worktree-create.js writes).
 */
function makeSetup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2328-w2-'));
  const masterDir = path.join(base, 'master');
  fs.mkdirSync(masterDir, { recursive: true });

  const opts = gitOpts(masterDir, base);
  execSync('git init -b main', opts);
  execSync('git config user.email test@local', opts);
  execSync('git config user.name test', opts);
  fs.writeFileSync(path.join(masterDir, 'shared.txt'), 'original\n');
  fs.writeFileSync(path.join(masterDir, 'untouched.txt'), 'never changes\n');
  execSync('git add -A', opts);
  execSync('git commit -m "init"', opts);

  const worktreesParent = path.join(masterDir, '.claude', 'worktrees');
  fs.mkdirSync(worktreesParent, { recursive: true });

  function addWorktree(name) {
    const wtPath = path.join(worktreesParent, name);
    execSync(`git worktree add --detach "${wtPath}" HEAD`, opts);

    const baseHead = execSync('git rev-parse HEAD', opts).trim();
    const metaDir = path.join(masterDir, '.orchestray', 'state', 'worktree-meta');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, name + '.json'), JSON.stringify({
      agent_name: name,
      worktree_path: wtPath,
      created_at: new Date().toISOString(),
      main_tree_head_at_creation: baseHead,
      main_tree_uncommitted_count_at_creation: 0,
    }) + '\n', 'utf8');

    return wtPath;
  }

  function advanceMain(relPath, content, msg) {
    fs.writeFileSync(path.join(masterDir, relPath), content);
    execSync('git add -A', opts);
    execSync(`git commit -m "${msg}"`, opts);
  }

  return {
    masterDir,
    homeDir: base,
    addWorktree,
    advanceMain,
    cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_e) {} },
  };
}

function runCli(args, cwd, homeDir) {
  const r = spawnSync(NODE, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: homeDir },
  });
  return r;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2328 W2 — worktree-merge (safe PM merge helper)', () => {

  test('1. Clean base, tracked + untracked changes → merge succeeds', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-clean');
      fs.writeFileSync(path.join(wt, 'shared.txt'), 'modified by agent\n');
      fs.writeFileSync(path.join(wt, 'new-module.js'), 'module.exports = {};\n');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.ok, true);
      assert.equal(plan.stale, false);
      assert.equal(plan.conflicts.length, 0);

      const result = executeMerge(s.masterDir, wt, plan);
      assert.equal(result.ok, true);
      assert.equal(result.filesApplied, 1);
      assert.equal(result.filesCopied, 1);

      assert.equal(fs.readFileSync(path.join(s.masterDir, 'shared.txt'), 'utf8'), 'modified by agent\n');
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'new-module.js'), 'utf8'), 'module.exports = {};\n');
    } finally { s.cleanup(); }
  });

  test('2. Stale base, no file overlap → merge proceeds, main work not reverted (D6 scenario)', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-stale-safe');
      // Main advances on a DIFFERENT file after the worktree was created.
      s.advanceMain('untouched.txt', 'main moved on\n', 'main advances on untouched.txt');

      fs.writeFileSync(path.join(wt, 'shared.txt'), 'agent edit\n');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.stale, true);
      assert.equal(plan.conflicts.length, 0, 'no overlap between the two changed files');

      const result = executeMerge(s.masterDir, wt, plan);
      assert.equal(result.ok, true);
      assert.equal(result.filesApplied, 1);

      // Both the agent's change AND main's live fix survive.
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'shared.txt'), 'utf8'), 'agent edit\n');
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'untouched.txt'), 'utf8'), 'main moved on\n');
    } finally { s.cleanup(); }
  });

  test('3. GENUINE 3-way conflict (same file changed both sides) → refused entirely', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-conflict');
      // Main changes shared.txt AFTER the worktree's base.
      s.advanceMain('shared.txt', 'changed by main\n', 'main edits shared.txt');
      // Worktree independently changes the SAME file.
      fs.writeFileSync(path.join(wt, 'shared.txt'), 'changed by agent\n');
      // Plus an unrelated, non-conflicting untracked file.
      fs.writeFileSync(path.join(wt, 'new-module.js'), 'module.exports = {};\n');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.stale, true);
      assert.equal(plan.conflicts.length, 1);
      assert.equal(plan.conflicts[0].path, 'shared.txt');
      assert.equal(plan.conflicts[0].reason, 'modified_in_worktree_and_main_since_base');

      const result = executeMerge(s.masterDir, wt, plan);
      assert.equal(result.ok, false);
      assert.ok(result.conflicts && result.conflicts.length === 1);

      // Refusal is total: even the non-conflicting untracked file was NOT
      // applied — no partial merge.
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'shared.txt'), 'utf8'), 'changed by main\n');
      assert.equal(fs.existsSync(path.join(s.masterDir, 'new-module.js')), false);
    } finally { s.cleanup(); }
  });

  test('4a. Untracked-only changes (V3I/D2 case) → copied cleanly', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-untracked');
      fs.mkdirSync(path.join(wt, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'bin', 'new-hook.js'), '// new hook\n');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.deepEqual(plan.untracked, ['bin/new-hook.js']);
      assert.equal(plan.conflicts.length, 0);

      const result = executeMerge(s.masterDir, wt, plan);
      assert.equal(result.ok, true);
      assert.equal(result.filesCopied, 1);
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'bin', 'new-hook.js'), 'utf8'), '// new hook\n');
    } finally { s.cleanup(); }
  });

  test('4b. Untracked path collides with an existing main file → refused', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-collide');
      // main creates a file at this path AFTER the worktree's base...
      s.advanceMain('surprise.txt', 'main created this\n', 'main adds surprise.txt');
      // ...and the worktree independently has an untracked file at the same path.
      fs.writeFileSync(path.join(wt, 'surprise.txt'), 'agent created this\n');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.conflicts.length, 1);
      assert.equal(plan.conflicts[0].reason, 'untracked_collides_with_existing_main_file');

      const result = executeMerge(s.masterDir, wt, plan);
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'surprise.txt'), 'utf8'), 'main created this\n');
    } finally { s.cleanup(); }
  });

  test('5. No baseline recorded → hard refusal', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-nometa');
      fs.rmSync(path.join(s.masterDir, '.orchestray', 'state', 'worktree-meta', 'agent-nometa.json'));

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.ok, false);
      assert.match(plan.error, /no baseline recorded/);
    } finally { s.cleanup(); }
  });

  test('6. status command is read-only and reports safe_to_merge', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-status');
      fs.writeFileSync(path.join(wt, 'shared.txt'), 'edited\n');

      const r = runCli(['status', 'agent-status'], s.masterDir, s.homeDir);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.safe_to_merge, true);
      assert.equal(parsed.stale, false);
      // status must not have touched main tree
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'shared.txt'), 'utf8'), 'original\n');
    } finally { s.cleanup(); }
  });

  test('7. CLI exit codes: 0 clean merge, 2 conflict, 1 resolution error', () => {
    const s = makeSetup();
    try {
      const wtClean = s.addWorktree('agent-cli-clean');
      fs.writeFileSync(path.join(wtClean, 'shared.txt'), 'cli clean edit\n');
      const rClean = runCli(['merge', 'agent-cli-clean'], s.masterDir, s.homeDir);
      assert.equal(rClean.status, 0);

      const wtConflict = s.addWorktree('agent-cli-conflict');
      s.advanceMain('shared.txt', 'main changed again\n', 'main edits shared.txt again');
      fs.writeFileSync(path.join(wtConflict, 'shared.txt'), 'agent changed again\n');
      const rConflict = runCli(['merge', 'agent-cli-conflict'], s.masterDir, s.homeDir);
      assert.equal(rConflict.status, 2);

      const rMissing = runCli(['merge', 'does-not-exist'], s.masterDir, s.homeDir);
      assert.equal(rMissing.status, 1);
    } finally { s.cleanup(); }
  });

  test('8. classifyChanges parses tracked/untracked/rename correctly', () => {
    const parsed = classifyChanges(' M tracked-mod.txt\n?? untracked-new.txt\nR  old.txt -> new.txt\n');
    assert.deepEqual(parsed.tracked.sort(), ['new.txt', 'tracked-mod.txt']);
    assert.deepEqual(parsed.untracked, ['untracked-new.txt']);
  });
});

// ---------------------------------------------------------------------------
// Case 8 — committed-in-worktree work (v2.3.28 W2 follow-up).
//
// Regression: change discovery used `git status --porcelain` alone, which
// reports only UNCOMMITTED work. An agent that COMMITS inside its worktree
// (as W2I itself did) produced an empty porcelain, so the tool reported
// zero changed files with safe_to_merge=true and exit 0 — merging nothing
// while signalling success. That is the D2/D7 silent-loss shape with a
// green light on top. Discovery must union porcelain with
// `git diff --name-only <base> HEAD`.
// ---------------------------------------------------------------------------
describe('committed-in-worktree work is discovered and merged', () => {
  test('committed new + modified files are seen, merged, and counted', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-committed');
      const wtOpts = gitOpts(wt, s.homeDir);
      execSync('git config user.email test@local', wtOpts);
      execSync('git config user.name test', wtOpts);

      // Agent does its work and COMMITS it — porcelain goes clean.
      fs.writeFileSync(path.join(wt, 'brand-new.txt'), 'new deliverable\n');
      fs.writeFileSync(path.join(wt, 'shared.txt'), 'modified by agent\n');
      execSync('git add -A', wtOpts);
      execSync('git commit -m "agent work"', wtOpts);

      assert.equal(
        execSync('git status --porcelain', wtOpts).trim(), '',
        'precondition: worktree is clean because the agent committed',
      );

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.ok, true, plan.error);
      assert.equal(plan.conflicts.length, 0, 'no conflicts: main never moved');
      assert.equal(plan.totalChangedFiles, 2, 'both committed files must be discovered');
      assert.equal(plan.uncommittedCount, 0, 'nothing was left dirty');
      assert.equal(plan.committedCount, 2, 'both files came from the committed set');
      assert.ok(plan.tracked.includes('brand-new.txt'), 'committed new file discovered');
      assert.ok(plan.tracked.includes('shared.txt'), 'committed modification discovered');

      const res = executeMerge(s.masterDir, wt, plan);
      assert.equal(res.ok, true, res.error);
      assert.notEqual(res.noChanges, true, 'must not report a no-op merge');

      assert.equal(fs.readFileSync(path.join(s.masterDir, 'brand-new.txt'), 'utf8'), 'new deliverable\n');
      assert.equal(fs.readFileSync(path.join(s.masterDir, 'shared.txt'), 'utf8'), 'modified by agent\n');
    } finally { s.cleanup(); }
  });

  test('committed work still refuses on a genuine 3-way conflict', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-committed-conflict');
      const wtOpts = gitOpts(wt, s.homeDir);
      execSync('git config user.email test@local', wtOpts);
      execSync('git config user.name test', wtOpts);

      fs.writeFileSync(path.join(wt, 'shared.txt'), 'agent version\n');
      execSync('git add -A', wtOpts);
      execSync('git commit -m "agent edits shared"', wtOpts);

      // Main moves on the SAME file after the worktree's base.
      s.advanceMain('shared.txt', 'main version\n', 'main edits shared');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.ok, true, plan.error);
      assert.equal(plan.stale, true);
      assert.ok(
        plan.conflicts.some((c) => c.path === 'shared.txt'),
        'committed-side change must participate in conflict detection',
      );

      const res = executeMerge(s.masterDir, wt, plan);
      assert.equal(res.ok, false, 'conflicting merge must be refused');
      assert.equal(
        fs.readFileSync(path.join(s.masterDir, 'shared.txt'), 'utf8'), 'main version\n',
        'main tree must be untouched by a refused merge',
      );
    } finally { s.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Case 9 — uncommitted work in MAIN overlapping the merge set.
//
// Staleness is computed HEAD-to-HEAD, so it cannot see edits sitting
// UNCOMMITTED in main — the D6 shape (live fixes made minutes earlier, not
// yet committed). executeMerge's `git apply --check` is the real guard, but a
// status report saying "safe_to_merge: true" without naming the overlap is the
// silent half of that same bug. Status must name it.
// ---------------------------------------------------------------------------
describe('uncommitted main-tree work overlapping the merge set', () => {
  test('status names overlapping files instead of silently reporting safe', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-overlap');
      const wtOpts = gitOpts(wt, s.homeDir);
      execSync('git config user.email test@local', wtOpts);
      execSync('git config user.name test', wtOpts);

      fs.writeFileSync(path.join(wt, 'shared.txt'), 'agent line\noriginal\n');
      execSync('git add -A', wtOpts);
      execSync('git commit -m "agent edits shared"', wtOpts);

      // Main has an UNCOMMITTED edit to the same file — HEAD has not moved.
      fs.writeFileSync(path.join(s.masterDir, 'shared.txt'), 'original\nmain uncommitted\n');

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.ok, true, plan.error);
      assert.equal(plan.stale, false, 'HEAD has not moved — staleness alone cannot see this');
      assert.ok(
        plan.mainUncommittedOverlap.includes('shared.txt'),
        'the overlapping file must be named in the plan',
      );
    } finally { s.cleanup(); }
  });

  test('no overlap reported when main is clean', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-no-overlap');
      const wtOpts = gitOpts(wt, s.homeDir);
      execSync('git config user.email test@local', wtOpts);
      execSync('git config user.name test', wtOpts);

      fs.writeFileSync(path.join(wt, 'shared.txt'), 'agent only\n');
      execSync('git add -A', wtOpts);
      execSync('git commit -m "agent edits"', wtOpts);

      const plan = computeMergePlan(s.masterDir, wt);
      assert.equal(plan.ok, true, plan.error);
      assert.deepEqual(plan.mainUncommittedOverlap, [], 'clean main means no overlap');
    } finally { s.cleanup(); }
  });
});
