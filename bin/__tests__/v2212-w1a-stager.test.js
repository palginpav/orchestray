'use strict';

/**
 * Tests for bin/inject-context-size-hint.js — W1a: context_size_hint stager hook.
 *
 * Runner: node --test bin/__tests__/v2212-w1a-stager.test.js
 *
 * Strategy: exercise the parsing logic by importing the hook's internals
 * indirectly via child_process, feeding JSON on stdin, reading stdout.
 * writeEvent is a side-effect; we tolerate it failing in the test environment
 * (audit dir may not exist) — the hook is fail-open on audit errors.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'inject-context-size-hint.js');

function runHook(stdinPayload, env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 5000,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout.trim();
  return {
    status: result.status,
    stdout,
    parsed: stdout ? JSON.parse(stdout) : null,
    stderr: result.stderr,
  };
}

// ---------------------------------------------------------------------------
// Case 1: prompt with context_size_hint line → stager parses and stages
// ---------------------------------------------------------------------------
test('parses context_size_hint from prompt body and stages into tool_input', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'developer',
      prompt: 'You are a developer.\n\ncontext_size_hint: system=12000 tier2=8000 handoff=10000 total=30000\n\nDo the thing.',
    },
    cwd: '/tmp',
  };

  const { parsed, status } = runHook(payload);
  assert.equal(status, 0, 'hook must exit 0');
  assert.ok(parsed, 'must emit JSON on stdout');

  const updatedInput = parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput;
  assert.ok(updatedInput, 'hookSpecificOutput.updatedInput must be present');
  assert.deepEqual(updatedInput.context_size_hint, { system: 12000, tier2: 8000, handoff: 10000 });
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(parsed.continue, true);
});

// ---------------------------------------------------------------------------
// Case 2: prompt with NO context_size_hint line → no staging, no crash
// ---------------------------------------------------------------------------
test('missing context_size_hint in prompt → no staging, exits 0', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'reviewer',
      prompt: 'You are a reviewer. Do a review.',
    },
    cwd: '/tmp',
  };

  const { parsed, status } = runHook(payload);
  assert.equal(status, 0, 'hook must exit 0');
  assert.ok(parsed, 'must emit JSON on stdout');

  // Should emit { continue: true } with no updatedInput
  const hasUpdatedInput = !!(parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput);
  assert.equal(hasUpdatedInput, false, 'must not stage when hint is absent');
  assert.equal(parsed.continue, true);
});

// ---------------------------------------------------------------------------
// Case 3: context_size_hint inside backtick wrapper → stager parses successfully
// ---------------------------------------------------------------------------
test('context_size_hint inside backticks is parsed correctly', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'architect',
      prompt: 'Some preamble.\n\n`context_size_hint: system=5 tier2=5 handoff=5`\n\nTask body.',
    },
    cwd: '/tmp',
  };

  const { parsed, status } = runHook(payload);
  assert.equal(status, 0);
  assert.ok(parsed);

  const updatedInput = parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput;
  assert.ok(updatedInput, 'must stage when hint is inside backticks');
  assert.deepEqual(updatedInput.context_size_hint, { system: 5, tier2: 5, handoff: 5 });
});

// ---------------------------------------------------------------------------
// Case 4: ORCHESTRAY_CTX_HINT_STAGER_DISABLED=1 → exits 0 without parsing
// ---------------------------------------------------------------------------
test('ORCHESTRAY_CTX_HINT_STAGER_DISABLED=1 → exits 0, no staging', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'developer',
      prompt: 'context_size_hint: system=99 tier2=99 handoff=99\nDo stuff.',
    },
    cwd: '/tmp',
  };

  const { parsed, status } = runHook(payload, { ORCHESTRAY_CTX_HINT_STAGER_DISABLED: '1' });
  assert.equal(status, 0, 'hook must exit 0 with kill switch');
  assert.ok(parsed, 'must emit JSON on stdout');

  // Kill switch → just { continue: true }
  const hasUpdatedInput = !!(parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput);
  assert.equal(hasUpdatedInput, false, 'must not stage when kill switch is set');
  assert.equal(parsed.continue, true);
});
