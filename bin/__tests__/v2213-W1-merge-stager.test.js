'use strict';

/**
 * v2213-W1-merge-stager.test.js — W1 inline-parser tests (v2.2.13).
 *
 * Verifies that preflight-spawn-budget.js resolves context_size_hint from:
 *   1. tool_input.context_size_hint (native, non-zero) → source='tool_input_native'
 *   2. prompt body regex match (tool_input.context_size_hint absent) → source='prompt_body'
 *   3. neither source → source='absent'; exits 2 (hard-block)
 *   4. ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 is now a NO-OP (v2.2.14 G-04
 *      retired the var); spawn still blocks (exits 2)
 *   5. ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1 skips prompt-body
 *      parse; falls through to absent path and hard-blocks
 *
 * Runner: node --test bin/__tests__/v2213-W1-merge-stager.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'preflight-spawn-budget.js');
const NODE      = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-w1-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });

  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
      architect:  { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
    },
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-w1-test-001' }),
    'utf8',
  );

  return dir;
}

function readEvents(root) {
  try {
    return fs.readFileSync(
      path.join(root, '.orchestray', 'audit', 'events.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(e => e.type !== 'audit_event_autofilled'); /* v2.2.15: filter P1-13 diagnostic emit */
  } catch (_e) { return []; }
}

function runHook(cwd, toolInput, envOverrides) {
  const payload = { tool_name: 'Agent', cwd, tool_input: toolInput };
  // Clear all context_size_hint kill switches so tests are deterministic.
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED;
  const env = Object.assign({}, baseEnv, { ORCHESTRAY_DEBUG: '' }, envOverrides || {});
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.13 W1 — inline context_size_hint parser in preflight-spawn-budget', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Case 1: tool_input.context_size_hint native, non-zero ──────────────
  test('tool_input.context_size_hint populated natively → source=tool_input_native, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'W1-C1',
      context_size_hint: { system: 12000, tier2: 8000, handoff: 5000 },
    });
    assert.equal(r.status, 0, 'exits 0 for valid native hint; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'tool_input_native', 'source must be tool_input_native');
    assert.equal(inline[0].subagent_type, 'developer', 'subagent_type must be set');
    assert.equal(inline[0].schema_version, 1, 'schema_version must be 1');

    // No block events
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing event expected');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed event expected');
  });

  // ── Case 2: hint in prompt body, context_size_hint absent ──────────────
  test('prompt body contains hint line, context_size_hint absent → source=prompt_body, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'W1-C2',
      prompt: 'You are a developer.\n\ncontext_size_hint: system=14000 tier2=2000 handoff=1500\n\nDo the task.',
      // no context_size_hint field
    });
    assert.equal(r.status, 0, 'exits 0 when hint is found in prompt; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'prompt_body', 'source must be prompt_body');
    assert.equal(inline[0].schema_version, 1, 'schema_version must be 1');

    // No block events
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing event expected');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed event expected');
  });

  // ── Case 3: no hint in prompt, context_size_hint absent → absent/block ──
  test('prompt has no hint line, context_size_hint absent → source=absent, exits 2 (hard-block)', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'W1-C3',
      prompt: 'You are a developer. Do the task.',
      // no context_size_hint
    });
    assert.equal(r.status, 2, 'exits 2 (hard-block) when no hint anywhere; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'absent', 'source must be absent');

    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'exactly 1 context_size_hint_required_failed event');
  });

  // ── Case 4: retired env var is no-op — spawn still hard-blocks (v2.2.14 G-04)
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 → exits 2 (var is retired no-op)', () => {
    const r = runHook(
      tmpRoot,
      {
        subagent_type: 'developer',
        task_id: 'W1-C4',
        prompt: 'You are a developer. No hint here.',
        // no context_size_hint
      },
      { ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED: '1' },
    );
    assert.equal(r.status, 2, 'retired var must not bypass hard-block; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    // inline parse event still fires (source=absent because no hint in prompt)
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'context_size_hint_parsed_inline still emits');
    assert.equal(inline[0].source, 'absent', 'source=absent (no hint anywhere)');

    // required_failed MUST emit — var is no longer read
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'context_size_hint_required_failed must emit (var is no-op)');

    // deprecated_kill_switch_detected must NOT emit — detection code removed
    const deprecated = events.filter(e => e.event_type === 'deprecated_kill_switch_detected');
    assert.equal(deprecated.length, 0, 'deprecated_kill_switch_detected must not emit (function removed in G-04)');
  });

  // ── Case 5: INLINE_PARSE_DISABLED skips prompt-body parse → absent/block ─
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1 + hint in prompt → source=absent, exits 2', () => {
    const r = runHook(
      tmpRoot,
      {
        subagent_type: 'architect',
        task_id: 'W1-C5',
        prompt: 'context_size_hint: system=99 tier2=99 handoff=99\nDo stuff.',
        // no context_size_hint in tool_input
      },
      { ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED: '1' },
    );
    assert.equal(r.status, 2, 'exits 2 when inline parse is disabled; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'context_size_hint_parsed_inline still emits');
    assert.equal(inline[0].source, 'absent', 'source=absent (parser disabled; hint in prompt ignored)');

    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'hard-block fires when inline parse disabled');
  });

});
