#!/usr/bin/env node
'use strict';

/**
 * r-curator-split.test.js — TDD tests for the R-CURATOR-SPLIT curator stage split
 * (W9, v2.1.15). Mirrors tests/i-phase-gate.test.js shape for toolchain reuse.
 *
 * Tests:
 *   1. Toolchain rule-driven — curator-stages.json classifies curator.md.legacy
 *   2. Validate-refs exits 0 on curator traceability (BLOCK gate)
 *   3. Hook injection per stage (discover/decide/commit fires the right stage)
 *   4. Fallback on unparseable stage (contract still loads, fallback returned)
 *   5. Behavior-equivalence (all stage files exist, legacy preserved)
 *   6. Kill switch (curator_slice_loading.enabled: false loads legacy)
 *
 * Runner: node --test tests/r-curator-split.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const CURATOR_STAGES_DIR = path.join(AGENTS_DIR, 'curator-stages');
const PM_MD = path.join(ROOT, 'agents', 'pm.md');
const CONFIG_PATH = path.join(ROOT, '.orchestray', 'config.json');

const CURATOR_LEGACY = 'curator.md.legacy';

const CURATOR_STAGE_FILES = [
  'phase-contract.md',
  'phase-decomp.md',
  'phase-execute.md',
  'phase-close.md',
];

// ---------------------------------------------------------------------------
// Test 1 — toolchain rule-driven (--rules arg, curator-stages.json)
// ---------------------------------------------------------------------------

describe('Test 1: toolchain rule-driven with curator-stages.json', () => {
  const classifyPath = path.join(ROOT, 'bin', '_tools', 'phase-split-classify.js');
  const rulesPath    = path.join(ROOT, 'bin', '_tools', 'curator-stages.json');

  test('curator-stages.json exists and is valid JSON with required shape', () => {
    assert.ok(fs.existsSync(rulesPath), 'curator-stages.json must exist');
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    assert.ok(Array.isArray(rules.phases), 'rules.phases must be an array');
    assert.ok(rules.classification && typeof rules.classification === 'object',
      'rules.classification must be an object');
    assert.ok(rules.name, 'rules.name must be present');
    // Must have contract phase
    assert.ok(rules.phases.includes('contract'), 'rules must define a contract phase');
  });

  test('classifier runs on curator.md.legacy with curator-stages rules (exit 0)', () => {
    const legacy = path.join(AGENTS_DIR, CURATOR_LEGACY);
    assert.ok(fs.existsSync(legacy), `${CURATOR_LEGACY} must exist`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-split-'));
    const r = spawnSync('node', [
      classifyPath,
      '--source', legacy,
      '--rules',  rulesPath,
      '--out-dir', tmp,
    ], { encoding: 'utf8' });

    assert.equal(r.status, 0, `classify failed: ${r.stderr}`);

    const anchors = JSON.parse(fs.readFileSync(path.join(tmp, 'anchors.json'), 'utf8'));
    assert.ok(anchors.anchors.length > 0, 'must produce at least one anchor');

    // Must classify at least some anchors into contract
    const contractCount = anchors.anchors.filter((a) => a.phase === 'contract').length;
    assert.ok(contractCount >= 1, 'at least one anchor must be classified as contract');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 2 — validate-refs exits 0 (BLOCK gate)
// ---------------------------------------------------------------------------

describe('Test 2: validate-refs exits 0 on curator traceability', () => {
  const classifyPath  = path.join(ROOT, 'bin', '_tools', 'phase-split-classify.js');
  const rewritePath   = path.join(ROOT, 'bin', '_tools', 'phase-split-rewrite-refs.js');
  const validatePath  = path.join(ROOT, 'bin', '_tools', 'phase-split-validate-refs.js');
  const rulesPath     = path.join(ROOT, 'bin', '_tools', 'curator-stages.json');

  test('all three split-toolchain scripts exist', () => {
    assert.ok(fs.existsSync(classifyPath), 'classify must exist');
    assert.ok(fs.existsSync(rewritePath),  'rewrite-refs must exist');
    assert.ok(fs.existsSync(validatePath), 'validate-refs must exist');
  });

  test('phase-split-validate-refs exits 0 on curator traceability (BLOCK gate)', () => {
    const legacy = path.join(AGENTS_DIR, CURATOR_LEGACY);
    if (!fs.existsSync(legacy)) {
      assert.fail(`${CURATOR_LEGACY} must exist — R-CURATOR-SPLIT requires it`);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-valid-'));

    const r1 = spawnSync('node', [
      classifyPath, '--source', legacy, '--rules', rulesPath, '--out-dir', tmp,
    ], { encoding: 'utf8' });
    assert.equal(r1.status, 0, `classify failed: ${r1.stderr}`);

    const r2 = spawnSync('node', [
      rewritePath, '--in-dir', tmp, '--out-dir', tmp,
    ], { encoding: 'utf8' });
    assert.equal(r2.status, 0, `rewrite failed: ${r2.stderr}`);

    const r3 = spawnSync('node', [
      validatePath,
      '--traceability', path.join(tmp, 'traceability.json'),
      '--slices-dir',   CURATOR_STAGES_DIR,
    ], { encoding: 'utf8' });

    assert.equal(
      r3.status, 0,
      `validate-refs MUST exit 0 (BLOCK gate). Stderr:\n${r3.stderr}\nStdout:\n${r3.stdout}`
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — hook injection per stage
// ---------------------------------------------------------------------------

describe('Test 3: hook injection per curator stage', () => {
  let hookModule;

  test('inject-active-curator-stage.js loads as a module without hanging', () => {
    const mod = require(path.join(ROOT, 'bin', 'inject-active-curator-stage.js'));
    hookModule = mod;
    assert.ok(typeof mod.resolveStageForPhase === 'function',
      'must export resolveStageForPhase');
    assert.ok(typeof mod.STAGE_TO_FILE === 'object',
      'must export STAGE_TO_FILE');
  });

  test('discover/input/read stage resolves to phase-decomp.md', () => {
    assert.equal(hookModule.resolveStageForPhase('discover'), 'phase-decomp.md');
    assert.equal(hookModule.resolveStageForPhase('input'),    'phase-decomp.md');
    assert.equal(hookModule.resolveStageForPhase('read'),     'phase-decomp.md');
  });

  test('decide/evaluate/score stage resolves to phase-execute.md', () => {
    assert.equal(hookModule.resolveStageForPhase('decide'),   'phase-execute.md');
    assert.equal(hookModule.resolveStageForPhase('evaluate'), 'phase-execute.md');
    assert.equal(hookModule.resolveStageForPhase('score'),    'phase-execute.md');
  });

  test('commit/apply/output stage resolves to phase-close.md', () => {
    assert.equal(hookModule.resolveStageForPhase('commit'),   'phase-close.md');
    assert.equal(hookModule.resolveStageForPhase('apply'),    'phase-close.md');
    assert.equal(hookModule.resolveStageForPhase('output'),   'phase-close.md');
    assert.equal(hookModule.resolveStageForPhase('complete'), 'phase-close.md');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — fallback on unparseable stage
// ---------------------------------------------------------------------------

describe('Test 4: fallback on unparseable stage', () => {
  let hookModule;

  test('hook module loadable', () => {
    hookModule = require(path.join(ROOT, 'bin', 'inject-active-curator-stage.js'));
  });

  test('unrecognized stage returns null (caller falls back to contract-only)', () => {
    assert.equal(hookModule.resolveStageForPhase('flibbertigibbet'), null);
  });

  test('null/empty/undefined stage returns null', () => {
    assert.equal(hookModule.resolveStageForPhase(null),      null);
    assert.equal(hookModule.resolveStageForPhase(''),        null);
    assert.equal(hookModule.resolveStageForPhase(undefined), null);
  });

  test('phase-contract.md is loadable as the fallback', () => {
    const contractPath = path.join(CURATOR_STAGES_DIR, 'phase-contract.md');
    assert.ok(fs.existsSync(contractPath), 'curator phase-contract.md must exist');
    const content = fs.readFileSync(contractPath, 'utf8');
    assert.ok(content.includes('Identity and Scope'),
      'curator contract must contain §1 Identity and Scope');
    assert.ok(content.includes('times_applied'),
      'curator contract must contain §3 times_applied semantics');
    assert.ok(content.includes('Per-run caps'),
      'curator contract must contain per-run caps');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — behavior-equivalence (stage files exist, legacy preserved)
// ---------------------------------------------------------------------------

describe('Test 5: behavior-equivalence', () => {
  test('all 4 curator stage files exist', () => {
    for (const f of CURATOR_STAGE_FILES) {
      assert.ok(
        fs.existsSync(path.join(CURATOR_STAGES_DIR, f)),
        `curator stage file ${f} must exist`
      );
    }
  });

  test('legacy file preserved for one release', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS_DIR, CURATOR_LEGACY)),
      `${CURATOR_LEGACY} must remain for the v2.1.15 rollback path`
    );
  });

  test('original curator.md is retired', () => {
    assert.ok(
      !fs.existsSync(path.join(AGENTS_DIR, 'curator.md')),
      'curator.md must be renamed to curator.md.legacy'
    );
  });

  test('stage files contain expected canonical sections', () => {
    const contract = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-contract.md'), 'utf8');
    const decomp = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-decomp.md'), 'utf8');
    const execute = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-execute.md'), 'utf8');
    const close = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-close.md'), 'utf8');

    assert.ok(contract.includes('Identity and Scope'),
      'phase-contract must contain §1');
    assert.ok(contract.includes('times_applied'),
      'phase-contract must contain §3 counter semantics');
    assert.ok(decomp.includes('Inputs You Read Every Run'),
      'phase-decomp must contain §2');
    assert.ok(execute.includes('Decision Protocol'),
      'phase-execute must contain §4');
    assert.ok(execute.includes('Promote'),
      'phase-execute must contain §4.1 Promote');
    assert.ok(execute.includes('Merge'),
      'phase-execute must contain §4.2 Merge');
    assert.ok(execute.includes('Deprecate'),
      'phase-execute must contain §4.3 Deprecate');
    assert.ok(close.includes('Tombstone Protocol'),
      'phase-close must contain §5');
    assert.ok(close.includes('Guardrails'),
      'phase-close must contain §6');
  });

  test('cross-stage pointer present (phase-execute references phase-decomp)', () => {
    const execute = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-execute.md'), 'utf8');
    assert.ok(
      execute.includes('phase-decomp.md'),
      'phase-execute.md must include cross-stage pointer to phase-decomp.md'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6 — kill switch (curator_slice_loading.enabled: false)
// ---------------------------------------------------------------------------

describe('Test 6: kill switch (curator_slice_loading.enabled: false)', () => {
  test('agents/pm.md dispatch table contains curator 2-branch conditional', () => {
    const pm = fs.readFileSync(PM_MD, 'utf8');
    assert.ok(
      pm.includes('curator_slice_loading.enabled'),
      'pm.md must reference curator_slice_loading.enabled in curator dispatch'
    );
    assert.ok(
      pm.includes('curator.md.legacy'),
      'pm.md must name curator.md.legacy as the legacy fallback'
    );
    assert.ok(
      pm.includes('curator-stages/phase-contract.md'),
      'pm.md must name curator-stages/phase-contract.md under branch (a)'
    );
    assert.ok(
      pm.includes('Do NOT load any curator stage'),
      'pm.md must state that branch (b) skips curator stages'
    );
  });

  test('config has curator_slice_loading block with default enabled=true', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.ok(cfg.curator_slice_loading,
      'config must have curator_slice_loading block');
    assert.equal(cfg.curator_slice_loading.enabled, true,
      'curator_slice_loading.enabled must default to true');
  });

  test('hook respects config kill switch (enabled=false → no stage staged)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-killswitch-'));
    const tmpOrch = path.join(tmp, '.orchestray', 'state');
    fs.mkdirSync(tmpOrch, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'config.json'),
      JSON.stringify({ curator_slice_loading: { enabled: false } })
    );
    fs.writeFileSync(
      path.join(tmpOrch, 'curator-run.md'),
      '---\ncurrent_stage: discover\n---\n'
    );

    // Copy stage files so their absence isn't the reason for skipping
    const tmpStages = path.join(tmp, 'agents', 'curator-stages');
    fs.mkdirSync(tmpStages, { recursive: true });
    for (const f of CURATOR_STAGE_FILES) {
      fs.copyFileSync(path.join(CURATOR_STAGES_DIR, f), path.join(tmpStages, f));
    }

    const hookPath = path.join(ROOT, 'bin', 'inject-active-curator-stage.js');
    const r = spawnSync('node', [hookPath], {
      cwd: tmp,
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRAY_DISABLE_CURATOR_STAGES: '' },
    });
    assert.equal(r.status, 0);

    const out = JSON.parse(r.stdout.trim() || '{}');
    assert.equal(out.continue, true);
    assert.equal(
      out.hookSpecificOutput,
      undefined,
      'kill-switch path must NOT inject hookSpecificOutput'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpOrch, 'active-curator-stage.md')),
      'kill-switch path must not stage active-curator-stage.md'
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('env kill switch ORCHESTRAY_DISABLE_CURATOR_STAGES=1 also disables', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-envkill-'));
    fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'curator-run.md'),
      '---\ncurrent_stage: discover\n---\n'
    );

    const hookPath = path.join(ROOT, 'bin', 'inject-active-curator-stage.js');
    const r = spawnSync('node', [hookPath], {
      cwd: tmp,
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRAY_DISABLE_CURATOR_STAGES: '1' },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout.trim() || '{}');
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 7 — sacred invariants (v2.2.3 G5 retirement formalization)
// ---------------------------------------------------------------------------

describe('Test 7: sacred invariants block (G5)', () => {
  test('phase-contract.md publishes SI-1..SI-4 sacred-invariants block', () => {
    const contract = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-contract.md'), 'utf8');
    assert.match(contract, /Sacred Invariants/i,
      'phase-contract.md must publish a Sacred Invariants section');
    assert.match(contract, /SI-1\b[\s\S]*Never auto-trigger/i,
      'SI-1 (never auto-trigger / C-CURATE-AUTO RETIRE) must be present');
    assert.match(contract, /SI-2\b[\s\S]*user-correction/i,
      'SI-2 (user-correction never auto-deprecated/promoted) must be present');
    assert.match(contract, /SI-3\b[\s\S]*local-only/i,
      'SI-3 (local-only never promoted) must be present');
    assert.match(contract, /SI-4\b[\s\S]*[Dd]estructive action/,
      'SI-4 (action first, tombstone second atomicity) must be present');
    assert.match(contract, /C-CURATE-AUTO|G5/,
      'phase-contract.md must cite the C-CURATE-AUTO retirement provenance');
  });

  test('every other curator stage references the sacred-invariants block', () => {
    const stages = ['phase-decomp.md', 'phase-execute.md', 'phase-close.md'];
    for (const f of stages) {
      const body = fs.readFileSync(path.join(CURATOR_STAGES_DIR, f), 'utf8');
      assert.match(
        body,
        /phase-contract\.md\s*§0|Sacred invariants applicable here/i,
        `${f} must point to phase-contract.md §0 sacred invariants`
      );
    }
  });

  test('phase-execute.md re-asserts user-correction and local-only floors', () => {
    const exec = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-execute.md'), 'utf8');
    assert.match(exec, /SI-2\b[\s\S]*user-correction/i,
      'phase-execute.md preamble must restate SI-2');
    assert.match(exec, /SI-3\b[\s\S]*local-only/i,
      'phase-execute.md preamble must restate SI-3');
  });

  test('phase-close.md re-asserts atomicity ordering and never-auto-trigger', () => {
    const close = fs.readFileSync(
      path.join(CURATOR_STAGES_DIR, 'phase-close.md'), 'utf8');
    assert.match(close, /SI-4\b[\s\S]*tombstone|action FIRST/i,
      'phase-close.md preamble must restate SI-4 atomicity');
    assert.match(close, /SI-1\b[\s\S]*[Nn]ever auto-trigger/,
      'phase-close.md preamble must restate SI-1 (never enqueue follow-up)');
  });
});
