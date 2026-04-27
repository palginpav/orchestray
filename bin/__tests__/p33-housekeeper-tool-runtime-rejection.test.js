#!/usr/bin/env node
'use strict';

/**
 * p33-housekeeper-tool-runtime-rejection.test.js — P3.3 Clause 2(b).
 *
 * Spawns `bin/validate-task-completion.js` with stdin payloads simulating
 * SubagentStop events for `orchestray-housekeeper` and verifies:
 *   1. Each of {Edit, Write, Bash, Grep} → exit 2 + housekeeper_forbidden_tool_blocked.
 *   2. Scout payload with the same forbidden tools (Edit/Write/Bash) still
 *      emits the SCOUT-flavoured event (per-agent map differentiation).
 *   3. Scout payload with Grep → exit 0 (scout permits Grep, housekeeper does NOT).
 *   4. Clean housekeeper payload (Read+Glob only) → exit 0.
 *
 * Layer (b) of the three-layer enforcement (Clause 2 of locked-scope D-5).
 *
 * Runner: node --test bin/__tests__/p33-housekeeper-tool-runtime-rejection.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

function runHook(payload, cwd) {
  const tmp = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'p33-tw-rt-'));
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
  summary: 'housekeeper verified the bytes',
  files_changed: [],
  files_read: ['/tmp/.orchestray/kb/artifacts/x.md'],
  issues: [],
  assumptions: [],
};

describe('P3.3 — validate-task-completion rejects forbidden housekeeper tool calls', () => {

  test('clean orchestray-housekeeper payload (Read+Glob only) → exit 0', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'orchestray-housekeeper',
      tool_calls: [{ name: 'Read' }, { name: 'Glob' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  for (const forbiddenTool of ['Edit', 'Write', 'Bash', 'Grep']) {
    test('housekeeper with ' + forbiddenTool + ' → exit 2 + housekeeper_forbidden_tool_blocked', () => {
      const r = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'orchestray-housekeeper',
        tool_calls: [{ name: forbiddenTool }, { name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
      });
      assert.equal(r.status, 2,
        'expected exit 2 for forbidden tool ' + forbiddenTool + '; stderr=' + r.stderr);
      assert.match(r.stderr, /read-only contract violation/);
      assert.match(r.stderr, new RegExp(forbiddenTool));
      assert.match(r.stderr, /FROZEN/i);
      const events = readEvents(r.tmp);
      const hit = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
      assert.ok(hit,
        'expected housekeeper_forbidden_tool_blocked event for ' + forbiddenTool +
        '; got: ' + JSON.stringify(events.map(e => e.type)));
      assert.deepEqual(hit.forbidden_tools, [forbiddenTool]);
      assert.equal(hit.agent_role, 'orchestray-housekeeper');
      // Sanity: scout-flavoured event must NOT also fire.
      const scoutHit = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.equal(scoutHit, undefined,
        'scout event must NOT fire for housekeeper payload');
      fs.rmSync(r.tmp, { recursive: true, force: true });
    });
  }

  test('haiku-scout with Edit still uses scout_forbidden_tool_blocked (per-agent map differentiation)', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'haiku-scout',
      tool_calls: [{ name: 'Edit' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 2);
    const events = readEvents(r.tmp);
    const scoutHit = events.find(e => e.type === 'scout_forbidden_tool_blocked');
    assert.ok(scoutHit, 'scout payload must still emit scout_forbidden_tool_blocked');
    const houseHit = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
    assert.equal(houseHit, undefined,
      'scout payload must NOT emit housekeeper_forbidden_tool_blocked');
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('haiku-scout with Grep does NOT exit 2 (scout permits Grep, housekeeper does not)', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'haiku-scout',
      tool_calls: [{ name: 'Grep' }, { name: 'Read' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 0,
      'scout permits Grep — must NOT be blocked; stderr=' + r.stderr);
    const events = readEvents(r.tmp);
    const blocked = events.filter(e =>
      e.type === 'scout_forbidden_tool_blocked' || e.type === 'housekeeper_forbidden_tool_blocked'
    );
    assert.equal(blocked.length, 0,
      'no forbidden-tool events expected for scout+Grep; events=' +
      JSON.stringify(events.map(e => e.type)));
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('housekeeper with whitespace-padded subagent_type still triggers gate (S-001)', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'orchestray-housekeeper ',
      tool_calls: [{ name: 'Grep' }],
      output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
    });
    assert.equal(r.status, 2,
      'whitespace-padded role must still be blocked; stderr=' + r.stderr);
    const events = readEvents(r.tmp);
    const hit = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
    assert.ok(hit, 'expected housekeeper_forbidden_tool_blocked despite padding');
    assert.equal(hit.agent_role, 'orchestray-housekeeper',
      'agent_role must be normalized (trimmed) before the membership check');
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

});
