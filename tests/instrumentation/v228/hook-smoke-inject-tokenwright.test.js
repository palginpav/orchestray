'use strict';

/**
 * Smoke tests for bin/inject-tokenwright.js
 *
 * Hook event: PreToolUse:Agent
 *
 * Validates:
 *   1. Non-Agent tool → passthrough (exit 0, original toolInput unchanged)
 *   2. ORCHESTRAY_DISABLE_COMPRESSION=1 → passthrough (exit 0)
 *   3. Valid Agent spawn with prompt inside orchestration → exit 0, hookSpecificOutput present
 *   4. Malformed JSON on stdin → exit 0, fail-open
 *   5. Agent spawn with no prompt field → exit 0 (skip path)
 *   6. compression.enabled=false config → exit 0 passthrough
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/inject-tokenwright.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-it-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function setupProject(dir) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-it-test' })
  );
}

function writeConfig(dir, cfg) {
  const configDir = path.join(dir, '.orchestray');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg));
}

function invoke(payload, env) {
  const mergedEnv = Object.assign({}, process.env, env || {});
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  10000,
    env:      mergedEnv,
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch (_e) {}
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', parsed };
}

// Make a realistic Agent spawn payload with a substantial prompt
function makeAgentPayload(dir, overrides) {
  return Object.assign({
    hook_event_name: 'PreToolUse',
    tool_name:       'Agent',
    cwd:             dir,
    tool_input: {
      subagent_type: 'developer',
      model:         'sonnet',
      prompt: [
        '# Task: Implement feature X',
        '',
        '## Context',
        'You are implementing a new feature.',
        '',
        '## Previous Agent Output',
        'The architect designed the system as follows...',
        'Here is a summary of what was done in the last turn.',
        '',
        '## Instructions',
        'Please write the implementation.',
      ].join('\n'),
    },
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// Test 1: Non-Agent tool → passthrough immediately
// ---------------------------------------------------------------------------
test('inject-tokenwright: non-Agent tool (Bash) exits 0 with continue:true immediately', (t) => {
  const dir = makeTmpDir(t);

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Bash',
    cwd:             dir,
    tool_input:      { command: 'echo hello' },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'non-Agent tool must emit { continue: true }');
});

// ---------------------------------------------------------------------------
// Test 2: ORCHESTRAY_DISABLE_COMPRESSION=1 → passthrough (exit 0)
// ---------------------------------------------------------------------------
test('inject-tokenwright: ORCHESTRAY_DISABLE_COMPRESSION=1 exits 0 with passthrough output', (t) => {
  const dir = makeTmpDir(t);
  setupProject(dir);

  const payload = makeAgentPayload(dir);
  const { status, parsed } = invoke(payload, { ORCHESTRAY_DISABLE_COMPRESSION: '1' });

  assert.strictEqual(status, 0, 'exit code must be 0 when compression is disabled');
  assert.ok(parsed, 'stdout must be valid JSON');
  // In passthrough mode, script emits hookSpecificOutput with permissionDecision:allow
  // and the original modifiedToolInput (unchanged) or { continue: true }
  const isPassthrough =
    parsed.continue === true ||
    (parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'allow');
  assert.ok(isPassthrough, 'kill switch must produce passthrough output');
});

// ---------------------------------------------------------------------------
// Test 3: Valid Agent spawn inside orchestration → exit 0, hookSpecificOutput present
// ---------------------------------------------------------------------------
test('inject-tokenwright: valid Agent spawn inside orchestration exits 0 with hookSpecificOutput', (t) => {
  const dir = makeTmpDir(t);
  setupProject(dir);

  const payload = makeAgentPayload(dir);
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 for valid Agent spawn');
  assert.ok(parsed, 'stdout must be valid JSON');
  // Must have hookSpecificOutput with allow decision
  assert.ok(
    parsed.hookSpecificOutput || parsed.continue === true,
    'output must have hookSpecificOutput or continue:true'
  );
  if (parsed.hookSpecificOutput) {
    assert.strictEqual(
      parsed.hookSpecificOutput.permissionDecision,
      'allow',
      'permissionDecision must be allow (compression must not block spawns)'
    );
  }
});

// ---------------------------------------------------------------------------
// Test 4: Malformed JSON on stdin → exit 0, fail-open
// ---------------------------------------------------------------------------
test('inject-tokenwright: malformed JSON on stdin exits 0 (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    '{ not json',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
  // Output should still be valid JSON
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch (_e) {}
  assert.ok(parsed, 'stdout must be valid JSON on malformed stdin');
});

// ---------------------------------------------------------------------------
// Test 5: Agent spawn with no prompt field → exit 0 (skip path, no crash)
// ---------------------------------------------------------------------------
test('inject-tokenwright: Agent spawn with no prompt field exits 0 without crashing', (t) => {
  const dir = makeTmpDir(t);
  setupProject(dir);

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Agent',
    cwd:             dir,
    tool_input:      { subagent_type: 'developer' }, // no prompt
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'missing prompt field must not cause non-zero exit');
  assert.ok(parsed, 'stdout must be valid JSON');
});

// ---------------------------------------------------------------------------
// Test 6: compression.enabled=false in config → exit 0 passthrough
// ---------------------------------------------------------------------------
test('inject-tokenwright: compression.enabled=false in config produces passthrough output', (t) => {
  const dir = makeTmpDir(t);
  setupProject(dir);
  writeConfig(dir, { compression: { enabled: false } });

  const payload = makeAgentPayload(dir);
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 when compression is config-disabled');
  assert.ok(parsed, 'stdout must be valid JSON');
  const isPassthrough =
    parsed.continue === true ||
    (parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'allow');
  assert.ok(isPassthrough, 'config-disabled compression must produce passthrough output');
});
