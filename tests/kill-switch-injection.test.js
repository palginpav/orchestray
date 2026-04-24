#!/usr/bin/env node
'use strict';

/**
 * R-KS kill-switch injection integration tests (v2.1.12).
 *
 * Verifies that bin/inject-archetype-advisory.js mechanically injects the
 * correct file content when kill-switch env vars are set.
 *
 * Test plan:
 *   T1. ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1 → tier1-orchestration-rare.md content injected
 *   T2. ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1 → delegation-templates-detailed.md content injected
 *   T3. ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1 → event-schemas.md content injected
 *   T4. No env vars set → no injection (baseline, AC-04)
 *   T5. Multiple env vars set → all three injected in a single additionalContext
 *   T6. ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=0 (unknown value) → treated as unset (AC-05)
 *   T7. ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=false (unknown value) → treated as unset (AC-05)
 *
 * Strategy: spawn the hook script as a subprocess with a minimal UserPromptSubmit
 * payload. No active orchestration needed — kill-switch injection fires regardless.
 * The hook resolves cwd from the event payload; we point it at the real project root
 * so file reads succeed.
 *
 * Runner: node --test tests/kill-switch-injection.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(ROOT, 'bin', 'inject-archetype-advisory.js');

// The backing files that should be injected
const BACKING_FILES = {
  ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD:    path.join(ROOT, 'agents', 'pm-reference', 'tier1-orchestration-rare.md'),
  ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: path.join(ROOT, 'agents', 'pm-reference', 'delegation-templates-detailed.md'),
  ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: path.join(ROOT, 'agents', 'pm-reference', 'event-schemas.md'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal UserPromptSubmit hook payload.
 */
function buildPayload(cwd) {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt: 'test prompt for kill switch integration',
  });
}

/**
 * Run inject-archetype-advisory.js with the given env vars and payload.
 * Returns { stdout, stderr, status }.
 */
function runHook(payload, envOverrides) {
  const env = Object.assign({}, process.env, envOverrides);
  const result = spawnSync('node', [HOOK_SCRIPT], {
    input: payload,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Parse hook stdout as JSON. Returns null on failure (hook may exit with no output).
 */
function parseHookOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    return null;
  }
}

/**
 * Extract the additionalContext string from hook output, or null if not present.
 */
function getAdditionalContext(stdout) {
  const parsed = parseHookOutput(stdout);
  if (!parsed) return null;
  return (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || null;
}

/**
 * Read a few distinctive bytes from the start of a backing file for assertion.
 * Returns the first 100 chars of the file (stripping leading whitespace).
 */
function readFileDistinctive(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, 200).trim();
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: confirm backing files exist
// ---------------------------------------------------------------------------

for (const [envVar, filePath] of Object.entries(BACKING_FILES)) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write('[kill-switch-injection.test] WARNING: backing file missing: ' + filePath + '\n');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('R-KS kill-switch injection via inject-archetype-advisory.js', () => {
  const payload = buildPayload(ROOT);

  test('T1: ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1 → tier1-orchestration-rare.md content injected (AC-01)', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: '1',
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: undefined,
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: undefined,
    });

    assert.equal(status, 0, 'hook should exit 0');

    const ctx = getAdditionalContext(stdout);
    assert.ok(ctx !== null, 'should emit additionalContext when kill switch is set');
    assert.ok(
      ctx.includes('ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD'),
      'additionalContext should mention the env var'
    );
    assert.ok(
      ctx.includes('tier1-orchestration-rare.md'),
      'additionalContext should mention the injected file'
    );

    // Verify actual file content is present
    const fileContent = readFileDistinctive(BACKING_FILES.ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD);
    if (fileContent) {
      // Check at least some unique content from the file appears in context
      const firstLine = fileContent.split('\n')[0].trim().slice(0, 30);
      assert.ok(
        ctx.includes(firstLine),
        'actual file content should appear in additionalContext (first line: ' + firstLine + ')'
      );
    }
  });

  test('T2: ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1 → delegation-templates-detailed.md content injected (AC-02)', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: undefined,
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: '1',
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: undefined,
    });

    assert.equal(status, 0, 'hook should exit 0');

    const ctx = getAdditionalContext(stdout);
    assert.ok(ctx !== null, 'should emit additionalContext when kill switch is set');
    assert.ok(
      ctx.includes('ORCHESTRAY_DELEGATION_TEMPLATES_MERGE'),
      'additionalContext should mention the env var'
    );
    assert.ok(
      ctx.includes('delegation-templates-detailed.md'),
      'additionalContext should mention the injected file'
    );
  });

  test('T3: ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1 → event-schemas.md content injected (AC-03)', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: undefined,
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: undefined,
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: '1',
    });

    assert.equal(status, 0, 'hook should exit 0');

    const ctx = getAdditionalContext(stdout);
    assert.ok(ctx !== null, 'should emit additionalContext when kill switch is set');
    assert.ok(
      ctx.includes('ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD'),
      'additionalContext should mention the env var'
    );
    assert.ok(
      ctx.includes('event-schemas.md'),
      'additionalContext should mention the injected file'
    );
  });

  test('T4: no env vars set → no kill-switch injection (baseline, AC-04)', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: undefined,
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: undefined,
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: undefined,
    });

    assert.equal(status, 0, 'hook should exit 0');

    // With no active orchestration and no kill switches, hook should emit nothing
    // OR emit archetype advisory only (which won't contain kill-switch markers).
    // We verify no kill-switch content appears.
    const ctx = getAdditionalContext(stdout);
    if (ctx !== null) {
      // If archetype advisory fired (unlikely without active orchestration), it should
      // not contain kill-switch injection markers.
      assert.ok(
        !ctx.includes('ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1 — injecting'),
        'kill-switch marker should not appear in baseline'
      );
      assert.ok(
        !ctx.includes('ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1 — injecting'),
        'kill-switch marker should not appear in baseline'
      );
      assert.ok(
        !ctx.includes('ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1 — injecting'),
        'kill-switch marker should not appear in baseline'
      );
    }
    // stdout being empty (null ctx) is also acceptable and expected in baseline
  });

  test('T5: multiple env vars set → all injected in single additionalContext', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: '1',
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: '1',
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: '1',
    });

    assert.equal(status, 0, 'hook should exit 0');

    const ctx = getAdditionalContext(stdout);
    assert.ok(ctx !== null, 'should emit additionalContext when kill switches are set');

    // All three env var markers should appear in a single additionalContext
    assert.ok(ctx.includes('ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD'), 'tier1-rare marker present');
    assert.ok(ctx.includes('ORCHESTRAY_DELEGATION_TEMPLATES_MERGE'), 'delegation marker present');
    assert.ok(ctx.includes('ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD'), 'event-schemas marker present');

    // And the single output should contain only ONE hookSpecificOutput
    const parsed = parseHookOutput(stdout);
    assert.ok(parsed && parsed.hookSpecificOutput, 'should have hookSpecificOutput');
    // If multiple outputs were emitted, JSON.parse would fail or only get the first —
    // verify by checking the stdout has exactly one JSON object (no newline-separated extras
    // that would indicate multiple writes beyond what JSON.parse consumed).
    // spawnSync gives us the full stdout; a single JSON.stringify call produces one line.
    const lines = stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'should emit exactly one JSON object (not one per env var)');
  });

  test('T6: ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=0 → treated as unset (AC-05)', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: '0',
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: undefined,
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: undefined,
    });

    assert.equal(status, 0, 'hook should exit 0');

    const ctx = getAdditionalContext(stdout);
    if (ctx !== null) {
      assert.ok(
        !ctx.includes('tier1-orchestration-rare.md'),
        'value=0 should be treated as unset — no injection'
      );
    }
    // Empty output is also acceptable
  });

  test('T7: ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=false → treated as unset (AC-05)', () => {
    const { stdout, status } = runHook(payload, {
      ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD: 'false',
      ORCHESTRAY_DELEGATION_TEMPLATES_MERGE: undefined,
      ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: undefined,
    });

    assert.equal(status, 0, 'hook should exit 0');

    const ctx = getAdditionalContext(stdout);
    if (ctx !== null) {
      assert.ok(
        !ctx.includes('tier1-orchestration-rare.md'),
        'value=false should be treated as unset — no injection'
      );
    }
  });
});
