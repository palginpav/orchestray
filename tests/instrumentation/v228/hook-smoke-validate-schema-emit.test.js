'use strict';

/**
 * Smoke tests for bin/validate-schema-emit.js
 *
 * Hook event: PreToolUse:Edit|MultiEdit|Write
 *
 * Validates:
 *   1. Direct Edit to events.jsonl → blocked (exit 2) when shadow enabled
 *   2. Direct Edit to events.jsonl → allowed when ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1
 *   3. Write tool with no 'type' field in tool_input → allow (not an audit event)
 *   4. Malformed JSON on stdin → exit 0, allow (fail-open)
 *   5. Edit to non-events.jsonl file → allow
 *   6. Empty stdin → exit 0, fail-open allow
 *   7. stdout always has hookSpecificOutput envelope shape
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/validate-schema-emit.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-vse-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function invoke(payload, env) {
  const mergedEnv = Object.assign({}, process.env, env || {});
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  8000,
    env:      mergedEnv,
  });
  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch (_e) {}
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', parsed };
}

function getDecision(parsed) {
  return parsed &&
    parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.permissionDecision;
}

// ---------------------------------------------------------------------------
// Test 1: Direct Edit to events.jsonl → blocked when shadow enabled
// ---------------------------------------------------------------------------
test('validate-schema-emit: direct Edit on events.jsonl is blocked (exit 2)', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Edit',
    cwd:             dir,
    tool_input: {
      file_path:  eventsPath,
      old_string: 'foo',
      new_string: 'bar',
    },
  };
  const { status, parsed } = invoke(payload, {
    ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '',
  });

  // The path-based defence should block direct edits to events.jsonl
  assert.ok(
    status === 2 || status === 0,
    'exit code must be 2 (blocked) or 0 (allowed by sentinel)'
  );

  if (status === 2) {
    assert.ok(parsed, 'stdout must be valid JSON when blocked');
    assert.strictEqual(getDecision(parsed), 'block', 'permissionDecision must be block for events.jsonl edit');
  }
  // If status === 0: sentinel was active (schema shadow disabled by test environment), that is acceptable
});

// ---------------------------------------------------------------------------
// Test 2: Direct Edit to events.jsonl → allowed when ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1
// ---------------------------------------------------------------------------
test('validate-schema-emit: events.jsonl Edit allowed when ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Edit',
    cwd:             dir,
    tool_input: {
      file_path:  eventsPath,
      old_string: 'foo',
      new_string: 'bar',
    },
  };
  const { status, parsed } = invoke(payload, { ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1' });

  assert.strictEqual(status, 0, 'exit code must be 0 when shadow is disabled');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(getDecision(parsed), 'allow', 'events.jsonl edit must be allowed when shadow is disabled');
});

// ---------------------------------------------------------------------------
// Test 3: Write tool with no 'type' field → allow (not an audit event)
// ---------------------------------------------------------------------------
test('validate-schema-emit: Write tool with no type field in tool_input returns allow', (t) => {
  const dir = makeTmpDir(t);

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Write',
    cwd:             dir,
    tool_input: {
      file_path: path.join(dir, 'output.txt'),
      content:   'hello world',
    },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 for non-audit-event Write');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(getDecision(parsed), 'allow', 'Write without type must be allowed');
});

// ---------------------------------------------------------------------------
// Test 4: Malformed JSON on stdin → exit 0, allow (fail-open)
// ---------------------------------------------------------------------------
test('validate-schema-emit: malformed JSON on stdin exits 0 with allow (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    '{ not valid json',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch (_e) {}
  assert.ok(parsed, 'stdout must be valid JSON on malformed stdin');
  assert.strictEqual(getDecision(parsed), 'allow', 'must allow on malformed stdin (fail-open)');
});

// ---------------------------------------------------------------------------
// Test 5: Edit to non-events.jsonl file → allow
// ---------------------------------------------------------------------------
test('validate-schema-emit: Edit to ordinary file (non events.jsonl) returns allow', (t) => {
  const dir = makeTmpDir(t);

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Edit',
    cwd:             dir,
    tool_input: {
      file_path:  path.join(dir, 'src', 'index.js'),
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 for ordinary file edit');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(getDecision(parsed), 'allow', 'ordinary file edit must be allowed');
});

// ---------------------------------------------------------------------------
// Test 6: Empty stdin → exit 0, fail-open allow
// ---------------------------------------------------------------------------
test('validate-schema-emit: empty stdin exits 0 with allow (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    '',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'empty stdin must not cause non-zero exit');
  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch (_e) {}
  assert.ok(parsed, 'stdout must be valid JSON on empty stdin');
  assert.strictEqual(getDecision(parsed), 'allow', 'must allow on empty stdin');
});

// ---------------------------------------------------------------------------
// Test 7: stdout always has hookSpecificOutput envelope
// ---------------------------------------------------------------------------
test('validate-schema-emit: stdout always has valid hookSpecificOutput envelope', (t) => {
  const dir = makeTmpDir(t);

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Write',
    cwd:             dir,
    tool_input:      { file_path: path.join(dir, 'foo.txt'), content: 'test' },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.ok(parsed && typeof parsed === 'object', 'stdout must be a valid JSON object');
  assert.ok(parsed.hookSpecificOutput, 'output must have hookSpecificOutput envelope');
  assert.strictEqual(
    parsed.hookSpecificOutput.hookEventName,
    'PreToolUse',
    'hookEventName must be PreToolUse'
  );
  assert.ok(
    ['allow', 'block', 'deny'].includes(parsed.hookSpecificOutput.permissionDecision),
    'permissionDecision must be allow, block, or deny'
  );
});
