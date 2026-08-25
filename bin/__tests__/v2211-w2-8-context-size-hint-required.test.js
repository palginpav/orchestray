#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-8-context-size-hint-required.test.js — W2-8 fail-closed tests (v2.2.11).
 *
 * v2.3.18 W3 Q1 UPDATE: the hard-block-on-any-missing-hint behaviour these
 * tests originally verified was replaced by a compute-and-warn fallback
 * (v2318-implementation-plan.md "Q1 -> compute-and-warn, not block" — 14 real
 * misses / 51 days, zero on developer/architect; blocking on a number the
 * hook can derive itself is prose-enforcement in a hook costume). Test 1
 * (valid hint passes through unaffected) is unchanged. Tests 2-5 are rewritten
 * to verify the new behaviour: a missing/all-zero hint with a readable prompt
 * now computes a fallback and PROCEEDS (exit 0); only a genuinely unreadable
 * prompt (or the ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED=1 escape hatch)
 * still hard-blocks.
 *
 * v2.3.31 W5 UPDATE: `context_size_hint_missing` no longer fires on the
 * successful-compute path (Tests 2, 3, 6 below) — it used to fire
 * unconditionally, which made "missing" indistinguishable from "handled
 * automatically" and directly contradicted the W5 acceptance criterion (a
 * full wave should show ZERO `context_size_hint_missing` when the field was
 * filled mechanically). It still fires on the two genuine-block paths (Tests
 * 4, 5) where a human decision is actually required.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-w28-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

  // Minimal config so the hook doesn't fail-open before our code path.
  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 100000, source: 'fallback_model_tier_thin_telemetry' },
      architect:  { budget_tokens: 100000, source: 'fallback_model_tier_thin_telemetry' },
    },
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );

  // Write current-orchestration.json so orchId resolves cleanly.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-w28' }),
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

function runHookSync(cwd, toolInput, envOverrides) {
  const payload = {
    tool_name: 'Agent',
    cwd,
    tool_input: toolInput,
  };
  // v2.2.12: clear inherited kill-switch env state so tests are deterministic.
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED;
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

describe('v2.2.11 W2-8 / v2.3.18 W3 Q1 — context_size_hint compute-and-warn (not block)', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Test 1: valid hint → no block, both events absent (unchanged) ──────
  test('valid context_size_hint (system:5000) → 0 fails, both events absent, exit 0', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'T1',
      context_size_hint: { system: 5000, tier2: 0, handoff: 0 },
    });
    assert.equal(r.status, 0, 'hook exits 0 for valid hint; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.type === 'context_size_hint_missing');
    const required = events.filter(e => e.type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing events expected');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed events expected');
  });

  // ── Test 2: all-zero hint, readable prompt → computed fallback, exit 0 ──
  test('all-zero context_size_hint + readable prompt → computed fallback, warn AND computed emit, exit 0', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'T2',
      context_size_hint: { system: 0, tier2: 0, handoff: 0 },
      prompt: 'Please implement the widget. '.repeat(50),
    });
    assert.equal(r.status, 0, 'hook exits 0 (computed fallback, not blocked); stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.type === 'context_size_hint_missing');
    const computed = events.filter(e => e.type === 'context_size_hint_computed');
    const required = events.filter(e => e.type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing on the successful-compute path (W5)');
    assert.equal(computed.length, 1, 'exactly 1 context_size_hint_computed event');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed event — spawn was not blocked');
    assert.ok(computed[0].handoff > 0, 'computed handoff size must be derived from the prompt body');
  });

  // ── Test 3: missing hint field, readable prompt → computed fallback, exit 0
  test('no context_size_hint field + readable prompt → computed fallback, exit 0', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'architect',
      task_id: 'T3',
      prompt: 'Design the widget subsystem. '.repeat(50),
      // no context_size_hint
    });
    assert.equal(r.status, 0, 'hook exits 0 (computed fallback, not blocked); stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.type === 'context_size_hint_missing');
    const computed = events.filter(e => e.type === 'context_size_hint_computed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing on the successful-compute path (W5)');
    assert.equal(computed.length, 1, 'exactly 1 context_size_hint_computed event');
    assert.equal(computed[0].subagent_type, 'architect');
  });

  // ── Test 4: unreadable prompt (genuinely nothing to compute) → still blocks
  test('no context_size_hint AND no readable prompt → hard-blocks (only remaining block path)', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'T4',
      // no context_size_hint, no prompt at all
    });
    assert.equal(r.status, 2, 'hook exits 2 — nothing to compute from; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.type === 'context_size_hint_missing');
    const required = events.filter(e => e.type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  1, 'context_size_hint_missing still emits (telemetry trail)');
    assert.equal(required.length, 1, 'context_size_hint_required_failed emits — genuine block');
    assert.equal(required[0].reason, 'prompt_unreadable');
  });

  // ── Test 5: ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED=1 → legacy strict block
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED=1 restores the pre-v2.3.18 strict hard-block', () => {
    const r = runHookSync(
      tmpRoot,
      { subagent_type: 'developer', task_id: 'T5', prompt: 'Do real work here. '.repeat(50) },
      { ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED: '1' },
    );
    assert.equal(r.status, 2, 'compute-fallback kill switch restores strict blocking; stderr=' + r.stderr);

    const events   = readEvents(tmpRoot);
    const required = events.filter(e => e.type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'exactly 1 context_size_hint_required_failed event');
    assert.equal(required[0].reason, 'compute_fallback_disabled');
    assert.equal(required[0].version, 1, 'version field must be 1');
    assert.ok('schema_version' in required[0], 'schema_version field must be present');
  });

  // ── Test 6: computed event carries subagent_type from spawn payload ────
  test('context_size_hint_computed event has subagent_type from spawn payload', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'architect',
      task_id: 'T6',
      prompt: 'Design something. '.repeat(50),
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);

    const events   = readEvents(tmpRoot);
    const computed = events.filter(e => e.type === 'context_size_hint_computed');
    assert.equal(computed.length, 1, 'exactly 1 context_size_hint_computed event');
    assert.equal(computed[0].subagent_type, 'architect', 'subagent_type must match the spawn payload');
  });

});
