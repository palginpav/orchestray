#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.14 G-08 — debugger/architect/reviewer kb/artifacts allow-list.
 *
 * Coverage:
 *   - debugger can write .orchestray/kb/artifacts/**.md  → allowed
 *   - architect can write .orchestray/kb/artifacts/**.md → allowed (ungated role)
 *   - reviewer can write .orchestray/kb/artifacts/**.md  → allowed
 *   - debugger still blocked from writing bin/install.js  → blocked
 *   - documenter can write kb artifacts (via **\/*.md)    → no regression
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isPathAllowed } = require('../gate-role-write-paths.js');

const HOOK = path.resolve(__dirname, '..', 'gate-role-write-paths.js');

// ---------------------------------------------------------------------------
// Unit: isPathAllowed — kb/artifacts paths
// ---------------------------------------------------------------------------

describe('v2214-G08 — unit: kb/artifacts allow-list', () => {
  const ARTIFACT = '.orchestray/kb/artifacts/v2214-W1-sessionstart-debug.md';

  test('debugger allowed to write kb/artifacts .md file', () => {
    assert.ok(
      isPathAllowed('debugger', ARTIFACT),
      'debugger should be allowed to write ' + ARTIFACT
    );
  });

  test('reviewer allowed to write kb/artifacts .md file', () => {
    assert.ok(
      isPathAllowed('reviewer', ARTIFACT),
      'reviewer should be allowed to write ' + ARTIFACT
    );
  });

  test('debugger still blocked from writing bin/ files', () => {
    assert.ok(
      !isPathAllowed('debugger', 'bin/install.js'),
      'debugger must not be allowed to write bin/install.js'
    );
  });

  test('documenter still allowed to write kb/artifacts .md (via **/*.md — no regression)', () => {
    // documenter has **/*.md in its allowlist, so kb artifacts remain writable
    assert.ok(
      isPathAllowed('documenter', ARTIFACT),
      'documenter must still be allowed to write ' + ARTIFACT
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: hook exit codes for kb/artifacts writes
// ---------------------------------------------------------------------------

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g08-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  return { ...res, tmp };
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

describe('v2214-G08 — integration: debugger kb/artifacts write allowed', () => {
  test('debugger writing .orchestray/kb/artifacts/ md → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'debugger',
      tool_input: { file_path: '.orchestray/kb/artifacts/v2214-W1-sessionstart-debug.md' },
    });
    assert.equal(r.status, 0, 'expected exit 0 for debugger kb/artifacts write. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});

describe('v2214-G08 — integration: architect kb/artifacts write allowed (ungated role)', () => {
  test('architect writing .orchestray/kb/artifacts/ md → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'architect',
      tool_input: { file_path: '.orchestray/kb/artifacts/v2214-W1-sessionstart-debug.md' },
    });
    assert.equal(r.status, 0, 'expected exit 0 for architect kb/artifacts write (ungated). stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});

describe('v2214-G08 — integration: reviewer kb/artifacts write allowed', () => {
  test('reviewer writing .orchestray/kb/artifacts/ md → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'reviewer',
      tool_input: { file_path: '.orchestray/kb/artifacts/v2214-W1-sessionstart-debug.md' },
    });
    assert.equal(r.status, 0, 'expected exit 0 for reviewer kb/artifacts write. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});

describe('v2214-G08 — integration: negative — debugger still blocked from code files', () => {
  test('debugger writing bin/install.js → exit 2', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'debugger',
      tool_input: { file_path: 'bin/install.js' },
    });
    assert.equal(r.status, 2, 'expected exit 2 for debugger writing bin/install.js. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});

describe('v2214-G08 — integration: negative — documenter kb/artifacts write (no regression)', () => {
  test('documenter writing .orchestray/kb/artifacts/ md → exit 0', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'documenter',
      tool_input: { file_path: '.orchestray/kb/artifacts/v2214-W1-sessionstart-debug.md' },
    });
    assert.equal(r.status, 0, 'expected exit 0 for documenter kb/artifacts write (via **/*.md). stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});
