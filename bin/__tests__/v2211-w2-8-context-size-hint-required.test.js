#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-8-context-size-hint-required.test.js — W2-8 fail-closed tests (v2.2.11).
 *
 * Verifies that preflight-spawn-budget.js promotes context_size_hint_missing
 * from warn-only to hard-block (exit 2) when a spawn lacks context_size_hint
 * or has all-zero values. Both the warn event AND the required_failed event
 * must fire before the block.
 *
 * Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 reverts to
 * legacy warn-only behaviour (only context_size_hint_missing fires, exit 0).
 *
 * Tests:
 *   1. Valid hint (system:5000) → 0 fails, both events absent, exit 0.
 *   2. All-zero hint → both context_size_hint_missing AND
 *      context_size_hint_required_failed emit, exit 2.
 *   3. Missing context_size_hint field → both events emit, exit 2.
 *   4. Kill switch ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 →
 *      only context_size_hint_missing emits, exit 0.
 *   5. context_size_hint_required_failed carries subagent_type from spawn payload.
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
      .map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function runHookSync(cwd, toolInput, envOverrides) {
  const payload = {
    tool_name: 'Agent',
    cwd,
    tool_input: toolInput,
  };
  const env = Object.assign({}, process.env, { ORCHESTRAY_DEBUG: '' }, envOverrides || {});
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

describe('v2.2.11 W2-8 — context_size_hint fail-closed (warn → exit-2)', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Test 1: valid hint → no block, both events absent ──────────────────
  test('valid context_size_hint (system:5000) → 0 fails, both events absent, exit 0', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'T1',
      context_size_hint: { system: 5000, tier2: 0, handoff: 0 },
    });
    assert.equal(r.status, 0, 'hook exits 0 for valid hint; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  0, 'no context_size_hint_missing events expected');
    assert.equal(required.length, 0, 'no context_size_hint_required_failed events expected');
  });

  // ── Test 2: all-zero hint → both events fire, exit 2 ───────────────────
  test('all-zero context_size_hint → both warn AND required_failed emit, exit 2', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'T2',
      context_size_hint: { system: 0, tier2: 0, handoff: 0 },
    });
    assert.equal(r.status, 2, 'hook exits 2 (hard-block); stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  1, 'exactly 1 context_size_hint_missing event');
    assert.equal(required.length, 1, 'exactly 1 context_size_hint_required_failed event');
  });

  // ── Test 3: missing context_size_hint field → both events fire, exit 2 ─
  test('no context_size_hint field → both warn AND required_failed emit, exit 2', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'architect',
      task_id: 'T3',
      // no context_size_hint
    });
    assert.equal(r.status, 2, 'hook exits 2 (hard-block); stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  1, 'exactly 1 context_size_hint_missing event');
    assert.equal(required.length, 1, 'exactly 1 context_size_hint_required_failed event');
  });

  // ── Test 4: kill switch → only warn emits, exit 0 ──────────────────────
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 → only warn emits, exit 0', () => {
    const r = runHookSync(
      tmpRoot,
      { subagent_type: 'developer', task_id: 'T4' },
      { ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED: '1' },
    );
    assert.equal(r.status, 0, 'kill switch reverts to legacy warn-only; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing  = events.filter(e => e.event_type === 'context_size_hint_missing');
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(missing.length,  1, 'context_size_hint_missing still emits (telemetry trail)');
    assert.equal(required.length, 0, 'context_size_hint_required_failed must NOT emit when kill switch is set');
  });

  // ── Test 5: required_failed event carries subagent_type ────────────────
  test('context_size_hint_required_failed event has subagent_type from spawn payload', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'architect',
      task_id: 'T5',
      // no context_size_hint → triggers the block
    });
    assert.equal(r.status, 2, 'hook exits 2; stderr=' + r.stderr);

    const events   = readEvents(tmpRoot);
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(required.length, 1, 'exactly 1 context_size_hint_required_failed event');
    assert.equal(required[0].subagent_type, 'architect', 'subagent_type must match the spawn payload');
    assert.equal(required[0].version, 1, 'version field must be 1');
    assert.ok('schema_version' in required[0], 'schema_version field must be present');
  });

});
