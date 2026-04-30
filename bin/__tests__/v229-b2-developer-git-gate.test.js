#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.9 B-2.5 — gate-developer-git.js.
 *
 * Coverage:
 *   - developer attempting git push --force → exit 2 + event
 *   - developer attempting git push -f → exit 2
 *   - developer attempting git reset --hard origin/<branch> → exit 2
 *   - developer attempting git commit -m "release: ..." → exit 2
 *   - developer attempting normal git commit → exit 0
 *   - developer attempting normal git push → exit 0
 *   - non-developer role attempting force-push → exit 0 (not gated)
 *   - ORCHESTRAY_GIT_GATE_DISABLED=1 bypass
 *   - Non-Bash tool → pass-through
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../gate-developer-git.js');
const HOOK = path.resolve(__dirname, '..', 'gate-developer-git.js');

// ---------------------------------------------------------------------------
// Unit: findForbiddenPattern
// ---------------------------------------------------------------------------

describe('v229-b2.5 — findForbiddenPattern unit', () => {
  const { findForbiddenPattern } = mod;

  test('detects git push --force', () => {
    const r = findForbiddenPattern('git push origin main --force');
    assert.ok(r, 'should detect force push');
    assert.equal(r.id, 'force_push');
  });

  test('detects git push -f shorthand', () => {
    const r = findForbiddenPattern('git push -f origin main');
    assert.ok(r);
    assert.equal(r.id, 'force_push');
  });

  test('detects git push --force with no remote', () => {
    const r = findForbiddenPattern('git push --force');
    assert.ok(r);
    assert.equal(r.id, 'force_push');
  });

  test('detects git reset --hard origin/main', () => {
    const r = findForbiddenPattern('git reset --hard origin/main');
    assert.ok(r);
    assert.equal(r.id, 'hard_reset_origin');
  });

  test('detects git reset --hard origin/feature-branch', () => {
    const r = findForbiddenPattern('git reset --hard origin/v2.2.9-branch');
    assert.ok(r);
    assert.equal(r.id, 'hard_reset_origin');
  });

  test('allows git reset --hard HEAD (not origin)', () => {
    const r = findForbiddenPattern('git reset --hard HEAD');
    assert.equal(r, null, 'git reset --hard HEAD is not forbidden');
  });

  test('detects git commit with release: prefix', () => {
    const r = findForbiddenPattern('git commit -m "release: v2.2.9"');
    assert.ok(r);
    assert.equal(r.id, 'release_commit');
  });

  test('detects git commit with release: in single quotes', () => {
    const r = findForbiddenPattern("git commit -m 'release: v2.2.9 hotfix'");
    assert.ok(r);
    assert.equal(r.id, 'release_commit');
  });

  test('allows normal git commit', () => {
    const r = findForbiddenPattern('git commit -m "wip: add new feature"');
    assert.equal(r, null);
  });

  test('allows git commit without message', () => {
    const r = findForbiddenPattern('git commit --amend --no-edit');
    assert.equal(r, null);
  });

  test('allows normal git push', () => {
    const r = findForbiddenPattern('git push origin main');
    assert.equal(r, null);
  });

  test('returns null for non-git command', () => {
    const r = findForbiddenPattern('npm test');
    assert.equal(r, null);
  });

  test('returns null for empty string', () => {
    const r = findForbiddenPattern('');
    assert.equal(r, null);
  });

  test('does not fire on unrelated text containing force', () => {
    const r = findForbiddenPattern('npm run build --force');
    // This must NOT be detected — "git push" is not in the string
    assert.equal(r, null, 'npm --force should not be treated as git force push');
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveRole
// ---------------------------------------------------------------------------

describe('v229-b2.5 — resolveRole unit', () => {
  const { resolveRole } = mod;

  test('reads from agent_role', () => {
    assert.equal(resolveRole({ agent_role: 'developer' }), 'developer');
  });

  test('reads from subagent_type', () => {
    assert.equal(resolveRole({ subagent_type: 'Developer' }), 'developer');
  });

  test('returns null when missing', () => {
    assert.equal(resolveRole({}), null);
  });
});

// ---------------------------------------------------------------------------
// Integration: hook behavior
// ---------------------------------------------------------------------------

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b25-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  return { ...res, tmp };
}

function readAuditEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

function bashPayload(command, env_role = 'developer') {
  return {
    tool_name: 'Bash',
    agent_role: env_role,
    tool_input: { command },
  };
}

describe('v229-b2.5 — integration: forbidden git commands blocked for developer', () => {
  test('git push --force → exit 2 + developer_git_violation event', () => {
    const r = runHook(bashPayload('git push origin main --force'));
    assert.equal(r.status, 2, 'force push should be blocked. stderr=' + r.stderr.slice(0, 200));
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev, 'developer_git_violation event must be emitted');
    assert.equal(ev.violation_type, 'force_push');
    assert.equal(ev.agent_role, 'developer');
    cleanup(r.tmp);
  });

  test('git push -f → exit 2', () => {
    const r = runHook(bashPayload('git push -f origin main'));
    assert.equal(r.status, 2, 'git push -f should be blocked');
    cleanup(r.tmp);
  });

  test('git reset --hard origin/main → exit 2 + event', () => {
    const r = runHook(bashPayload('git reset --hard origin/main'));
    assert.equal(r.status, 2);
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev);
    assert.equal(ev.violation_type, 'hard_reset_origin');
    cleanup(r.tmp);
  });

  test('git commit -m "release: v2.2.9" → exit 2 + event', () => {
    const r = runHook(bashPayload('git commit -m "release: v2.2.9"'));
    assert.equal(r.status, 2);
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev);
    assert.equal(ev.violation_type, 'release_commit');
    cleanup(r.tmp);
  });
});

describe('v229-b2.5 — integration: safe git commands pass', () => {
  test('normal git commit → exit 0', () => {
    const r = runHook(bashPayload('git commit -m "wip: v2.2.9 B-2 implementation"'));
    assert.equal(r.status, 0, 'normal commit should pass. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('normal git push (no force) → exit 0', () => {
    const r = runHook(bashPayload('git push origin main'));
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('git status → exit 0', () => {
    const r = runHook(bashPayload('git status'));
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('git diff HEAD → exit 0', () => {
    const r = runHook(bashPayload('git diff HEAD'));
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });
});

describe('v229-b2.5 — integration: non-developer/release-manager roles not gated', () => {
  // FN-48 (v2.2.15): release-manager IS now gated; see dedicated suite below.

  test('reviewer calling git → exit 0', () => {
    const r = runHook(bashPayload('git push -f', 'reviewer'));
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('architect calling git push → exit 0', () => {
    const r = runHook(bashPayload('git push origin main', 'architect'));
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// FN-48 (v2.2.15): release-manager push/tag block.
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-48 — release-manager push/tag block', () => {
  test('release-manager `git push origin main` → exit 2 (any push form blocked)', () => {
    const r = runHook(bashPayload('git push origin main', 'release-manager'));
    assert.equal(r.status, 2, 'release-manager push must block. stderr=' + r.stderr.slice(0, 200));
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev, 'developer_git_violation event must be emitted');
    assert.equal(ev.violation_type, 'release_manager_push');
    assert.equal(ev.agent_role, 'release-manager');
    cleanup(r.tmp);
  });

  test('release-manager `git tag -a v2.2.15` → exit 2', () => {
    const r = runHook(bashPayload('git tag -a v2.2.15 -m "release"', 'release-manager'));
    assert.equal(r.status, 2);
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev);
    assert.equal(ev.violation_type, 'release_manager_tag_write');
    cleanup(r.tmp);
  });

  test('developer `git push origin main` (non-force) → exit 0 (not blocked for developer)', () => {
    const r = runHook(bashPayload('git push origin main', 'developer'));
    assert.equal(r.status, 0, 'developer non-force push remains allowed');
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// FN-46 (v2.2.15): commit-trailer regex (Co-Authored-By, Generated with Claude).
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-46 — commit trailer regex', () => {
  test('developer commit with Co-Authored-By: → exit 2', () => {
    const r = runHook(bashPayload(
      'git commit -m "wip: foo\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
      'developer'
    ));
    assert.equal(r.status, 2, 'Co-Authored-By trailer must block. stderr=' + r.stderr.slice(0, 200));
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev);
    assert.equal(ev.violation_type, 'co_authored_by_trailer');
    cleanup(r.tmp);
  });

  test('developer commit with "Generated with Claude" → exit 2', () => {
    const r = runHook(bashPayload(
      'git commit -m "wip: foo\n\nGenerated with [Claude Code]"',
      'developer'
    ));
    assert.equal(r.status, 2, 'Generated with Claude trailer must block. stderr=' + r.stderr.slice(0, 200));
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'developer_git_violation');
    assert.ok(ev);
    assert.equal(ev.violation_type, 'generated_with_claude_trailer');
    cleanup(r.tmp);
  });

  test('developer normal commit (no trailer) → exit 0', () => {
    const r = runHook(bashPayload('git commit -m "wip: normal commit, no trailers"', 'developer'));
    assert.equal(r.status, 0, 'normal commit must pass. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});

describe('v229-b2.5 — integration: kill switch and non-Bash tools', () => {
  test('ORCHESTRAY_GIT_GATE_DISABLED=1 allows force push for developer', () => {
    const r = runHook(
      bashPayload('git push --force'),
      { ORCHESTRAY_GIT_GATE_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch should bypass check');
    cleanup(r.tmp);
  });

  test('non-Bash tool (Edit) with developer role → pass-through', () => {
    const r = runHook({
      tool_name: 'Edit',
      agent_role: 'developer',
      tool_input: { file_path: 'bin/foo.js', command: 'git push --force' },
    });
    assert.equal(r.status, 0, 'non-Bash tool must not be gated');
    cleanup(r.tmp);
  });
});
