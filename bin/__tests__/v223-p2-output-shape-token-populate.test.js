#!/usr/bin/env node
'use strict';

/**
 * v223-p2-output-shape-token-populate.test.js — v2.2.3 Phase-2 W2 unit tests.
 *
 * Validates the paired-event approach for measuring output_shape effectiveness:
 *
 *   1. inject-output-shape.js (PreToolUse:Agent) populates
 *      `baseline_output_tokens` from `.orchestray/state/role-budgets.json`,
 *      tags the source via `baseline_source`, and echoes the cap as
 *      `cap_output_tokens`.
 *   2. observe-output-shape.js (SubagentStop) emits a NEW
 *      `output_shape_observed` row carrying realized token count and a
 *      cap_respected boolean.
 *
 * Pairing key is (orchestration_id, role) — verified via dedicated test.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT       = path.resolve(__dirname, '..', '..');
const INJECT_HOOK     = path.join(REPO_ROOT, 'bin', 'inject-output-shape.js');
const OBSERVE_HOOK    = path.join(REPO_ROOT, 'bin', 'observe-output-shape.js');
const SCHEMA_PATH     = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE            = process.execPath;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p2-w2-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // Copy real event-schemas.md so the audit-event-writer's schema validator
  // runs against the canonical schema (mirrors v222-inject-output-shape.test.js
  // Fix #6).
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

function writeOrchMarker(root, orchId) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function writeRoleBudgets(root, content) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'state', 'role-budgets.json'),
    JSON.stringify(content),
    'utf8'
  );
}

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter((e) => e !== null);
}

function runHook(hookPath, payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  const r = cp.spawnSync(NODE, [hookPath], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    parsedStdout: (() => {
      try { return r.stdout ? JSON.parse(r.stdout) : null; } catch (_e) { return null; }
    })(),
  };
}

const ORIG_PROMPT = '## Task\nReview the changes in src/foo.ts.\n';

// ---------------------------------------------------------------------------
// inject-output-shape.js — baseline + cap fields
// ---------------------------------------------------------------------------

describe('inject-output-shape: baseline_output_tokens populated from role-budgets.json (wrapped form)', () => {
  test('reviewer with budget_tokens=50000 → baseline_source=budget_tokens_cache', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-baseline-wrapped');
    // Mirrors the production .orchestray/state/role-budgets.json shape
    // (v2.1.16 fallback seed). Wrapped form: cache.role_budgets[role].
    writeRoleBudgets(root, {
      role_budgets: {
        reviewer: { budget_tokens: 50000, source: 'fallback', calibrated_at: '2026-04-25' },
      },
    });

    const r = runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0, 'inject hook exits 0; stderr=' + r.stderr);

    const ev = readEvents(root).find((e) => e.type === 'output_shape_applied');
    assert.ok(ev, 'output_shape_applied row written');
    assert.equal(ev.role, 'reviewer');
    assert.equal(ev.baseline_output_tokens, 50000,
      'baseline_output_tokens populated from role-budgets cache');
    assert.equal(ev.baseline_source, 'budget_tokens_cache',
      'baseline_source labels the lookup path');
    assert.equal(typeof ev.cap_output_tokens, 'number',
      'cap_output_tokens populated for hybrid role');
    assert.equal(ev.cap_output_tokens, ev.length_cap,
      'cap_output_tokens echoes length_cap for join-convenience');
    assert.equal(ev.observed_output_tokens, null,
      'observed_output_tokens stays null on applied row (filled by SubagentStop)');
  });
});

describe('inject-output-shape: baseline prefers p95 over budget_tokens (flat form)', () => {
  test('developer with both p95=42000 and budget_tokens=60000 → baseline=42000, source=p95_cache', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-baseline-p95');
    // Flat form: cache[role] (post-`--emit-cache` shape per output-shape.js
    // `getRoleLengthCap` documentation).
    writeRoleBudgets(root, {
      developer: { p95: 42000, budget_tokens: 60000 },
    });

    const r = runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const ev = readEvents(root).find((e) => e.type === 'output_shape_applied');
    assert.ok(ev);
    assert.equal(ev.baseline_output_tokens, 42000, 'p95 wins over budget_tokens');
    assert.equal(ev.baseline_source, 'p95_cache');
  });
});

describe('inject-output-shape: missing role-budgets cache → baseline=null, source=no_cache', () => {
  test('no cache file at all → baseline_source=no_cache', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-no-cache');
    // Intentionally do NOT write role-budgets.json.

    const r = runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const ev = readEvents(root).find((e) => e.type === 'output_shape_applied');
    assert.ok(ev);
    assert.equal(ev.baseline_output_tokens, null,
      'baseline null when cache missing');
    assert.equal(ev.baseline_source, 'no_cache',
      'baseline_source explicitly labels the miss for debuggability');
  });

  test('cache present but role absent → baseline_source=no_cache', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-role-absent');
    writeRoleBudgets(root, { role_budgets: { architect: { budget_tokens: 70000 } } });

    const r = runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const ev = readEvents(root).find((e) => e.type === 'output_shape_applied');
    assert.ok(ev);
    assert.equal(ev.baseline_output_tokens, null);
    assert.equal(ev.baseline_source, 'no_cache');
  });
});

// ---------------------------------------------------------------------------
// observe-output-shape.js — paired event emission
// ---------------------------------------------------------------------------

describe('observe-output-shape: emits output_shape_observed with cap_respected=true on under-cap spawn', () => {
  test('end-to-end pair: inject(reviewer) → observe(reviewer, 12000 tokens, cap=50000)', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-pair-under');
    writeRoleBudgets(root, {
      role_budgets: { reviewer: { budget_tokens: 50000 } },
    });

    // Step 1 — inject hook fires, writes output_shape_applied.
    const inj = runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });
    assert.equal(inj.status, 0);

    // Step 2 — observe hook fires on SubagentStop with usage.output_tokens.
    const obs = runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      agent_type: 'reviewer',
      agent_id: 'task-r1',
      session_id: 'sess-abc',
      usage: { input_tokens: 1000, output_tokens: 12000 },
    });
    assert.equal(obs.status, 0, 'observe hook exits 0; stderr=' + obs.stderr);
    assert.equal(obs.parsedStdout && obs.parsedStdout.continue, true,
      'observe hook always returns continue:true (fail-open)');

    const events = readEvents(root);
    const observed = events.find((e) => e.type === 'output_shape_observed');
    assert.ok(observed, 'output_shape_observed row written');
    assert.equal(observed.role, 'reviewer');
    assert.equal(observed.agent_type, 'reviewer');
    assert.equal(observed.agent_id, 'task-r1');
    assert.equal(observed.observed_output_tokens, 12000);
    assert.equal(typeof observed.cap_output_tokens, 'number');
    assert.equal(observed.cap_respected, true,
      'cap_respected=true when observed <= cap');
    // Baseline is echoed from the applied row.
    assert.equal(observed.baseline_output_tokens, 50000,
      'baseline echoed from applied row for join-convenience');
    assert.equal(observed.version, 1);
  });
});

describe('observe-output-shape: cap_respected=false when observed exceeds cap', () => {
  test('reviewer over cap → cap_respected=false', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-over-cap');

    runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });

    // Find the cap injected by the applied row, then exceed it.
    const applied = readEvents(root).find((e) => e.type === 'output_shape_applied');
    assert.ok(applied);
    const cap = applied.cap_output_tokens || applied.length_cap;
    assert.ok(typeof cap === 'number' && cap > 0, 'applied row has a cap');

    runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      agent_type: 'reviewer',
      usage: { output_tokens: cap + 1 },
    });

    const observed = readEvents(root).find((e) => e.type === 'output_shape_observed');
    assert.ok(observed);
    assert.equal(observed.cap_respected, false,
      'cap_respected=false when observed > cap');
    assert.equal(observed.observed_output_tokens, cap + 1);
  });
});

describe('observe-output-shape: cap_respected=null when observed cannot be determined', () => {
  test('no usage payload, no transcript → observed_output_tokens=null, cap_respected=null', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-no-tokens');

    runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });

    runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      agent_type: 'reviewer',
      // Deliberately no usage, no transcript_path.
    });

    const observed = readEvents(root).find((e) => e.type === 'output_shape_observed');
    assert.ok(observed);
    assert.equal(observed.observed_output_tokens, null);
    assert.equal(observed.cap_respected, null,
      'cap_respected=null when observed is unknown');
  });
});

describe('observe-output-shape: pairing by (orchestration_id, role) — most recent wins', () => {
  test('two reviewer applieds in same orch → observed pairs with the SECOND', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-pair-recent');
    writeRoleBudgets(root, {
      role_budgets: { reviewer: { budget_tokens: 50000 } },
    });

    // First reviewer spawn — applied row #1.
    runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: 'first' },
    });
    // Second reviewer spawn — applied row #2 (most recent).
    runHook(INJECT_HOOK, {
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: 'second' },
    });

    const beforeObserve = readEvents(root).filter((e) => e.type === 'output_shape_applied');
    assert.equal(beforeObserve.length, 2, 'two applied rows present');

    runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      agent_type: 'reviewer',
      agent_id: 'task-second',
      usage: { output_tokens: 8000 },
    });

    const observed = readEvents(root).find((e) => e.type === 'output_shape_observed');
    assert.ok(observed);
    assert.equal(observed.role, 'reviewer');
    assert.equal(observed.observed_output_tokens, 8000);
    assert.equal(observed.cap_respected, true);
    // Same orchestration_id so the pairing key holds.
    assert.equal(observed.orchestration_id, 'orch-w2-pair-recent');
  });
});

describe('observe-output-shape: no matching applied row → silent no-op', () => {
  test('different orchestration → no observed row written', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-mismatch');

    // Note: NO inject hook firing. The applied row simply doesn't exist.
    runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      agent_type: 'reviewer',
      usage: { output_tokens: 8000 },
    });

    const observed = readEvents(root).filter((e) => e.type === 'output_shape_observed');
    assert.equal(observed.length, 0,
      'no applied row → no observed row (cannot pair)');
  });

  test('excluded role (pm) → no observed row even with usage', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-pm');

    runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      agent_type: 'pm',
      usage: { output_tokens: 8000 },
    });

    const observed = readEvents(root).filter((e) => e.type === 'output_shape_observed');
    assert.equal(observed.length, 0,
      'pm role is excluded by inject hook → no applied row → no observed row');
  });
});

describe('observe-output-shape: defensive paths', () => {
  test('malformed stdin → silent continue, no row written', () => {
    const r = cp.spawnSync(NODE, [OBSERVE_HOOK], {
      input: 'not json',
      env: Object.assign({}, process.env),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).continue, true);
  });

  test('empty stdin → silent continue', () => {
    const r = cp.spawnSync(NODE, [OBSERVE_HOOK], {
      input: '',
      env: Object.assign({}, process.env),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).continue, true);
  });

  test('missing agent_type → silent continue (cannot pair)', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-w2-no-type');

    const r = runHook(OBSERVE_HOOK, {
      hook_event_name: 'SubagentStop',
      cwd: root,
      // No agent_type.
      usage: { output_tokens: 1000 },
    });
    assert.equal(r.status, 0);
    const observed = readEvents(root).filter((e) => e.type === 'output_shape_observed');
    assert.equal(observed.length, 0);
  });
});
