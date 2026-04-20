#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-task-subject.js — v2.1.9 Bundle B1 / I-01.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-task-subject.js');
const HOOK = path.resolve(__dirname, '..', 'validate-task-subject.js');

function runHook(payload, extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vts-test-'));
  const env = Object.assign({}, process.env, extraEnv || {}, {
    ORCHESTRAY_TEST_SENTINEL_PATH: path.join(tmp, 'sentinel'),
  });
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env,
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { ...res, tmp };
}

describe('validate-task-subject — evaluateSpawn', () => {
  test('accepts tool_input with meaningful description', () => {
    const r = mod.evaluateSpawn({ description: 'Fix auth bug in login flow', prompt: '' });
    assert.equal(r.valid, true);
  });

  test('rejects missing description and empty prompt', () => {
    const r = mod.evaluateSpawn({});
    assert.equal(r.valid, false);
  });

  test('rejects description shorter than MIN_DESCRIPTION_LENGTH', () => {
    const r = mod.evaluateSpawn({ description: 'fix', prompt: '' });
    assert.equal(r.valid, false);
  });

  test('accepts explicit task_subject field', () => {
    const r = mod.evaluateSpawn({ task_subject: 'migrate users table', description: '' });
    assert.equal(r.valid, true);
    assert.equal(r.foundSubject, 'migrate users table');
  });

  test('accepts prompt with task_subject marker', () => {
    const r = mod.evaluateSpawn({ prompt: 'You are W1.\n\ntask_subject: upgrade pattern extractor\n\nDetails follow.' });
    assert.equal(r.valid, true);
    assert.equal(r.foundSubject, 'upgrade pattern extractor');
  });

  test('rejects whitespace-only description', () => {
    const r = mod.evaluateSpawn({ description: '      ' });
    assert.equal(r.valid, false);
  });
});

describe('validate-task-subject — extractTaskSubjectFromPrompt', () => {
  test('handles bold marker variants', () => {
    const s = mod.extractTaskSubjectFromPrompt('**task_subject**: foo-bar');
    assert.equal(s, 'foo-bar');
  });

  test('handles `Task subject:` style', () => {
    const s = mod.extractTaskSubjectFromPrompt('Task subject: migrate auth');
    assert.equal(s, 'migrate auth');
  });

  test('returns null when marker absent', () => {
    const s = mod.extractTaskSubjectFromPrompt('Just some prompt text.');
    assert.equal(s, null);
  });
});

describe('validate-task-subject — shouldValidate', () => {
  test('ignores non-Agent tool calls', () => {
    const ok = mod.shouldValidate({ tool_name: 'Read', tool_input: { subagent_type: 'x' } });
    assert.equal(ok, false);
  });

  test('ignores Agent calls without subagent_type', () => {
    const ok = mod.shouldValidate({ tool_name: 'Agent', tool_input: {} });
    assert.equal(ok, false);
  });

  test('validates Agent + subagent_type', () => {
    const ok = mod.shouldValidate({ tool_name: 'Agent', tool_input: { subagent_type: 'developer' } });
    assert.equal(ok, true);
  });
});

describe('validate-task-subject — integration (spawned hook)', () => {
  test('block path: exit 2 when subject missing', () => {
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'no subject here' },
    });
    // pass cwd via payload so the hook writes to our isolated tmp dir.
    const r2 = (() => {
      const res = spawnSync('node', [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: 'developer', prompt: 'no subject here' },
          cwd: r.tmp,
        }),
        cwd: r.tmp,
        encoding: 'utf8',
        timeout: 10_000,
      });
      return { ...res, tmp: r.tmp };
    })();
    assert.equal(r2.status, 2, 'expected exit 2, got stderr=' + r2.stderr);
    const auditPath = path.join(r2.tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditPath), 'audit events file should exist at ' + auditPath);
    const raw = fs.readFileSync(auditPath, 'utf8');
    assert.match(raw, /task_subject_missing/);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('pass path: exit 0 when description is present', () => {
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', description: 'Fix null-ref in login handler', prompt: '...' },
    });
    assert.equal(r.status, 0);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('no-op path: exit 0 on non-Agent tool', () => {
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { path: '/tmp/foo' },
    });
    assert.equal(r.status, 0);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('fail-open on malformed JSON input', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vts-bad-'));
    const res = spawnSync('node', [HOOK], {
      input: '{not json',
      cwd: tmp,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
