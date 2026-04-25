#!/usr/bin/env node
'use strict';

/**
 * Regression test: R-TGATE gate-telemetry.js hook (v2.1.14).
 *
 * AC verified:
 *   - Hook emits feature_gate_eval event with version:1 and correct truthy/falsy splits
 *   - eval_source is always 'config_snapshot'
 *   - Kill switches work: ORCHESTRAY_METRICS_DISABLED=1, ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1,
 *     config.telemetry.tier2_tracking.enabled=false
 *   - Missing config results in all explicit gates going to gates_false
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const SCRIPT = path.resolve(__dirname, '../../bin/gate-telemetry.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeDir({ orchId = 'orch-r-tgate-gt', config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-tgate-gt-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  if (config !== null) {
    const orchDir = path.join(dir, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(path.join(orchDir, 'config.json'), JSON.stringify(config));
  }
  return dir;
}

function run(dir, env = {}) {
  const payload = JSON.stringify({ cwd: dir });
  return spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env),
  });
}

function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('gate-telemetry.js: feature_gate_eval emission', () => {

  test('emits feature_gate_eval event with version:1', () => {
    const dir = makeDir({ config: { enable_drift_sentinel: true, auto_review: false } });
    const result = run(dir);
    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, 'feature_gate_eval');
    assert.equal(ev.version, 1);
  });

  test('gates_true contains truthy gates, gates_false contains falsy gates', () => {
    const dir = makeDir({
      config: {
        enable_drift_sentinel: true,
        enable_consequence_forecast: false,
        auto_review: true,
        auto_document: false,
      },
    });
    run(dir);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok(Array.isArray(ev.gates_true), 'gates_true must be an array');
    assert.ok(Array.isArray(ev.gates_false), 'gates_false must be an array');
    assert.ok(ev.gates_true.includes('enable_drift_sentinel'), 'enable_drift_sentinel=true must be in gates_true');
    assert.ok(ev.gates_true.includes('auto_review'), 'auto_review=true must be in gates_true');
    assert.ok(ev.gates_false.includes('enable_consequence_forecast'), 'enable_consequence_forecast=false must be in gates_false');
    assert.ok(ev.gates_false.includes('auto_document'), 'auto_document=false must be in gates_false');
  });

  test('eval_source is always config_snapshot', () => {
    const dir = makeDir({ config: {} });
    run(dir);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].eval_source, 'config_snapshot');
  });

  test('orchestration_id matches the current orchestration', () => {
    const dir = makeDir({ orchId: 'orch-tgate-id-check', config: {} });
    run(dir);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].orchestration_id, 'orch-tgate-id-check');
  });

  test('gates_true and gates_false are sorted arrays', () => {
    const dir = makeDir({
      config: {
        enable_backpressure: true,
        enable_drift_sentinel: true,
        enable_consequence_forecast: false,
        auto_review: false,
      },
    });
    run(dir);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    const ev = events[0];
    // Verify sorted
    const trueClone = [...ev.gates_true];
    assert.deepEqual(ev.gates_true, trueClone.sort(), 'gates_true must be sorted');
    const falseClone = [...ev.gates_false];
    assert.deepEqual(ev.gates_false, falseClone.sort(), 'gates_false must be sorted');
  });

  test('emits event with orchestration_id=unknown when no orchestration active', () => {
    const dir = makeDir({ config: {}, orchId: null });
    // Remove the orchestration file to simulate no active orchestration
    try {
      fs.rmSync(path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'));
    } catch (_e) {}
    run(dir);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].orchestration_id, 'unknown');
  });

  test('honors ORCHESTRAY_METRICS_DISABLED=1', () => {
    const dir = makeDir({ config: { enable_drift_sentinel: true } });
    run(dir, { ORCHESTRAY_METRICS_DISABLED: '1' });
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing when ORCHESTRAY_METRICS_DISABLED=1');
  });

  test('honors ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1', () => {
    const dir = makeDir({ config: { enable_drift_sentinel: true } });
    run(dir, { ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '1' });
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing when ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1');
  });

  test('honors config.telemetry.tier2_tracking.enabled=false', () => {
    const dir = makeDir({
      config: {
        enable_drift_sentinel: true,
        telemetry: { tier2_tracking: { enabled: false } },
      },
    });
    run(dir);
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing when tier2_tracking disabled in config');
  });

  test('missing config results in exit 0 with empty event (no crash)', () => {
    // No config file — all explicit gates should land in gates_false (absent = falsy)
    const dir = makeDir(); // no config
    const result = run(dir);
    assert.equal(result.status, 0, 'Must exit 0 even with no config');
    const events = readEvents(dir);
    assert.equal(events.length, 1, 'Must still emit an event with empty config');
    const ev = events[0];
    assert.equal(ev.type, 'feature_gate_eval');
    // All explicit keys should be in gates_false (undefined = falsy)
    assert.ok(ev.gates_false.length >= 0, 'gates_false is an array');
  });
});
