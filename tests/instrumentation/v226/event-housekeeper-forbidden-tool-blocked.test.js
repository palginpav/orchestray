'use strict';

/**
 * event-housekeeper-forbidden-tool-blocked.test.js
 *
 * Instrumentation test for the `housekeeper_forbidden_tool_blocked` event.
 *
 * Verifies that bin/validate-task-completion.js emits a well-formed
 * `housekeeper_forbidden_tool_blocked` event (and exits 2) when
 * orchestray-housekeeper is observed calling a tool outside its whitelist
 * (Read, Glob). The housekeeper's forbidden set is STRICTER than the scout's
 * — it also forbids Grep (per Clause 1 of locked-scope D-5).
 *
 * Schema r=6:
 *   version, type, timestamp, orchestration_id, hook, agent_role,
 *   forbidden_tools, session_id
 *
 * See agents/pm-reference/event-schemas.md §housekeeper_forbidden_tool_blocked
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', '..', 'bin', 'validate-task-completion.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v226-hk-fbt-'));
}

function runHook(payload, tmp) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return res;
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const VALID_RESULT = {
  status: 'success',
  summary: 'housekeeper verified the bytes',
  files_changed: [],
  files_read: ['/tmp/.orchestray/kb/artifacts/x.md'],
  issues: [],
  assumptions: [],
};

describe('housekeeper_forbidden_tool_blocked — instrumentation', () => {

  test('emits housekeeper_forbidden_tool_blocked when orchestray-housekeeper calls Grep', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'orchestray-housekeeper',
        tool_calls: [{ name: 'Grep' }, { name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
        session_id: 'test-session-003',
      }, tmp);

      // Gate must block.
      assert.equal(res.status, 2, 'expected exit 2; stderr=' + res.stderr);

      // Event must be present in events.jsonl.
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
      assert.ok(ev, 'housekeeper_forbidden_tool_blocked event must be emitted; got types: ' +
        events.map(e => e.type).join(','));

      // Required schema fields.
      assert.equal(ev.version, 1, 'version must be 1');
      assert.equal(ev.type, 'housekeeper_forbidden_tool_blocked');
      assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0, 'timestamp required');
      assert.ok(typeof ev.orchestration_id === 'string', 'orchestration_id required');
      assert.equal(ev.hook, 'validate-task-completion', 'hook field must match emitter');
      assert.equal(ev.agent_role, 'orchestray-housekeeper', 'agent_role must be orchestray-housekeeper');
      assert.ok(Array.isArray(ev.forbidden_tools) && ev.forbidden_tools.includes('Grep'),
        'forbidden_tools must contain the offending tool');
      assert.ok('session_id' in ev, 'session_id field must be present');

      // Scout event must NOT also fire.
      const scoutEv = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.equal(scoutEv, undefined, 'scout event must NOT fire for housekeeper payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits housekeeper_forbidden_tool_blocked for Edit (common to both agents)', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'orchestray-housekeeper',
        tool_calls: [{ name: 'Edit' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
      }, tmp);

      assert.equal(res.status, 2, 'exit 2 for Edit violation; stderr=' + res.stderr);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
      assert.ok(ev, 'event must be emitted for Edit violation');
      assert.deepEqual(ev.forbidden_tools, ['Edit']);
      assert.equal(ev.agent_role, 'orchestray-housekeeper');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does NOT emit housekeeper_forbidden_tool_blocked for allowed Read+Glob calls', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'orchestray-housekeeper',
        tool_calls: [{ name: 'Read' }, { name: 'Glob' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
      }, tmp);

      // Clean payload — must pass.
      assert.equal(res.status, 0, 'exit 0 for allowed tools; stderr=' + res.stderr);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
      assert.equal(ev, undefined, 'no event for allowed tools');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('session_id is null when not supplied in payload', () => {
    const tmp = makeTmp();
    try {
      runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'orchestray-housekeeper',
        tool_calls: [{ name: 'Bash' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
        // no session_id
      }, tmp);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
      assert.ok(ev, 'event must be emitted');
      assert.equal(ev.session_id, null, 'session_id must be null when absent from payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
