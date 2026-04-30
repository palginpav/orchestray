'use strict';

/**
 * v2214-G11-hint-re-format.test.js — G-11 dual-form context_size_hint parser tests.
 *
 * Verifies that preflight-spawn-budget.js (v2.2.14 G-11) accepts BOTH inline forms:
 *
 *   Flat:   context_size_hint: system=8000 tier2=4000 handoff=12000
 *   Object: context_size_hint: { system: 8000, tier2: 4000, handoff: 12000 }
 *
 * Both must parse to source='prompt_body' and allow the spawn (exits 0).
 * Mixed forms must fail gracefully (source='absent', exits 2, no JS exception).
 * Empty inline hint falls through to tool_input.context_size_hint when present.
 *
 * Runner: node --test bin/__tests__/v2214-G11-hint-re-format.test.js
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g11-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });

  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
    },
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-g11-test-001' }),
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
      .map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function runHook(cwd, toolInput, envOverrides) {
  const payload = { tool_name: 'Agent', cwd, tool_input: toolInput };
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

describe('v2.2.14 G-11 — dual-form context_size_hint parser in preflight-spawn-budget', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Case 1: flat form parses correctly ────────────────────────────────────
  test('flat form "system=N tier2=N handoff=N" → source=prompt_body, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C1',
      prompt: 'context_size_hint: system=8000 tier2=4000 handoff=12000\n\nDo the task.',
    });
    assert.equal(r.status, 0, 'exits 0 for valid flat hint; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'prompt_body', 'source must be prompt_body');
    assert.equal(inline[0].schema_version, 1, 'schema_version must be 1');

    // No block events
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing event');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed event');
  });

  // ── Case 2: object form parses correctly ──────────────────────────────────
  test('object form "{ system: N, tier2: N, handoff: N }" → source=prompt_body, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C2',
      prompt: 'context_size_hint: { system: 8000, tier2: 4000, handoff: 12000 }\n\nDo the task.',
    });
    assert.equal(r.status, 0, 'exits 0 for valid object hint; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'prompt_body', 'source must be prompt_body');
    assert.equal(inline[0].schema_version, 1, 'schema_version must be 1');

    // No block events
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing event');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed event');
  });

  // ── Case 2b: object form with extra whitespace ────────────────────────────
  test('object form with extra whitespace "{ system : N, tier2:N , handoff: N }" → parses, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C2b',
      prompt: 'context_size_hint: { system : 8000, tier2:4000 , handoff: 12000 }\n\nDo the task.',
    });
    assert.equal(r.status, 0, 'exits 0 for object hint with whitespace variants; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'prompt_body', 'source must be prompt_body');

    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 0, 'no block event for whitespace-variant object form');
  });

  // ── Case 2c: object form embedded mid-prompt ──────────────────────────────
  test('object form in middle of prompt body → parses, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C2c',
      prompt: [
        'You are a developer agent.',
        '',
        'context_size_hint: { system: 5000, tier2: 2000, handoff: 3000 }',
        '',
        'Do the task.',
      ].join('\n'),
    });
    assert.equal(r.status, 0, 'exits 0 for object hint mid-prompt; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1);
    assert.equal(inline[0].source, 'prompt_body');
  });

  // ── Case 3: mixed form fails gracefully ───────────────────────────────────
  test('mixed form "system: N tier2=N" → source=absent, exits 2, no JS exception in stderr', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C3',
      // "system: N" (object-key syntax) followed by "tier2=N" (flat syntax) —
      // matches neither HINT_RE_FLAT nor HINT_RE_OBJ
      prompt: 'context_size_hint: system: 8000 tier2=4000 handoff=12000\n\nDo the task.',
    });
    assert.equal(r.status, 2, 'exits 2 for mixed/invalid hint form; stderr=' + r.stderr);
    // Must fail gracefully — no uncaught JS exception
    assert.ok(!r.stderr.includes('TypeError'),   'no TypeError in stderr');
    assert.ok(!r.stderr.includes('SyntaxError'), 'no SyntaxError in stderr');

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'absent', 'source must be absent for unrecognised form');

    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'exactly 1 context_size_hint_required_failed spawn-block event');
  });

  // ── Case 4: empty inline hint → falls through to tool_input.context_size_hint
  test('no inline hint in prompt → falls through to tool_input.context_size_hint, exits 0', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C4',
      prompt: 'You are a developer agent. Do the task.',
      context_size_hint: { system: 9000, tier2: 3000, handoff: 6000 },
    });
    assert.equal(r.status, 0, 'exits 0 when context_size_hint comes from tool_input; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1, 'exactly 1 context_size_hint_parsed_inline event');
    assert.equal(inline[0].source, 'tool_input_native', 'source must be tool_input_native');
    assert.equal(inline[0].schema_version, 1);

    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 0, 'no block event for native tool_input hint');
  });

  // ── Case 5: no hint anywhere → absent/block ───────────────────────────────
  test('no hint anywhere → source=absent, exits 2', () => {
    const r = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C5',
      prompt: 'You are a developer agent. Do the task.',
      // no context_size_hint field
    });
    assert.equal(r.status, 2, 'exits 2 when no hint at all; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const inline = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.equal(inline.length, 1);
    assert.equal(inline[0].source, 'absent');

    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'exactly 1 block event when no hint present');
  });

  // ── Case 6: flat and object forms are equivalent (same exit code/source) ───
  test('flat and object forms are equivalent — both exit 0 with source=prompt_body', () => {
    const flatR = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C6a',
      prompt: 'context_size_hint: system=7000 tier2=1500 handoff=2500\n\nTask A.',
    });
    assert.equal(flatR.status, 0, 'flat exits 0; stderr=' + flatR.stderr);

    const flatEvents = readEvents(tmpRoot);
    const flatInline = flatEvents.find(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.ok(flatInline, 'flat inline event must exist');
    assert.equal(flatInline.source, 'prompt_body', 'flat source=prompt_body');

    // Reset state for second run
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = makeTmpRoot();

    const objR = runHook(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'G11-C6b',
      prompt: 'context_size_hint: { system: 7000, tier2: 1500, handoff: 2500 }\n\nTask B.',
    });
    assert.equal(objR.status, 0, 'object exits 0; stderr=' + objR.stderr);

    const objEvents = readEvents(tmpRoot);
    const objInline = objEvents.find(e => e.event_type === 'context_size_hint_parsed_inline');
    assert.ok(objInline, 'object inline event must exist');
    assert.equal(objInline.source, 'prompt_body', 'object source=prompt_body');

    // Both sources must be identical
    assert.equal(flatInline.source, objInline.source, 'source fields must be identical');
  });
});
