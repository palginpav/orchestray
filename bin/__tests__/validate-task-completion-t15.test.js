#!/usr/bin/env node
'use strict';

/**
 * Tests for the v2.1.9 T15 pre-done checklist addition to
 * bin/validate-task-completion.js (Bundle B1 / I-12).
 *
 * Legacy Agent-Teams path (task_id/task_subject) is covered by existing
 * tests; this file focuses on the structured-result checklist.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-task-completion.js');
const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

describe('validate-task-completion — extractStructuredResult', () => {
  test('extracts from json block under ## Structured Result', () => {
    const raw = [
      '# My task',
      '',
      '## Structured Result',
      '',
      '```json',
      JSON.stringify({ status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [] }, null, 2),
      '```',
      '',
    ].join('\n');
    const r = mod.extractStructuredResult({ output: raw });
    assert.equal(r.status, 'success');
  });

  test('extracts from trailing bare json', () => {
    const raw = 'Summary prose.\n\n' + JSON.stringify({
      status: 'partial', summary: 's', files_changed: [], files_read: [], issues: [], assumptions: [],
    });
    const r = mod.extractStructuredResult({ output: raw });
    assert.equal(r.status, 'partial');
  });

  test('returns null on missing payload', () => {
    const r = mod.extractStructuredResult({});
    assert.equal(r, null);
  });
});

describe('validate-task-completion — validateStructuredResult', () => {
  test('valid result passes', () => {
    const v = mod.validateStructuredResult({
      status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
    });
    assert.deepEqual(v, { valid: true, missing: [] });
  });

  test('missing summary flagged', () => {
    const v = mod.validateStructuredResult({
      status: 'success', files_changed: [], files_read: [], issues: [], assumptions: [],
    });
    assert.equal(v.valid, false);
    assert.deepEqual(v.missing, ['summary']);
  });

  test('empty summary flagged', () => {
    const v = mod.validateStructuredResult({
      status: 'success', summary: '   ', files_changed: [], files_read: [], issues: [], assumptions: [],
    });
    assert.equal(v.valid, false);
  });

  test('non-array files_changed flagged', () => {
    const v = mod.validateStructuredResult({
      status: 'success', summary: 's', files_changed: 'bad', files_read: [], issues: [], assumptions: [],
    });
    assert.equal(v.valid, false);
    assert.ok(v.missing.includes('files_changed'));
  });
});

describe('validate-task-completion — identifyAgentRole', () => {
  test('picks subagent_type first', () => {
    const r = mod.identifyAgentRole({ subagent_type: 'Developer', role: 'x' });
    assert.equal(r, 'developer');
  });

  test('falls back to agent_type when subagent_type absent', () => {
    const r = mod.identifyAgentRole({ agent_type: 'Reviewer' });
    assert.equal(r, 'reviewer');
  });

  test('teammate_name is NOT a role source (Agent-Teams label)', () => {
    const r = mod.identifyAgentRole({ teammate_name: 'developer' });
    assert.equal(r, null, 'teammate_name must not be confused with subagent role');
  });

  test('returns null when no signal', () => {
    const r = mod.identifyAgentRole({});
    assert.equal(r, null);
  });
});

function runHook(payload, cwd) {
  const tmp = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-t15-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { ...res, tmp };
}

describe('validate-task-completion — integration (T15)', () => {
  test('block path: hard-tier agent with malformed structured result', () => {
    const r = runHook({
      hook_event_name: 'TaskCompleted',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n{"status":"success"}\n```\n',
    });
    assert.equal(r.status, 2, 'stderr=' + r.stderr);
    const auditPath = path.join(r.tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const content = fs.readFileSync(auditPath, 'utf8');
    assert.match(content, /pre_done_checklist_failed/);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('warn path: warn-tier agent with malformed result exits 0', () => {
    const r = runHook({
      hook_event_name: 'TaskCompleted',
      subagent_type: 'researcher',
      output: '## Structured Result\n```json\n{"status":"success"}\n```\n',
    });
    assert.equal(r.status, 0);
    const auditPath = path.join(r.tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const content = fs.readFileSync(auditPath, 'utf8');
    assert.match(content, /task_completion_warn/);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('pass path: valid structured result exits 0', () => {
    const r = runHook({
      hook_event_name: 'TaskCompleted',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
      }) + '\n```\n',
    });
    assert.equal(r.status, 0);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('fail-open on malformed JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-bad-'));
    const res = spawnSync('node', [HOOK], {
      input: '{not json',
      cwd: tmp,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // v2.1.9 post-review fix: T15 gate MUST fire on SubagentStop too (reviewer
  // W5 finding; spec §5 I-12 explicitly requires SubagentStop wiring so normal
  // orchestrations, not just Agent Teams, are gated).
  test('SubagentStop: hard-tier agent with missing assumptions is blocked', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [],
        // assumptions intentionally omitted — must be flagged
      }) + '\n```\n',
    });
    assert.equal(r.status, 2, 'SubagentStop must route through T15 gate');
    const auditPath = path.join(r.tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const content = fs.readFileSync(auditPath, 'utf8');
    assert.match(content, /pre_done_checklist_failed/);
    assert.match(content, /assumptions/);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('SubagentStop: valid result with assumptions passes', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
      }) + '\n```\n',
    });
    assert.equal(r.status, 0);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('SubagentStop bypasses Agent-Teams task_id/task_subject gate', () => {
    // SubagentStop events never carry task_id/task_subject — must not be
    // misclassified as a malformed Agent-Teams event.
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'researcher', // warn-tier: missing assumptions → warn, not block
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [],
      }) + '\n```\n',
    });
    assert.equal(r.status, 0, 'warn-tier should exit 0, not 2 via teams gate');
    const auditPath = path.join(r.tmp, '.orchestray', 'audit', 'events.jsonl');
    const content = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
    assert.doesNotMatch(content, /missing task_id/, 'must not trip teams gate');
    assert.match(content, /task_completion_warn/);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('unrecognized hook_event_name passes through', () => {
    const r = runHook({
      hook_event_name: 'PostToolUse',
      subagent_type: 'developer',
    });
    assert.equal(r.status, 0);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });
});
