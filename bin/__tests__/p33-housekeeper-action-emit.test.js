#!/usr/bin/env node
'use strict';

/**
 * p33-housekeeper-action-emit.test.js — S-002 (v2.2.0 fix-pass).
 *
 * Verifies the Clause 4 telemetry contract: when an
 * `orchestray-housekeeper` SubagentStop fires, the
 * `bin/audit-housekeeper-action.js` hook MUST emit a `housekeeper_action`
 * event row with the documented schema shape (op_type, target_bytes,
 * savings_claimed_usd, marker_received, orchestration_id, session_id,
 * timestamp, version).
 *
 * Without this hook, the schema row, validator allowlist, and shadow
 * JSON exist but the v2.2.1+ promotion gate criterion ("≥ 100
 * housekeeper_action events") is permanently unreachable.
 *
 * Runner: node --test bin/__tests__/p33-housekeeper-action-emit.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-action.js');

function setupSandbox(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-action-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
  // Default-on per locked-scope D-5: include the enabled flag.
  fs.writeFileSync(path.join(tmp, '.orchestray', 'config.json'),
    JSON.stringify({ haiku_routing: { housekeeper_enabled: true } }), 'utf8');

  if (opts.orchId) {
    // Per bin/_lib/orchestration-state.js: file lives in audit/, not state/.
    const orchPath = path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json');
    fs.writeFileSync(orchPath, JSON.stringify({ orchestration_id: opts.orchId }), 'utf8');
  }

  return tmp;
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function buildSubagentStopPayload(opts) {
  // Build a minimal SubagentStop payload that the hook recognizes as a
  // housekeeper completion. The hook reuses validate-task-completion's
  // extractStructuredResult / identifyAgentRole helpers, so any of the
  // standard role-identifying keys works (`subagent_type` is canonical).
  const sr = Object.assign({
    status: 'success',
    summary: 'kb-write-verify completed',
    files_changed: [],
    files_read: ['/abs/path/to/somefile.md'],
    issues: [],
    assumptions: [],
    housekeeper_op: 'kb-write-verify',
    housekeeper_target_bytes: 4096,
    housekeeper_savings_usd: 0.008,
  }, opts.structuredResultExtra || {});

  return {
    cwd: opts.cwd,
    hook_event_name: 'SubagentStop',
    subagent_type: 'orchestray-housekeeper',
    session_id: opts.sessionId || 'test-session-uuid',
    structured_result: sr,
    tool_input: {
      description: opts.markerDescription ||
        'rollup recompute [housekeeper: write /abs/path/to/somefile.md]',
    },
  };
}

function runHook(tmp, payload, env) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    env: Object.assign({}, process.env, env || {}),
    cwd: tmp,
  });
}

describe('P3.3 S-002 — housekeeper_action emission', () => {

  test('SubagentStop for orchestray-housekeeper → housekeeper_action row in events.jsonl', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-xyz' });
    try {
      const payload = buildSubagentStopPayload({ cwd: tmp });
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.ok(hit, 'expected housekeeper_action event; got: ' +
        JSON.stringify(events.map(e => e.type)));
      assert.equal(hit.version, 1);
      assert.equal(hit.op_type, 'kb-write-verify');
      assert.equal(hit.target_bytes, 4096);
      assert.equal(hit.savings_claimed_usd, 0.008);
      assert.equal(hit.orchestration_id, 'orch-test-xyz');
      assert.equal(hit.session_id, 'test-session-uuid');
      assert.equal(typeof hit.timestamp, 'string');
      assert.match(hit.timestamp, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(hit.marker_received || '', /\[housekeeper: write/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('non-housekeeper SubagentStop is a no-op', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-other' });
    try {
      const payload = buildSubagentStopPayload({ cwd: tmp });
      payload.subagent_type = 'developer';
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.equal(hit, undefined, 'non-housekeeper stop must not emit; got: ' +
        JSON.stringify(events.map(e => e.type)));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('env kill switch suppresses emission', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-killed' });
    try {
      const payload = buildSubagentStopPayload({ cwd: tmp });
      const r = runHook(tmp, payload, { ORCHESTRAY_HOUSEKEEPER_DISABLED: '1' });
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.equal(hit, undefined, 'env kill switch must suppress emission');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('config kill switch suppresses emission', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-cfgoff' });
    try {
      // Override the default-on config with disabled.
      fs.writeFileSync(path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ haiku_routing: { housekeeper_enabled: false } }), 'utf8');
      const payload = buildSubagentStopPayload({ cwd: tmp });
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.equal(hit, undefined, 'config kill switch must suppress emission');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('missing housekeeper_savings_usd defaults to 0', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-defaults' });
    try {
      const payload = buildSubagentStopPayload({
        cwd: tmp,
        // Drop the savings field — the housekeeper may legitimately omit it
        // when it cannot compute a savings estimate.
        structuredResultExtra: { housekeeper_savings_usd: undefined },
      });
      delete payload.structured_result.housekeeper_savings_usd;
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.ok(hit, 'expected housekeeper_action even without savings field');
      assert.equal(hit.savings_claimed_usd, 0,
        'missing savings field must default to 0');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('whitespace-padded role still triggers emission (S-001 hardening)', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-padded' });
    try {
      const payload = buildSubagentStopPayload({ cwd: tmp });
      // Pad with NBSP (U+00A0) — the strengthened identifyAgentRole
      // strips it via NFKC normalization + the new char class.
      payload.subagent_type = 'orchestray-housekeeper ';
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.ok(hit,
        'NBSP-padded role must still be recognized after S-001 normalization');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // -------------------------------------------------------------------------
  // X-002 (v2.2.0 pre-ship cross-phase fix-pass): the audit-housekeeper-action
  // hook MUST honor the quarantine sentinel as a third kill switch, mirroring
  // gate-agent-spawn.js:138-153. Telemetry from a drifted-but-running
  // housekeeper must NOT be admitted into the rollup — it would corrupt
  // the locked-scope D-5 promotion-gate counter.
  // -------------------------------------------------------------------------

  test('quarantine sentinel suppresses emission (X-002 defense-in-depth)', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-quarantined' });
    try {
      // Plant the quarantine sentinel as the drift detector would.
      const sentinelPath = path.join(tmp, '.orchestray', 'state', 'housekeeper-quarantined');
      fs.writeFileSync(sentinelPath,
        JSON.stringify({ reason: 'baseline_mismatch', ts: new Date().toISOString() }),
        'utf8');

      const payload = buildSubagentStopPayload({ cwd: tmp });
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0,
        'hook must still exit 0 (fail-open contract); stderr=' + r.stderr);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.equal(hit, undefined,
        'X-002 regression: a quarantined housekeeper must NOT emit ' +
        'housekeeper_action telemetry. Sentinel-present admission would ' +
        'pollute the v2.2.1 promotion-gate counter (>=100 events / zero ' +
        'violations) with attacker-influenced data. Mirror Clause 3 from ' +
        'gate-agent-spawn.js:138-153.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('absent quarantine sentinel still admits emission (sentinel is the gate, not the default)', () => {
    const tmp = setupSandbox({ orchId: 'orch-test-not-quarantined' });
    try {
      // Confirm sentinel does NOT exist.
      const sentinelPath = path.join(tmp, '.orchestray', 'state', 'housekeeper-quarantined');
      assert.equal(fs.existsSync(sentinelPath), false,
        'precondition: sentinel must be absent for the positive case');

      const payload = buildSubagentStopPayload({ cwd: tmp });
      const r = runHook(tmp, payload);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_action');
      assert.ok(hit,
        'absent sentinel must NOT block emission — the X-002 fix is ' +
        'sentinel-presence-gated, not unconditional');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

});
