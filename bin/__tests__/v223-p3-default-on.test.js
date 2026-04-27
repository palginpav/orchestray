#!/usr/bin/env node
'use strict';

/**
 * v223-p3-default-on.test.js — v2.2.3 Phase 3 W3 default-on flips.
 *
 * Per `feedback_default_on_shipping.md` ("new functionality ships default-on;
 * regressions fix in next patch, not gated behind opt-in"), the v2.2.3 Phase 3
 * W3 work flips 5 feature gates that the W3 telemetry surfaced as gates_false
 * in feature_gate_eval. Two of the five live in bin/_lib/config-schema.js
 * loaders (cost_budget_enforcement.enabled, adaptive_verbosity.enabled) — this
 * file regression-locks those defaults.
 *
 * The remaining three (enable_disagreement_protocol, enable_outcome_tracking,
 * enable_checkpoints) are top-level boolean flags whose fresh-install seed
 * lives in bin/install.js (FRESH_INSTALL_*) and whose runtime evaluation in
 * bin/gate-telemetry.js reads `config[key]` directly (no loader-with-default).
 * Flipping those three requires editing bin/install.js — out of scope for this
 * worker's allowed file set (see .orchestray/kb/artifacts/v223-p3-default-on.md
 * "Open question" for the handoff).
 *
 * Tests:
 *   1. DEFAULT_COST_BUDGET_ENFORCEMENT.enabled === true
 *   2. DEFAULT_ADAPTIVE_VERBOSITY.enabled === true
 *   3. loadCostBudgetEnforcementConfig with empty config returns enabled:true
 *   4. loadAdaptiveVerbosityConfig with empty config returns enabled:true
 *   5. User explicit enabled:false is respected (regression guard)
 *      — both for cost_budget_enforcement and adaptive_verbosity
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const {
  DEFAULT_COST_BUDGET_ENFORCEMENT,
  loadCostBudgetEnforcementConfig,
  DEFAULT_ADAPTIVE_VERBOSITY,
  loadAdaptiveVerbosityConfig,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'config-schema.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p3-default-on-'));
}

function writeConfig(tmpDir, obj) {
  const dir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. cost_budget_enforcement.enabled — default-on flip
// ---------------------------------------------------------------------------

describe('v2.2.3 P3-W3 — cost_budget_enforcement.enabled default-on', () => {

  test('DEFAULT_COST_BUDGET_ENFORCEMENT.enabled is true (was false in v2.2.2 and earlier)', () => {
    assert.strictEqual(
      DEFAULT_COST_BUDGET_ENFORCEMENT.enabled,
      true,
      'P3-W3: enabled must default to true per feedback_default_on_shipping.md'
    );
  });

  test('DEFAULT_COST_BUDGET_ENFORCEMENT.hard_block stays true (unchanged by P3-W3)', () => {
    assert.strictEqual(DEFAULT_COST_BUDGET_ENFORCEMENT.hard_block, true);
  });

  test('loadCostBudgetEnforcementConfig() with no config file returns enabled:true', () => {
    const dir = makeTmpDir();
    try {
      const cfg = loadCostBudgetEnforcementConfig(dir);
      assert.strictEqual(cfg.enabled, true, 'fresh install must surface enabled:true');
      assert.strictEqual(cfg.hard_block, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadCostBudgetEnforcementConfig() with config missing the block returns enabled:true', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { some_other_key: true });
      const cfg = loadCostBudgetEnforcementConfig(dir);
      assert.strictEqual(cfg.enabled, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('regression guard: user explicit enabled:false wins over default', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { cost_budget_enforcement: { enabled: false } });
      const cfg = loadCostBudgetEnforcementConfig(dir);
      assert.strictEqual(
        cfg.enabled,
        false,
        'User explicit enabled:false MUST be respected — Object.assign overrides default'
      );
      // hard_block falls back to default (true) since not specified.
      assert.strictEqual(cfg.hard_block, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('regression guard: user explicit enabled:false + hard_block:false both honored', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {
        cost_budget_enforcement: { enabled: false, hard_block: false },
      });
      const cfg = loadCostBudgetEnforcementConfig(dir);
      assert.strictEqual(cfg.enabled, false);
      assert.strictEqual(cfg.hard_block, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 2. adaptive_verbosity.enabled — default-on flip
// ---------------------------------------------------------------------------

describe('v2.2.3 P3-W3 — adaptive_verbosity.enabled default-on', () => {

  test('DEFAULT_ADAPTIVE_VERBOSITY.enabled is true (was false in v2.2.2 and earlier)', () => {
    assert.strictEqual(
      DEFAULT_ADAPTIVE_VERBOSITY.enabled,
      true,
      'P3-W3: enabled must default to true per feedback_default_on_shipping.md'
    );
  });

  test('DEFAULT_ADAPTIVE_VERBOSITY other fields unchanged (base_response_tokens=2000, reducer=0.4)', () => {
    assert.strictEqual(DEFAULT_ADAPTIVE_VERBOSITY.base_response_tokens, 2000);
    assert.strictEqual(DEFAULT_ADAPTIVE_VERBOSITY.reducer_on_late_phase, 0.4);
  });

  test('loadAdaptiveVerbosityConfig() with no config file returns enabled:true', () => {
    const dir = makeTmpDir();
    try {
      const cfg = loadAdaptiveVerbosityConfig(dir);
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 2000);
      assert.strictEqual(cfg.reducer_on_late_phase, 0.4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadAdaptiveVerbosityConfig() with config missing the block returns enabled:true', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { unrelated: 1 });
      const cfg = loadAdaptiveVerbosityConfig(dir);
      assert.strictEqual(cfg.enabled, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('regression guard: user explicit enabled:false wins over default', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { adaptive_verbosity: { enabled: false } });
      const cfg = loadAdaptiveVerbosityConfig(dir);
      assert.strictEqual(
        cfg.enabled,
        false,
        'User explicit enabled:false MUST be respected'
      );
      // Other fields fall back to defaults.
      assert.strictEqual(cfg.base_response_tokens, 2000);
      assert.strictEqual(cfg.reducer_on_late_phase, 0.4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 3. Top-level boolean gates (enable_disagreement_protocol, enable_outcome_tracking,
//    enable_checkpoints) — feature_gate_eval semantics from gate-telemetry.js.
//
// These three flags do NOT have loader-with-default in bin/_lib/config-schema.js.
// gate-telemetry.js evaluates them as `config[key] === true` directly. To flip
// them default-on for fresh installs, the FRESH_INSTALL seed in bin/install.js
// must include `<key>: true`. That edit is out of scope for this worker's
// allowed file set; documented in .orchestray/kb/artifacts/v223-p3-default-on.md.
//
// This test block locks the gate-telemetry semantics so a future edit to
// bin/install.js (seeding `<key>: true`) flows through correctly.
// ---------------------------------------------------------------------------

describe('v2.2.3 P3-W3 — top-level enable_* gate-telemetry semantics (regression locks for follow-up install.js seed)', () => {

  // Use the gate-telemetry handle() function directly, isolated.
  // Re-require with a fresh handle each time — handle() reads from disk.

  test('explicit enable_outcome_tracking:true → gates_true (proves seed-true would land correctly)', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { enable_outcome_tracking: true });
      const evt = simulateGateEval(dir);
      assert.ok(
        evt.gates_true.includes('enable_outcome_tracking'),
        'enable_outcome_tracking must be in gates_true when set true; got: ' +
          JSON.stringify(evt)
      );
      assert.ok(
        !evt.gates_false.includes('enable_outcome_tracking'),
        'enable_outcome_tracking must NOT be in gates_false when set true'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit enable_outcome_tracking:false → gates_false (regression guard)', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { enable_outcome_tracking: false });
      const evt = simulateGateEval(dir);
      assert.ok(
        evt.gates_false.includes('enable_outcome_tracking'),
        'User explicit false → must land in gates_false'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit enable_disagreement_protocol:true → gates_true', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { enable_disagreement_protocol: true });
      const evt = simulateGateEval(dir);
      assert.ok(
        evt.gates_true.includes('enable_disagreement_protocol'),
        'enable_disagreement_protocol:true must land in gates_true'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit enable_checkpoints:true → gates_true', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { enable_checkpoints: true });
      const evt = simulateGateEval(dir);
      assert.ok(
        evt.gates_true.includes('enable_checkpoints'),
        'enable_checkpoints:true must land in gates_true'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent (empty config): EXPLICIT-list gates land in gates_false; non-listed keys do not surface', () => {
    // Documents current gate-telemetry semantics:
    //   - Keys in EXPLICIT_GATE_KEYS (enable_outcome_tracking,
    //     enable_disagreement_protocol) are evaluated even when absent → gates_false.
    //   - Keys NOT in EXPLICIT_GATE_KEYS (enable_checkpoints) only surface
    //     when present in config (the dynamic `key.startsWith('enable_')` walk
    //     iterates Object.keys(config), so missing keys are invisible).
    //
    // Once bin/install.js seeds all 3 keys :true on fresh install, all three
    // will surface in gates_true. The follow-up worker editing install.js is
    // expected to invert this test.
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {}); // Truly empty config
      const evt = simulateGateEval(dir);
      // EXPLICIT_GATE_KEYS members evaluated even when absent.
      assert.ok(
        evt.gates_false.includes('enable_outcome_tracking'),
        'enable_outcome_tracking is in EXPLICIT_GATE_KEYS → must surface as gates_false'
      );
      assert.ok(
        evt.gates_false.includes('enable_disagreement_protocol'),
        'enable_disagreement_protocol is in EXPLICIT_GATE_KEYS → must surface as gates_false'
      );
      // enable_checkpoints is NOT in EXPLICIT_GATE_KEYS — only the dynamic
      // walk surfaces it, and that walk only sees keys present in config.
      // So absent enable_checkpoints does not appear in either bucket.
      assert.ok(
        !evt.gates_true.includes('enable_checkpoints'),
        'enable_checkpoints absent from config → must not be in gates_true'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// gate-telemetry simulator — invokes the handle() entry directly without
// going through the spawned-process stdin path. This avoids hard-coupling the
// test to a child-process harness and matches the export surface
// (`module.exports.handle`) in bin/gate-telemetry.js.
// ---------------------------------------------------------------------------

function simulateGateEval(cwd) {
  // Clear any stale require cache to ensure a fresh load against the test cwd.
  const gateTelemetryPath = path.join(REPO_ROOT, 'bin', 'gate-telemetry.js');
  delete require.cache[require.resolve(gateTelemetryPath)];

  // Execute via subprocess — gate-telemetry expects to receive cwd through
  // the stdin event payload, then writes the audit event into
  // <cwd>/.orchestray/audit/events.jsonl. We read the event back from disk.
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [gateTelemetryPath], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      // Ensure metrics aren't disabled and tier2 telemetry isn't killed.
      ORCHESTRAY_METRICS_DISABLED: '0',
      ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '0',
    },
  });
  if (result.status !== 0) {
    throw new Error(
      'gate-telemetry exited non-zero: ' + result.status + ' stderr=' + (result.stderr || '')
    );
  }

  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    throw new Error('gate-telemetry did not write events.jsonl at ' + eventsPath);
  }
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
  // Find the most recent feature_gate_eval event.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.type === 'feature_gate_eval') return ev;
    } catch (_e) {}
  }
  throw new Error('No feature_gate_eval event found in events.jsonl');
}
