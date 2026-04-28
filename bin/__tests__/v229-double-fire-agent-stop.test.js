#!/usr/bin/env node
'use strict';

/**
 * v229-double-fire-agent-stop.test.js — B-4.1 unit tests.
 *
 * Spawns bin/collect-agent-metrics.js as a child process with synthesized
 * SubagentStop / TaskCompleted payloads on stdin. Asserts:
 *   1. Same agent_stop fired twice (dual-install) → 1 emit + 1
 *      agent_stop_double_fire_suppressed.
 *   2. Distinct agent_stops (different agent_type) → 2 emits, no suppression.
 *   3. ORCHESTRAY_AGENT_STOP_DOUBLE_FIRE_GUARD_DISABLED=1 → both fire (kill switch).
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'collect-agent-metrics.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE       = process.execPath;

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b4-1-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // Copy schema so audit-event-writer's validator runs.
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  // Disable schema-shadow validation: the existing `agent_stop` emitter in
  // collect-agent-metrics.js does NOT carry a `version` field on its payload
  // (a known pre-existing condition — production config also has shadow
  // disabled, and historical events.jsonl rows lack version). Without this
  // bypass, every emit becomes a `schema_shadow_validation_block` surrogate
  // and we never see the real `agent_stop` row.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ event_schema_shadow: { enabled: false } }),
    'utf8'
  );
  // Mark current orchestration so emits attach orchestration_id.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-b41-test' }),
    'utf8'
  );
  return root;
}

function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  // Force the hook to read the test's current-orchestration.json.
  if (!env.ORCHESTRAY_PROJECT_ROOT && payload && payload.cwd) {
    env.ORCHESTRAY_PROJECT_ROOT = payload.cwd;
  }
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(e => e !== null);
}

function buildPayload(root, overrides) {
  return Object.assign({
    cwd: root,
    hook_event_name: 'SubagentStop',
    agent_type: 'developer',
    agent_id: 'spawn-1',
    session_id: 'session-1',
    last_assistant_message: 'done',
  }, overrides || {});
}

describe('v229 B-4.1 — agent_stop double-fire guard', () => {
  test('dual-install double fire → 1 agent_stop + 1 agent_stop_double_fire_suppressed', () => {
    const root = makeTmpRoot();

    // Simulate dual-install: two distinct hook script paths that both forward
    // to the real hook implementation. The double-fire-guard tracks
    // caller_path via the script's __filename, so two `require('real-hook')`
    // shims sitting at different paths will look like two distinct installs.
    //
    // We must keep _lib resolution working, so each shim sits in a directory
    // that has access to the real `_lib/` (we re-export `__filename`-aware
    // logic by direct require of the real script — which sets the calling
    // module's __filename, not the requirer's).
    //
    // Cleaner approach: copy the hook script body to two different paths
    // and rewrite the require() prefixes to absolute paths into the real
    // _lib dir so the modules resolve from the new location.
    const realLibDir = path.join(REPO_ROOT, 'bin', '_lib');
    function makeShimAt(shimPath) {
      const original = fs.readFileSync(HOOK_PATH, 'utf8');
      // Rewrite require('./_lib/...') and require('./read-event') to
      // absolute paths so the copied script can run from anywhere.
      const rewritten = original
        .replace(/require\('\.\/_lib\//g, "require('" + realLibDir.replace(/\\/g, '\\\\') + "/")
        .replace(/require\('\.\/read-event'\)/g,
                 "require('" + path.join(REPO_ROOT, 'bin', 'read-event.js').replace(/\\/g, '\\\\') + "')");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(shimPath, rewritten, 'utf8');
    }

    const installAPath = path.join(root, '.claude', 'install-A', 'collect-agent-metrics.js');
    const installBPath = path.join(root, '.claude', 'install-B', 'collect-agent-metrics.js');
    makeShimAt(installAPath);
    makeShimAt(installBPath);

    const payload = buildPayload(root);

    // First fire: install A.
    const r1 = cp.spawnSync(NODE, [installAPath], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { ORCHESTRAY_PROJECT_ROOT: root }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(r1.status, 0, 'first fire exits 0; stderr=' + r1.stderr);

    // Second fire: install B.
    const r2 = cp.spawnSync(NODE, [installBPath], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { ORCHESTRAY_PROJECT_ROOT: root }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(r2.status, 0, 'second fire exits 0; stderr=' + r2.stderr);

    const events = readEvents(root);
    const stops = events.filter(e => e.type === 'agent_stop');
    const supp  = events.filter(e => e.type === 'agent_stop_double_fire_suppressed');

    assert.equal(stops.length, 1, 'exactly one agent_stop row written; got ' + stops.length);
    assert.equal(supp.length, 1, 'exactly one suppression event; got ' + supp.length);
    assert.match(supp[0].dedup_token, /:agent_stop$/, 'dedup_token has agent_stop suffix');
    assert.equal(supp[0].agent_type, 'developer');
    assert.equal(supp[0].orchestration_id, 'orch-b41-test');
    assert.ok(typeof supp[0].delta_ms === 'number', 'delta_ms is a number');
    assert.ok(supp[0].first_caller, 'first_caller present');
    assert.ok(supp[0].second_caller, 'second_caller present');
    assert.notEqual(supp[0].first_caller, supp[0].second_caller, 'callers distinct');
  });

  test('distinct agent_types → 2 agent_stop rows, no suppression', () => {
    const root = makeTmpRoot();

    const r1 = runHook(buildPayload(root, { agent_type: 'developer', agent_id: 'spawn-A' }), {
      env: { ORCHESTRAY_PROJECT_ROOT: root },
    });
    assert.equal(r1.status, 0, r1.stderr);

    const r2 = runHook(buildPayload(root, { agent_type: 'reviewer', agent_id: 'spawn-B' }), {
      env: { ORCHESTRAY_PROJECT_ROOT: root },
    });
    assert.equal(r2.status, 0, r2.stderr);

    const events = readEvents(root);
    const stops = events.filter(e => e.type === 'agent_stop');
    const supp  = events.filter(e => e.type === 'agent_stop_double_fire_suppressed');

    assert.equal(stops.length, 2, 'two distinct agent_stop rows written');
    assert.equal(supp.length, 0, 'no suppression for distinct stops');
  });

  test('kill switch ORCHESTRAY_AGENT_STOP_DOUBLE_FIRE_GUARD_DISABLED=1 → both fire', () => {
    const root = makeTmpRoot();

    // Same payload twice — without kill switch this would suppress; with it,
    // both rows write.
    const env = {
      ORCHESTRAY_PROJECT_ROOT: root,
      ORCHESTRAY_AGENT_STOP_DOUBLE_FIRE_GUARD_DISABLED: '1',
    };

    const r1 = runHook(buildPayload(root), { env });
    assert.equal(r1.status, 0, r1.stderr);

    const r2 = runHook(buildPayload(root), { env });
    assert.equal(r2.status, 0, r2.stderr);

    const events = readEvents(root);
    const stops = events.filter(e => e.type === 'agent_stop');
    const supp  = events.filter(e => e.type === 'agent_stop_double_fire_suppressed');

    assert.equal(stops.length, 2, 'kill switch lets both fire');
    assert.equal(supp.length, 0, 'no suppression event when kill switch set');
  });
});
