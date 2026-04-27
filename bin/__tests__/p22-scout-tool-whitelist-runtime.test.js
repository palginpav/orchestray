#!/usr/bin/env node
'use strict';

/**
 * p22-scout-tool-whitelist-runtime.test.js — P2.2 runtime tool-whitelist enforcement.
 *
 * Spawns `bin/validate-task-completion.js` as a child process with stdin
 * payloads simulating SubagentStop events for `haiku-scout` and verifies:
 *   1. Clean Read-only payload → exit 0.
 *   2. Edit tool call → exit 2 + scout_forbidden_tool_blocked event.
 *   3. Non-empty files_changed → exit 2 + scout_files_changed_blocked event.
 *   4. Forbidden tool from a non-scout agent (developer) → NOT blocked.
 *
 * Layer (b) of the three-layer tool-whitelist enforcement (P2.2 §4).
 *
 * Runner: node --test bin/__tests__/p22-scout-tool-whitelist-runtime.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

function runHook(payload, cwd) {
  const tmp = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'p22-tw-rt-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return Object.assign({}, res, { tmp });
}

function readEvents(tmp) {
  const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

const VALID_RESULT = {
  status: 'success',
  summary: 'scout fetched the file',
  files_changed: [],
  files_read: ['/tmp/something.md'],
  issues: [],
  assumptions: [],
};

describe('P2.2 — validate-task-completion rejects forbidden scout tool calls', () => {

  test('clean haiku-scout payload (Read-only tool calls) → exit 0', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'haiku-scout',
      tool_calls: [{ name: 'Read' }, { name: 'Glob' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('haiku-scout with Edit tool call → exit 2 + scout_forbidden_tool_blocked', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'haiku-scout',
      tool_calls: [{ name: 'Edit' }, { name: 'Read' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 2, 'stderr=' + r.stderr);
    assert.match(r.stderr, /read-only contract violation/);
    const events = readEvents(r.tmp);
    const hit = events.find(e => e.type === 'scout_forbidden_tool_blocked');
    assert.ok(hit, 'expected scout_forbidden_tool_blocked event; got: ' + JSON.stringify(events));
    assert.deepEqual(hit.forbidden_tools, ['Edit']);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('haiku-scout with non-empty files_changed → exit 2 + scout_files_changed_blocked', () => {
    const dirtyResult = Object.assign({}, VALID_RESULT, { files_changed: ['/tmp/forbidden.md'] });
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'haiku-scout',
      tool_calls: [{ name: 'Read' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(dirtyResult) + '\n```\n',
    });
    assert.equal(r.status, 2, 'stderr=' + r.stderr);
    assert.match(r.stderr, /non-empty files_changed/);
    const events = readEvents(r.tmp);
    const hit = events.find(e => e.type === 'scout_files_changed_blocked');
    assert.ok(hit, 'expected scout_files_changed_blocked event; got: ' + JSON.stringify(events));
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('developer (NOT a scout) with Edit tool call → NOT blocked by scout rule', () => {
    // Developer is allowed to use Edit. Scout rule only fires for the
    // `haiku-scout` agent_type. Developer payloads still pass through the
    // T15 pre-done checklist, so a fully valid Structured Result is required
    // for the test to land at exit 0 without being blocked by THAT path.
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      tool_calls: [{ name: 'Edit' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 0, 'developer should not be blocked by scout rule; stderr=' + r.stderr);
    const events = readEvents(r.tmp);
    const scoutEvents = events.filter(e =>
      e.type === 'scout_forbidden_tool_blocked' || e.type === 'scout_files_changed_blocked'
    );
    assert.equal(scoutEvents.length, 0, 'no scout-rule events for developer');
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  // S-001 (v2.2.0 fix-pass): trailing whitespace / NUL on subagent_type
  // must NOT bypass the read-only-tier gate (CWE-178).
  test('S-001: subagent_type with trailing whitespace still triggers scout gate', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'haiku-scout ', // intentional trailing space
      tool_calls: [{ name: 'Edit' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 2, 'whitespace-padded haiku-scout must still be blocked. stderr=' + r.stderr);
    const events = readEvents(r.tmp);
    const hit = events.find(e => e.type === 'scout_forbidden_tool_blocked');
    assert.ok(hit, 'expected scout_forbidden_tool_blocked event despite whitespace padding');
    assert.equal(hit.agent_role, 'haiku-scout',
      'agent_role must be normalized (trimmed) before the membership check');
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('S-001: subagent_type with mixed case + trailing space still triggers gate', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'HAIKU-SCOUT  ',
      tool_calls: [{ name: 'Write' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 2, 'case+whitespace haiku-scout must still be blocked. stderr=' + r.stderr);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

});
