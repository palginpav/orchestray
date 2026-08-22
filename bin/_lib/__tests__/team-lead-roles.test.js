#!/usr/bin/env node
'use strict';

/**
 * Tests for team-lead-roles.js (v2.3.31 W8A).
 *
 * Coverage:
 *   - isTeamLead() membership + normalisation + null/undefined tolerance
 *   - isTeamLeadExemptionEnabled() precedence: env kill switch > config > default
 *   - Integration matrix via the real gate-developer-git.js hook (spawnSync),
 *     proving real process exit codes, not merely "did not throw":
 *       pm: all 5 destructive verbs ALLOWED in a real main-checkout repo
 *       pm + kill switch: BLOCKED (byte-identical to pre-W8A behaviour)
 *       read-only roles: still BLOCKED in main checkout AND linked worktree
 *       developer/release-manager role rules: unaffected
 *   - The team_lead_git_exemption_applied audit event is actually written
 *     and read back from the sink when the exemption fires.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../team-lead-roles');

const GATE = path.resolve(__dirname, '..', '..', 'gate-developer-git.js');

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('isTeamLead()', () => {
  test('pm is a team-lead role', () => {
    assert.equal(mod.isTeamLead('pm'), true);
  });

  test('normalises case and whitespace', () => {
    assert.equal(mod.isTeamLead('  PM  '), true);
    assert.equal(mod.isTeamLead('Pm'), true);
  });

  test('read-only and worker roles are not team-lead', () => {
    for (const r of ['reviewer', 'debugger', 'researcher', 'developer', 'release-manager']) {
      assert.equal(mod.isTeamLead(r), false, r);
    }
  });

  test('tolerates null/undefined/non-string without throwing', () => {
    assert.equal(mod.isTeamLead(null), false);
    assert.equal(mod.isTeamLead(undefined), false);
    assert.equal(mod.isTeamLead(42), false);
    assert.equal(mod.isTeamLead(''), false);
  });
});

describe('isTeamLeadExemptionEnabled()', () => {
  test('default: enabled with no env/config', () => {
    assert.equal(mod.isTeamLeadExemptionEnabled({}, {}), true);
  });

  test('env kill switch disables regardless of config', () => {
    const env = { ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED: '1' };
    assert.equal(mod.isTeamLeadExemptionEnabled(env, { team_lead: { git_exemption_enabled: true } }), false);
  });

  test('config can disable when env is absent', () => {
    assert.equal(mod.isTeamLeadExemptionEnabled({}, { team_lead: { git_exemption_enabled: false } }), false);
  });

  test('env kill switch value other than "1" does not disable', () => {
    assert.equal(mod.isTeamLeadExemptionEnabled({ ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED: 'true' }, {}), true);
  });

  test('malformed config does not throw and does not disable', () => {
    assert.equal(mod.isTeamLeadExemptionEnabled({}, null), true);
    assert.equal(mod.isTeamLeadExemptionEnabled({}, { team_lead: 'not-an-object' }), true);
    assert.equal(mod.isTeamLeadExemptionEnabled(undefined, undefined), true);
  });
});

// ---------------------------------------------------------------------------
// Integration matrix — real hook, real process exit codes
// ---------------------------------------------------------------------------

function makeMainRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w8a-main-'));
  spawnSync('git', ['init', '-q'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'x\n');
  spawnSync('git', ['add', 'f.txt'], { cwd: tmp });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmp });
  return tmp;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function runGate(command, role, cwd, extraEnv) {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({
      tool_name: 'Bash',
      hook_event_name: 'PreToolUse',
      agent_role: role,
      tool_input: { command },
      cwd,
    }),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ORCHESTRAY_GIT_GATE_DISABLED: undefined, ...extraEnv },
  });
}

function readAuditEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

describe('gate-developer-git integration — team-lead exemption (real main checkout)', () => {
  const DESTRUCTIVE = [
    ['git stash', 'git stash'],
    ['git reset --hard HEAD', 'git reset --hard HEAD'],
    ['git clean -fd', 'git clean -fd'],
    ['git checkout -- f.txt', 'git checkout -- f.txt'],
    ['git restore f.txt', 'git restore f.txt'],
  ];

  for (const [label, cmd] of DESTRUCTIVE) {
    test(`pm ALLOWED: ${label}`, () => {
      const tmp = makeMainRepo();
      try {
        const r = runGate(cmd, 'pm', tmp);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
      } finally {
        cleanup(tmp);
      }
    });
  }

  test('pm ALLOWED: git status (non-destructive, short-circuit path)', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git status', 'pm', tmp);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('pm + kill switch: git stash BLOCKED (byte-identical to pre-W8A behaviour)', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git stash', 'pm', tmp, { ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED: '1' });
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('every applied exemption writes a team_lead_git_exemption_applied event, read back from the sink', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git clean -fd', 'pm', tmp);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
      const events = readAuditEvents(tmp);
      const matches = events.filter((e) => e.type === 'team_lead_git_exemption_applied');
      assert.equal(matches.length, 1, 'expected exactly one exemption event, got: ' + JSON.stringify(events));
      const evt = matches[0];
      assert.equal(evt.agent_role, 'pm');
      assert.equal(evt.git_subcommand, 'clean');
      assert.equal(evt.is_main_checkout, true);
      assert.equal(evt.exemption_source, 'default');
      assert.ok(typeof evt.command_excerpt === 'string' && evt.command_excerpt.includes('git clean'));
    } finally {
      cleanup(tmp);
    }
  });

  test('no exemption event is written when the kill switch disables the exemption (command is blocked instead)', () => {
    const tmp = makeMainRepo();
    try {
      runGate('git stash', 'pm', tmp, { ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED: '1' });
      const events = readAuditEvents(tmp);
      assert.equal(events.filter((e) => e.type === 'team_lead_git_exemption_applied').length, 0);
      assert.ok(events.some((e) => e.type === 'git_destructive_blocked'));
    } finally {
      cleanup(tmp);
    }
  });
});

describe('gate-developer-git integration — no W6 regression', () => {
  const READ_ONLY_ROLES = ['reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent'];

  for (const role of READ_ONLY_ROLES) {
    test(`${role} BLOCKED: git stash (main checkout)`, () => {
      const tmp = makeMainRepo();
      try {
        const r = runGate('git stash', role, tmp);
        assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
      } finally {
        cleanup(tmp);
      }
    });
  }

  test('reviewer BLOCKED: git stash', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git stash', 'reviewer', tmp);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('researcher BLOCKED: git checkout -- f (main checkout)', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git checkout -- f.txt', 'researcher', tmp);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('researcher BLOCKED: git checkout -- f in a LINKED WORKTREE too (axis 1 applies regardless of cwd)', () => {
    const tmp = makeMainRepo();
    const wtDir = path.join(os.tmpdir(), 'w8a-linked-wt-' + Date.now());
    try {
      const branch = spawnSync('git', ['worktree', 'add', '-b', 'w8a-side', wtDir], { cwd: tmp, encoding: 'utf8' });
      assert.equal(branch.status, 0, 'setup: git worktree add failed: ' + branch.stderr);
      const r = runGate('git checkout -- f.txt', 'researcher', wtDir);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', wtDir], { cwd: tmp });
      cleanup(wtDir);
      cleanup(tmp);
    }
  });

  test('developer BLOCKED: git push --force (unaffected by W8A)', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git push --force origin main', 'developer', tmp);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('release-manager BLOCKED: git push (unaffected by W8A)', () => {
    const tmp = makeMainRepo();
    try {
      const r = runGate('git push origin main', 'release-manager', tmp);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });
});
