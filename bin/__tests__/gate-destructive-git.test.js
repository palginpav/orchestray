#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.3.8 wt_destructive_git guard in gate-developer-git.js.
 *
 * Coverage:
 *   - reviewer + git stash → exit 2 (read-only role, always blocked)
 *   - reviewer + git stash list → exit 0 (allowed, non-destructive)
 *   - reviewer + git stash show → exit 0 (allowed, non-destructive)
 *   - developer + git checkout -- . cwd=main → exit 2 (main checkout)
 *   - developer + git checkout -- . cwd=own-worktree → exit 0 (linked worktree)
 *   - any role + git -C /home/<repo> reset --hard → exit 2 (explicit main via -C)
 *   - cd x && git clean -fd → exit 2 (chained command)
 *   - developer + git reset --soft HEAD~1 own worktree → exit 0 (--soft allowed)
 *   - pm/no-role context → exit 0 for stash (no-role fails open for non-read-only)
 *   - git_destructive_blocked event emitted on block
 *   - worktree-create twin-idempotency path
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const mod = require('../gate-developer-git.js');
const HOOK = path.resolve(__dirname, '..', 'gate-developer-git.js');
const WORKTREE_CREATE = path.resolve(__dirname, '..', 'worktree-create.js');

// ---------------------------------------------------------------------------
// Unit tests for new helpers
// ---------------------------------------------------------------------------

describe('v238 wt_destructive_git — unit: splitChained', () => {
  const { splitChained } = mod;

  test('splits on &&', () => {
    const segs = splitChained('cd /tmp && git stash');
    assert.ok(segs.some(s => s.includes('git stash')));
  });

  test('splits on ;', () => {
    const segs = splitChained('echo hi; git clean -fd');
    assert.ok(segs.some(s => s.includes('git clean -fd')));
  });

  test('single command returns single segment', () => {
    const segs = splitChained('git stash');
    assert.equal(segs.length, 1);
    assert.equal(segs[0], 'git stash');
  });
});

describe('v238 wt_destructive_git — unit: extractGitCDir', () => {
  const { extractGitCDir } = mod;

  test('extracts unquoted -C path', () => {
    assert.equal(extractGitCDir('git -C /home/palgin/orchestray reset --hard'), '/home/palgin/orchestray');
  });

  test('extracts quoted -C path', () => {
    assert.equal(extractGitCDir('git -C "/home/palgin/orchestray" status'), '/home/palgin/orchestray');
  });

  test('returns null when no -C', () => {
    assert.equal(extractGitCDir('git reset --hard HEAD'), null);
  });
});

describe('v238 wt_destructive_git — unit: findForbiddenPattern read-only roles', () => {
  const { findForbiddenPattern } = mod;

  test('reviewer + git stash → blocked', () => {
    const r = findForbiddenPattern('git stash', 'reviewer');
    assert.ok(r, 'reviewer git stash must be blocked');
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('reviewer + git stash list → allowed', () => {
    const r = findForbiddenPattern('git stash list', 'reviewer');
    assert.equal(r, null, 'git stash list should be allowed');
  });

  test('reviewer + git stash show → allowed', () => {
    const r = findForbiddenPattern('git stash show stash@{0}', 'reviewer');
    assert.equal(r, null, 'git stash show should be allowed');
  });

  test('debugger + git clean -fd → blocked', () => {
    const r = findForbiddenPattern('git clean -fd', 'debugger');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('researcher + git restore . → blocked', () => {
    const r = findForbiddenPattern('git restore .', 'researcher');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('ux-critic + git reset HEAD → blocked', () => {
    const r = findForbiddenPattern('git reset HEAD', 'ux-critic');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('platform-oracle + git checkout -- . → blocked', () => {
    const r = findForbiddenPattern('git checkout -- .', 'platform-oracle');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('project-intent + git stash → blocked', () => {
    const r = findForbiddenPattern('git stash', 'project-intent');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });
});

describe('v238 wt_destructive_git — unit: alsoBlockWhenMainCheckout', () => {
  const { findForbiddenPattern } = mod;

  test('developer + git stash in main checkout → blocked', () => {
    const r = findForbiddenPattern('git stash', 'developer', { isMain: true, isReadOnly: false });
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('developer + git stash in own worktree → allowed', () => {
    const r = findForbiddenPattern('git stash', 'developer', { isMain: false, isReadOnly: false });
    assert.equal(r, null, 'developer git stash in own worktree should be allowed');
  });

  test('developer + git reset --soft HEAD~1 in main → allowed (--soft exempted)', () => {
    const r = findForbiddenPattern('git reset --soft HEAD~1', 'developer', { isMain: true, isReadOnly: false });
    assert.equal(r, null, 'git reset --soft should be allowed even in main checkout');
  });

  test('developer + git checkout -- . in main → blocked', () => {
    const r = findForbiddenPattern('git checkout -- .', 'developer', { isMain: true, isReadOnly: false });
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('pm + git stash in main → blocked (pm not in allowedRoles but alsoBlockWhenMainCheckout)', () => {
    const r = findForbiddenPattern('git stash', 'pm', { isMain: true, isReadOnly: false });
    assert.ok(r, 'pm in main checkout stash should be blocked');
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('pm + git stash in own worktree → allowed', () => {
    const r = findForbiddenPattern('git stash', 'pm', { isMain: false, isReadOnly: false });
    assert.equal(r, null, 'pm in own worktree stash should be allowed');
  });

  test('developer + chained cd && git clean in main → blocked', () => {
    const r = findForbiddenPattern('cd /tmp && git clean -fd', 'developer', { isMain: true, isReadOnly: false });
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });
});

// ---------------------------------------------------------------------------
// Integration: hook running against real git repos
// ---------------------------------------------------------------------------

/**
 * Create a minimal git repo in a temp dir. Returns the root path.
 */
function createGitRepo(suffix = '') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `v238-git-${suffix || 'main'}-`));
  execSync('git init', { cwd: tmp });
  execSync('git config user.email "test@example.com"', { cwd: tmp });
  execSync('git config user.name "Test"', { cwd: tmp });
  fs.writeFileSync(path.join(tmp, 'README.md'), 'hello');
  execSync('git add .', { cwd: tmp });
  execSync('git commit -m "init"', { cwd: tmp });
  return tmp;
}

/**
 * Create a linked worktree from mainRepo. Returns the worktree path.
 */
function createLinkedWorktree(mainRepo) {
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'v238-wt-'));
  // Remove the auto-created dir so git can create it
  fs.rmdirSync(wtPath);
  execSync(`git worktree add --detach "${wtPath}" HEAD`, { cwd: mainRepo });
  return wtPath;
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}

function runHook(payload, hookCwd, env = {}) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: hookCwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  return res;
}

function readAuditEvents(hookCwd) {
  const p = path.join(hookCwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function bashPayload(command, role) {
  const p = {
    tool_name: 'Bash',
    tool_input: { command },
  };
  if (role !== undefined) p.agent_role = role;
  return p;
}

describe('v238 wt_destructive_git — integration: reviewer blocked always', () => {
  test('reviewer + git stash → exit 2 + git_destructive_blocked event', () => {
    const mainRepo = createGitRepo('rm1');
    try {
      const res = runHook(bashPayload('git stash', 'reviewer'), mainRepo);
      assert.equal(res.status, 2, 'reviewer git stash must exit 2. stderr=' + res.stderr.slice(0, 200));
      const events = readAuditEvents(mainRepo);
      const ev = events.find(e => e.type === 'git_destructive_blocked');
      assert.ok(ev, 'git_destructive_blocked event must be emitted');
      assert.equal(ev.violation_type, 'wt_destructive_git');
      assert.equal(ev.agent_role, 'reviewer');
    } finally {
      cleanup(mainRepo);
    }
  });

  test('reviewer + git stash list → exit 0 (allowed)', () => {
    const mainRepo = createGitRepo('rm2');
    try {
      const res = runHook(bashPayload('git stash list', 'reviewer'), mainRepo);
      assert.equal(res.status, 0, 'reviewer git stash list must be allowed. stderr=' + res.stderr.slice(0, 200));
    } finally {
      cleanup(mainRepo);
    }
  });

  test('reviewer + git stash show → exit 0 (allowed)', () => {
    const mainRepo = createGitRepo('rm3');
    try {
      const res = runHook(bashPayload('git stash show', 'reviewer'), mainRepo);
      assert.equal(res.status, 0, 'reviewer git stash show must be allowed');
    } finally {
      cleanup(mainRepo);
    }
  });
});

describe('v238 wt_destructive_git — integration: developer in own worktree vs main', () => {
  test('developer + git checkout -- . cwd=main → exit 2', () => {
    const mainRepo = createGitRepo('dm1');
    try {
      const res = runHook(bashPayload('git checkout -- .', 'developer'), mainRepo);
      assert.equal(res.status, 2, 'developer checkout in main must exit 2. stderr=' + res.stderr.slice(0, 200));
    } finally {
      cleanup(mainRepo);
    }
  });

  test('developer + git checkout -- . cwd=own-worktree → exit 0', () => {
    const mainRepo = createGitRepo('dm2');
    let wtPath;
    try {
      wtPath = createLinkedWorktree(mainRepo);
      const res = runHook(bashPayload('git checkout -- .', 'developer'), wtPath);
      assert.equal(res.status, 0, 'developer checkout in own worktree must be allowed. stderr=' + res.stderr.slice(0, 200));
    } finally {
      cleanup(mainRepo, wtPath);
    }
  });

  test('developer + git reset --soft HEAD~1 own worktree → exit 0', () => {
    const mainRepo = createGitRepo('dm3');
    let wtPath;
    try {
      wtPath = createLinkedWorktree(mainRepo);
      const res = runHook(bashPayload('git reset --soft HEAD~1', 'developer'), wtPath);
      assert.equal(res.status, 0, 'developer git reset --soft in own worktree must be allowed');
    } finally {
      cleanup(mainRepo, wtPath);
    }
  });
});

describe('v238 wt_destructive_git — integration: git -C evasion blocked', () => {
  test('git -C <mainRepo> reset --hard from any cwd → exit 2', () => {
    const mainRepo = createGitRepo('ev1');
    let wtPath;
    try {
      wtPath = createLinkedWorktree(mainRepo);
      // Run from worktree cwd but target main via -C
      const cmd = `git -C ${mainRepo} reset --hard`;
      const res = runHook(bashPayload(cmd, 'developer'), wtPath);
      assert.equal(res.status, 2, 'git -C main reset --hard must be blocked. stderr=' + res.stderr.slice(0, 200));
    } finally {
      cleanup(mainRepo, wtPath);
    }
  });
});

describe('v238 wt_destructive_git — integration: chained command blocked', () => {
  test('cd x && git clean -fd (chained) → exit 2', () => {
    const mainRepo = createGitRepo('ch1');
    try {
      const res = runHook(bashPayload('cd /tmp && git clean -fd', 'developer'), mainRepo);
      assert.equal(res.status, 2, 'chained git clean must be blocked. stderr=' + res.stderr.slice(0, 200));
    } finally {
      cleanup(mainRepo);
    }
  });
});

describe('v238 wt_destructive_git — integration: pm/no-role in own worktree', () => {
  test('no-role (pm context) + git stash in own worktree → exit 0', () => {
    const mainRepo = createGitRepo('pm1');
    let wtPath;
    try {
      wtPath = createLinkedWorktree(mainRepo);
      // No agent_role field — pm/orchestrator context
      const res = runHook({ tool_name: 'Bash', tool_input: { command: 'git stash' } }, wtPath);
      assert.equal(res.status, 0, 'unroled agent in own worktree should not be blocked. stderr=' + res.stderr.slice(0, 200));
    } finally {
      cleanup(mainRepo, wtPath);
    }
  });
});

// ---------------------------------------------------------------------------
// worktree-create.js twin-idempotency tests
// ---------------------------------------------------------------------------

describe('v238 worktree-create twin-idempotency', () => {
  /**
   * Run worktree-create.js with given stdin payload.
   */
  function runWorktreeCreate(payload, cwd) {
    const res = spawnSync('node', [WORKTREE_CREATE], {
      input: JSON.stringify(payload),
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env },
    });
    return res;
  }

  test('first invocation creates worktree and exits 0', () => {
    const mainRepo = createGitRepo('wc1');
    try {
      const agentName = 'test-agent-wc1';
      const res = runWorktreeCreate({ name: agentName, cwd: mainRepo }, mainRepo);
      assert.equal(res.status, 0, 'first create must succeed. stderr=' + res.stderr.slice(0, 300));
      const wtPath = path.join(mainRepo, '.claude', 'worktrees', agentName);
      assert.ok(fs.existsSync(wtPath), 'worktree dir must exist');
      assert.ok(res.stdout.trim().endsWith(agentName), 'stdout must contain worktree path');
    } finally {
      cleanup(mainRepo);
    }
  });

  test('second invocation (twin) with same agent name exits 0 (idempotent)', () => {
    const mainRepo = createGitRepo('wc2');
    try {
      const agentName = 'test-agent-wc2';
      const payload = { name: agentName, cwd: mainRepo };

      // First invocation
      const r1 = runWorktreeCreate(payload, mainRepo);
      assert.equal(r1.status, 0, 'first create must succeed');

      // Second invocation — twin scenario
      const r2 = runWorktreeCreate(payload, mainRepo);
      assert.equal(r2.status, 0, 'second (twin) invocation must exit 0 (idempotent). stderr=' + r2.stderr.slice(0, 300));

      // The worktree path must still be printed
      const wtPath = path.join(mainRepo, '.claude', 'worktrees', agentName);
      assert.ok(r2.stdout.trim().endsWith(agentName), 'twin must output worktree path');
      assert.ok(fs.existsSync(wtPath), 'worktree must still exist after twin');

      // Confirm it is still a valid registered worktree
      const listRes = spawnSync('git', ['-C', mainRepo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
      assert.ok(listRes.stdout.includes(agentName), 'worktree must remain registered after twin');
    } finally {
      cleanup(mainRepo);
    }
  });

  test('worktreeAlreadyValid returns false for non-existent path', () => {
    // The exported module only has the functions we test via integration;
    // the worktreeAlreadyValid helper is internal — tested via the twin scenario above.
    // This test verifies the hook exits 1 (not 0) for a completely invalid repo.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v238-nonrepo-'));
    try {
      const res = runWorktreeCreate({ name: 'agent-x', cwd: tmpDir }, tmpDir);
      assert.notEqual(res.status, 0, 'non-git dir must fail');
    } finally {
      cleanup(tmpDir);
    }
  });

  // F1 (v2.3.9): fresh worktree dir (mtime = now) must NOT be removed by twin B.
  // Simulates: twin A creates worktree, twin B runs and sees the fresh dir.
  // Twin B's first worktreeAlreadyValid() passes (already valid) → reuse, no removal.
  test('F1: twin B exits 0 and does not destroy A fresh worktree (post-exists re-check)', () => {
    const mainRepo = createGitRepo('f1toctou');
    try {
      const agentName = 'agent-f1-toctou';
      const payload = { name: agentName, cwd: mainRepo };

      // Twin A creates the worktree
      const r1 = runWorktreeCreate(payload, mainRepo);
      assert.equal(r1.status, 0, 'twin A must succeed. stderr=' + r1.stderr.slice(0, 300));

      const wtPath = path.join(mainRepo, '.claude', 'worktrees', agentName);
      assert.ok(fs.existsSync(wtPath), 'worktree dir must exist after twin A');

      // Twin B runs immediately after (fresh dir, mtime now) — must reuse, not destroy.
      const r2 = runWorktreeCreate(payload, mainRepo);
      assert.equal(r2.status, 0, 'twin B must exit 0 (reuse). stderr=' + r2.stderr.slice(0, 300));
      assert.ok(fs.existsSync(wtPath), 'twin B must NOT have destroyed twin A worktree');

      // Verify still registered
      const listRes = spawnSync('git', ['-C', mainRepo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
      assert.ok(listRes.stdout.includes(agentName), 'worktree still registered after twin B');
    } finally {
      cleanup(mainRepo);
    }
  });
});

// ---------------------------------------------------------------------------
// F2 (v2.3.9): tokenizer option-evasion tests
// ---------------------------------------------------------------------------

describe('v239 F2 — option-evasion tokenizer: extractGitSubcommand', () => {
  const { extractGitSubcommand } = mod;

  test('git stash → subcommand = stash', () => {
    const r = extractGitSubcommand('git stash');
    assert.equal(r.subcommand, 'stash');
    assert.equal(r.gitDirRedirected, false);
  });

  test('git -c k=v stash → subcommand = stash (option stripped)', () => {
    const r = extractGitSubcommand('git -c core.pager=cat stash');
    assert.equal(r.subcommand, 'stash');
  });

  test('git -c x=y -C /path stash → subcommand = stash', () => {
    const r = extractGitSubcommand('git -c x=y -C /tmp stash');
    assert.equal(r.subcommand, 'stash');
  });

  test('git --git-dir=/p/.git stash → gitDirRedirected=true', () => {
    const r = extractGitSubcommand('git --git-dir=/p/.git stash');
    assert.equal(r.subcommand, 'stash');
    assert.equal(r.gitDirRedirected, true);
  });

  test('git --no-pager -c k=v clean -fd → subcommand = clean', () => {
    const r = extractGitSubcommand('git --no-pager -c k=v clean -fd');
    assert.equal(r.subcommand, 'clean');
  });

  test('git status → subcommand = status (read-only, not blocked)', () => {
    const r = extractGitSubcommand('git status');
    assert.equal(r.subcommand, 'status');
  });
});

describe('v239 F2 — option-evasion: findForbiddenPattern blocks evasions', () => {
  const { findForbiddenPattern } = mod;

  test('reviewer + git -c k=v stash → blocked (evasion via -c)', () => {
    const r = findForbiddenPattern('git -c core.pager=cat stash', 'reviewer');
    assert.ok(r, 'reviewer -c evasion must be blocked');
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('reviewer + git -c x=y -C /path stash → blocked', () => {
    const r = findForbiddenPattern('git -c x=y -C /tmp stash', 'reviewer');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('reviewer + git --git-dir=/p/.git stash → blocked (fail-closed on redirect)', () => {
    const r = findForbiddenPattern('git --git-dir=/p/.git stash', 'reviewer');
    assert.ok(r, 'reviewer --git-dir redirect must fail-closed');
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('reviewer + git --no-pager -c k=v clean -fd → blocked', () => {
    const r = findForbiddenPattern('git --no-pager -c k=v clean -fd', 'reviewer');
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });

  test('reviewer + git -c k=v stash list → allowed (stash list is read-only)', () => {
    const r = findForbiddenPattern('git -c k=v stash list', 'reviewer');
    assert.equal(r, null, 'stash list with -c must still be allowed');
  });

  test('reviewer + git -c k=v reset --soft HEAD~1 → allowed', () => {
    const r = findForbiddenPattern('git -c k=v reset --soft HEAD~1', 'reviewer');
    assert.equal(r, null, 'reset --soft with -c must still be allowed');
  });

  test('developer in main checkout + git -c k=v stash → blocked', () => {
    const r = findForbiddenPattern('git -c k=v stash', 'developer', { isMain: true, isReadOnly: false });
    assert.ok(r);
    assert.equal(r.id, 'wt_destructive_git');
  });
});

describe('v239 F2 — option-evasion: isWtDestructiveGit', () => {
  const { isWtDestructiveGit } = mod;

  test('git -c k=v stash → true', () => {
    assert.equal(isWtDestructiveGit('git -c k=v stash'), true);
  });

  test('git -c k=v stash list → false', () => {
    assert.equal(isWtDestructiveGit('git -c k=v stash list'), false);
  });

  test('git --no-pager clean -fd → true', () => {
    assert.equal(isWtDestructiveGit('git --no-pager clean -fd'), true);
  });

  test('git status → false (non-destructive)', () => {
    assert.equal(isWtDestructiveGit('git status'), false);
  });

  test('no git token → false', () => {
    assert.equal(isWtDestructiveGit('ls -la'), false);
  });
});

// ---------------------------------------------------------------------------
// v2.3.32 W1/W2/W3 — `via` selection, message accuracy, blocked_via audit field.
//
// Prior to this fix, wt_destructive_git always printed the role-based
// "read-only agents must not mutate git state" description regardless of
// which of its two independent trigger paths fired. A non-read-only role
// blocked in the shared main checkout (alsoBlockWhenMainCheckout) saw a false
// claim about its own role and no actionable recovery path.
// ---------------------------------------------------------------------------

describe('v2332 W1/W2 — findForbiddenPattern via selection (unit)', () => {
  const { findForbiddenPattern } = mod;

  test('unknown non-read-only role + main checkout → via=main_checkout, message is NOT the read-only text', () => {
    const r = findForbiddenPattern('git checkout -- apps/x.h', 'envz38-fv', { isMain: true, isReadOnly: false });
    assert.ok(r, 'must be blocked');
    assert.equal(r.via, 'main_checkout');
    assert.ok(!/read-only agents/i.test(r.description), 'main_checkout message must not claim the role is read-only');
    assert.ok(/shared main checkout/i.test(r.description), 'main_checkout message must name the actual rule');
    assert.ok(/git show HEAD:/.test(r.description), 'main_checkout message must give the concrete recovery command');
    assert.ok(/Write tool/.test(r.description), 'main_checkout message must name the Write-tool follow-up');
  });

  test('reviewer (read-only role) → via=role, message keeps the read-only text', () => {
    const r = findForbiddenPattern('git stash', 'reviewer', { isMain: false, isReadOnly: true });
    assert.ok(r);
    assert.equal(r.via, 'role');
    assert.ok(/read-only agents/i.test(r.description));
  });

  test('reviewer in main checkout too → via=role wins over main_checkout', () => {
    const r = findForbiddenPattern('git stash', 'reviewer', { isMain: true, isReadOnly: true });
    assert.ok(r);
    assert.equal(r.via, 'role', 'role must win when both paths could apply');
    assert.ok(/read-only agents/i.test(r.description));
  });

  test('tester in main checkout → via=role (tester is on the destructive-git-blocked axis)', () => {
    const r = findForbiddenPattern('git reset --hard', 'tester', { isMain: true, isReadOnly: true });
    assert.ok(r);
    assert.equal(r.via, 'role');
  });
});

describe('v2332 W1/W2/W3 — integration: message + blocked_via via real hook', () => {
  test('unknown role in main checkout: git checkout -- f → exit 2, message says main-checkout not read-only, blocked_via=main_checkout', () => {
    const mainRepo = createGitRepo('w1a');
    try {
      const res = runHook(bashPayload('git checkout -- f', 'envz38-fv'), mainRepo);
      assert.equal(res.status, 2, 'stderr=' + res.stderr.slice(0, 300));
      assert.ok(!/read-only agents/i.test(res.stderr), 'must not claim the role is read-only. stderr=' + res.stderr);
      assert.ok(/shared main checkout/i.test(res.stderr), 'must name the main-checkout rule. stderr=' + res.stderr);
      assert.ok(/git show HEAD:/.test(res.stderr), 'must give the recovery command. stderr=' + res.stderr);
      const events = readAuditEvents(mainRepo);
      const ev = events.find(e => e.type === 'git_destructive_blocked');
      assert.ok(ev, 'git_destructive_blocked event must be emitted');
      assert.equal(ev.blocked_via, 'main_checkout');
    } finally {
      cleanup(mainRepo);
    }
  });

  test('reviewer in linked worktree: git stash → exit 2, message says read-only, blocked_via=role', () => {
    const mainRepo = createGitRepo('w1b');
    let wtPath;
    try {
      wtPath = createLinkedWorktree(mainRepo);
      const res = runHook(bashPayload('git stash', 'reviewer'), wtPath);
      assert.equal(res.status, 2, 'stderr=' + res.stderr.slice(0, 300));
      assert.ok(/read-only agents/i.test(res.stderr), 'stderr=' + res.stderr);
      const events = readAuditEvents(wtPath);
      const ev = events.find(e => e.type === 'git_destructive_blocked');
      assert.ok(ev, 'git_destructive_blocked event must be emitted');
      assert.equal(ev.blocked_via, 'role');
    } finally {
      cleanup(mainRepo, wtPath);
    }
  });

  test('reviewer in main checkout: git stash → exit 2, via=role wins over main_checkout', () => {
    const mainRepo = createGitRepo('w1c');
    try {
      const res = runHook(bashPayload('git stash', 'reviewer'), mainRepo);
      assert.equal(res.status, 2, 'stderr=' + res.stderr.slice(0, 300));
      assert.ok(/read-only agents/i.test(res.stderr), 'stderr=' + res.stderr);
      const events = readAuditEvents(mainRepo);
      const ev = events.find(e => e.type === 'git_destructive_blocked');
      assert.ok(ev, 'git_destructive_blocked event must be emitted');
      assert.equal(ev.blocked_via, 'role');
    } finally {
      cleanup(mainRepo);
    }
  });

  test('pm in main checkout: git stash → exit 0 (team-lead exemption unchanged)', () => {
    const mainRepo = createGitRepo('w1d');
    try {
      const res = runHook(bashPayload('git stash', 'pm'), mainRepo);
      assert.equal(res.status, 0, 'pm must remain exempt. stderr=' + res.stderr.slice(0, 300));
    } finally {
      cleanup(mainRepo);
    }
  });

  test('tester in main checkout: git reset --hard → exit 2', () => {
    const mainRepo = createGitRepo('w1e');
    try {
      const res = runHook(bashPayload('git reset --hard', 'tester'), mainRepo);
      assert.equal(res.status, 2, 'stderr=' + res.stderr.slice(0, 300));
    } finally {
      cleanup(mainRepo);
    }
  });

  test('any role: git status → exit 0 (read-only verb always allowed)', () => {
    const mainRepo = createGitRepo('w1f');
    try {
      const res1 = runHook(bashPayload('git status', 'envz38-fv'), mainRepo);
      assert.equal(res1.status, 0, 'stderr=' + res1.stderr.slice(0, 300));
      const res2 = runHook(bashPayload('git status', 'reviewer'), mainRepo);
      assert.equal(res2.status, 0, 'stderr=' + res2.stderr.slice(0, 300));
      const res3 = runHook(bashPayload('git status', 'pm'), mainRepo);
      assert.equal(res3.status, 0, 'stderr=' + res3.stderr.slice(0, 300));
    } finally {
      cleanup(mainRepo);
    }
  });
});
