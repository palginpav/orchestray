#!/usr/bin/env node
'use strict';

/**
 * v222-bucket-c-integration-smoke.test.js — Bucket C integration smoke.
 *
 * Drives the two new PreToolUse:Agent hooks in sequence (matching the order
 * declared in hooks/hooks.json) against a small in-memory orchestration to
 * confirm:
 *
 *   1. First spawn of (orch, agent_type) emits `delegation_delta_emit`
 *      type_emitted='full' AND `output_shape_applied`.
 *   2. Second spawn of the same (orch, agent_type) emits
 *      `delegation_delta_emit` type_emitted='delta' AND `output_shape_applied`
 *      again. The delta hook substitutes a smaller prompt; the output-shape
 *      hook then appends the per-spawn addendum to that delta.
 *   3. `output_shape_applied` lands for every spawn of reviewer / debugger /
 *      documenter (per-role telemetry assertion).
 *
 * Each "spawn" runs the chain in serial: payload through C1, then payload
 * (mutated by C1) through C2. This mirrors what Claude Code does when it
 * walks the matcher chain in hooks.json.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT       = path.resolve(__dirname, '..', '..');
const HOOK_DELTA      = path.join(REPO_ROOT, 'bin', 'inject-delegation-delta.js');
const HOOK_OUT_SHAPE  = path.join(REPO_ROOT, 'bin', 'inject-output-shape.js');
const NODE            = process.execPath;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-c-smoke-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

function writeOrchMarker(root, orchId) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function buildMarkedPrompt(staticBody, perSpawnBody) {
  return (
    '<!-- delta:static-begin -->\n' +
    staticBody +
    '\n<!-- delta:static-end -->\n' +
    '<!-- delta:per-spawn-begin -->\n' +
    perSpawnBody +
    '\n<!-- delta:per-spawn-end -->'
  );
}

function runHook(hookPath, payload) {
  const r = cp.spawnSync(NODE, [hookPath], {
    input: JSON.stringify(payload),
    env: process.env,
    encoding: 'utf8',
    timeout: 8000,
  });
  if (r.status !== 0) {
    throw new Error('Hook ' + hookPath + ' exit ' + r.status + ': ' + r.stderr);
  }
  let parsed = null;
  try { parsed = r.stdout ? JSON.parse(r.stdout) : null; } catch (_e) {}
  return parsed;
}

function chainSpawn(root, agentType, prompt, extras) {
  // Simulate Claude Code walking the matcher="Agent" chain.
  // Order per hooks.json: (validate-* hooks) → inject-delegation-delta →
  // inject-output-shape. We only test the two injection hooks here; the
  // validators are read-only and tested separately.
  let curToolInput = Object.assign({ subagent_type: agentType, prompt }, extras || {});
  const payload1 = {
    tool_name: 'Agent',
    cwd: root,
    tool_input: curToolInput,
  };
  const out1 = runHook(HOOK_DELTA, payload1);
  if (out1 && out1.hookSpecificOutput && out1.hookSpecificOutput.updatedInput) {
    curToolInput = out1.hookSpecificOutput.updatedInput;
  }

  const payload2 = {
    tool_name: 'Agent',
    cwd: root,
    tool_input: curToolInput,
  };
  const out2 = runHook(HOOK_OUT_SHAPE, payload2);
  if (out2 && out2.hookSpecificOutput && out2.hookSpecificOutput.updatedInput) {
    curToolInput = out2.hookSpecificOutput.updatedInput;
  }

  return curToolInput;
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

const STATIC_BODY = (
  '## Handoff Contract\nfollow contract.md\n\n' +
  '## Pre-Flight\n- read repo map\n- list files\n\n' +
  '## Repo Map\n' + ('[entry]\n'.repeat(40))
);

describe('Bucket C smoke — two same-type spawns produce expected event sequence', () => {
  test('reviewer x2 + developer x1 spawn sequence', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-c-smoke-1');

    // Spawn 1 — reviewer (first of its kind for this orch)
    chainSpawn(root, 'reviewer',
      buildMarkedPrompt(STATIC_BODY, '## Task\nreview src/foo.ts\n'));

    // Spawn 2 — reviewer again (second of same agent_type)
    chainSpawn(root, 'reviewer',
      buildMarkedPrompt(STATIC_BODY, '## Task\nre-review after fix\n'));

    // Spawn 3 — developer (first of its kind for this orch)
    chainSpawn(root, 'developer',
      buildMarkedPrompt(STATIC_BODY, '## Task\nimplement feature\n'));

    const evs = readEvents(root);

    // Filter delegation_delta_emit events
    const reviewerEmits = evs.filter((e) =>
      e.type === 'delegation_delta_emit' && e.agent_type === 'reviewer');
    assert.equal(reviewerEmits.length, 2, 'two reviewer emits');
    assert.equal(reviewerEmits[0].type_emitted, 'full', 'first reviewer = full');
    assert.equal(reviewerEmits[0].reason, 'first_spawn');
    assert.equal(reviewerEmits[1].type_emitted, 'delta', 'second reviewer = delta');
    assert.ok(reviewerEmits[1].full_bytes_avoided > 0,
      'delta path saves bytes');

    const devEmits = evs.filter((e) =>
      e.type === 'delegation_delta_emit' && e.agent_type === 'developer');
    assert.equal(devEmits.length, 1, 'one developer emit');
    assert.equal(devEmits[0].type_emitted, 'full',
      'first developer = full (different agent_type → first spawn)');

    // output_shape_applied event for every spawn (3 total).
    const shapeApplies = evs.filter((e) => e.type === 'output_shape_applied');
    assert.equal(shapeApplies.length, 3,
      'output_shape_applied fires on every reviewer + developer spawn');

    // All three are hybrid category.
    for (const ev of shapeApplies) {
      assert.equal(ev.category, 'hybrid');
      assert.equal(ev.caveman, true);
      assert.equal(ev.structured, false);
    }

    // No delegation_delta_skip events (smoke runs on the happy path).
    const skips = evs.filter((e) => e.type === 'delegation_delta_skip');
    assert.equal(skips.length, 0,
      'happy path emits zero skip events');
  });
});

describe('Bucket C smoke — output_shape_applied lands for every reviewer/debugger/documenter spawn', () => {
  test('per-role telemetry assertion', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-c-smoke-2');

    const roles = ['reviewer', 'debugger', 'documenter'];
    for (const role of roles) {
      chainSpawn(root, role,
        buildMarkedPrompt(STATIC_BODY, '## Task\nreviewing for ' + role + '\n'));
    }

    const evs = readEvents(root);
    for (const role of roles) {
      const ev = evs.find((e) => e.type === 'output_shape_applied' && e.role === role);
      assert.ok(ev, 'output_shape_applied event for ' + role + ' must be present');
      assert.equal(ev.category, 'hybrid', role + ' is hybrid category');
    }
  });
});

describe('Bucket C smoke — markers_missing path uses mechanical injection (W3 fix)', () => {
  // W3 fix: the hook now injects delta markers heuristically when the PM omits them.
  // Prompts starting with a per-spawn boundary heading (## Task, ## Files to, etc.)
  // get an empty static portion + full content as per-spawn.  The hook emits
  // delegation_delta_emit(reason='markers_injected') and writes the prefix cache;
  // no delegation_delta_skip is emitted.
  test('orchestrator-typed prompt (no markers) → injection fires, prefix cached, no skip', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-c-smoke-3');

    // Operator-typed prompt with NO delta markers — starts with ## Task heading.
    chainSpawn(root, 'reviewer', '## Task\nreview src/bar.ts (no markers)');

    const evs = readEvents(root);
    // No skip event — W3 fix injects markers mechanically.
    const skip = evs.find((e) => e.type === 'delegation_delta_skip');
    assert.equal(skip, undefined, 'W3 fix: no delegation_delta_skip when injection succeeds');

    // delegation_delta_emit is emitted with reason=markers_injected.
    const emit = evs.find((e) => e.type === 'delegation_delta_emit');
    assert.ok(emit, 'delegation_delta_emit must be emitted after injection');
    assert.equal(emit.reason, 'markers_injected');
    assert.equal(emit.agent_type, 'reviewer');
    assert.equal(emit.orchestration_id, 'orch-c-smoke-3');

    // Output-shape still fires (independent hook).
    const sh = evs.find((e) => e.type === 'output_shape_applied');
    assert.ok(sh, 'output_shape_applied still fires when delta path uses injection');
  });
});
