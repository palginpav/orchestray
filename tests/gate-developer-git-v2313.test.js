'use strict';

/**
 * v2.3.13 gate-developer-git bug fixes:
 *   F-RT-02 — full-path git (/usr/bin/git) now caught by extractGitSubcommand
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// We access extractGitSubcommand via the module export. The function is not
// exported by default, so we use a workaround: load the module and reach the
// function through the module scope by importing after adding to exports.
// Since the file doesn't export extractGitSubcommand, we call the gate hook
// binary via spawnSync with a synthetic payload to observe behaviour.

const { spawnSync } = require('child_process');

const GATE = path.resolve(__dirname, '..', 'bin/gate-developer-git.js');

function runGate(command, agentRole = 'reviewer') {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({
      tool_name: 'Bash',
      hook_event_name: 'PreToolUse',
      agent_role: agentRole,
      tool_input: { command },
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ORCHESTRAY_GIT_GATE_DISABLED: undefined },
  });
}

// F-RT-02: /usr/bin/git reset --hard should be caught for read-only roles
test('F-RT-02: /usr/bin/git reset --hard is blocked for reviewer role', () => {
  const r = runGate('/usr/bin/git reset --hard origin/main', 'reviewer');
  // Should be blocked (exit 2) — full-path git must be recognised
  assert.strictEqual(r.status, 2, 'expected exit 2, got: ' + r.status + ' stderr: ' + r.stderr);
});

test('F-RT-02: /usr/bin/git clean -fd is blocked for reviewer role', () => {
  const r = runGate('/usr/bin/git clean -fd', 'reviewer');
  assert.strictEqual(r.status, 2, 'expected exit 2 stderr: ' + r.stderr);
});

test('F-RT-02: /usr/bin/git status is allowed for reviewer role (read-only verb)', () => {
  const r = runGate('/usr/bin/git status', 'reviewer');
  assert.strictEqual(r.status, 0, 'expected exit 0, got: ' + r.status + ' stderr: ' + r.stderr);
});

test('F-RT-02: /usr/bin/git log is allowed for reviewer role (read-only verb)', () => {
  const r = runGate('/usr/bin/git log --oneline -5', 'reviewer');
  assert.strictEqual(r.status, 0, 'expected exit 0, got: ' + r.status + ' stderr: ' + r.stderr);
});

test('F-RT-02: bare git reset --hard still blocked for reviewer role', () => {
  const r = runGate('git reset --hard origin/main', 'reviewer');
  assert.strictEqual(r.status, 2, 'bare git path should also be blocked');
});

// The developer role reset via full path should also be blocked (destructive)
test('F-RT-02: /usr/bin/git reset --hard origin/ blocked for developer role', () => {
  const r = runGate('/usr/bin/git reset --hard origin/main', 'developer');
  assert.strictEqual(r.status, 2, 'hard reset origin/<branch> blocked for developer');
});

// F-RT-02 negative cases: the /(?:^|\/)git$/ anchor must NOT match a binary
// whose name merely ends in "git" (preceded by a letter, not start-or-slash).
test('F-RT-02 (negative): "legit" binary ending in git is not treated as git', () => {
  const r = runGate('/usr/bin/legit reset --hard origin/main', 'reviewer');
  assert.strictEqual(r.status, 0, 'non-git "legit" must not be classified as destructive git; stderr: ' + r.stderr);
});

test('F-RT-02 (negative): "mygit" command is not treated as git', () => {
  const r = runGate('mygit clean -fd', 'reviewer');
  assert.strictEqual(r.status, 0, 'non-git "mygit" must not be blocked; stderr: ' + r.stderr);
});
