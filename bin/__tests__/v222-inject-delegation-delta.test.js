#!/usr/bin/env node
'use strict';

/**
 * v222-inject-delegation-delta.test.js — C1 hook unit tests (v2.2.2 Bucket C).
 *
 * Tests the bin/inject-delegation-delta.js PreToolUse:Agent hook in isolation
 * by spawning it as a child process and feeding it a synthesized hook payload
 * on stdin. Asserts:
 *   1. First spawn → type=full, prefix cache file written, delegation_delta_emit
 *      event with type_emitted='full' and reason='first_spawn'.
 *   2. Second spawn (same orch+agent) → type=delta, updatedInput.prompt is the
 *      delta_text (smaller than original), event with type_emitted='delta' and
 *      full_bytes_avoided > 0.
 *   3. Hash mismatch (PM rewrote static block mid-orch) → type=full with
 *      reason='hash_mismatch', cache file overwritten.
 *   4. Markers missing → delegation_delta_skip event with reason='markers_missing'.
 *   5. ORCHESTRAY_DISABLE_DELEGATION_DELTA=1 → no updatedInput, skip event with
 *      reason='kill_switch_env'.
 *   6. config kill switch → skip event with reason='kill_switch_config'.
 *   7. No orchestration active → skip event with reason='no_orchestration_active'.
 *   8. Non-Agent tool_name → noop continue.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'inject-delegation-delta.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE       = process.execPath;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-c1-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // v2.2.2 Fix #6: copy the real event-schemas.md into the tmpdir so the
  // audit-event-writer's schema validator (bin/_lib/schema-emit-validator.js)
  // takes the validation path instead of the "schema unreadable → skipped"
  // fall-through. Without this, missing-required-field defects in the C1 hook
  // would slip past the test (REV1 v222-review.md issue #6).
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

// v2.2.2 Fix #6: assert that no schema-validation surrogate rows landed in
// events.jsonl. A single `schema_shadow_validation_block` row means a real
// emit was rejected for a missing required field and replaced with this
// surrogate — proves the test fixture is exercising validation AND the
// underlying emit is malformed.
function assertNoValidationSurrogates(events, label) {
  const surrogates = events.filter(
    (e) => e.type === 'schema_shadow_validation_block' || e.type === 'schema_unknown_type_warn'
  );
  if (surrogates.length > 0) {
    const detail = surrogates.map((s) => JSON.stringify(s)).join('\n');
    throw new Error(
      (label || 'emit') + ': schema validation produced ' + surrogates.length +
      ' surrogate row(s) — a real emit was malformed:\n' + detail
    );
  }
}

function writeOrchMarker(root, orchId) {
  const file = path.join(root, '.orchestray', 'audit', 'current-orchestration.json');
  fs.writeFileSync(file, JSON.stringify({ orchestration_id: orchId }), 'utf8');
}

function writeConfig(root, cfg) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
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

function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
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
const PER_SPAWN_V1 = '## Task\nimplement feature X\n';
const PER_SPAWN_V2 = '## Task\nfix feature Y\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('C1 inject-delegation-delta hook — first spawn', () => {
  test('first Agent spawn returns full result, writes prefix cache, emits full event', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-test1');
    const prompt = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1);

    const r = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: 'developer', prompt },
    });

    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);

    // Stdout payload — first spawn means the helper returns type=full and the
    // hook does NOT emit an updatedInput (passes original through).
    const out = r.parsedStdout;
    assert.ok(out, 'stdout must be valid JSON');
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined,
      'first-spawn full path has no updatedInput');

    // Prefix cache file created on disk.
    const cacheFile = path.join(root,
      '.orchestray', 'state', 'spawn-prefix-cache',
      'orch-c1-test1-developer.txt');
    assert.ok(fs.existsSync(cacheFile),
      'prefix cache file must be written on first spawn');

    // Audit event written.
    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'first-spawn emit');
    const emit = evs.find((e) => e.type === 'delegation_delta_emit');
    assert.ok(emit, 'delegation_delta_emit event must be written');
    assert.equal(emit.type_emitted, 'full');
    assert.equal(emit.reason, 'first_spawn');
    assert.equal(emit.agent_type, 'developer');
    assert.equal(emit.orchestration_id, 'orch-c1-test1');
    assert.equal(emit.full_bytes_avoided, 0);
    assert.match(emit.prefix_hash, /^[0-9a-f]{64}$/);
    // v2.2.2 Fix #2: spawn_n + version are required fields; verify both.
    assert.equal(emit.version, 1, 'version must be 1 (Fix #2)');
    assert.equal(emit.spawn_n, 1, 'first spawn must carry spawn_n=1 (Fix #2)');
  });
});

describe('C1 inject-delegation-delta hook — second spawn (delta)', () => {
  test('second Agent spawn with same static portion returns delta, mutates prompt', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-test2');
    const promptV1 = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1);
    const promptV2 = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V2);

    // First spawn — primes the cache.
    const r1 = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: 'developer', prompt: promptV1 },
    });
    assert.equal(r1.status, 0);

    // Second spawn — should return delta and rewrite the prompt.
    const r2 = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: 'developer', prompt: promptV2, model: 'sonnet' },
    });
    assert.equal(r2.status, 0, 'second spawn exits 0; stderr=' + r2.stderr);
    const out2 = r2.parsedStdout;
    assert.ok(out2.hookSpecificOutput, 'delta path must produce updatedInput');
    assert.equal(out2.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(out2.hookSpecificOutput.hookEventName, 'PreToolUse');

    const updatedPrompt = out2.hookSpecificOutput.updatedInput.prompt;
    assert.ok(updatedPrompt.startsWith('<!-- delta:reference prefix_hash="'),
      'updated prompt is the delta block with the reference anchor');
    assert.ok(updatedPrompt.length < promptV2.length,
      'delta payload is smaller than the original prompt');
    assert.ok(updatedPrompt.includes(PER_SPAWN_V2),
      'delta payload preserves the per-spawn portion of promptV2');
    assert.ok(!updatedPrompt.includes(STATIC_BODY),
      'delta payload omits the static portion');

    // Other tool_input fields preserved.
    assert.equal(out2.hookSpecificOutput.updatedInput.subagent_type, 'developer');
    assert.equal(out2.hookSpecificOutput.updatedInput.model, 'sonnet');

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'delta emit');
    const deltas = evs.filter((e) =>
      e.type === 'delegation_delta_emit' && e.type_emitted === 'delta');
    assert.equal(deltas.length, 1, 'one delta-mode emit row');
    assert.ok(deltas[0].full_bytes_avoided > 0);
    // v2.2.2 Fix #2: spawn_n on second spawn must be 2.
    assert.equal(deltas[0].version, 1, 'version must be 1 (Fix #2)');
    assert.equal(deltas[0].spawn_n, 2, 'second spawn must carry spawn_n=2 (Fix #2)');
  });
});

describe('C1 inject-delegation-delta hook — hash mismatch', () => {
  test('static body change mid-orch returns full with reason=hash_mismatch', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-hashm');
    const p1 = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1);
    const p2 = buildMarkedPrompt(STATIC_BODY + '\n## NEW SECTION\nx', PER_SPAWN_V1);

    runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt: p1 },
    });
    const r2 = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt: p2 },
    });
    assert.equal(r2.status, 0);

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'hash mismatch');
    const fulls = evs.filter((e) =>
      e.type === 'delegation_delta_emit' && e.type_emitted === 'full');
    assert.equal(fulls.length, 2);
    assert.equal(fulls[1].reason, 'hash_mismatch');
    // v2.2.2 Fix #2: confirm spawn_n increments correctly even on hash mismatch.
    assert.equal(fulls[0].spawn_n, 1);
    assert.equal(fulls[1].spawn_n, 2);
  });
});

describe('C1 inject-delegation-delta hook — markers missing (W3 mechanical injection)', () => {
  // W3 fix: instead of skipping, the hook now injects markers heuristically.
  // For prompts without per-spawn boundary headings the whole prompt is treated
  // as static; a delegation_delta_emit (type_emitted='full', reason='markers_injected')
  // is emitted and the prefix cache is written — no skip, no prompt mutation.
  test('prompt without markers → mechanical injection, delegation_delta_emit with reason=markers_injected', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-marker');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt: 'plain prompt without markers' },
    });
    assert.equal(r.status, 0);
    const out = r.parsedStdout;
    assert.equal(out.continue, true);
    // Original prompt is passed through unchanged (no updatedInput).
    assert.equal(out.hookSpecificOutput, undefined,
      'markers_injected path passes original prompt through unchanged');

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'markers_injected emit');
    // No skip event — the hook processed the prompt via injection.
    const skips = evs.filter((e) => e.type === 'delegation_delta_skip');
    assert.equal(skips.length, 0, 'no skip event emitted when injection succeeds');
    // A delegation_delta_emit is emitted.
    const emits = evs.filter((e) => e.type === 'delegation_delta_emit');
    assert.equal(emits.length, 1, 'one delegation_delta_emit emitted');
    assert.equal(emits[0].type_emitted, 'full');
    assert.equal(emits[0].reason, 'markers_injected');
    assert.equal(emits[0].agent_type, 'developer');
    assert.equal(emits[0].orchestration_id, 'orch-c1-marker');
    assert.equal(emits[0].version, 1, 'emit carries version=1');
    // Prefix cache file must be written.
    const cacheFile = path.join(root,
      '.orchestray', 'state', 'spawn-prefix-cache',
      'orch-c1-marker-developer.txt');
    assert.ok(fs.existsSync(cacheFile),
      'prefix cache file must be written even for injected-marker prompts');
  });

  test('unstructured prompt with per-spawn boundary heading → injection splits at heading', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-marker2');
    // Prompt with a ## Task heading — injection should split there.
    const prompt = '## Context\nsome static context\n\n## Task\ndo thing X\n';

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt },
    });
    assert.equal(r.status, 0);
    const out = r.parsedStdout;
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined, 'original prompt passed through');

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'split injection');
    const emits = evs.filter((e) => e.type === 'delegation_delta_emit');
    assert.equal(emits.length, 1);
    assert.equal(emits[0].reason, 'markers_injected');
  });
});

describe('C1 inject-delegation-delta hook — kill switches', () => {
  test('ORCHESTRAY_DISABLE_DELEGATION_DELTA=1 → skip event with reason=kill_switch_env', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-killenv');
    const prompt = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1);

    const r = runHook(
      { tool_name: 'Agent', cwd: root,
        tool_input: { subagent_type: 'developer', prompt } },
      { env: { ORCHESTRAY_DISABLE_DELEGATION_DELTA: '1' } }
    );
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'kill_switch_env skip');
    const skip = evs.find((e) => e.type === 'delegation_delta_skip');
    assert.ok(skip, 'skip event must be written');
    assert.equal(skip.reason, 'kill_switch_env');
    assert.equal(skip.version, 1, 'skip carries version=1 (Fix #2)');
  });

  test('config pm_protocol.delegation_delta.enabled=false → skip with reason=kill_switch_config', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-killcfg');
    writeConfig(root, { pm_protocol: { delegation_delta: { enabled: false } } });
    const prompt = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1);

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'kill_switch_config skip');
    const skip = evs.find((e) => e.type === 'delegation_delta_skip');
    assert.ok(skip);
    assert.equal(skip.reason, 'kill_switch_config');
    assert.equal(skip.version, 1, 'skip carries version=1 (Fix #2)');
  });
});

describe('C1 inject-delegation-delta hook — no active orchestration', () => {
  test('current-orchestration.json missing → skip with reason=no_orchestration_active', () => {
    const root = makeTmpRoot();
    // do NOT write orch marker
    const prompt = buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1);

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'developer', prompt },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'no_orchestration_active skip');
    const skip = evs.find((e) => e.type === 'delegation_delta_skip');
    assert.ok(skip);
    assert.equal(skip.reason, 'no_orchestration_active');
    assert.equal(skip.version, 1, 'skip carries version=1 (Fix #2)');
  });
});

describe('C1 inject-delegation-delta hook — defensive paths', () => {
  test('non-Agent tool_name → silent continue, no events', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-other');

    const r = runHook({
      tool_name: 'Bash', cwd: root,
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    assert.equal(evs.length, 0, 'no events for non-Agent calls');
  });

  test('missing subagent_type → silent continue, no events', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c1-noagent');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { prompt: 'something' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    const evs = readEvents(root);
    assert.equal(evs.length, 0);
  });

  test('malformed stdin JSON → silent continue, no crash', () => {
    const env = Object.assign({}, process.env);
    const r = cp.spawnSync(NODE, [HOOK_PATH], {
      input: 'this is not json',
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).continue, true);
  });
});
