'use strict';

/**
 * event-scout-forbidden-tool-blocked.test.js
 *
 * Instrumentation test for the `scout_forbidden_tool_blocked` event.
 *
 * Verifies that bin/validate-task-completion.js emits a well-formed
 * `scout_forbidden_tool_blocked` event (and exits 2) when haiku-scout
 * is observed calling a tool outside its whitelist (Read, Glob, Grep).
 *
 * Schema r=6:
 *   version, type, timestamp, orchestration_id, hook, agent_role,
 *   forbidden_tools, session_id  (r counts non-null required fields)
 *
 * See agents/pm-reference/event-schemas.md §scout_forbidden_tool_blocked
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', '..', 'bin', 'validate-task-completion.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v226-scout-fbt-'));
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
  summary: 'scout completed read-only inspection',
  files_changed: [],
  files_read: ['/tmp/something.md'],
  issues: [],
  assumptions: [],
};

describe('scout_forbidden_tool_blocked — instrumentation', () => {

  test('emits scout_forbidden_tool_blocked when haiku-scout calls Edit', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Edit' }, { name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
        session_id: 'test-session-001',
      }, tmp);

      // Gate must block.
      assert.equal(res.status, 2, 'expected exit 2; stderr=' + res.stderr);

      // Event must be present in events.jsonl.
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.ok(ev, 'scout_forbidden_tool_blocked event must be emitted; got types: ' +
        events.map(e => e.type).join(','));

      // Required schema fields.
      assert.equal(ev.version, 1, 'version must be 1');
      assert.equal(ev.type, 'scout_forbidden_tool_blocked');
      assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0, 'timestamp required');
      assert.ok(typeof ev.orchestration_id === 'string', 'orchestration_id required');
      assert.equal(ev.hook, 'validate-task-completion', 'hook field must match emitter');
      assert.equal(ev.agent_role, 'haiku-scout', 'agent_role must be haiku-scout');
      assert.ok(Array.isArray(ev.forbidden_tools) && ev.forbidden_tools.includes('Edit'),
        'forbidden_tools must contain the offending tool');
      assert.ok('session_id' in ev, 'session_id field must be present');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits scout_forbidden_tool_blocked when haiku-scout calls Write', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Write' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
      }, tmp);

      assert.equal(res.status, 2, 'exit 2 for Write tool violation');
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.ok(ev, 'event must be emitted for Write violation');
      assert.deepEqual(ev.forbidden_tools, ['Write']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does NOT emit scout_forbidden_tool_blocked for allowed Grep calls', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Read' }, { name: 'Grep' }, { name: 'Glob' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
      }, tmp);

      // Grep is allowed for scout — must not block.
      assert.equal(res.status, 0, 'exit 0 for allowed tools; stderr=' + res.stderr);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.equal(ev, undefined, 'no scout_forbidden_tool_blocked for allowed tools');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('session_id is null when not supplied in payload', () => {
    const tmp = makeTmp();
    try {
      runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Bash' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```\n',
        // no session_id field
      }, tmp);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.ok(ev, 'event must be emitted');
      assert.equal(ev.session_id, null, 'session_id must be null when not in payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
