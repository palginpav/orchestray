#!/usr/bin/env node
'use strict';

/**
 * tests/gate-router-solo-edit.test.js — Integration tests for
 * bin/gate-router-solo-edit.js hook (F6).
 *
 * Tests: non-pm-router pass-through, protected path block, non-protected
 * path allow, file-cap enforcement.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/gate-router-solo-edit.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-solo-test-'));
  cleanup.push(d);
  return d;
}

function run(payload, { envOverrides = {} } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...envOverrides },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('gate-router-solo-edit — non-pm-router agent', () => {
  test('developer agent → exit 0 pass-through', () => {
    const dir = makeTmpDir();
    const { status } = run({
      agent_type: 'developer',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'agents/pm.md') },
    });
    assert.equal(status, 0, 'non-pm-router agent must always pass');
  });

  test('architect agent → exit 0 pass-through', () => {
    const dir = makeTmpDir();
    const { status } = run({
      agent_type: 'architect',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'agents/pm.md') },
    });
    assert.equal(status, 0);
  });
});

describe('gate-router-solo-edit — pm-router protected path', () => {
  test('pm-router + agents/pm.md → exit 2 blocked', () => {
    const dir = makeTmpDir();
    const { status, stderr } = run({
      agent_type: 'pm-router',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'agents/pm.md') },
    });
    assert.equal(status, 2, 'protected path must exit 2. stderr: ' + stderr);
    assert.ok(stderr.includes('BLOCK'), 'stderr should contain BLOCK message');
  });

  test('pm-router + bin/gate-cost-budget.js → exit 2 blocked', () => {
    const dir = makeTmpDir();
    const { status } = run({
      agent_type: 'pm-router',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'bin/gate-cost-budget.js') },
    });
    assert.equal(status, 2);
  });

  test('pm-router + hooks/hooks.json → exit 2 blocked', () => {
    const dir = makeTmpDir();
    const { status } = run({
      agent_type: 'pm-router',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'hooks/hooks.json') },
    });
    assert.equal(status, 2);
  });
});

describe('gate-router-solo-edit — pm-router non-protected path', () => {
  test('pm-router + /tmp/foo.txt → exit 0 allowed', () => {
    const { status } = run({
      agent_type: 'pm-router',
      tool_name: 'Edit',
      cwd: os.tmpdir(),
      tool_input: { file_path: '/tmp/foo.txt' },
    });
    assert.equal(status, 0);
  });

  test('pm-router + src/index.js → exit 0 allowed (first edit)', () => {
    const dir = makeTmpDir();
    const { status } = run({
      agent_type: 'pm-router',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'src/index.js') },
    });
    assert.equal(status, 0, 'first edit of non-protected file must be allowed');
  });
});

describe('gate-router-solo-edit — file cap enforcement', () => {
  test('pm-router + 2nd file edit when ledger has 1 entry → exit 2 capped', () => {
    const dir = makeTmpDir();

    // Pre-seed ledger with one entry under a deterministic fake session ID.
    const sessionId = 'pm-router-test-session-001';
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const ledgerPath = path.join(stateDir, 'router-solo-edits.jsonl');
    fs.writeFileSync(ledgerPath,
      JSON.stringify({ timestamp: new Date().toISOString(), agent_session_id: sessionId, file_path: 'src/first.js' }) + '\n'
    );

    // Run with the same session ID via env var.
    const { status, stderr } = run({
      agent_type: 'pm-router',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'src/second.js') },
    }, { envOverrides: { CLAUDE_AGENT_SESSION_ID: sessionId } });

    assert.equal(status, 2, 'file cap exceeded must exit 2. stderr: ' + stderr);
    assert.ok(stderr.includes('cap'), 'stderr should mention cap');
  });

  test('pm-router + 1st file edit when ledger is empty → exit 0', () => {
    const dir = makeTmpDir();
    const sessionId = 'pm-router-test-session-002';
    const { status } = run({
      agent_type: 'pm-router',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'src/first.js') },
    }, { envOverrides: { CLAUDE_AGENT_SESSION_ID: sessionId } });
    assert.equal(status, 0, 'first edit must be allowed');
  });
});
