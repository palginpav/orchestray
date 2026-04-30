#!/usr/bin/env node
'use strict';

/**
 * v2.2.15 W8d mech-enforcement validators — consolidated test file.
 *
 * Coverage matrix (per consolidated-findings §8 W8d test expectations):
 *   FN-43 (validate-reviewer-dimensions.js)         ≥3 cases
 *   FN-44 (validate-context-size-hint.js)           ≥4 cases
 *   FN-45 (validate-commit-handoff.js handoff body) ≥3 cases
 *   FN-47 (double-fire-guard + dual-install parity) ≥3 cases
 *   FN-53 (kb-index-validator bucket↔path)          ≥3 cases
 *
 * (FN-46 + FN-48 live in v229-b2-developer-git-gate.test.js.
 *  FN-49/FN-50 live in validate-no-deferral-phrases.test.js.
 *  FN-36 + FN-41 live in v2210-reviewer-dimensions.test.js.
 *  FN-42 lives in v229-b2-... companion + this file's coverage of git-diff is
 *  exercised via the warn→block flip; happy-path regressions are guarded by
 *  the existing reviewer-dimensions tests.)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE = process.execPath;
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
}

function writeOrchMarker(tmp, orchId) {
  fs.writeFileSync(
    path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// FN-43 — validate-reviewer-dimensions.js
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-43 — validate-reviewer-dimensions hard gate', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-reviewer-dimensions.js');

  function runHook(payload, env = {}) {
    const tmp = makeTmp('fn43-');
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED;
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify({ ...payload, cwd: tmp }),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return { ...r, tmp };
  }

  test('Test 1 (happy path): reviewer prompt with heading + bulleted list → exit 0', () => {
    const prompt = [
      'Review the patch.',
      '',
      '## Dimensions to Apply',
      '- correctness',
      '- security',
      '',
    ].join('\n');
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    assert.equal(r.status, 0, 'happy path must pass. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 2: reviewer prompt missing heading → exit 2', () => {
    const prompt = 'Review the patch.\n\n- correctness\n- security\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    assert.equal(r.status, 2, 'missing heading must block. stderr=' + r.stderr.slice(0, 200));
    const events = readEvents(r.tmp);
    const ev = events.find(e => e.type === 'reviewer_dimensions_gate_blocked');
    assert.ok(ev, 'expected reviewer_dimensions_gate_blocked event');
    assert.equal(ev.reason, 'missing_heading');
    cleanup(r.tmp);
  });

  test('Test 3: heading present but no bulleted list under it → exit 2', () => {
    const prompt = '## Dimensions to Apply\n\n(see review prompt for details)\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    assert.equal(r.status, 2, 'missing bulleted list must block. stderr=' + r.stderr.slice(0, 200));
    const events = readEvents(r.tmp);
    const ev = events.find(e => e.type === 'reviewer_dimensions_gate_blocked');
    assert.ok(ev);
    assert.equal(ev.reason, 'missing_bulleted_list');
    cleanup(r.tmp);
  });

  test('Test 4: kill switch ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1 → warn-only, exit 0', () => {
    const prompt = 'Review the patch.';
    const r = runHook(
      { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer', prompt } },
      { ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch must downgrade to warn. stderr=' + r.stderr.slice(0, 200));
    const events = readEvents(r.tmp);
    const warnEv = events.find(e => e.type === 'reviewer_dimensions_gate_warn');
    assert.ok(warnEv, 'expected reviewer_dimensions_gate_warn event under kill switch');
    cleanup(r.tmp);
  });

  test('Test 5: non-reviewer subagent → pass-through (exit 0)', () => {
    const prompt = 'Implement the change.'; // no dimensions block
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt },
    });
    assert.equal(r.status, 0, 'non-reviewer must not be gated. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// FN-44 — validate-context-size-hint.js
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-44 — validate-context-size-hint soft-warn ramp', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-context-size-hint.js');

  function runHook(tmp, payload, env = {}) {
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED;
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify({ ...payload, cwd: tmp }),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return r;
  }

  test('Test 1 (happy path): hint present in prompt body (flat form) → exit 0', () => {
    const tmp = makeTmp('fn44-');
    writeOrchMarker(tmp, 'orch-fn44-1');
    const prompt = 'context_size_hint: system=8000 tier2=4000 handoff=12000\n\nDo the thing.';
    const r = runHook(tmp, { tool_name: 'Agent', tool_input: { subagent_type: 'developer', prompt } });
    assert.equal(r.status, 0, 'flat-form hint must pass. stderr=' + r.stderr.slice(0, 200));
    cleanup(tmp);
  });

  test('Test 2 (happy path object form): hint in object form → exit 0 (G-11 form parity)', () => {
    const tmp = makeTmp('fn44-');
    writeOrchMarker(tmp, 'orch-fn44-2');
    const prompt = 'context_size_hint: { system: 8000, tier2: 4000, handoff: 12000 }\n\nDo the thing.';
    const r = runHook(tmp, { tool_name: 'Agent', tool_input: { subagent_type: 'developer', prompt } });
    assert.equal(r.status, 0, 'object-form hint must pass. stderr=' + r.stderr.slice(0, 200));
    cleanup(tmp);
  });

  test('Test 3 (warn ramp, count=1): missing hint, count below threshold → exit 0 + warn event', () => {
    const tmp = makeTmp('fn44-');
    writeOrchMarker(tmp, 'orch-fn44-3');
    const r = runHook(tmp, {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'Do the thing.' },
    });
    assert.equal(r.status, 0, 'first missing-hint spawn must warn, not block. stderr=' + r.stderr.slice(0, 200));
    const events = readEvents(tmp);
    const warnEv = events.find(e => e.type === 'context_size_hint_gate_warn');
    assert.ok(warnEv, 'expected context_size_hint_gate_warn event');
    assert.equal(warnEv.ramp_count, 1);
    cleanup(tmp);
  });

  test('Test 4 (block beyond ramp): 4th missing-hint spawn → exit 2', () => {
    const tmp = makeTmp('fn44-');
    writeOrchMarker(tmp, 'orch-fn44-4');
    // Pre-seed counter to exactly the threshold so the next spawn becomes count=4 → block.
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'context-size-hint-warn-count-orch-fn44-4.txt'),
      '3\n', 'utf8'
    );
    const r = runHook(tmp, {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'No hint here.' },
    });
    assert.equal(r.status, 2, '4th missing-hint spawn must block. stderr=' + r.stderr.slice(0, 200));
    const events = readEvents(tmp);
    const ev = events.find(e => e.type === 'context_size_hint_gate_blocked');
    assert.ok(ev);
    assert.equal(ev.ramp_count, 4);
    cleanup(tmp);
  });

  test('Test 5 (kill switch): ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1 bypasses entirely', () => {
    const tmp = makeTmp('fn44-');
    writeOrchMarker(tmp, 'orch-fn44-5');
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'context-size-hint-warn-count-orch-fn44-5.txt'),
      '99\n', 'utf8'
    );
    const r = runHook(
      tmp,
      { tool_name: 'Agent', tool_input: { subagent_type: 'developer', prompt: 'No hint.' } },
      { ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch must bypass. stderr=' + r.stderr.slice(0, 200));
    const events = readEvents(tmp);
    assert.equal(events.length, 0, 'kill switch must skip emit too');
    cleanup(tmp);
  });
});

// ---------------------------------------------------------------------------
// FN-45 — validate-commit-handoff.js head-commit `## Handoff` body check
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-45 — commit-handoff body gate', () => {
  const mod = require('../validate-commit-handoff.js');

  test('Test 1: bumpHandoffWarnCount increments and persists', () => {
    const tmp = makeTmp('fn45-');
    const r1 = mod.bumpHandoffWarnCount(tmp, 'orch-x', 3);
    assert.equal(r1.count, 1);
    const r2 = mod.bumpHandoffWarnCount(tmp, 'orch-x', 3);
    assert.equal(r2.count, 2);
    const persisted = fs.readFileSync(mod.handoffCounterPath(tmp, 'orch-x'), 'utf8').trim();
    assert.equal(persisted, '2');
    cleanup(tmp);
  });

  test('Test 2: readHeadCommitBody returns null in non-git tmpdir (fail-open)', () => {
    const tmp = makeTmp('fn45-');
    const body = mod.readHeadCommitBody(tmp);
    assert.equal(body, null, 'non-git cwd must return null');
    cleanup(tmp);
  });

  test('Test 3: counter file path is per-orchestration deterministic', () => {
    const tmp = makeTmp('fn45-');
    const p1 = mod.handoffCounterPath(tmp, 'orch-A');
    const p2 = mod.handoffCounterPath(tmp, 'orch-B');
    assert.notEqual(p1, p2);
    assert.match(p1, /commit-handoff-warn-count-orch-A\.txt$/);
    assert.match(p2, /commit-handoff-warn-count-orch-B\.txt$/);
    cleanup(tmp);
  });

  test('Test 4: HANDOFF_RAMP_DEFAULT is 3 (matches W8d spec)', () => {
    assert.equal(mod.HANDOFF_RAMP_DEFAULT, 3);
  });
});

// ---------------------------------------------------------------------------
// FN-47 — double-fire-guard + dual-install-parity-check session-start path
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-47 — double-fire skip + version-mismatch SessionStart', () => {
  const guardMod  = require('../_lib/double-fire-guard.js');
  const parityMod = require('../release-manager/dual-install-parity-check.js');

  test('Test 1: stageSessionStartWarn writes the sentinel file', () => {
    const tmp = makeTmp('fn47-');
    const stateDir = path.join(tmp, '.orchestray', 'state');
    guardMod.stageSessionStartWarn(stateDir, {
      version: 1, ts_ms: Date.now(), guard_name: 'g', dedup_key: 'k',
      orchestration_id: 'orch-fn47-1', fast_fire_count: 6, delta_ms: 50,
      first_caller: '/a', second_caller: '/b', message: 'racing',
    });
    const sentinel = path.join(stateDir, 'double-fire-warn-pending.json');
    assert.ok(fs.existsSync(sentinel), 'sentinel must be written');
    const parsed = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    assert.equal(parsed.fast_fire_count, 6);
    cleanup(tmp);
  });

  test('Test 2: consumePendingDoubleFireWarn reads and removes the sentinel', () => {
    const tmp = makeTmp('fn47-');
    const stateDir = path.join(tmp, '.orchestray', 'state');
    guardMod.stageSessionStartWarn(stateDir, { version: 1, guard_name: 'g', dedup_key: 'k' });
    const consumed = parityMod.consumePendingDoubleFireWarn(tmp);
    assert.ok(consumed, 'must read the sentinel');
    assert.equal(fs.existsSync(path.join(stateDir, 'double-fire-warn-pending.json')), false,
      'sentinel must be unlinked after consumption');
    // Second call returns null.
    const second = parityMod.consumePendingDoubleFireWarn(tmp);
    assert.equal(second, null, 'second consume returns null (idempotent)');
    cleanup(tmp);
  });

  test('Test 3: checkVersionParity detects mismatch when both installs present', () => {
    const tmp = makeTmp('fn47-');
    fs.mkdirSync(path.join(tmp, '.claude', 'orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'orchestray', 'package.json'),
      JSON.stringify({ name: 'orchestray', version: '2.2.13' }),
      'utf8'
    );
    // Fake a global install too.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fn47-home-'));
    fs.mkdirSync(path.join(fakeHome, '.claude', 'orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'orchestray', 'package.json'),
      JSON.stringify({ name: 'orchestray', version: '2.2.15' }),
      'utf8'
    );
    const oldHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const r = parityMod.checkVersionParity(tmp);
      assert.equal(r.ok, true);
      assert.equal(r.mismatch, true);
      assert.equal(r.global, '2.2.15');
      assert.equal(r.local, '2.2.13');
    } finally {
      process.env.HOME = oldHome;
    }
    cleanup(tmp);
    cleanup(fakeHome);
  });

  test('Test 4: isSessionStart recognises hook event', () => {
    assert.equal(parityMod.isSessionStart({ hook_event_name: 'SessionStart' }), true);
    assert.equal(parityMod.isSessionStart({ hook_event_name: 'sessionstart' }), true);
    assert.equal(parityMod.isSessionStart({ hook_event_name: 'SubagentStop' }), false);
    assert.equal(parityMod.isSessionStart(null), false);
  });
});

// ---------------------------------------------------------------------------
// FN-53 — kb-index-validator bucket↔path-prefix check
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-53 — kb-index-validator bucket↔path consistency', () => {
  const mod = require('../_lib/kb-index-validator.js');

  test('Test 1 (happy path): well-bucketed index passes', () => {
    const tmp = makeTmp('fn53-');
    fs.mkdirSync(path.join(tmp, '.orchestray', 'kb'), { recursive: true });
    const idx = {
      version: '1.0',
      artifacts: [{ id: 'a1', path: 'artifacts/foo.md' }],
      facts:     [{ id: 'f1', path: 'facts/bar.md' }],
    };
    fs.writeFileSync(path.join(tmp, '.orchestray', 'kb', 'index.json'), JSON.stringify(idx));
    const r = mod.validate(tmp);
    assert.equal(r.valid, true, 'reason=' + (r.reason || 'ok'));
    cleanup(tmp);
  });

  test('Test 2 (FN-53 catch): facts bucket pointing to artifacts/ → invalid', () => {
    const tmp = makeTmp('fn53-');
    fs.mkdirSync(path.join(tmp, '.orchestray', 'kb'), { recursive: true });
    const idx = {
      version: '1.0',
      facts: [{ id: 'mis1', path: 'artifacts/bad.md' }],
    };
    fs.writeFileSync(path.join(tmp, '.orchestray', 'kb', 'index.json'), JSON.stringify(idx));
    const r = mod.validate(tmp);
    assert.equal(r.valid, false);
    assert.match(r.reason, /^bucket_facts_path_mismatch/, 'reason=' + r.reason);
    cleanup(tmp);
  });

  test('Test 3: missing index file is valid (pre-write state)', () => {
    const tmp = makeTmp('fn53-');
    const r = mod.validate(tmp);
    assert.equal(r.valid, true, 'missing index must be valid (pre-write)');
    cleanup(tmp);
  });

  test('Test 4: pathMatchesBucket helper accepts both short and long forms', () => {
    assert.equal(mod.pathMatchesBucket('facts/foo.md', 'facts'), true);
    assert.equal(mod.pathMatchesBucket('.orchestray/kb/facts/foo.md', 'facts'), true);
    assert.equal(mod.pathMatchesBucket('artifacts/foo.md', 'facts'), false);
    assert.equal(mod.pathMatchesBucket('decisions/foo.md', 'decisions'), true);
  });
});
