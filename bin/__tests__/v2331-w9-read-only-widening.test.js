#!/usr/bin/env node
'use strict';

/**
 * v2331-w9-read-only-widening.test.js — v2.3.31 W9 (operator-approved widening).
 *
 * Pipes real payloads through the real hooks (spawnSync) and asserts real
 * exit codes, matching the coverage table in the delegation delta:
 *
 *   | role                                   | action                          | expect |
 *   |-----------------------------------------|--------------------------------|--------|
 *   | researcher                               | Write outside allowlist         | BLOCK  |
 *   | researcher                               | Write inside allowlist          | ALLOW  |
 *   | ux-critic / platform-oracle               | same pair                       | BLOCK/ALLOW |
 *   | tester                                    | git stash                       | BLOCK  |
 *   | tester                                    | git commit -m x                 | ALLOW  |
 *   | documenter                                | git reset --hard                | BLOCK  |
 *   | pm                                        | git stash                       | ALLOW (unchanged) |
 *   | reviewer                                  | SubagentStop, write inside allowlist | pass |
 *   | reviewer                                  | SubagentStop, write outside allowlist | fail |
 *   | each kill switch set                      | prior behaviour restored        |        |
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WRITE_GATE = path.resolve(__dirname, '..', 'gate-role-write-paths.js');
const GIT_GATE = path.resolve(__dirname, '..', 'gate-developer-git.js');
const T15_HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

function runNode(hookPath, payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2331-w9-'));
  const res = spawnSync('node', [hookPath], {
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

function writePayload(role, filePath) {
  return { tool_name: 'Write', agent_role: role, tool_input: { file_path: filePath } };
}

function bashPayload(command, role) {
  return { tool_name: 'Bash', agent_role: role, tool_input: { command } };
}

const VALID_RESULT_BASE = {
  status: 'success',
  summary: 'ok',
  files_changed: [],
  files_read: ['/tmp/x.md'],
  issues: [],
  assumptions: [],
};

// Per-role required_extra fields (bin/_lib/role-schemas.js) — the axis-4
// check runs before the HARD_TIER schema check, but an in-scope-write test
// still needs a schema-valid payload to reach exit 0 rather than tripping a
// later, unrelated hard-tier rejection.
const ROLE_EXTRA_FIELDS = {
  reviewer: { verdict: 'approve', rubric_scores: [], always_on_dimensions: ['correctness'] },
  debugger: { root_cause: 'test fixture', repro_confirmed: true, fix_location_hint: 'n/a' },
};

function stopPayload(role, toolCalls) {
  const result = { ...VALID_RESULT_BASE, ...(ROLE_EXTRA_FIELDS[role] || {}) };
  return {
    hook_event_name: 'SubagentStop',
    subagent_type: role,
    tool_calls: toolCalls,
    output: '## Structured Result\n```json\n' + JSON.stringify(result) + '\n```\n',
  };
}

// ---------------------------------------------------------------------------
// 1. Write-path allowlists — researcher, ux-critic, platform-oracle
// ---------------------------------------------------------------------------

describe('W9 §1 — write-path allowlist widening', () => {
  const IN_SCOPE = ['researcher', 'ux-critic'].map(role => [role, '.orchestray/kb/artifacts/x.md']);

  for (const [role, filePath] of IN_SCOPE) {
    test(role + ' writing inside .orchestray/kb/artifacts/ → exit 0', () => {
      const r = runNode(WRITE_GATE, writePayload(role, filePath));
      assert.equal(r.status, 0, role + ' in-scope write should pass. stderr=' + r.stderr.slice(0, 200));
      cleanup(r.tmp);
    });
  }

  for (const role of ['researcher', 'ux-critic', 'platform-oracle']) {
    test(role + ' writing outside its allowlist (bin/foo.js) → exit 2', () => {
      const r = runNode(WRITE_GATE, writePayload(role, 'bin/foo.js'));
      assert.equal(r.status, 2, role + ' out-of-scope write must block');
      const events = readAuditEvents(r.tmp);
      const blocked = events.find(e => e.type === 'role_write_path_blocked');
      assert.ok(blocked, 'role_write_path_blocked event must be emitted');
      assert.equal(blocked.agent_role, role);
      cleanup(r.tmp);
    });
  }

  test('platform-oracle writes inside .orchestray/kb/artifacts/ → exit 0, outside → exit 2', () => {
    // v2.3.31 W9: scoped to the same KB-artifacts path as its sibling read-tier
    // roles rather than deny-all. It has no documented write target today, but
    // it still carries a Write grant, and an empty allowlist would fail closed
    // with no signal if one were ever added.
    const ok = runNode(WRITE_GATE, writePayload('platform-oracle', '.orchestray/kb/artifacts/x.md'));
    assert.equal(ok.status, 0, 'KB artifact write must be allowed');
    cleanup(ok.tmp);
    const bad = runNode(WRITE_GATE, writePayload('platform-oracle', 'bin/evil.js'));
    assert.equal(bad.status, 2, 'write outside the allowlist must block');
    cleanup(bad.tmp);
  });

  test('project-intent is absent from the write gate (Read-only frontmatter — needs no allowlist)', () => {
    // project-intent has no Write tool grant at all, so it is correctly absent
    // from RESTRICTED_ROLES; the gate passes through (not restricted) rather
    // than blocking — the real backstop is the frontmatter tool grant itself.
    const r = runNode(WRITE_GATE, writePayload('project-intent', 'anything.md'));
    assert.equal(r.status, 0, 'project-intent is not in RESTRICTED_ROLES; gate passes through');
    cleanup(r.tmp);
  });

  test('kill switch ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED=1 restores unrestricted write for the 3 W9 roles', () => {
    for (const role of ['researcher', 'ux-critic', 'platform-oracle']) {
      const r = runNode(
        WRITE_GATE,
        writePayload(role, 'bin/foo.js'),
        { ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED: '1' }
      );
      assert.equal(r.status, 0, role + ' should be unrestricted when the W9 kill switch is set');
      cleanup(r.tmp);
    }
  });

  test('kill switch does not loosen a pre-existing restricted role (reviewer)', () => {
    const r = runNode(
      WRITE_GATE,
      writePayload('reviewer', 'bin/foo.js'),
      { ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED: '1' }
    );
    assert.equal(r.status, 2, 'reviewer must remain gated — the W9 kill switch only covers the 3 new roles');
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// 2. Destructive-git block — tester, documenter
// ---------------------------------------------------------------------------

describe('W9 §2 — destructive-git block for tester/documenter', () => {
  test('tester `git stash` → exit 2', () => {
    const r = runNode(GIT_GATE, bashPayload('git stash', 'tester'));
    assert.equal(r.status, 2, 'stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('tester `git commit -m x` → exit 0 (commit unaffected)', () => {
    const r = runNode(GIT_GATE, bashPayload('git commit -m "x"', 'tester'));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('tester `git push origin main` → exit 0 (push unaffected)', () => {
    const r = runNode(GIT_GATE, bashPayload('git push origin main', 'tester'));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('documenter `git reset --hard` → exit 2', () => {
    const r = runNode(GIT_GATE, bashPayload('git reset --hard HEAD~1', 'documenter'));
    assert.equal(r.status, 2, 'stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('documenter `git commit -m x` → exit 0', () => {
    const r = runNode(GIT_GATE, bashPayload('git commit -m "x"', 'documenter'));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('documenter `git push origin main` → exit 0', () => {
    const r = runNode(GIT_GATE, bashPayload('git push origin main', 'documenter'));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('pm `git stash` → exit 0 (unchanged — pm is exempt)', () => {
    const r = runNode(GIT_GATE, bashPayload('git stash', 'pm'));
    assert.equal(r.status, 0, 'pm must remain exempt from destructive-git blocking');
    cleanup(r.tmp);
  });

  test('the original 6 git-blocked roles are unaffected — reviewer `git stash` still blocks', () => {
    const r = runNode(GIT_GATE, bashPayload('git stash', 'reviewer'));
    assert.equal(r.status, 2, 'reviewer must remain destructive-git blocked');
    cleanup(r.tmp);
  });

  test('kill switch ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED=1 restores tester `git stash`', () => {
    const r = runNode(
      GIT_GATE,
      bashPayload('git stash', 'tester'),
      { ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch should restore pre-W9 unrestricted git for tester');
    cleanup(r.tmp);
  });

  test('kill switch does not loosen a pre-existing git-blocked role (reviewer)', () => {
    const r = runNode(
      GIT_GATE,
      bashPayload('git stash', 'reviewer'),
      { ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED: '1' }
    );
    assert.equal(r.status, 2, 'reviewer must remain blocked — the W9 kill switch only covers tester/documenter');
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime allowlist verification — reviewer, debugger (SubagentStop)
// ---------------------------------------------------------------------------

describe('W9 §3 — allowlist-scoped SubagentStop verification for reviewer/debugger', () => {
  test('reviewer: SubagentStop write inside allowlist → exit 0', () => {
    const r = runNode(T15_HOOK, stopPayload('reviewer', [
      { name: 'Write', tool_input: { file_path: '.orchestray/kb/artifacts/review.md' } },
    ]));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('reviewer: SubagentStop write outside allowlist → exit 2 + stop_allowlist_violation_blocked event', () => {
    const r = runNode(T15_HOOK, stopPayload('reviewer', [
      { name: 'Write', tool_input: { file_path: 'bin/gate-developer-git.js' } },
    ]));
    assert.equal(r.status, 2, 'stderr=' + r.stderr.slice(0, 300));
    const events = readAuditEvents(r.tmp);
    const ev = events.find(e => e.type === 'stop_allowlist_violation_blocked');
    assert.ok(ev, 'stop_allowlist_violation_blocked event must be emitted');
    assert.equal(ev.agent_role, 'reviewer');
    assert.ok(Array.isArray(ev.attempted_paths) && ev.attempted_paths.includes('bin/gate-developer-git.js'));
    cleanup(r.tmp);
  });

  test('debugger: SubagentStop write outside allowlist → exit 2', () => {
    const r = runNode(T15_HOOK, stopPayload('debugger', [
      { name: 'Edit', tool_input: { file_path: 'README.md' } },
    ]));
    assert.equal(r.status, 2, 'stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('debugger: SubagentStop write inside allowlist → exit 0', () => {
    const r = runNode(T15_HOOK, stopPayload('debugger', [
      { name: 'Write', tool_input: { file_path: '.orchestray/kb/artifacts/debug.md' } },
    ]));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('reviewer with no write tool calls (pure review) → exit 0', () => {
    const r = runNode(T15_HOOK, stopPayload('reviewer', [{ name: 'Read' }]));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('haiku-scout (axis-3 role, not axis-4) is unaffected by the new check', () => {
    // haiku-scout stays on axis 3 (zero writes) — the axis-4 addition must not
    // touch its existing enforcement path.
    const r = runNode(T15_HOOK, stopPayload('haiku-scout', [{ name: 'Read' }]));
    assert.equal(r.status, 0, 'stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('kill switch ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED=1 disables the axis-4 check', () => {
    const r = runNode(
      T15_HOOK,
      stopPayload('reviewer', [{ name: 'Write', tool_input: { file_path: 'bin/gate-developer-git.js' } }]),
      { ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch should disable axis-4 enforcement entirely');
    cleanup(r.tmp);
  });
});
