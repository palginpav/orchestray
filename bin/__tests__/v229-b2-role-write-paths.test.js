#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.9 B-2.4 — gate-role-write-paths.js.
 *
 * Coverage:
 *   - 5 out-of-scope writes (reviewer→bin/, tester→docs/, documenter→src/,
 *     release-manager→bin/, debugger→anything) → exit 2
 *   - In-scope writes pass → exit 0
 *   - ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1 bypass
 *   - Ungated roles (developer, architect) → pass-through
 *   - role_write_path_blocked event emitted on block
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../gate-role-write-paths.js');
const HOOK = path.resolve(__dirname, '..', 'gate-role-write-paths.js');

// ---------------------------------------------------------------------------
// Unit: globToRegex
// ---------------------------------------------------------------------------

describe('v229-b2.4 — globToRegex', () => {
  const { globToRegex } = mod;

  test('** matches any path', () => {
    const rx = globToRegex('.orchestray/kb/**');
    assert.ok(rx.test('.orchestray/kb/artifacts/design.md'), 'deep path should match **');
    assert.ok(!rx.test('bin/foo.js'), 'bin should not match .orchestray/kb/**');
  });

  test('* matches single segment', () => {
    const rx = globToRegex('*.md');
    assert.ok(rx.test('README.md'));
    assert.ok(!rx.test('docs/README.md'), '* should not cross dir boundary');
  });

  test('exact filename match', () => {
    const rx = globToRegex('CHANGELOG.md');
    assert.ok(rx.test('CHANGELOG.md'));
    assert.ok(!rx.test('bin/CHANGELOG.md'));
  });

  test('**/*.test.* matches deeply nested test files', () => {
    const rx = globToRegex('**/*.test.*');
    assert.ok(rx.test('bin/__tests__/foo.test.js'));
    assert.ok(rx.test('src/components/Button.test.tsx'));
    assert.ok(!rx.test('bin/validate-task-completion.js'));
  });
});

// ---------------------------------------------------------------------------
// Unit: isPathAllowed
// ---------------------------------------------------------------------------

describe('v229-b2.4 — isPathAllowed', () => {
  const { isPathAllowed } = mod;

  test('reviewer allowed to write to .orchestray/kb/', () => {
    assert.ok(isPathAllowed('reviewer', '.orchestray/kb/artifacts/review.md'));
  });

  test('reviewer blocked from writing to bin/', () => {
    assert.ok(!isPathAllowed('reviewer', 'bin/foo.js'));
  });

  test('tester allowed to write test files', () => {
    assert.ok(isPathAllowed('tester', 'bin/__tests__/foo.test.js'));
    assert.ok(isPathAllowed('tester', 'src/components/Button.spec.ts'));
  });

  test('tester blocked from writing non-test files', () => {
    assert.ok(!isPathAllowed('tester', 'bin/gate-role-write-paths.js'));
    assert.ok(!isPathAllowed('tester', 'docs/README.md'));
  });

  test('documenter allowed to write .md files', () => {
    assert.ok(isPathAllowed('documenter', 'README.md'));
    assert.ok(isPathAllowed('documenter', 'docs/architecture.md'));
  });

  test('documenter blocked from writing .js files', () => {
    assert.ok(!isPathAllowed('documenter', 'bin/foo.js'));
  });

  test('release-manager allowed to write CHANGELOG.md', () => {
    assert.ok(isPathAllowed('release-manager', 'CHANGELOG.md'));
    assert.ok(isPathAllowed('release-manager', 'package.json'));
    assert.ok(isPathAllowed('release-manager', 'agents/pm-reference/event-schemas.md'));
  });

  test('release-manager blocked from writing to bin/', () => {
    assert.ok(!isPathAllowed('release-manager', 'bin/foo.js'));
  });

  test('debugger blocked from all writes', () => {
    assert.ok(!isPathAllowed('debugger', 'bin/foo.js'));
    assert.ok(!isPathAllowed('debugger', 'README.md'));
    assert.ok(!isPathAllowed('debugger', '.orchestray/kb/foo.md'));
  });
});

// ---------------------------------------------------------------------------
// Integration: hook blocks out-of-scope writes
// ---------------------------------------------------------------------------

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b24-'));
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

const OUT_OF_SCOPE_FIXTURES = [
  ['reviewer',       'bin/validate-task-completion.js', 'reviewer writing to bin/'],
  ['tester',         'docs/architecture.md',             'tester writing to docs/'],
  ['documenter',     'bin/foo.js',                       'documenter writing to bin/'],
  ['release-manager','bin/foo.js',                       'release-manager writing to bin/'],
  ['debugger',       'README.md',                        'debugger writing to README.md'],
];

describe('v229-b2.4 — integration: out-of-scope writes blocked', () => {
  for (const [role, filePath, description] of OUT_OF_SCOPE_FIXTURES) {
    test(description + ' → exit 2', () => {
      const r = runHook({
        tool_name: 'Edit',
        agent_role: role,
        tool_input: { file_path: filePath },
      });
      assert.equal(r.status, 2, description + ': expected exit 2. stderr=' + r.stderr.slice(0, 200));
      const events = readAuditEvents(r.tmp);
      const blocked = events.find(e => e.type === 'role_write_path_blocked');
      assert.ok(blocked, 'role_write_path_blocked event must be emitted');
      assert.equal(blocked.agent_role, role, 'agent_role must match');
      assert.equal(blocked.allowlist_matched, false);
      cleanup(r.tmp);
    });
  }
});

describe('v229-b2.4 — integration: in-scope writes pass', () => {
  test('reviewer writing to .orchestray/kb/ → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'reviewer',
      tool_input: { file_path: '.orchestray/kb/artifacts/review.md' },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('tester writing to __tests__/ → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'tester',
      tool_input: { file_path: 'bin/__tests__/new.test.js' },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('documenter writing README.md → exit 0', () => {
    const r = runHook({
      tool_name: 'Edit',
      agent_role: 'documenter',
      tool_input: { file_path: 'README.md' },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });
});

describe('v229-b2.4 — integration: kill switch and ungated roles', () => {
  test('ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1 allows any write', () => {
    const r = runHook(
      {
        tool_name: 'Edit',
        agent_role: 'debugger',
        tool_input: { file_path: 'bin/foo.js' },
      },
      { ORCHESTRAY_ROLE_WRITE_GATE_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'global kill switch should bypass all checks');
    cleanup(r.tmp);
  });

  test('developer (ungated) writing anywhere → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'developer',
      tool_input: { file_path: 'bin/foo.js' },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('architect (ungated) writing anywhere → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'architect',
      tool_input: { file_path: '.orchestray/kb/artifacts/design.md' },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('unknown role (ungated) → exit 0', () => {
    const r = runHook({
      tool_name: 'Edit',
      agent_role: 'some-future-role',
      tool_input: { file_path: 'bin/foo.js' },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });
});
