#!/usr/bin/env node
'use strict';

/**
 * v222-inject-output-shape.test.js — C2 hook unit tests (v2.2.2 Bucket C).
 *
 * Tests the bin/inject-output-shape.js PreToolUse:Agent hook in isolation by
 * spawning it as a child process and feeding it a synthesized hook payload on
 * stdin. Asserts:
 *   1. reviewer (hybrid, IN default staged_flip_allowlist as of v2.2.3 P3-W1
 *      A4) → updatedInput.prompt ends with caveman + length-cap + handoff-
 *      contract suffix; outputConfig.format set to HYBRID_ROLE_SCHEMA;
 *      output_shape_applied event with category=hybrid, caveman=true,
 *      length_cap > 0, structured=true.
 *   2. tester (structured-only, IN allowlist) → handoff-contract suffix
 *      injected (no caveman, structured-only roles skip caveman); outputConfig
 *      .format set to TESTER_SCHEMA; event with structured=true.
 *   3. project-intent (category=none) → no prompt mutation; event with
 *      category=none (intentional opt-out telemetry preserved).
 *   4. pm (excluded role) → no updatedInput, no event.
 *   5. config output_shape.enabled=false → event with category=none, no mutation.
 *   6. ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1 → no updatedInput, no event.
 *   7. handoff-contract suffix is byte-identical to the verbatim Section 12.a
 *      contract (regression for D3 Finding #5).
 *   8. Caveman addendum is the verbatim 85-token literal from output-shape.js.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'inject-output-shape.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE       = process.execPath;

const { CAVEMAN_TEXT, ROLE_SCHEMA_MAP } = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-c2-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // v2.2.2 Fix #6: copy real event-schemas.md so the audit-event-writer's
  // schema validator runs (instead of falling through to the unreadable-
  // skipped branch). Without this, missing-required-field defects in the
  // C2 hook would slip past the test (REV1 v222-review.md issue #6).
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

// v2.2.2 Fix #6: assert no schema-validation surrogate rows landed. A single
// `schema_shadow_validation_block` row means a real emit was rejected for a
// missing required field and replaced with this surrogate.
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
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function writeConfig(root, cfg) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8'
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

// v2.2.2 Fix #7: import from the shared module so this test will catch a
// drift in either bin/inject-output-shape.js or bin/validate-task-completion.js
// at unit-test time. The previous in-test literal was byte-identical with
// inject-output-shape.js — moving to a shared module eliminates that
// 3-place-hardcoding drift risk.
const { HANDOFF_CONTRACT_SUFFIX } = require(path.join(REPO_ROOT, 'bin', '_lib', 'handoff-contract-text.js'));

const ORIG_PROMPT = '## Task\nReview the changes in src/foo.ts.\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('C2 inject-output-shape hook — reviewer (hybrid, in default allowlist v2.2.3 P3-W1)', () => {
  test('appends caveman + length cap + contract suffix; outputConfig.format set', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-reviewer');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);
    const out = r.parsedStdout;
    assert.ok(out.hookSpecificOutput,
      'hybrid role with non-`none` shape must produce updatedInput');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');

    const newPrompt = out.hookSpecificOutput.updatedInput.prompt;
    assert.ok(newPrompt.startsWith(ORIG_PROMPT),
      'original prompt body preserved at the start');
    assert.ok(newPrompt.includes('## Output Style'),
      'caveman block present');
    assert.ok(newPrompt.includes(CAVEMAN_TEXT),
      'caveman literal verbatim from output-shape.js');
    assert.ok(/\*\*Output token budget:\*\* ≤ \d+ tokens/.test(newPrompt),
      'length-cap line present');
    assert.ok(newPrompt.endsWith(HANDOFF_CONTRACT_SUFFIX),
      'handoff-contract suffix is the LAST appended block (D3 Layer 1 fix)');

    // v2.2.3 P3-W1 A4: reviewer now in default allowlist → outputConfig.format
    // is the shared HYBRID_ROLE_SCHEMA.
    const oc = out.hookSpecificOutput.updatedInput.outputConfig;
    assert.ok(oc && oc.format,
      'reviewer (hybrid) is in default staged_flip_allowlist as of v2.2.3 P3-W1 A4');
    assert.deepEqual(oc.format, ROLE_SCHEMA_MAP.reviewer,
      'reviewer schema matches the shared HYBRID_ROLE_SCHEMA');

    // Audit event.
    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'reviewer emit');
    const ev = evs.find((e) => e.type === 'output_shape_applied');
    assert.ok(ev, 'output_shape_applied event must be written');
    assert.equal(ev.role, 'reviewer');
    assert.equal(ev.category, 'hybrid');
    assert.equal(ev.caveman, true);
    assert.equal(ev.structured, true,
      'v2.2.3 P3-W1 A4: hybrid roles now report structured=true');
    assert.ok(typeof ev.length_cap === 'number' && ev.length_cap > 0);
    // v2.2.2 Fix #3: version + task_id + session_id required-field hygiene.
    assert.equal(ev.version, 1, 'version must be 1 (Fix #3)');
    assert.equal(ev.task_id, null, 'task_id null at hook boundary (Fix #3)');
    assert.ok('session_id' in ev, 'session_id field must be present (Fix #3)');
  });
});

describe('C2 inject-output-shape hook — tester (structured-only, in allowlist)', () => {
  test('contract suffix injected; no caveman; outputConfig.format set to TESTER_SCHEMA', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-tester');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'tester', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const out = r.parsedStdout;
    assert.ok(out.hookSpecificOutput);
    const newPrompt = out.hookSpecificOutput.updatedInput.prompt;

    assert.ok(!newPrompt.includes('## Output Style'),
      'structured-only roles skip caveman block');
    assert.ok(!/\*\*Output token budget:\*\*/.test(newPrompt),
      'structured-only roles skip length-cap line');
    assert.ok(newPrompt.endsWith(HANDOFF_CONTRACT_SUFFIX),
      'handoff-contract suffix STILL present for structured-only roles (D3 fix)');

    const oc = out.hookSpecificOutput.updatedInput.outputConfig;
    assert.ok(oc && oc.format,
      'tester is in staged_flip_allowlist → outputConfig.format must be set');
    assert.deepEqual(oc.format, ROLE_SCHEMA_MAP.tester,
      'tester schema matches the canonical TESTER_SCHEMA from output-shape.js');

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'tester emit');
    const ev = evs.find((e) => e.type === 'output_shape_applied');
    assert.ok(ev);
    assert.equal(ev.role, 'tester');
    assert.equal(ev.category, 'structured-only');
    assert.equal(ev.caveman, false);
    assert.equal(ev.structured, true);
    assert.equal(ev.version, 1, 'version=1 (Fix #3)');
  });
});

describe('C2 inject-output-shape hook — project-intent (category=none)', () => {
  test('no prompt mutation, telemetry event with category=none', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-pi');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'project-intent', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const out = r.parsedStdout;
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined,
      'category=none → no updatedInput');

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'project-intent emit');
    const ev = evs.find((e) => e.type === 'output_shape_applied');
    assert.ok(ev, 'category=none still emits telemetry (intentional opt-out)');
    assert.equal(ev.category, 'none');
    assert.equal(ev.version, 1, 'version=1 (Fix #3)');
  });
});

describe('C2 inject-output-shape hook — pm (excluded role)', () => {
  test('no updatedInput, no event for excluded roles', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-pm');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'pm', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    const ev = evs.find((e) => e.type === 'output_shape_applied');
    assert.equal(ev, undefined, 'excluded roles emit nothing');
  });
});

describe('C2 inject-output-shape hook — config kill switch', () => {
  test('output_shape.enabled=false → category=none telemetry, no prompt mutation', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-cfg');
    writeConfig(root, { output_shape: { enabled: false } });

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined,
      'kill switch → no prompt mutation');

    const evs = readEvents(root);
    assertNoValidationSurrogates(evs, 'config killswitch emit');
    const ev = evs.find((e) => e.type === 'output_shape_applied');
    assert.ok(ev, 'opt-out telemetry preserved');
    assert.equal(ev.category, 'none');
    assert.equal(ev.version, 1, 'version=1 (Fix #3)');
  });
});

describe('C2 inject-output-shape hook — env kill switch', () => {
  test('ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1 → no updatedInput, no event', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-env');

    const r = runHook(
      { tool_name: 'Agent', cwd: root,
        tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT } },
      { env: { ORCHESTRAY_DISABLE_OUTPUT_SHAPE: '1' } }
    );
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    assert.equal(evs.length, 0,
      'env kill switch is total — no events at all');
  });
});

describe('C2 inject-output-shape hook — defensive paths', () => {
  test('non-Agent tool_name → silent continue', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-bash');

    const r = runHook({
      tool_name: 'Bash', cwd: root,
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
    assert.equal(r.parsedStdout.hookSpecificOutput, undefined);

    const evs = readEvents(root);
    assert.equal(evs.length, 0);
  });

  test('missing subagent_type → silent continue', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-c2-nosub');

    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { prompt: 'no subagent_type' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.parsedStdout.continue, true);
  });

  test('malformed stdin → silent continue', () => {
    const r = cp.spawnSync(NODE, [HOOK_PATH], {
      input: 'not json',
      env: Object.assign({}, process.env),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).continue, true);
  });
});

describe('C2 inject-output-shape hook — D3 Finding #5 regression', () => {
  test('all hybrid roles get the contract suffix and outputConfig (v2.2.3 P3-W1 A4)', () => {
    // The hybrid roles list per output-shape.js ROLE_CATEGORY_MAP. v2.2.3 P3-W1
    // (A4) flipped them into the default staged_flip_allowlist; all 8 now
    // receive the shared HYBRID_ROLE_SCHEMA via outputConfig.format AND the
    // contract suffix (D3 Finding #5 regression).
    const hybridRoles = [
      'developer', 'debugger', 'reviewer', 'architect',
      'documenter', 'refactorer', 'inventor', 'release-manager',
    ];
    for (const role of hybridRoles) {
      const root = makeTmpRoot();
      writeOrchMarker(root, 'orch-c2-r-' + role);
      const r = runHook({
        tool_name: 'Agent', cwd: root,
        tool_input: { subagent_type: role, prompt: ORIG_PROMPT },
      });
      assert.equal(r.status, 0, role + ' hook exit 0');
      const newPrompt = r.parsedStdout.hookSpecificOutput.updatedInput.prompt;
      assert.ok(newPrompt.endsWith(HANDOFF_CONTRACT_SUFFIX),
        role + ': prompt MUST end with handoff-contract suffix (D3 Finding #5 regression)');
      // v2.2.3 P3-W1 A4: outputConfig.format MUST be set with HYBRID_ROLE_SCHEMA.
      const oc = r.parsedStdout.hookSpecificOutput.updatedInput.outputConfig;
      assert.ok(oc && oc.format,
        role + ': hybrid role now in default staged_flip_allowlist → outputConfig.format set');
      assert.deepEqual(oc.format, ROLE_SCHEMA_MAP[role],
        role + ': hybrid schema matches HYBRID_ROLE_SCHEMA from output-shape.js');
    }
  });

  test('prose-heavy roles (security-engineer, ux-critic) also get contract suffix', () => {
    const proseRoles = ['security-engineer', 'ux-critic'];
    for (const role of proseRoles) {
      const root = makeTmpRoot();
      writeOrchMarker(root, 'orch-c2-p-' + role);
      const r = runHook({
        tool_name: 'Agent', cwd: root,
        tool_input: { subagent_type: role, prompt: ORIG_PROMPT },
      });
      assert.equal(r.status, 0);
      const newPrompt = r.parsedStdout.hookSpecificOutput.updatedInput.prompt;
      assert.ok(newPrompt.endsWith(HANDOFF_CONTRACT_SUFFIX),
        role + ': prose-heavy role MUST get contract suffix');
      assert.ok(newPrompt.includes('## Output Style'),
        role + ': prose-heavy gets caveman block too');
    }
  });
});
