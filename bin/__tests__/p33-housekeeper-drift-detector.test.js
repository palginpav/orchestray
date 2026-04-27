#!/usr/bin/env node
'use strict';

/**
 * p33-housekeeper-drift-detector.test.js — P3.3 SessionStart drift detector.
 *
 * Runs `bin/audit-housekeeper-drift.js` as a child process against fabricated
 * temp project trees and asserts the Clause 3 contract:
 *
 *   1. Clean baseline: hook exits 0 with no stderr drift warning.
 *   2. SHA mismatch: hook emits `housekeeper_drift_detected` event + sentinel
 *      + stderr warning containing `quarantined`.
 *   3. tools-line mismatch: same outcome with reason `tools_only`.
 *   4. agent file missing: emits drift event with reason `agent_file_missing`.
 *   5. Recovery: clean run unlinks the sentinel.
 *   6. Env kill switch: `ORCHESTRAY_HOUSEKEEPER_DISABLED=1` short-circuits.
 *   7. Config kill switch: `housekeeper_enabled: false` short-circuits.
 *
 * Runner: node --test bin/__tests__/p33-housekeeper-drift-detector.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-drift.js');
const REAL_BASELINE = path.join(REPO_ROOT, 'bin', '_lib', '_housekeeper-baseline.js');
const REAL_AGENT = path.join(REPO_ROOT, 'agents', 'orchestray-housekeeper.md');

function runHook(cwd, env) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    timeout: 10_000,
    env: Object.assign({}, process.env, env || {}),
    cwd,
  });
}

function setupSandbox(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-drift-'));
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'bin', '_lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });

  // Copy or fabricate the agent file.
  if (opts.skipAgentFile) {
    // intentionally do not write the agent file
  } else {
    const agentBody = opts.agentBody || fs.readFileSync(REAL_AGENT, 'utf8');
    fs.writeFileSync(path.join(tmp, 'agents', 'orchestray-housekeeper.md'),
      agentBody, 'utf8');
  }

  // Copy or fabricate the baseline.
  if (opts.skipBaseline) {
    // intentionally do not write the baseline
  } else {
    const baselineBody = opts.baselineBody !== undefined
      ? opts.baselineBody
      : fs.readFileSync(REAL_BASELINE, 'utf8');
    fs.writeFileSync(path.join(tmp, 'bin', '_lib', '_housekeeper-baseline.js'),
      baselineBody, 'utf8');
  }

  // Config (default-on per locked-scope D-5).
  const cfg = Object.assign({
    haiku_routing: { housekeeper_enabled: true },
  }, opts.cfgExtra || {});
  fs.writeFileSync(path.join(tmp, '.orchestray', 'config.json'),
    JSON.stringify(cfg), 'utf8');

  return tmp;
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function sentinelPath(tmp) {
  return path.join(tmp, '.orchestray', 'state', 'housekeeper-quarantined');
}

describe('P3.3 — audit-housekeeper-drift hook', () => {

  test('clean baseline → exit 0, no drift event, no sentinel', () => {
    // Sandbox copies the real agent + real baseline → SHA matches.
    const tmp = setupSandbox();
    try {
      const r = runHook(tmp);
      assert.equal(r.status, 0, 'stderr=' + r.stderr);
      const events = readEvents(tmp);
      const drift = events.filter(e => e.type === 'housekeeper_drift_detected');
      assert.equal(drift.length, 0, 'no drift event expected; got: ' + JSON.stringify(drift));
      assert.equal(fs.existsSync(sentinelPath(tmp)), false,
        'sentinel must not exist on clean baseline');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('SHA mismatch → drift event + sentinel + stderr warning', () => {
    // Tamper with the agent body but keep tools-line intact: SHA differs
    // from the (unchanged) baseline.
    const realBody = fs.readFileSync(REAL_AGENT, 'utf8');
    const tamperedBody = realBody + '\n<!-- tampered tail -->\n';
    const tmp = setupSandbox({ agentBody: tamperedBody });
    try {
      const r = runHook(tmp);
      assert.equal(r.status, 0, 'hook always exits 0; stderr=' + r.stderr);
      assert.match(r.stderr, /drift detected/);
      assert.match(r.stderr, /quarantined/);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_drift_detected');
      assert.ok(hit, 'expected housekeeper_drift_detected event; events=' + JSON.stringify(events));
      assert.equal(hit.reason, 'sha_only',
        'reason should be sha_only when only body bytes (not tools line) drifted');
      assert.equal(typeof hit.previous_sha, 'string');
      assert.equal(typeof hit.current_sha, 'string');
      assert.notEqual(hit.previous_sha, hit.current_sha);
      assert.equal(fs.existsSync(sentinelPath(tmp)), true,
        'sentinel must be written on drift');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('tools-line mismatch → drift event with reason that includes "tools"', () => {
    // Replace tools line so the tools-line differs from baseline.
    const realBody = fs.readFileSync(REAL_AGENT, 'utf8');
    const tamperedBody = realBody.replace(
      /^tools: \[Read, Glob\]$/m,
      'tools: [Read, Glob, Bash]'
    );
    assert.notEqual(tamperedBody, realBody, 'sandbox must actually replace the tools line');
    const tmp = setupSandbox({ agentBody: tamperedBody });
    try {
      const r = runHook(tmp);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_drift_detected');
      assert.ok(hit, 'expected housekeeper_drift_detected; events=' + JSON.stringify(events));
      assert.match(hit.reason, /tools/,
        'reason must mention tools when tools-line differs; got: ' + hit.reason);
      assert.equal(hit.current_tools, 'tools: [Read, Glob, Bash]');
      assert.equal(fs.existsSync(sentinelPath(tmp)), true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('agent file missing → drift event with reason agent_file_missing', () => {
    // W3 introduced a 3-tier resolver: project (<cwd>/.claude/agents),
    // user (~/.claude/agents), and plugin (~/.claude/orchestray/agents).
    // To assert "missing in ALL tiers", we pin HOME to the sandbox so the
    // user/plugin tiers point inside <tmp> (which is empty) and cannot
    // accidentally pick up the real ~/.claude/agents/orchestray-housekeeper.md
    // that exists on the developer's machine.
    const tmp = setupSandbox({ skipAgentFile: true });
    try {
      const r = runHook(tmp, { HOME: tmp });
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_drift_detected');
      assert.ok(hit, 'expected housekeeper_drift_detected; events=' + JSON.stringify(events));
      assert.equal(hit.reason, 'agent_file_missing');
      assert.equal(hit.current_sha, null);
      assert.equal(hit.current_tools, null);
      // W3 contract: when no tier resolves, resolved_via is null.
      assert.equal(hit.resolved_via, null,
        'resolved_via must be null when the agent file is missing in every tier');
      assert.equal(fs.existsSync(sentinelPath(tmp)), true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('agent file found via user-scope tier → drift event has resolved_via: "user"', () => {
    // Coverage gap closer (v2.2.1): exercise the user-scope path W3 added.
    // The hook ONLY emits events on drift, so to observe `resolved_via: "user"`
    // we must (a) make the project-local file absent, (b) place a TAMPERED
    // copy in the user-scope tier, and (c) pin HOME=<tmp>. The hook resolves
    // via user-scope, detects SHA drift on the tampered body, and emits a
    // drift event whose `resolved_via` field is "user" — proving both the
    // tier-resolution and the field propagation.
    const realBody = fs.readFileSync(REAL_AGENT, 'utf8');
    const tamperedBody = realBody + '\n<!-- user-tier tamper -->\n';
    const tmp = setupSandbox({ skipAgentFile: true });
    // HOME must be DISTINCT from cwd, otherwise <cwd>/.claude/agents and
    // <HOME>/.claude/agents collapse to the same path and the resolver
    // attributes the hit to the project tier (first candidate wins).
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-home-'));
    try {
      const userAgentDir = path.join(fakeHome, '.claude', 'agents');
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, 'orchestray-housekeeper.md'),
        tamperedBody, 'utf8'
      );
      const r = runHook(tmp, { HOME: fakeHome });
      assert.equal(r.status, 0, 'stderr=' + r.stderr);
      const events = readEvents(tmp);
      const missing = events.find(e =>
        e.type === 'housekeeper_drift_detected' && e.reason === 'agent_file_missing');
      assert.equal(missing, undefined,
        'agent_file_missing must NOT fire when user-scope tier resolves');
      const drift = events.find(e => e.type === 'housekeeper_drift_detected');
      assert.ok(drift, 'expected drift event from user-scope tampered copy; events=' +
        JSON.stringify(events));
      assert.equal(drift.resolved_via, 'user',
        'resolved_via must be "user" when only the user-scope tier has the file');
      assert.equal(drift.reason, 'sha_only',
        'tampered tail (tools line intact) → reason should be sha_only');
      assert.match(r.stderr, /resolved_via=user/,
        'stderr must surface resolved_via=user for operator visibility');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('recovery: clean run after drift unlinks the sentinel', () => {
    const tmp = setupSandbox();
    try {
      // Pre-write the sentinel (simulate prior drift cycle).
      fs.writeFileSync(sentinelPath(tmp), '{"reason":"sha_only"}', 'utf8');
      assert.equal(fs.existsSync(sentinelPath(tmp)), true);
      const r = runHook(tmp);
      assert.equal(r.status, 0, 'stderr=' + r.stderr);
      assert.equal(fs.existsSync(sentinelPath(tmp)), false,
        'sentinel must be unlinked after a clean run (recovery)');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('ORCHESTRAY_HOUSEKEEPER_DISABLED=1 → no events, no sentinel even on drift', () => {
    const realBody = fs.readFileSync(REAL_AGENT, 'utf8');
    const tamperedBody = realBody + '\n<!-- tampered -->\n';
    const tmp = setupSandbox({ agentBody: tamperedBody });
    try {
      const r = runHook(tmp, { ORCHESTRAY_HOUSEKEEPER_DISABLED: '1' });
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_drift_detected');
      assert.equal(hit, undefined, 'kill switch must short-circuit; no drift event expected');
      assert.equal(fs.existsSync(sentinelPath(tmp)), false,
        'kill switch must short-circuit; no sentinel');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('haiku_routing.housekeeper_enabled: false → no events even on drift', () => {
    const realBody = fs.readFileSync(REAL_AGENT, 'utf8');
    const tamperedBody = realBody + '\n<!-- tampered -->\n';
    const tmp = setupSandbox({
      agentBody: tamperedBody,
      cfgExtra: { haiku_routing: { housekeeper_enabled: false } },
    });
    try {
      const r = runHook(tmp);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_drift_detected');
      assert.equal(hit, undefined, 'config kill switch must short-circuit');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

});
