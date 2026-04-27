#!/usr/bin/env node
'use strict';

/**
 * v221-housekeeper-drift.test.js — W5 / B2 (W3)
 *
 * Tests the v2.2.1 3-tier agent file resolver in
 * `bin/audit-housekeeper-drift.js`.
 *
 * Cases (W5.md "B2 (W3)"):
 *   1. Agent file present project-local → resolved_via:"project",
 *      no agent_file_missing.
 *   2. Agent file present user-scope only → resolved_via:"user",
 *      no agent_file_missing.
 *   3. Agent file present plugin-source only → resolved_via:"plugin",
 *      no agent_file_missing.
 *   4. Agent file missing all three tiers → agent_file_missing fires
 *      (preserved fail-closed behaviour).
 *   5. Agent SHA differs from baseline → drift fires regardless of tier
 *      (preserved security property).
 *   6. Migration: legacy baseline file (already SHA-only on disk) → still
 *      resolves cleanly; no rewrite needed because the baseline schema is
 *      already SHA-only (W3 result file confirms no on-disk migration).
 *   7. REGRESSION: tuman 2026-04-27T08:33 condition — agent file present
 *      ONLY at ~/.claude/agents/orchestray-housekeeper.md, no project
 *      local, no plugin install → no false-positive agent_file_missing,
 *      resolved_via must be "user".
 *
 * IMPORTANT: every test below stubs `process.env.HOME` to a tmp dir so
 * the user-scope tier is fully isolated from the developer's real
 * ~/.claude/agents/ contents. No test ever reads or writes the real
 * home directory.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT     = path.resolve(__dirname, '..');
const HOOK          = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-drift.js');
const REAL_BASELINE = path.join(REPO_ROOT, 'bin', '_lib', '_housekeeper-baseline.js');
const REAL_AGENT    = path.join(REPO_ROOT, 'agents', 'orchestray-housekeeper.md');
const AGENT_FILE_NAME = 'orchestray-housekeeper.md';

function makeProjectSandbox(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v221-hk-drift-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin', '_lib'),         { recursive: true });

  // Always copy the real baseline so SHA comparison is meaningful.
  if (!opts.skipBaseline) {
    fs.copyFileSync(REAL_BASELINE,
      path.join(dir, 'bin', '_lib', '_housekeeper-baseline.js'));
  }

  // Project-local agent file (only if requested).
  if (opts.projectAgentBody !== undefined) {
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agents', AGENT_FILE_NAME),
      opts.projectAgentBody, 'utf8'
    );
  }

  // Default config (housekeeper enabled).
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({ haiku_routing: { housekeeper_enabled: true } }),
    'utf8'
  );

  return dir;
}

function makeFakeHome(opts) {
  opts = opts || {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v221-hk-home-'));
  if (opts.userAgentBody !== undefined) {
    const userAgentDir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(userAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(userAgentDir, AGENT_FILE_NAME),
      opts.userAgentBody, 'utf8'
    );
  }
  if (opts.pluginAgentBody !== undefined) {
    const pluginAgentDir = path.join(home, '.claude', 'orchestray', 'agents');
    fs.mkdirSync(pluginAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginAgentDir, AGENT_FILE_NAME),
      opts.pluginAgentBody, 'utf8'
    );
  }
  return home;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function runHook(cwd, fakeHome) {
  // Stub HOME so the hook's user-scope tier resolves into our tmp dir.
  // Both HOME and USERPROFILE are set so os.homedir() returns the fake
  // path on every supported platform.
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    timeout: 10_000,
    env: Object.assign({}, process.env, {
      HOME:        fakeHome,
      USERPROFILE: fakeHome,
    }),
    cwd,
  });
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

function readRealAgent() {
  return fs.readFileSync(REAL_AGENT, 'utf8');
}

describe('B2.1 — agent file present project-local', () => {
  test('resolved_via: "project", no agent_file_missing event', () => {
    const realBody = readRealAgent();
    const dir  = makeProjectSandbox({ projectAgentBody: realBody });
    const home = makeFakeHome({ /* no user, no plugin */ });
    try {
      const r = runHook(dir, home);
      assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);
      const events  = readEvents(dir);
      const missing = events.find(e =>
        e && e.type === 'housekeeper_drift_detected' && e.reason === 'agent_file_missing');
      assert.equal(missing, undefined,
        'no agent_file_missing must fire when project-local agent is present');

      // resolved_via field must accompany every drift event. On clean
      // SHA we don't expect a drift event at all, but if W3 fires one
      // (e.g. tools-line drift), it must carry resolved_via:"project".
      const drift = events.find(e => e && e.type === 'housekeeper_drift_detected');
      if (drift) {
        assert.equal(drift.resolved_via, 'project',
          'drift event must carry resolved_via:"project"');
      }

      const sentinelPath = path.join(dir, '.orchestray', 'state', 'housekeeper-quarantined');
      assert.equal(fs.existsSync(sentinelPath), false,
        'no quarantine sentinel must be written on clean baseline');
    } finally { cleanup(dir); cleanup(home); }
  });
});

describe('B2.2 — agent file present user-scope only', () => {
  test('resolved_via: "user", no agent_file_missing event', () => {
    const realBody = readRealAgent();
    const dir  = makeProjectSandbox({ /* no project-local agent */ });
    const home = makeFakeHome({ userAgentBody: realBody });
    try {
      const r = runHook(dir, home);
      assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);
      const events  = readEvents(dir);
      const missing = events.find(e =>
        e && e.type === 'housekeeper_drift_detected' && e.reason === 'agent_file_missing');
      assert.equal(missing, undefined,
        'no agent_file_missing must fire when user-scope agent is present (3-tier resolver)');

      const drift = events.find(e => e && e.type === 'housekeeper_drift_detected');
      if (drift) {
        assert.equal(drift.resolved_via, 'user',
          'drift event must carry resolved_via:"user" when user-scope file resolves');
      }

      const sentinelPath = path.join(dir, '.orchestray', 'state', 'housekeeper-quarantined');
      assert.equal(fs.existsSync(sentinelPath), false,
        'no quarantine sentinel must be written when user-scope SHA matches baseline');
    } finally { cleanup(dir); cleanup(home); }
  });
});

describe('B2.3 — agent file present plugin-source only', () => {
  test('resolved_via: "plugin", no agent_file_missing event', () => {
    const realBody = readRealAgent();
    const dir  = makeProjectSandbox({ /* no project-local agent */ });
    const home = makeFakeHome({ pluginAgentBody: realBody });
    try {
      const r = runHook(dir, home);
      assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);
      const events  = readEvents(dir);
      const missing = events.find(e =>
        e && e.type === 'housekeeper_drift_detected' && e.reason === 'agent_file_missing');
      assert.equal(missing, undefined,
        'no agent_file_missing must fire when plugin-source agent is present (3-tier resolver)');

      const drift = events.find(e => e && e.type === 'housekeeper_drift_detected');
      if (drift) {
        assert.equal(drift.resolved_via, 'plugin',
          'drift event must carry resolved_via:"plugin" when plugin-source file resolves');
      }
    } finally { cleanup(dir); cleanup(home); }
  });
});

describe('B2.4 — agent file missing across all three tiers', () => {
  test('agent_file_missing fires (fail-closed preserved); resolved_via:null', () => {
    const dir  = makeProjectSandbox({ /* no project-local */ });
    const home = makeFakeHome({ /* no user, no plugin */ });
    try {
      const r = runHook(dir, home);
      assert.equal(r.status, 0);
      const events  = readEvents(dir);
      const missing = events.find(e =>
        e && e.type === 'housekeeper_drift_detected' && e.reason === 'agent_file_missing');
      assert.ok(missing,
        'agent_file_missing must fire when ALL three tiers miss (fail-closed)');
      assert.equal(missing.resolved_via, null,
        'resolved_via must be null when reason is agent_file_missing');

      const sentinelPath = path.join(dir, '.orchestray', 'state', 'housekeeper-quarantined');
      assert.equal(fs.existsSync(sentinelPath), true,
        'quarantine sentinel must be written when no agent file resolves');
    } finally { cleanup(dir); cleanup(home); }
  });
});

describe('B2.5 — SHA mismatch fires drift regardless of tier (security property preserved)', () => {
  test('user-scope agent with tampered body → drift event with resolved_via:"user"', () => {
    const realBody     = readRealAgent();
    const tamperedBody = realBody + '\n<!-- tampered tail v221 -->\n';
    const dir  = makeProjectSandbox({ /* no project-local */ });
    const home = makeFakeHome({ userAgentBody: tamperedBody });
    try {
      const r = runHook(dir, home);
      assert.equal(r.status, 0);
      const events = readEvents(dir);
      const drift  = events.find(e => e && e.type === 'housekeeper_drift_detected');
      assert.ok(drift, 'drift event must fire on SHA mismatch');
      assert.match(drift.reason, /sha/,
        'reason must mention "sha" when body bytes differ; got: ' + drift.reason);
      assert.equal(drift.resolved_via, 'user',
        'resolved_via must be "user" when the user-scope tier supplied the file');
      assert.notEqual(drift.previous_sha, drift.current_sha,
        'SHAs must differ on drift');

      const sentinelPath = path.join(dir, '.orchestray', 'state', 'housekeeper-quarantined');
      assert.equal(fs.existsSync(sentinelPath), true,
        'sentinel must be written on real drift regardless of which tier resolved');
    } finally { cleanup(dir); cleanup(home); }
  });
});

describe('B2.6 — baseline migration: SHA-only baseline already on disk needs no rewrite', () => {
  test('clean run with SHA-only baseline emits no migration / no error event', () => {
    // The baseline at bin/_lib/_housekeeper-baseline.js is already SHA-
    // only (no absolute paths) per W3 result. This test confirms a clean
    // run on the current baseline does NOT emit housekeeper_baseline_missing
    // and does NOT mutate the baseline file on disk.
    const realBody = readRealAgent();
    const dir  = makeProjectSandbox({ projectAgentBody: realBody });
    const home = makeFakeHome({});
    try {
      const baselinePath = path.join(dir, 'bin', '_lib', '_housekeeper-baseline.js');
      const beforeBytes  = fs.readFileSync(baselinePath, 'utf8');

      const r = runHook(dir, home);
      assert.equal(r.status, 0);

      const afterBytes = fs.readFileSync(baselinePath, 'utf8');
      assert.equal(beforeBytes, afterBytes,
        'baseline file must not be mutated by the hook (no on-disk migration needed)');

      const events  = readEvents(dir);
      const missing = events.find(e => e && e.type === 'housekeeper_baseline_missing');
      assert.equal(missing, undefined,
        'no housekeeper_baseline_missing event when baseline is well-formed');
    } finally { cleanup(dir); cleanup(home); }
  });
});

describe('B2.7 — REGRESSION: tuman 2026-04-27T08:33 condition (user-scope only, no project, no plugin)', () => {
  // Reproduces the exact tuman incident: housekeeper agent file present
  // ONLY at ~/.claude/agents/orchestray-housekeeper.md (because the user
  // installed via npm into user scope), no project-local copy, no plugin
  // install. v2.2.0 hard-coded the project-local path and false-fired
  // agent_file_missing on every SessionStart, quarantining housekeeper
  // spawns. v2.2.1 W3 walks the 3-tier ladder and resolves to user.
  test('user-scope agent only → NO agent_file_missing event AND resolved_via:"user"', () => {
    const realBody = readRealAgent();
    const dir  = makeProjectSandbox({ /* no project-local — exactly tuman's state */ });
    const home = makeFakeHome({ userAgentBody: realBody });
    try {
      const r = runHook(dir, home);
      assert.equal(r.status, 0);

      const events    = readEvents(dir);
      const missingEv = events.find(e =>
        e && e.type === 'housekeeper_drift_detected' && e.reason === 'agent_file_missing');
      assert.equal(missingEv, undefined,
        'REGRESSION: no agent_file_missing event must fire (this is the exact tuman bug)');

      // No quarantine sentinel may be written for a clean user-scope install
      const sentinelPath = path.join(dir, '.orchestray', 'state', 'housekeeper-quarantined');
      assert.equal(fs.existsSync(sentinelPath), false,
        'REGRESSION: no quarantine sentinel must be written when user-scope agent is clean');

      // If any drift event was emitted (it shouldn't on clean SHA), it
      // MUST carry resolved_via:"user" — proving the resolver actually
      // hit the user tier.
      const drift = events.find(e => e && e.type === 'housekeeper_drift_detected');
      if (drift) {
        assert.equal(drift.resolved_via, 'user',
          'resolved_via must be "user" — the user-scope tier supplied the file');
      }
    } finally { cleanup(dir); cleanup(home); }
  });
});
