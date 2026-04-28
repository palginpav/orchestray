'use strict';

/**
 * event-scout-files-changed-blocked.test.js
 *
 * Instrumentation test for the `scout_files_changed_blocked` event.
 *
 * Verifies that bin/validate-task-completion.js emits a well-formed
 * `scout_files_changed_blocked` event (and exits 2) when haiku-scout
 * returns a Structured Result with a non-empty `files_changed` array.
 * Read-only agents must always return files_changed: [].
 *
 * Schema r=6:
 *   version, type, timestamp, orchestration_id, hook, agent_role,
 *   files_changed, session_id
 *
 * See agents/pm-reference/event-schemas.md §scout_files_changed_blocked
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', '..', 'bin', 'validate-task-completion.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v226-scout-fcb-'));
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

const CLEAN_RESULT = {
  status: 'success',
  summary: 'scout completed read-only inspection',
  files_changed: [],
  files_read: ['/tmp/something.md'],
  issues: [],
  assumptions: [],
};

describe('scout_files_changed_blocked — instrumentation', () => {

  test('emits scout_files_changed_blocked when haiku-scout returns non-empty files_changed', () => {
    const tmp = makeTmp();
    try {
      const dirtyResult = Object.assign({}, CLEAN_RESULT, {
        files_changed: ['agents/pm.md'],
      });
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(dirtyResult) + '\n```\n',
        session_id: 'test-session-002',
      }, tmp);

      // Gate must block.
      assert.equal(res.status, 2, 'expected exit 2; stderr=' + res.stderr);

      // Event must be present in events.jsonl.
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_files_changed_blocked');
      assert.ok(ev, 'scout_files_changed_blocked event must be emitted; got types: ' +
        events.map(e => e.type).join(','));

      // Required schema fields.
      assert.equal(ev.version, 1, 'version must be 1');
      assert.equal(ev.type, 'scout_files_changed_blocked');
      assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0, 'timestamp required');
      assert.ok(typeof ev.orchestration_id === 'string', 'orchestration_id required');
      assert.equal(ev.hook, 'validate-task-completion', 'hook field must match emitter');
      assert.equal(ev.agent_role, 'haiku-scout', 'agent_role must be haiku-scout');
      assert.ok(Array.isArray(ev.files_changed) && ev.files_changed.includes('agents/pm.md'),
        'files_changed must mirror the offending array from Structured Result');
      assert.ok('session_id' in ev, 'session_id field must be present');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits scout_files_changed_blocked for multiple files in files_changed', () => {
    const tmp = makeTmp();
    try {
      const dirtyResult = Object.assign({}, CLEAN_RESULT, {
        files_changed: ['agents/pm.md', 'bin/validate-task-completion.js'],
      });
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(dirtyResult) + '\n```\n',
      }, tmp);

      assert.equal(res.status, 2);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_files_changed_blocked');
      assert.ok(ev, 'event must be emitted');
      assert.equal(ev.files_changed.length, 2, 'both files must appear in event');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does NOT emit scout_files_changed_blocked when files_changed is empty', () => {
    const tmp = makeTmp();
    try {
      const res = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(CLEAN_RESULT) + '\n```\n',
      }, tmp);

      // Clean payload — must pass.
      assert.equal(res.status, 0, 'exit 0 for empty files_changed; stderr=' + res.stderr);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_files_changed_blocked');
      assert.equal(ev, undefined, 'no scout_files_changed_blocked for clean payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('session_id is null when not supplied in payload', () => {
    const tmp = makeTmp();
    try {
      const dirtyResult = Object.assign({}, CLEAN_RESULT, { files_changed: ['foo.md'] });
      runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: 'haiku-scout',
        tool_calls: [{ name: 'Read' }],
        output: '## Structured Result\n```json\n' + JSON.stringify(dirtyResult) + '\n```\n',
        // no session_id
      }, tmp);
      const events = readEvents(tmp);
      const ev = events.find(e => e.type === 'scout_files_changed_blocked');
      assert.ok(ev, 'event must be emitted');
      assert.equal(ev.session_id, null, 'session_id must be null when absent from payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
