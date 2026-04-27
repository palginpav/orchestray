#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-reviewer-scope.js — v2.1.9 Bundle B1 / I-03.
 * v2.2.3 E3/B7: warn-only → exit-2 hard-block on unscoped reviewer delegation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-reviewer-scope.js');
const HOOK = path.resolve(__dirname, '..', 'validate-reviewer-scope.js');

describe('validate-reviewer-scope — evaluateScope', () => {
  test('detects explicit files: marker', () => {
    const r = mod.evaluateScope('Please review.\n\nfiles:\n- src/auth.ts\n- src/login.ts\n');
    assert.equal(r.scoped, true);
  });

  test('detects scope: marker', () => {
    const r = mod.evaluateScope('scope:\n  src/**/*.ts');
    assert.equal(r.scoped, true);
  });

  test('detects bullet path list (>=3 paths)', () => {
    const prompt = 'Review the following:\n\n- foo/bar.ts\n- foo/baz.ts\n- foo/qux.ts\n\nLook for issues.';
    const r = mod.evaluateScope(prompt);
    assert.equal(r.scoped, true);
  });

  test('returns scoped=false on broad prompt without file list', () => {
    const r = mod.evaluateScope('Please review the codebase for security issues.');
    assert.equal(r.scoped, false);
  });

  test('returns scoped=false on empty prompt', () => {
    const r = mod.evaluateScope('');
    assert.equal(r.scoped, false);
  });
});

describe('validate-reviewer-scope — shouldValidate', () => {
  test('triggers on Agent + reviewer', () => {
    const ok = mod.shouldValidate({ tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' } });
    assert.equal(ok, true);
  });

  test('ignores other subagent_types', () => {
    const ok = mod.shouldValidate({ tool_name: 'Agent', tool_input: { subagent_type: 'developer' } });
    assert.equal(ok, false);
  });

  test('ignores non-Agent tool_name', () => {
    const ok = mod.shouldValidate({ tool_name: 'Task', tool_input: { subagent_type: 'reviewer' } });
    assert.equal(ok, false);
  });
});

describe('validate-reviewer-scope — integration (v2.2.3 hard-block)', () => {
  test('block path: exit 2 and emits reviewer_scope_warn event with action=block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrs-block-'));
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'reviewer',
          prompt: 'Review my recent work',
        },
        cwd: tmp,
      }),
      cwd: tmp,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 2, 'reviewer-scope MUST hard-block in v2.2.3 (E3/B7)');
    assert.match(res.stderr, /BLOCK/);
    // Decision payload must signal block to upstream hook consumer.
    const stdoutObj = JSON.parse(res.stdout);
    assert.equal(stdoutObj.continue, false);
    assert.match(stdoutObj.stopReason || '', /explicit file list/i);
    const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const raw = fs.readFileSync(auditPath, 'utf8');
    assert.match(raw, /reviewer_scope_warn/);
    assert.match(raw, /"action":"block"/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('pass path: exit 0, no event when scope is explicit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrs-pass-'));
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'reviewer',
          prompt: 'Review the following.\n\nfiles:\n- bin/foo.js\n- bin/bar.js\n- bin/baz.js\n',
        },
        cwd: tmp,
      }),
      cwd: tmp,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 0);
    const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(!fs.existsSync(auditPath) || !/reviewer_scope_warn/.test(fs.readFileSync(auditPath, 'utf8')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no-op path: exit 0 on non-reviewer Agent call', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrs-skip-'));
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'developer', prompt: 'anything' },
        cwd: tmp,
      }),
      cwd: tmp,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 0);
    const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(!fs.existsSync(auditPath));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('fail-open: malformed JSON input → exit 0 (never block on parse failure)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrs-failopen-'));
    const res = spawnSync('node', [HOOK], {
      input: 'this is not json {{',
      cwd: tmp,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 0, 'malformed input must fail-open (exit 0)');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
