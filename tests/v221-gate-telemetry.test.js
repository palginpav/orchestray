#!/usr/bin/env node
'use strict';

/**
 * v221-gate-telemetry.test.js — W5 / B3 (W4)
 *
 * Tests the v2.2.1 namespaced gate walker in `bin/gate-telemetry.js`.
 *
 * Cases (W5.md "B3 (W4)"):
 *   1. Config with `output_shape.enabled: true` → gates_true includes
 *      "output_shape.enabled".
 *   2. Config with `caching.block_z.enabled: false` → gates_false includes
 *      "caching.block_z.enabled".
 *   3. Quarantined namespace → forced into gates_false regardless of value.
 *   4. Legacy `enable_*` keys still appear correctly.
 *   5. REGRESSION: load the actual shipped `.orchestray/config.json`
 *      from /home/palgin/orchestray/ and assert all 8 known v2.2.0 gates
 *      appear somewhere in gates_true ∪ gates_false.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK      = path.join(REPO_ROOT, 'bin', 'gate-telemetry.js');
const REAL_CONFIG = path.join(REPO_ROOT, '.orchestray', 'config.json');

// `bin/gate-telemetry.js` registers stdin listeners at top-level (it is
// designed to run as a one-shot hook, not be require()d), so the test
// process would hang waiting for stdin to close if we imported it
// directly. Use a small spawn-helper instead — every assertion in this
// file goes through the actual process boundary, which is also the
// production code path.
function evalConfigViaHook(config) {
  const dir = makeSandbox(config);
  try {
    const r = runHook(dir);
    if (r.status !== 0) {
      throw new Error('gate-telemetry hook failed: ' + r.stderr);
    }
    return readGateEvent(dir);
  } finally { cleanup(dir); }
}

// `walkNamespacedGates` and `isGateLeafName` are pure functions reachable
// without requiring the hook module: we re-execute them here as a sanity
// check by spawning a tiny one-liner that imports them and prints JSON.
function walkInChild(config) {
  const r = spawnSync(process.execPath, [
    '-e',
    'const {walkNamespacedGates}=require(' + JSON.stringify(HOOK) + ');' +
    'process.stdin.removeAllListeners();' +
    'process.stdout.write(JSON.stringify(walkNamespacedGates(JSON.parse(process.argv[1]))));' +
    'process.exit(0);',
    JSON.stringify(config),
  ], { encoding: 'utf8', timeout: 5000, input: '' });
  if (r.status !== 0) throw new Error('walker child failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function isGateLeafNameInChild(name) {
  const r = spawnSync(process.execPath, [
    '-e',
    'const {isGateLeafName}=require(' + JSON.stringify(HOOK) + ');' +
    'process.stdin.removeAllListeners();' +
    'process.stdout.write(JSON.stringify(isGateLeafName(process.argv[1])));' +
    'process.exit(0);',
    name,
  ], { encoding: 'utf8', timeout: 5000, input: '' });
  if (r.status !== 0) throw new Error('child failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function blocklistInChild() {
  const r = spawnSync(process.execPath, [
    '-e',
    'const {NAMESPACE_WALK_BLOCKLIST}=require(' + JSON.stringify(HOOK) + ');' +
    'process.stdin.removeAllListeners();' +
    'process.stdout.write(JSON.stringify([...NAMESPACE_WALK_BLOCKLIST]));' +
    'process.exit(0);',
  ], { encoding: 'utf8', timeout: 5000, input: '' });
  if (r.status !== 0) throw new Error('child failed: ' + r.stderr);
  return new Set(JSON.parse(r.stdout));
}

function makeSandbox(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v221-gate-tel-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(config),
    'utf8'
  );
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function runHook(dir) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 5000,
    env: process.env,
  });
}

function readGateEvent(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && e.type === 'feature_gate_eval') return e;
    } catch (_e) {}
  }
  return null;
}

describe('B3.1 — output_shape.enabled: true → gates_true', () => {
  test('walker surfaces a namespaced enabled leaf as a true gate (dotted path)', () => {
    const dir = makeSandbox({ output_shape: { enabled: true } });
    try {
      const r = runHook(dir);
      assert.equal(r.status, 0, 'hook must exit 0');
      const ev = readGateEvent(dir);
      assert.ok(ev, 'feature_gate_eval event must be emitted');
      assert.ok(ev.gates_true.includes('output_shape.enabled'),
        'gates_true must include "output_shape.enabled"; got: ' +
        JSON.stringify(ev.gates_true));
      assert.ok(!ev.gates_false.includes('output_shape.enabled'),
        'gates_false must NOT include "output_shape.enabled"');
    } finally { cleanup(dir); }
  });
});

describe('B3.2 — caching.block_z.enabled: false → gates_false', () => {
  test('walker surfaces a deeply-namespaced disabled gate as a false gate', () => {
    const dir = makeSandbox({ caching: { block_z: { enabled: false } } });
    try {
      const r = runHook(dir);
      assert.equal(r.status, 0);
      const ev = readGateEvent(dir);
      assert.ok(ev, 'feature_gate_eval event must be emitted');
      assert.ok(ev.gates_false.includes('caching.block_z.enabled'),
        'gates_false must include "caching.block_z.enabled"');
      assert.ok(!ev.gates_true.includes('caching.block_z.enabled'),
        'gates_true must NOT include "caching.block_z.enabled"');
    } finally { cleanup(dir); }
  });
});

describe('B3.3 — quarantine overlay forces namespaced gate to false', () => {
  test('a dotted-path candidate in feature_demand_gate.quarantine_candidates moves the gate to gates_false', () => {
    const dir = makeSandbox({
      output_shape: { enabled: true },
      feature_demand_gate: { quarantine_candidates: ['output_shape.enabled'] },
    });
    try {
      const r = runHook(dir);
      assert.equal(r.status, 0);
      const ev = readGateEvent(dir);
      assert.ok(ev);
      assert.ok(ev.gates_false.includes('output_shape.enabled'),
        'quarantined namespaced gate must be forced into gates_false');
      assert.ok(!ev.gates_true.includes('output_shape.enabled'),
        'gates_true must NOT include the quarantined gate');
      assert.equal(ev.eval_source, 'config_with_quarantine_overlay',
        'eval_source must flip when a quarantine override actually applies');
    } finally { cleanup(dir); }
  });
});

describe('B3.4 — legacy enable_* keys still surface', () => {
  test('top-level enable_threads:true and enable_outcome_tracking:false land in the right buckets', () => {
    const dir = makeSandbox({
      enable_threads: true,
      enable_outcome_tracking: false,
    });
    try {
      const r = runHook(dir);
      assert.equal(r.status, 0);
      const ev = readGateEvent(dir);
      assert.ok(ev);
      assert.ok(ev.gates_true.includes('enable_threads'),
        'legacy gates_true membership preserved for enable_threads');
      assert.ok(ev.gates_false.includes('enable_outcome_tracking'),
        'legacy gates_false membership preserved for enable_outcome_tracking');
    } finally { cleanup(dir); }
  });

  test('enable_agent_teams alias of agent_teams.enabled still works (no double-emit)', () => {
    const dir = makeSandbox({ agent_teams: { enabled: false } });
    try {
      const r = runHook(dir);
      assert.equal(r.status, 0);
      const ev = readGateEvent(dir);
      assert.ok(ev);
      assert.ok(ev.gates_false.includes('enable_agent_teams'),
        'agent_teams.enabled:false must surface as enable_agent_teams in gates_false');
      assert.ok(!ev.gates_true.includes('agent_teams.enabled'),
        'walker must not double-emit agent_teams.enabled (blocklist)');
      assert.ok(!ev.gates_false.includes('agent_teams.enabled'),
        'walker must not double-emit agent_teams.enabled (blocklist)');
    } finally { cleanup(dir); }
  });
});

describe('B3 — telemetry namespace is blocklisted (would be circular)', () => {
  test('telemetry.tier2_tracking.enabled is NOT surfaced as a namespaced gate', () => {
    const dir = makeSandbox({
      telemetry: { tier2_tracking: { enabled: true } },
      output_shape: { enabled: true }, // sentinel gate to keep the event valid
    });
    try {
      const r = runHook(dir);
      assert.equal(r.status, 0);
      const ev = readGateEvent(dir);
      assert.ok(ev, 'event still emitted (telemetry.tier2_tracking.enabled is true)');
      const all = (ev.gates_true || []).concat(ev.gates_false || []);
      assert.ok(!all.includes('telemetry.tier2_tracking.enabled'),
        'telemetry namespace must be blocklisted from the walker');
    } finally { cleanup(dir); }
  });
});

describe('B3 — walkNamespacedGates unit behaviour', () => {
  test('event_schemas.full_load_disabled:true keeps polarity (lands in gates_true verbatim)', () => {
    const out = walkInChild({ event_schemas: { full_load_disabled: true } });
    assert.deepEqual(out, [{ path: 'event_schemas.full_load_disabled', value: true }],
      'walker must report config value verbatim — no polarity inversion');
  });

  test('isGateLeafName recognises enabled, *_enabled, *_disabled', () => {
    assert.equal(isGateLeafNameInChild('enabled'),             true);
    // Generic *_enabled regex check — was 'housekeeper_enabled' pre-v2.2.3 P4.
    assert.equal(isGateLeafNameInChild('something_enabled'),   true);
    assert.equal(isGateLeafNameInChild('full_load_disabled'),  true);
    assert.equal(isGateLeafNameInChild('something_else'),      false);
    assert.equal(isGateLeafNameInChild('disabled'),            false,
      'bare "disabled" (without prefix) does not qualify');
  });

  test('NAMESPACE_WALK_BLOCKLIST contains telemetry and agent_teams', () => {
    const bl = blocklistInChild();
    assert.ok(bl.has('telemetry'));
    assert.ok(bl.has('agent_teams'));
  });

  test('walker requires depth >= 2 (top-level enabled is not a namespaced gate)', () => {
    const out = walkInChild({ enabled: true, foo: { enabled: true } });
    assert.ok(out.find(x => x.path === 'foo.enabled'));
    assert.ok(!out.find(x => x.path === 'enabled'),
      'top-level "enabled" must not be reported (depth < 2)');
  });
});

describe('B3.5 — REGRESSION: shipped .orchestray/config.json carries all required v2.2.x gates', () => {
  // v2.2.3 P4 W2 Strip: orchestray-housekeeper removed (zero invocations
  // across 7 post-v2.2.0 orchs); haiku_routing.housekeeper_enabled is no
  // longer a shipped gate. v2.2.3 P4 A3 added pm_router.enabled.
  const REQUIRED_GATES = [
    'audit.round_archive.enabled',
    'caching.block_z.enabled',
    'caching.engineered_breakpoints.enabled',
    'event_schemas.full_load_disabled',
    'haiku_routing.enabled',
    'output_shape.enabled',
    'pm_protocol.delegation_delta.enabled',
    'pm_router.enabled',
  ];

  test('all 8 named gates appear in gates_true ∪ gates_false against shipped config.json', () => {
    // Run the walker (in a child process to avoid the stdin-listener
    // hang) directly against the shipped config — the walker is pure.
    const raw = fs.readFileSync(REAL_CONFIG, 'utf8');
    const cfg = JSON.parse(raw);

    const gates = walkInChild(cfg);
    const paths = new Set(gates.map(g => g.path));

    const missing = REQUIRED_GATES.filter(g => !paths.has(g));
    assert.deepEqual(missing, [],
      'all 8 v2.2.0 gates must be discovered by the walker; missing: ' +
      JSON.stringify(missing) + '\nWalker output (paths only): ' +
      JSON.stringify([...paths].sort()));
  });

  test('end-to-end: hook against shipped config produces a feature_gate_eval event with all 8 named gates', () => {
    // Copy the shipped config into a sandbox so we don't pollute the real
    // .orchestray/audit/events.jsonl with a test-driven event.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v221-gate-tel-real-'));
    try {
      fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
      fs.copyFileSync(REAL_CONFIG, path.join(dir, '.orchestray', 'config.json'));
      const r = runHook(dir);
      assert.equal(r.status, 0);
      const ev = readGateEvent(dir);
      assert.ok(ev, 'event must be emitted');
      const all = new Set((ev.gates_true || []).concat(ev.gates_false || []));
      const missing = REQUIRED_GATES.filter(g => !all.has(g));
      assert.deepEqual(missing, [],
        'all 8 v2.2.0 gates must appear in the emitted event; missing: ' +
        JSON.stringify(missing));
    } finally { cleanup(dir); }
  });
});
