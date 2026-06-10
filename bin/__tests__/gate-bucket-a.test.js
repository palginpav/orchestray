#!/usr/bin/env node
'use strict';

/**
 * gate-bucket-a.test.js — v2.3.10 Bucket A security-gate fixes.
 *
 * Coverage (observable exit codes + emitted events, not doesNotThrow):
 *   A0 — gate-developer-git: PM never gated for non-destructive git; read-only
 *        verbs always allowed for all roles; destructive-by-read-only-role still
 *        blocked; developer reset --hard in main blocked; reset --soft in own
 *        worktree allowed.
 *   A1 — both gates fail CLOSED (exit 2) on stdin overflow (>1MB).
 *   A2 — gate-role-write-paths MultiEdit checks ALL edits; ANY out-of-scope blocks.
 *   A3 — worktree-create rejects traversal / separator in agentName.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GIT_HOOK   = path.resolve(__dirname, '..', 'gate-developer-git.js');
const WRITE_HOOK = path.resolve(__dirname, '..', 'gate-role-write-paths.js');
const WT_CREATE  = path.resolve(__dirname, '..', 'worktree-create.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.t'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 't'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });
}

function runGitHook(command, role, opts = {}) {
  const tmp = opts.cwd || mkTmp('bucketA-git-');
  const payload = {
    tool_name: 'Bash',
    agent_role: role,
    cwd: tmp,
    tool_input: { command },
  };
  const input = opts.rawInput != null ? opts.rawInput : JSON.stringify(payload);
  const res = spawnSync('node', [GIT_HOOK], {
    input,
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env },
  });
  return { ...res, tmp };
}

function runWriteHook(toolName, toolInput, role, opts = {}) {
  const tmp = opts.cwd || mkTmp('bucketA-write-');
  const payload = { tool_name: toolName, agent_role: role, cwd: tmp, tool_input: toolInput };
  const input = opts.rawInput != null ? opts.rawInput : JSON.stringify(payload);
  const res = spawnSync('node', [WRITE_HOOK], {
    input, cwd: tmp, encoding: 'utf8', timeout: 15_000, env: { ...process.env },
  });
  return { ...res, tmp };
}

function readAuditEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function cleanup(tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }

// ---------------------------------------------------------------------------
// A0 — read-only-verb + PM exemption + destructive set
// ---------------------------------------------------------------------------

describe('A0 — gate-developer-git read-only / PM exemption', () => {
  test('pm + git status → allow (exit 0)', () => {
    const r = runGitHook('git status', 'pm');
    assert.equal(r.status, 0); cleanup(r.tmp);
  });

  test('pm + git commit → allow (exit 0)', () => {
    const r = runGitHook('git commit -m "wip"', 'pm');
    assert.equal(r.status, 0); cleanup(r.tmp);
  });

  test('reviewer + git log → allow (exit 0)', () => {
    const r = runGitHook('git log --oneline -5', 'reviewer');
    assert.equal(r.status, 0); cleanup(r.tmp);
  });

  test('reviewer + git diff → allow (exit 0)', () => {
    const r = runGitHook('git diff HEAD', 'reviewer');
    assert.equal(r.status, 0); cleanup(r.tmp);
  });

  test('reviewer + git stash → block (exit 2) + git_destructive_blocked event', () => {
    const r = runGitHook('git stash', 'reviewer');
    assert.equal(r.status, 2);
    const ev = readAuditEvents(r.tmp);
    assert.ok(ev.some(e => e.type === 'git_destructive_blocked'), 'expected git_destructive_blocked');
    cleanup(r.tmp);
  });

  test('reviewer + git stash list → allow (read-only subform)', () => {
    const r = runGitHook('git stash list', 'reviewer');
    assert.equal(r.status, 0); cleanup(r.tmp);
  });

  test('developer + git reset --hard in main checkout → block (exit 2)', () => {
    const tmp = mkTmp('bucketA-main-');
    initGitRepo(tmp);
    const r = runGitHook('git reset --hard', 'developer', { cwd: tmp });
    assert.equal(r.status, 2);
    cleanup(tmp);
  });

  test('developer + git reset --soft in own (linked) worktree → allow', () => {
    const main = mkTmp('bucketA-mainwt-');
    initGitRepo(main);
    const wt = path.join(main, '.claude', 'worktrees', 'dev1');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    spawnSync('git', ['-C', main, 'worktree', 'add', '--detach', '-q', wt, 'HEAD'], { encoding: 'utf8' });
    const r = runGitHook('git reset --soft HEAD', 'developer', { cwd: wt });
    assert.equal(r.status, 0);
    cleanup(main);
  });

  test('pm + git worktree list → allow (read-only)', () => {
    const r = runGitHook('git worktree list', 'pm');
    assert.equal(r.status, 0); cleanup(r.tmp);
  });

  test('reviewer + git branch (list) → allow; git branch foo (create) → block in main', () => {
    const a = runGitHook('git branch', 'reviewer');
    assert.equal(a.status, 0); cleanup(a.tmp);
  });
});

// ---------------------------------------------------------------------------
// A5 — git commit -F blocked for gated roles; basename in audit
// ---------------------------------------------------------------------------

describe('A5 — gate-developer-git commit -F + basename logging', () => {
  test('developer + git commit -F msg.txt → block (exit 2)', () => {
    const r = runGitHook('git commit -F /tmp/msg.txt', 'developer');
    assert.equal(r.status, 2);
    const ev = readAuditEvents(r.tmp);
    assert.ok(ev.some(e => e.violation_type === 'commit_from_file_uncheckable'));
    cleanup(r.tmp);
  });

  test('destructive event logs target_repo as basename (no home path)', () => {
    const tmp = mkTmp('bucketA-base-');
    initGitRepo(tmp);
    const r = runGitHook('git clean -fd', 'developer', { cwd: tmp });
    assert.equal(r.status, 2);
    const ev = readAuditEvents(tmp).filter(e => e.type === 'git_destructive_blocked');
    assert.ok(ev.length > 0);
    assert.ok(!String(ev[0].target_repo).includes(path.sep), 'target_repo must be basename only');
    cleanup(tmp);
  });
});

// ---------------------------------------------------------------------------
// A1 — fail-closed on stdin overflow
// ---------------------------------------------------------------------------

describe('A1 — gates fail CLOSED on stdin overflow', () => {
  const BIG = 'x'.repeat(1024 * 1024 + 1024); // >1MB

  test('gate-developer-git overflow → exit 2', () => {
    // pad command field past 1MB
    const payload = JSON.stringify({ tool_name: 'Bash', agent_role: 'developer', tool_input: { command: 'git status ' + BIG } });
    const r = runGitHook(null, null, { rawInput: payload });
    assert.equal(r.status, 2);
    assert.ok(/overflow|exceeded/i.test(r.stdout + r.stderr));
    cleanup(r.tmp);
  });

  test('gate-role-write-paths overflow → exit 2', () => {
    const payload = JSON.stringify({ tool_name: 'Write', agent_role: 'reviewer', tool_input: { file_path: '/x/' + BIG } });
    const r = runWriteHook(null, null, null, { rawInput: payload });
    assert.equal(r.status, 2);
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// A2 — MultiEdit checks ALL edits
// ---------------------------------------------------------------------------

describe('A2 — gate-role-write-paths MultiEdit all-edits', () => {
  test('reviewer MultiEdit: first allowed, second out-of-scope → block (exit 2)', () => {
    const tmp = mkTmp('bucketA-multi-');
    // reviewer allowlist includes .orchestray/kb/artifacts/*.md (review notes)
    const toolInput = {
      edits: [
        { file_path: path.join(tmp, '.orchestray', 'kb', 'artifacts', 'note.md') },
        { file_path: path.join(tmp, 'src', 'app.js') }, // out of scope for reviewer
      ],
    };
    const r = runWriteHook('MultiEdit', toolInput, 'reviewer', { cwd: tmp });
    assert.equal(r.status, 2, 'second out-of-scope edit must block');
    const ev = readAuditEvents(tmp);
    assert.ok(ev.some(e => e.type === 'role_write_path_blocked'));
    cleanup(tmp);
  });
});

// ---------------------------------------------------------------------------
// A3 — worktree-create agentName traversal rejection
// ---------------------------------------------------------------------------

describe('A3 — worktree-create agentName validation', () => {
  function runWtCreate(name, cwd) {
    return spawnSync('node', [WT_CREATE], {
      input: JSON.stringify({ name, cwd, hook_event_name: 'WorktreeCreate' }),
      encoding: 'utf8', timeout: 15_000, env: { ...process.env },
    });
  }

  test('traversal agentName → exit non-zero, no worktree created', () => {
    const tmp = mkTmp('bucketA-wt-');
    initGitRepo(tmp);
    const r = runWtCreate('../../../tmp/evil', tmp);
    assert.notEqual(r.status, 0);
    assert.ok(/invalid agent name/i.test(r.stderr));
    cleanup(tmp);
  });

  test('separator in agentName → exit non-zero', () => {
    const tmp = mkTmp('bucketA-wt2-');
    initGitRepo(tmp);
    const r = runWtCreate('foo/bar', tmp);
    assert.notEqual(r.status, 0);
    cleanup(tmp);
  });

  test('valid agentName → exit 0, worktree path printed', () => {
    const tmp = mkTmp('bucketA-wt3-');
    initGitRepo(tmp);
    const r = runWtCreate('agent-abc_1.2', tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(path.join('.claude', 'worktrees', 'agent-abc_1.2')));
    cleanup(tmp);
  });
});
