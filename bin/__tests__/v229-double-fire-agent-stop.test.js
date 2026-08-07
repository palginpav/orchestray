#!/usr/bin/env node
'use strict';

/**
 * v229-double-fire-agent-stop.test.js — B-4.1 unit tests.
 *
 * Spawns bin/collect-agent-metrics.js as a child process with synthesized
 * SubagentStop / TaskCompleted payloads on stdin. Asserts:
 *   1. Same agent_stop fired twice (dual-install) → 1 emit; the sibling install
 *      is suppressed at the shared hook entry (v2.3.18 W0 / D1).
 *   1b. With the legacy dual-install bypass set, the post-fire guard still emits
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
  // Simulate dual-install: two distinct hook script paths that both forward to
  // the real hook implementation. The guard tracks caller_path via the script's
  // __filename, so two copies at different paths look like two installs. Each
  // copy has its `require('./_lib/...')` prefixes rewritten to absolute paths so
  // the module still resolves from its new location.
  function makeDualInstallShims(root) {
    const realLibDir = path.join(REPO_ROOT, 'bin', '_lib');
    const makeShimAt = (shimPath) => {
      const original = fs.readFileSync(HOOK_PATH, 'utf8');
      const rewritten = original
        .replace(/require\('\.\/_lib\//g, "require('" + realLibDir.replace(/\\/g, '\\\\') + "/")
        .replace(/require\('\.\/read-event'\)/g,
                 "require('" + path.join(REPO_ROOT, 'bin', 'read-event.js').replace(/\\/g, '\\\\') + "')");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(shimPath, rewritten, 'utf8');
      return shimPath;
    };
    return [
      makeShimAt(path.join(root, '.claude', 'install-A', 'collect-agent-metrics.js')),
      makeShimAt(path.join(root, '.claude', 'install-B', 'collect-agent-metrics.js')),
    ];
  }

  function fireShim(shimPath, payload, extraEnv) {
    return cp.spawnSync(NODE, [shimPath], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { ORCHESTRAY_PROJECT_ROOT: payload.cwd }, extraEnv || {}),
      encoding: 'utf8',
      timeout: 8000,
    });
  }

  // v2.3.18 W0 (D1): the dedup guard moved from this one opt-in script to the
  // shared hook entry (bin/_lib/hook-stdin.js). The sibling install now exits
  // BEFORE running the hook body, so it never reaches the post-fire guard and
  // no `agent_stop_double_fire_suppressed` row is produced. The user-visible
  // contract — exactly one `agent_stop` — is unchanged and is what this asserts.
  test('dual-install double fire → 1 agent_stop, sibling suppressed at the entry', () => {
    const root = makeTmpRoot();
    const [installAPath, installBPath] = makeDualInstallShims(root);
    const payload = buildPayload(root);

    const r1 = fireShim(installAPath, payload);
    assert.equal(r1.status, 0, 'first fire exits 0; stderr=' + r1.stderr);
    const r2 = fireShim(installBPath, payload);
    assert.equal(r2.status, 0, 'second fire exits 0; stderr=' + r2.stderr);

    const events = readEvents(root);
    const stops = events.filter(e => e.type === 'agent_stop');
    assert.equal(stops.length, 1, 'exactly one agent_stop row written; got ' + stops.length);
  });

  // The post-fire guard is still the fallback whenever the entry-level dedup is
  // bypassed, so its emit path must keep working.
  test('legacy bypass → post-fire guard still emits agent_stop_double_fire_suppressed', () => {
    const root = makeTmpRoot();
    const [installAPath, installBPath] = makeDualInstallShims(root);
    const payload = buildPayload(root);
    const env = { ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED: '1' };

    const r1 = fireShim(installAPath, payload, env);
    assert.equal(r1.status, 0, 'first fire exits 0; stderr=' + r1.stderr);
    const r2 = fireShim(installBPath, payload, env);
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
