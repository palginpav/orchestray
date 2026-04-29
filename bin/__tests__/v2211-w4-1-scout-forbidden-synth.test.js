#!/usr/bin/env node
'use strict';

/**
 * v2211-w4-1-scout-forbidden-synth.test.js — W4-1 synthetic scout forbidden-tool coverage.
 *
 * Synthetically spawns `bin/validate-task-completion.js` with SubagentStop
 * payloads that simulate a haiku-scout agent attempting forbidden tool calls.
 *
 * Target dark events:
 *   - `scout_forbidden_tool_blocked`  — scout called Edit/Write/Bash
 *   - `scout_files_changed_blocked`   — scout reported non-empty files_changed
 *
 * Tests:
 *   1. haiku-scout with Edit tool call → exit 2 + scout_forbidden_tool_blocked.
 *   2. haiku-scout with Write tool call → exit 2 + scout_forbidden_tool_blocked.
 *   3. haiku-scout with Bash tool call → exit 2 + scout_forbidden_tool_blocked.
 *   4. haiku-scout with non-empty files_changed → exit 2 + scout_files_changed_blocked.
 *
 * Each test creates an isolated tmpDir and cleans up on completion.
 *
 * Runner: node --test bin/__tests__/v2211-w4-1-scout-forbidden-synth.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK      = path.join(REPO_ROOT, 'bin', 'validate-task-completion.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Structured Result for a read-only scout (no files_changed). */
const CLEAN_RESULT = {
  status:       'success',
  summary:      'scout fetched the requested context',
  files_changed: [],
  files_read:   ['/tmp/context.md'],
  issues:       [],
  assumptions:  [],
};

/** Wrap Structured Result as the expected output string format. */
function wrapResult(result) {
  return '## Structured Result\n```json\n' + JSON.stringify(result) + '\n```\n';
}

/**
 * Invoke validate-task-completion.js as a child process.
 * Returns the spawnSync result with `.tmp` set to the isolated tmpDir.
 */
function runHook(payload) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-scout-'));
  const res = spawnSync('node', [HOOK], {
    input:    JSON.stringify(payload),
    cwd:      tmp,
    encoding: 'utf8',
    timeout:  10_000,
  });
  return Object.assign({}, res, { tmp });
}

/** Read all events from a tmpDir's audit events.jsonl. */
function readEvents(tmp) {
  const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W4-1 — scout forbidden-tool synthetic coverage', () => {

  // -------------------------------------------------------------------------
  // Test 1: Edit is in SCOUT_FORBIDDEN_TOOLS → blocked + event emitted.
  // -------------------------------------------------------------------------
  test('haiku-scout with Edit tool call → exit 2 + scout_forbidden_tool_blocked', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type:   'haiku-scout',
      tool_calls:      [{ name: 'Edit' }, { name: 'Read' }],
      output:          wrapResult(CLEAN_RESULT),
    });
    try {
      assert.equal(r.status, 2,
        'Expected exit 2 for haiku-scout + Edit. stderr=' + r.stderr);
      assert.match(r.stderr, /read-only contract violation/,
        'stderr must mention read-only contract violation');

      const events = readEvents(r.tmp);
      const hit    = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.ok(hit,
        'Expected scout_forbidden_tool_blocked event. ' +
        'Got event types: ' + JSON.stringify(events.map(e => e.type)));
      assert.deepEqual(hit.forbidden_tools, ['Edit'],
        'forbidden_tools must list Edit; got: ' + JSON.stringify(hit.forbidden_tools));
      assert.equal(hit.agent_role, 'haiku-scout',
        'agent_role must be haiku-scout; got: ' + JSON.stringify(hit.agent_role));

      // Verify no housekeeper event leaks across agent boundaries.
      const houseHit = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
      assert.equal(houseHit, undefined,
        'housekeeper_forbidden_tool_blocked must NOT fire for scout payload');
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Write is in SCOUT_FORBIDDEN_TOOLS → blocked + event emitted.
  // -------------------------------------------------------------------------
  test('haiku-scout with Write tool call → exit 2 + scout_forbidden_tool_blocked', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type:   'haiku-scout',
      tool_calls:      [{ name: 'Write' }],
      output:          wrapResult(CLEAN_RESULT),
    });
    try {
      assert.equal(r.status, 2,
        'Expected exit 2 for haiku-scout + Write. stderr=' + r.stderr);

      const events = readEvents(r.tmp);
      const hit    = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.ok(hit,
        'Expected scout_forbidden_tool_blocked for Write. ' +
        'Got: ' + JSON.stringify(events.map(e => e.type)));
      assert.deepEqual(hit.forbidden_tools, ['Write'],
        'forbidden_tools must list Write; got: ' + JSON.stringify(hit.forbidden_tools));
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Bash is in SCOUT_FORBIDDEN_TOOLS → blocked + event emitted.
  // -------------------------------------------------------------------------
  test('haiku-scout with Bash tool call → exit 2 + scout_forbidden_tool_blocked', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type:   'haiku-scout',
      tool_calls:      [{ name: 'Bash' }],
      output:          wrapResult(CLEAN_RESULT),
    });
    try {
      assert.equal(r.status, 2,
        'Expected exit 2 for haiku-scout + Bash. stderr=' + r.stderr);

      const events = readEvents(r.tmp);
      const hit    = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.ok(hit,
        'Expected scout_forbidden_tool_blocked for Bash. ' +
        'Got: ' + JSON.stringify(events.map(e => e.type)));
      assert.deepEqual(hit.forbidden_tools, ['Bash'],
        'forbidden_tools must list Bash; got: ' + JSON.stringify(hit.forbidden_tools));
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Non-empty files_changed in Structured Result → scout_files_changed_blocked.
  // -------------------------------------------------------------------------
  test('haiku-scout with non-empty files_changed → exit 2 + scout_files_changed_blocked', () => {
    const dirtyResult = Object.assign({}, CLEAN_RESULT, {
      files_changed: ['/tmp/orchestray/kb/artifacts/illicit-write.md'],
    });
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type:   'haiku-scout',
      tool_calls:      [{ name: 'Read' }],
      output:          wrapResult(dirtyResult),
    });
    try {
      assert.equal(r.status, 2,
        'Expected exit 2 for scout with non-empty files_changed. stderr=' + r.stderr);
      assert.match(r.stderr, /non-empty files_changed/,
        'stderr must mention non-empty files_changed');

      const events = readEvents(r.tmp);
      const hit    = events.find(e => e.type === 'scout_files_changed_blocked');
      assert.ok(hit,
        'Expected scout_files_changed_blocked event. ' +
        'Got: ' + JSON.stringify(events.map(e => e.type)));
      assert.equal(hit.agent_role, 'haiku-scout',
        'agent_role must be haiku-scout; got: ' + JSON.stringify(hit.agent_role));
      assert.ok(Array.isArray(hit.files_changed) && hit.files_changed.length >= 1,
        'files_changed field must be a non-empty array on the event');

      // Verify scout_forbidden_tool_blocked does NOT also fire (only Read was used).
      const forbiddenHit = events.find(e => e.type === 'scout_forbidden_tool_blocked');
      assert.equal(forbiddenHit, undefined,
        'scout_forbidden_tool_blocked must NOT fire when the only violation is files_changed');
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

});
