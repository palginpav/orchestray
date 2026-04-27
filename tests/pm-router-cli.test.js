#!/usr/bin/env node
'use strict';

/**
 * tests/pm-router-cli.test.js — Integration tests for pm-router-cli.js.
 *
 * Spawns the CLI with stdin task text, parses JSON output, asserts
 * decision/reason/lite_score fields (F6).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../bin/_lib/pm-router-cli.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function runCli(text, { cwd } = {}) {
  const opts = {
    input: text,
    encoding: 'utf8',
    timeout: 10000,
    cwd: cwd || os.tmpdir(),
  };
  const result = spawnSync(process.execPath, [CLI], opts);
  assert.equal(result.status, 0, 'CLI must always exit 0. stderr: ' + result.stderr);
  const line = result.stdout.trim();
  assert.ok(line.length > 0, 'CLI must produce non-empty output');
  let parsed;
  try { parsed = JSON.parse(line); }
  catch (_e) { assert.fail('CLI output is not valid JSON: ' + line); }
  return parsed;
}

describe('pm-router-cli integration', () => {
  test('typo task → solo', () => {
    const r = runCli('fix typo in README.md');
    assert.equal(r.decision, 'solo');
    assert.equal(r.reason, 'all_signals_simple');
    assert.ok(typeof r.lite_score === 'number');
  });

  test('path-floor task (bin/ prefix) → escalate', () => {
    const r = runCli('update bin/gate-router-solo-edit.js with new check');
    assert.equal(r.decision, 'escalate');
  });

  test('control-flow keyword (stop) → decline', () => {
    const r = runCli('stop all orchestration');
    assert.equal(r.decision, 'decline');
    assert.equal(r.reason, 'control_flow_keyword');
    assert.equal(r.lite_score, 0);
  });

  test('empty input → escalate parse_error_fail_safe', () => {
    const r = runCli('');
    assert.equal(r.decision, 'escalate');
    assert.equal(r.reason, 'parse_error_fail_safe');
  });

  test('output is a single JSON line with required fields', () => {
    const r = runCli('fix typo in src/main.ts');
    assert.ok('decision' in r, 'must have decision field');
    assert.ok('reason' in r, 'must have reason field');
    assert.ok('lite_score' in r, 'must have lite_score field');
  });
});
