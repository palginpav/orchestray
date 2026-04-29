#!/usr/bin/env node
'use strict';

/**
 * v2210-context-size-hint.test.js — B4 tests (v2.2.10).
 *
 * Verifies that preflight-spawn-budget.js emits a `context_size_hint_missing`
 * warn-event when a delegation prompt lacks context_size_hint or all values
 * are zero, and that ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1 suppresses
 * the event.
 *
 * Tests:
 *   1. Valid context_size_hint (tokens:8000) → 0 context_size_hint_missing emits.
 *   2. Missing context_size_hint field entirely → 1 emit with subagent_type.
 *   3. All-zero context_size_hint → 1 emit.
 *   4. Kill switch ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1 → 0 emits.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOK_PATH   = path.join(REPO_ROOT, 'bin', 'preflight-spawn-budget.js');
const NODE        = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-hint-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });

  // Minimal config so the hook doesn't fail-open before our code path
  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 100000, source: 'fallback_model_tier_thin_telemetry' },
    },
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );

  // Write current-orchestration.json so orchId resolves
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-001' }),
    'utf8',
  );

  return dir;
}

function eventsPath(root) {
  return path.join(root, '.orchestray', 'audit', 'events.jsonl');
}

function readEvents(root) {
  try {
    return fs.readFileSync(eventsPath(root), 'utf8')
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
  // v2.2.12: explicitly clear context_size_hint kill switches so the test is
  // deterministic regardless of operator-side env state. Tests that want them
  // ON pass overrides.
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED;
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

describe('v2.2.10 B4 — context_size_hint_missing warn-event', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Test 1: populated hint → no context_size_hint_missing event ────────
  test('valid context_size_hint with non-zero tokens → 0 context_size_hint_missing emits, exit 0', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'W1',
      context_size_hint: { system: 8000, tier2: 0, handoff: 0 },
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing = events.filter(e => e.event_type === 'context_size_hint_missing');
    assert.equal(missing.length, 0, 'no context_size_hint_missing events should be emitted');
  });

  // ── Test 2: missing context_size_hint → warn + required_failed, exit 2 ─
  // Updated v2.2.11 (W2-8): fail-closed promotion — exit is now 2 (block).
  test('spawn input without context_size_hint → context_size_hint_missing + context_size_hint_required_failed, exit 2', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'developer',
      task_id: 'W2',
      // no context_size_hint field at all
    });
    assert.equal(r.status, 2, 'hook exits 2 (hard-block); stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing = events.filter(e => e.event_type === 'context_size_hint_missing');
    assert.equal(missing.length, 1, 'exactly 1 context_size_hint_missing event');
    assert.equal(missing[0].subagent_type, 'developer', 'subagent_type must be set');
    assert.equal(missing[0].task_id, 'W2', 'task_id must be propagated');
    assert.equal(missing[0].version, 1, 'version must be 1');
  });

  // ── Test 3: all-zero context_size_hint → warn + required_failed, exit 2 ─
  // Updated v2.2.11 (W2-8): fail-closed promotion — exit is now 2 (block).
  test('all-zero context_size_hint → context_size_hint_missing + context_size_hint_required_failed, exit 2', () => {
    const r = runHookSync(tmpRoot, {
      subagent_type: 'reviewer',
      task_id: 'W3',
      context_size_hint: { system: 0, tier2: 0, handoff: 0 },
    });
    assert.equal(r.status, 2, 'hook exits 2 (hard-block); stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing = events.filter(e => e.event_type === 'context_size_hint_missing');
    assert.equal(missing.length, 1, 'exactly 1 context_size_hint_missing event for all-zero hint');
    assert.equal(missing[0].subagent_type, 'reviewer', 'subagent_type matches');
  });

  // ── Test 4: kill switch → 0 emits ─────────────────────────────────
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1 → 0 context_size_hint_missing emits, exit 0', () => {
    const r = runHookSync(
      tmpRoot,
      { subagent_type: 'developer', task_id: 'W4' },
      { ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED: '1' },
    );
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);

    const events = readEvents(tmpRoot);
    const missing = events.filter(e => e.event_type === 'context_size_hint_missing');
    assert.equal(missing.length, 0, 'kill switch must suppress all context_size_hint_missing events');
  });

});
