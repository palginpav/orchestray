#!/usr/bin/env node
'use strict';

/**
 * i-phase-gate.test.js — TDD tests for the I-PHASE-GATE phase slice split
 * (W8, v2.1.15). Per W4 P-PHASE-SPLIT-RECONCILE prototype seeds + W5 F-05
 * kill-switch test.
 *
 * Tests:
 *   1. Phase classification determinism (same input -> same output)
 *   2. Reference rewriter coverage (every outgoing_refs entry resolves)
 *   3. Hook injection per phase (decomp/execute/verify/close fires the right slice)
 *   4. Fallback on unparseable phase (phase-contract.md still loads, fallback event emitted)
 *   5. Behavior-equivalence dogfood (all five slice files exist + phase-contract.md is loadable)
 *   6. Kill switch (phase_slice_loading.enabled: false loads legacy, omits contract+slices)
 *
 * Runner: node --test tests/i-phase-gate.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PM_REF_DIR = path.join(ROOT, 'agents', 'pm-reference');
const PM_MD = path.join(ROOT, 'agents', 'pm.md');
const CONFIG_PATH = path.join(ROOT, '.orchestray', 'config.json');

const SLICE_FILES = [
  'phase-contract.md',
  'phase-decomp.md',
  'phase-execute.md',
  'phase-verify.md',
  'phase-close.md',
];

const LEGACY_FILE = 'tier1-orchestration.md.legacy';

// ---------------------------------------------------------------------------
// Test 1 — phase classification determinism
// ---------------------------------------------------------------------------

describe('Test 1: phase classification determinism', () => {
  const classifyPath = path.join(ROOT, 'bin', '_tools', 'phase-split-classify.js');

  test('phase-split-classify.js exists and is executable', () => {
    assert.ok(fs.existsSync(classifyPath), 'classifier tool must exist');
    const stat = fs.statSync(classifyPath);
    // Owner-execute bit set
    assert.ok((stat.mode & 0o100) !== 0, 'classifier tool must be executable');
  });

  test('classify is deterministic across two runs on same input', () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-split-a-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-split-b-'));

    // Use the legacy monolith as fixture — it's the source we split.
    const legacy = path.join(PM_REF_DIR, LEGACY_FILE);
    if (!fs.existsSync(legacy)) {
      // After split, the legacy file MUST still be there.
      assert.fail(`${LEGACY_FILE} must exist for one release`);
    }

    const runA = spawnSync('node', [
      classifyPath, '--source', legacy, '--out-dir', tmpA,
    ], { encoding: 'utf8' });
    assert.equal(runA.status, 0, `run A failed: ${runA.stderr}`);

    const runB = spawnSync('node', [
      classifyPath, '--source', legacy, '--out-dir', tmpB,
    ], { encoding: 'utf8' });
    assert.equal(runB.status, 0, `run B failed: ${runB.stderr}`);

    const anchorsA = JSON.parse(fs.readFileSync(path.join(tmpA, 'anchors.json'), 'utf8'));
    const anchorsB = JSON.parse(fs.readFileSync(path.join(tmpB, 'anchors.json'), 'utf8'));

    // Determinism: phases per anchor are identical.
    assert.equal(anchorsA.anchors.length, anchorsB.anchors.length);
    for (let i = 0; i < anchorsA.anchors.length; i++) {
      assert.equal(
        anchorsA.anchors[i].phase,
        anchorsB.anchors[i].phase,
        `anchor ${i} (${anchorsA.anchors[i].heading}) should classify deterministically`
      );
    }

    // Cleanup
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 2 — reference rewriter coverage (validate-refs exits 0)
// ---------------------------------------------------------------------------

describe('Test 2: reference rewriter coverage', () => {
  const classifyPath = path.join(ROOT, 'bin', '_tools', 'phase-split-classify.js');
  const rewritePath  = path.join(ROOT, 'bin', '_tools', 'phase-split-rewrite-refs.js');
  const validatePath = path.join(ROOT, 'bin', '_tools', 'phase-split-validate-refs.js');

  test('all three split-toolchain scripts exist', () => {
    assert.ok(fs.existsSync(classifyPath), 'classify must exist');
    assert.ok(fs.existsSync(rewritePath),  'rewrite-refs must exist');
    assert.ok(fs.existsSync(validatePath), 'validate-refs must exist');
  });

  test('phase-split-validate-refs exits 0 on the canonical traceability', () => {
    // Build traceability fresh from the legacy monolith and validate against
    // the actual slice files we shipped.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-split-valid-'));

    const legacy = path.join(PM_REF_DIR, LEGACY_FILE);
    const r1 = spawnSync('node', [classifyPath, '--source', legacy, '--out-dir', tmp], { encoding: 'utf8' });
    assert.equal(r1.status, 0, `classify failed: ${r1.stderr}`);

    const r2 = spawnSync('node', [rewritePath, '--in-dir', tmp, '--out-dir', tmp], { encoding: 'utf8' });
    assert.equal(r2.status, 0, `rewrite failed: ${r2.stderr}`);

    const r3 = spawnSync('node', [
      validatePath,
      '--traceability', path.join(tmp, 'traceability.json'),
      '--slices-dir',   PM_REF_DIR,
    ], { encoding: 'utf8' });
    assert.equal(
      r3.status, 0,
      `validate-refs MUST exit 0 (BLOCK gate). Stderr:\n${r3.stderr}\nStdout:\n${r3.stdout}`
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — hook injection per phase
// ---------------------------------------------------------------------------

describe('Test 3: hook injection per phase', () => {
  // Lazy import — the hook script must be safe to require() (W6 require.main guard).
  let hookModule;
  test('inject-active-phase-slice.js loads as a module without hanging', () => {
    const mod = require(path.join(ROOT, 'bin', 'inject-active-phase-slice.js'));
    hookModule = mod;
    assert.ok(typeof mod.resolveSliceForPhase === 'function');
    assert.ok(typeof mod.PHASE_TO_FILE === 'object');
  });

  test('decomp phase resolves to phase-decomp.md', () => {
    assert.equal(hookModule.resolveSliceForPhase('decomposition'), 'phase-decomp.md');
    assert.equal(hookModule.resolveSliceForPhase('decomp'),        'phase-decomp.md');
    assert.equal(hookModule.resolveSliceForPhase('delegation'),    'phase-decomp.md');
    assert.equal(hookModule.resolveSliceForPhase('assessment'),    'phase-decomp.md');
  });

  test('implementation/execute phase resolves to phase-execute.md', () => {
    assert.equal(hookModule.resolveSliceForPhase('execute'),        'phase-execute.md');
    assert.equal(hookModule.resolveSliceForPhase('execution'),      'phase-execute.md');
    assert.equal(hookModule.resolveSliceForPhase('implementation'), 'phase-execute.md');
  });

  test('review/verify phase resolves to phase-verify.md', () => {
    assert.equal(hookModule.resolveSliceForPhase('verify'), 'phase-verify.md');
    assert.equal(hookModule.resolveSliceForPhase('review'), 'phase-verify.md');
  });

  test('close/complete phase resolves to phase-close.md', () => {
    assert.equal(hookModule.resolveSliceForPhase('close'),    'phase-close.md');
    assert.equal(hookModule.resolveSliceForPhase('closing'),  'phase-close.md');
    assert.equal(hookModule.resolveSliceForPhase('complete'), 'phase-close.md');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — fallback on unparseable phase
// ---------------------------------------------------------------------------

describe('Test 4: fallback on unparseable phase', () => {
  let hookModule;
  test('hook module loadable', () => {
    hookModule = require(path.join(ROOT, 'bin', 'inject-active-phase-slice.js'));
  });

  test('unrecognized phase returns null (caller falls back to contract-only)', () => {
    assert.equal(hookModule.resolveSliceForPhase('flibbertigibbet'), null);
  });

  test('null/empty/undefined phase returns null', () => {
    assert.equal(hookModule.resolveSliceForPhase(null),      null);
    assert.equal(hookModule.resolveSliceForPhase(''),        null);
    assert.equal(hookModule.resolveSliceForPhase(undefined), null);
  });

  test('phase-contract.md is loadable as the fallback', () => {
    const contractPath = path.join(PM_REF_DIR, 'phase-contract.md');
    assert.ok(fs.existsSync(contractPath), 'phase-contract.md must exist as fallback');
    const content = fs.readFileSync(contractPath, 'utf8');
    assert.ok(content.includes('State Persistence Protocol'),
      'phase-contract must contain shared §7');
    assert.ok(content.includes('Knowledge Base Protocol'),
      'phase-contract must contain shared §10');
    assert.ok(content.includes('Context Handoff Protocol'),
      'phase-contract must contain shared §11');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — behavior-equivalence (slice files complete + dispatch wired)
// ---------------------------------------------------------------------------

describe('Test 5: behavior-equivalence dogfood', () => {
  test('all 5 phase slice files exist', () => {
    for (const f of SLICE_FILES) {
      assert.ok(
        fs.existsSync(path.join(PM_REF_DIR, f)),
        `slice file ${f} must exist`
      );
    }
  });

  test('legacy file kept for one release', () => {
    assert.ok(
      fs.existsSync(path.join(PM_REF_DIR, LEGACY_FILE)),
      `${LEGACY_FILE} must remain for the v2.1.15 rollback path`
    );
  });

  test('original tier1-orchestration.md is retired', () => {
    assert.ok(
      !fs.existsSync(path.join(PM_REF_DIR, 'tier1-orchestration.md')),
      'tier1-orchestration.md must be renamed to .legacy'
    );
  });

  test('phase slices contain expected canonical sections', () => {
    const decomp  = fs.readFileSync(path.join(PM_REF_DIR, 'phase-decomp.md'),  'utf8');
    const execute = fs.readFileSync(path.join(PM_REF_DIR, 'phase-execute.md'), 'utf8');
    const verify  = fs.readFileSync(path.join(PM_REF_DIR, 'phase-verify.md'),  'utf8');
    const close   = fs.readFileSync(path.join(PM_REF_DIR, 'phase-close.md'),   'utf8');

    assert.ok(decomp.includes('Task Decomposition Protocol'),
      'phase-decomp must contain §13');
    assert.ok(decomp.includes('Contract Generation'),
      'phase-decomp must contain §13.X');
    assert.ok(execute.includes('Parallel Execution Protocol'),
      'phase-execute must contain §14');
    assert.ok(execute.includes('Dynamic Agent Spawning'),
      'phase-execute must contain §17');
    assert.ok(verify.includes('Adaptive Re-Planning Protocol'),
      'phase-verify must contain §16');
    assert.ok(verify.includes('Verify-Fix Loop Protocol'),
      'phase-verify must contain §18');
    assert.ok(close.includes('Cost Tracking'),
      'phase-close must contain §15');
    assert.ok(close.includes('Pattern Extraction'),
      'phase-close must contain §22');
  });

  test('cross-phase dogfood pointer present (W5 F-02)', () => {
    // The verify slice must cite phase-decomp's task numbering convention.
    const verify = fs.readFileSync(path.join(PM_REF_DIR, 'phase-verify.md'), 'utf8');
    assert.ok(
      verify.includes('phase-decomp.md'),
      'phase-verify.md must include cross-phase pointer to phase-decomp.md ' +
      '(W5 F-02 dogfood traversal target)'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6 — kill switch (W5 F-05)
// ---------------------------------------------------------------------------

describe('Test 6: kill switch (W5 F-05)', () => {
  test('agents/pm.md dispatch table contains 2-branch conditional', () => {
    const pm = fs.readFileSync(PM_MD, 'utf8');
    assert.ok(
      pm.includes('phase_slice_loading.enabled'),
      'pm.md Section Loading must reference phase_slice_loading.enabled'
    );
    assert.ok(
      pm.includes('tier1-orchestration.md.legacy'),
      'pm.md must name the legacy fallback file by full name'
    );
    assert.ok(
      pm.includes('phase-contract.md'),
      'pm.md must name phase-contract.md as always-loaded under branch (a)'
    );
    // Branch (b) must explicitly NOT load phase slices.
    assert.ok(
      pm.includes('Do NOT load any phase slice'),
      'pm.md must explicitly state that branch (b) skips phase slices'
    );
  });

  test('config has phase_slice_loading block with default enabled=true', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.ok(cfg.phase_slice_loading,
      'config must have phase_slice_loading block');
    assert.equal(cfg.phase_slice_loading.enabled, true,
      'phase_slice_loading.enabled must default to true');
  });

  test('hook respects config kill switch (enabled=false → no slice staged)', () => {
    // Run the hook in a tmp cwd with a config that disables phase slices, an
    // active orchestration, and the slice files in place. Verify it emits
    // {continue: true} only (no additionalContext) and does NOT stage a slice.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-killswitch-'));
    const tmpOrch = path.join(tmp, '.orchestray', 'state');
    fs.mkdirSync(tmpOrch, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'config.json'),
      JSON.stringify({ phase_slice_loading: { enabled: false } })
    );
    fs.writeFileSync(
      path.join(tmpOrch, 'orchestration.md'),
      '---\nid: orch-test\ncurrent_phase: implementation\n---\n'
    );
    // Copy slice files so their absence isn't the reason for skipping.
    const tmpRefs = path.join(tmp, 'agents', 'pm-reference');
    fs.mkdirSync(tmpRefs, { recursive: true });
    for (const f of SLICE_FILES) {
      fs.copyFileSync(path.join(PM_REF_DIR, f), path.join(tmpRefs, f));
    }

    const hookPath = path.join(ROOT, 'bin', 'inject-active-phase-slice.js');
    const r = spawnSync('node', [hookPath], {
      cwd: tmp,
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRAY_DISABLE_PHASE_SLICES: '' },
    });
    assert.equal(r.status, 0);

    const out = JSON.parse(r.stdout.trim() || '{}');
    // Kill-switch branch returns {continue: true} ONLY — no additionalContext.
    assert.equal(out.continue, true);
    assert.equal(
      out.hookSpecificOutput,
      undefined,
      'kill-switch path must NOT inject additionalContext'
    );
    // Slice file MUST NOT be staged in tmpOrch.
    assert.ok(
      !fs.existsSync(path.join(tmpOrch, 'active-phase-slice.md')),
      'kill-switch path must not stage active-phase-slice.md'
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('env kill switch ORCHESTRAY_DISABLE_PHASE_SLICES=1 also disables', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-envkill-'));
    fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'orchestration.md'),
      '---\nid: orch-test\ncurrent_phase: implementation\n---\n'
    );

    const hookPath = path.join(ROOT, 'bin', 'inject-active-phase-slice.js');
    const r = spawnSync('node', [hookPath], {
      cwd: tmp,
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRAY_DISABLE_PHASE_SLICES: '1' },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout.trim() || '{}');
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('default path (config absent) stages a slice when phase is set', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-default-'));
    const tmpOrch = path.join(tmp, '.orchestray', 'state');
    fs.mkdirSync(tmpOrch, { recursive: true });
    fs.writeFileSync(
      path.join(tmpOrch, 'orchestration.md'),
      '---\nid: orch-test\ncurrent_phase: implementation\n---\n'
    );
    const tmpRefs = path.join(tmp, 'agents', 'pm-reference');
    fs.mkdirSync(tmpRefs, { recursive: true });
    for (const f of SLICE_FILES) {
      fs.copyFileSync(path.join(PM_REF_DIR, f), path.join(tmpRefs, f));
    }

    const hookPath = path.join(ROOT, 'bin', 'inject-active-phase-slice.js');
    const r = spawnSync('node', [hookPath], {
      cwd: tmp,
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRAY_DISABLE_PHASE_SLICES: '' },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout.trim() || '{}');
    assert.equal(out.continue, true);
    assert.ok(out.hookSpecificOutput, 'default path must inject additionalContext');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('phase-execute.md'),
      'default path with phase=implementation must point at phase-execute.md');
    assert.ok(
      fs.existsSync(path.join(tmpOrch, 'active-phase-slice.md')),
      'default path must stage active-phase-slice.md'
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 7 — phase_slice_injected positive-path telemetry (v2.1.16 R-PHASE-INJ)
// ---------------------------------------------------------------------------

describe('Test 7: phase_slice_injected positive-path event (v2.1.16 R-PHASE-INJ)', () => {
  // Helper: spawn the hook in a tmp cwd with a real audit-event-writer wired
  // and return the parsed events.jsonl contents.
  function runHookInTmp({ phase, configBlock, env }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-inj-'));
    const tmpOrch = path.join(tmp, '.orchestray', 'state');
    fs.mkdirSync(tmpOrch, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
    if (configBlock !== undefined) {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify(configBlock)
      );
    }
    fs.writeFileSync(
      path.join(tmpOrch, 'orchestration.md'),
      `---\nid: orch-test\ncurrent_phase: ${phase}\n---\n`
    );
    // The audit-event-writer requires bin/_lib/* to be reachable; run hook
    // from the repo root so it resolves bin/_lib relative to ROOT, but use
    // tmp as the audit cwd via process.chdir-style override. The hook uses
    // process.cwd() everywhere — so the simplest path is to copy the bin/
    // tree into tmp so `bin/_lib/audit-event-writer.js` exists relative to
    // cwd. To avoid a heavy copy, we instead spawn the hook with `cwd: tmp`
    // and symlink the repo's bin/ and agents/pm-reference/ trees into tmp.
    fs.symlinkSync(path.join(ROOT, 'bin'),    path.join(tmp, 'bin'));
    fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'agents', 'pm-reference'), path.join(tmp, 'agents', 'pm-reference'));

    const hookPath = path.join(ROOT, 'bin', 'inject-active-phase-slice.js');
    const r = spawnSync('node', [hookPath], {
      cwd: tmp,
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, ...(env || {}) },
    });

    const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    const events = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];

    return { tmp, status: r.status, stdout: r.stdout, events };
  }

  test('emits phase_slice_injected on success (default config)', () => {
    const { tmp, status, stdout, events } = runHookInTmp({
      phase: 'implementation',
      configBlock: { phase_slice_loading: { enabled: true } },
      env: { ORCHESTRAY_DISABLE_PHASE_SLICES: '', ORCHESTRAY_DISABLE_PHASE_INJECT_TELEMETRY: '' },
    });
    assert.equal(status, 0);
    const out = JSON.parse(stdout.trim() || '{}');
    assert.ok(out.hookSpecificOutput, 'positive path must inject additionalContext');

    const inj = events.filter((e) => e.type === 'phase_slice_injected');
    assert.equal(inj.length, 1, 'exactly one phase_slice_injected event must be emitted');
    const ev = inj[0];
    assert.equal(ev.version, 1);
    assert.equal(ev.phase, 'implementation');
    assert.equal(ev.slice_path, path.join('agents', 'pm-reference', 'phase-execute.md'));
    assert.ok(typeof ev.pointer_bytes === 'number' && ev.pointer_bytes > 0,
      'pointer_bytes must be a positive number');
    assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0,
      'timestamp must be auto-filled');
    assert.ok(typeof ev.orchestration_id === 'string',
      'orchestration_id must be auto-filled');

    // No fallback should fire on the success path.
    const fb = events.filter((e) => e.type === 'phase_slice_fallback');
    assert.equal(fb.length, 0, 'fallback must NOT fire on the success path');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('config kill switch (telemetry_enabled: false) suppresses injected event but fallback still fires on errors', () => {
    // Success path with telemetry disabled — slice still stages, but no event.
    const { tmp, events } = runHookInTmp({
      phase: 'verify',
      configBlock: { phase_slice_loading: { enabled: true, telemetry_enabled: false } },
    });
    const inj = events.filter((e) => e.type === 'phase_slice_injected');
    assert.equal(inj.length, 0,
      'phase_slice_injected must NOT emit when telemetry_enabled: false');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('env kill switch ORCHESTRAY_DISABLE_PHASE_INJECT_TELEMETRY=1 suppresses event', () => {
    const { tmp, events } = runHookInTmp({
      phase: 'execute',
      configBlock: { phase_slice_loading: { enabled: true } },
      env: { ORCHESTRAY_DISABLE_PHASE_INJECT_TELEMETRY: '1' },
    });
    const inj = events.filter((e) => e.type === 'phase_slice_injected');
    assert.equal(inj.length, 0, 'env kill switch must suppress phase_slice_injected');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('telemetry_enabled defaults to true when field absent (rollout default)', () => {
    const { tmp, events } = runHookInTmp({
      phase: 'close',
      // Note: NO telemetry_enabled field — must default to true.
      configBlock: { phase_slice_loading: { enabled: true } },
    });
    const inj = events.filter((e) => e.type === 'phase_slice_injected');
    assert.equal(inj.length, 1,
      'phase_slice_injected must emit by default when telemetry_enabled is unspecified');
    assert.equal(inj[0].phase, 'close');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('event-schemas.md and shadow include phase_slice_injected entry', () => {
    const md = fs.readFileSync(
      path.join(PM_REF_DIR, 'event-schemas.md'),
      'utf8'
    );
    assert.ok(
      md.includes('### `phase_slice_injected` event'),
      'event-schemas.md must define phase_slice_injected section'
    );
    const shadow = JSON.parse(
      fs.readFileSync(path.join(PM_REF_DIR, 'event-schemas.shadow.json'), 'utf8')
    );
    assert.ok(
      shadow.phase_slice_injected && shadow.phase_slice_injected.v === 1,
      'shadow must contain phase_slice_injected v1'
    );
  });

  test('emitInjectedEvent is exported from the hook module', () => {
    const mod = require(path.join(ROOT, 'bin', 'inject-active-phase-slice.js'));
    assert.equal(typeof mod.emitInjectedEvent, 'function',
      'emitInjectedEvent must be exported for downstream consumers');
  });
});

// ---------------------------------------------------------------------------
// Bonus: rule-driven toolchain (W9 reuse contract)
// ---------------------------------------------------------------------------

describe('toolchain rule-driven (--rules arg accepted, W9 R-CURATOR-SPLIT reuse)', () => {
  const classifyPath = path.join(ROOT, 'bin', '_tools', 'phase-split-classify.js');

  test('classifier accepts --rules <json> and uses it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
    const minimalRules = {
      name: 'minimal-test',
      phases: ['contract', 'work'],
      classification: {
        contract: { sections: [], keywords: ['Foundation'] },
        work:     { sections: [], keywords: ['Worker'] },
      },
    };
    const rulesPath = path.join(tmp, 'rules.json');
    fs.writeFileSync(rulesPath, JSON.stringify(minimalRules));

    const fixtureMd = path.join(tmp, 'fixture.md');
    fs.writeFileSync(
      fixtureMd,
      '## 1. Foundation Setup\n\nbody\n\n## 2. Worker Loop\n\nbody\n'
    );

    const r = spawnSync('node', [
      classifyPath,
      '--source', fixtureMd,
      '--rules',  rulesPath,
      '--out-dir', tmp,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, `classify with --rules failed: ${r.stderr}`);

    const anchors = JSON.parse(fs.readFileSync(path.join(tmp, 'anchors.json'), 'utf8'));
    // 2 anchors, classified per minimal rules
    assert.equal(anchors.anchors.length, 2);
    const phases = anchors.anchors.map((a) => a.phase);
    assert.ok(phases.includes('contract'),
      'foundation heading must classify as contract per --rules');
    assert.ok(phases.includes('work'),
      'worker heading must classify as work per --rules');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
