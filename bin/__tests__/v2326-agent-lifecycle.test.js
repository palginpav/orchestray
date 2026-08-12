#!/usr/bin/env node
'use strict';

/**
 * v2326-agent-lifecycle.test.js — end-to-end coverage for the four W2/W4
 * acceptance criteria in `.orchestray/kb/decisions/v2326-scope-locked.md` §2a
 * and `.orchestray/kb/artifacts/v2326-lifecycle-design.md`.
 *
 * Drives the real hook pipeline as subprocesses (register-agent-spawn.js
 * pre-spawn/start, collect-agent-metrics.js SubagentStop) against an
 * isolated tmpdir, exactly mirroring the PreToolUse -> SubagentStart ->
 * SubagentStop sequence Claude Code fires.
 *
 * 1. Membership gate — a SubagentStop for an unregistered agent_id must
 *    write ZERO registry rows (phantom-stop rejection).
 * 2. The `name:` case — a spawn whose SubagentStop payload carries a broken
 *    roster-name agent_type (the real-world defect) must still resolve
 *    model_used via the agent_id-keyed registry.
 * 3. Kill switch — with the master switch set, no registry file is created
 *    and agent_stop's field set reverts to the pre-change shape.
 * 4. No regression — covered by running the pre-existing agent_stop suites
 *    unmodified (see PM/tester structured result for the full-suite run).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REGISTER_SCRIPT = path.resolve(__dirname, '../register-agent-spawn.js');
const METRICS_SCRIPT = path.resolve(__dirname, '../collect-agent-metrics.js');
const { registryPath } = require('../_lib/agent-registry');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lifecycle-test-'));
  cleanup.push(dir);
  return dir;
}

function writeOrchestrationId(cwd, id) {
  const auditDir = path.join(cwd, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

/** Runs a hook script (optionally with a subcommand arg) with a JSON payload on stdin. */
function run(script, subcommand, payload, envOverrides) {
  const args = subcommand ? [script, subcommand] : [script];
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, envOverrides || {}),
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function preSpawn(cwd, toolInput, extra, env) {
  return run(REGISTER_SCRIPT, 'pre-spawn', Object.assign({
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'tu-' + Math.random().toString(36).slice(2),
    tool_input: toolInput,
    session_id: 'sess-1',
  }, extra), env);
}

function startAgent(cwd, agentId, agentType, extra, env) {
  return run(REGISTER_SCRIPT, 'start', Object.assign({
    cwd,
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
    session_id: 'sess-1',
  }, extra), env);
}

function stopAgent(cwd, agentId, agentType, extra, env) {
  return run(METRICS_SCRIPT, null, Object.assign({
    cwd,
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: agentType,
    session_id: 'sess-1',
    last_assistant_message: 'Task complete.',
  }, extra), env);
}

function readEventsJsonl(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function readRegistryRows(cwd) {
  const p = registryPath(cwd);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1 — membership gate
// ---------------------------------------------------------------------------

describe('acceptance 1 — membership gate (phantom stops write nothing)', () => {

  test('SubagentStop for an agent_id never registered writes zero registry rows', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-phantom');

    // No pre-spawn, no start — this agent_id never appears in the registry,
    // exactly like Claude Code's internal compaction-summariser SubagentStop.
    const { status } = stopAgent(cwd, 'a-phantom-never-registered', null);
    assert.equal(status, 0);

    const rows = readRegistryRows(cwd);
    assert.equal(rows.length, 0, 'a stop for an unregistered agent_id must write NOTHING to the registry');

    const events = readEventsJsonl(cwd);
    const agentStop = events.find(e => e.type === 'agent_stop');
    assert.ok(agentStop, 'agent_stop must still be emitted unchanged apart from the new fields');
    assert.equal(agentStop.lifecycle_registered, false, 'membership must be false for a phantom stop');
  });

  test('control: a properly registered agent DOES produce a completed registry row', () => {
    // Inverts the assertion above — proves the membership-gate test can
    // actually fail (i.e. it is not vacuously true for any input).
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-real');

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'developer', description: 'DEV-1 build the thing' });
    startAgent(cwd, 'a-real-registered-agent', 'developer');
    const { status } = stopAgent(cwd, 'a-real-registered-agent', 'developer');
    assert.equal(status, 0);

    const rows = readRegistryRows(cwd);
    const completedRow = rows.find(r => r.agent_id === 'a-real-registered-agent' && r.event === 'completed');
    assert.ok(completedRow, 'a registered agent must produce a completed transition row');

    const events = readEventsJsonl(cwd);
    const agentStop = events.find(e => e.type === 'agent_stop');
    assert.equal(agentStop.lifecycle_registered, true);
  });

});

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — the `name:` case (W4's whole point)
// ---------------------------------------------------------------------------

describe('acceptance 2 — spawns using name: still resolve model_used', () => {

  test('a spawn whose SubagentStop carries a broken roster-name agent_type still resolves via registry', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-name-case');

    // PreToolUse: the PM's real Agent() call, model captured while it still exists.
    preSpawn(cwd, {
      model: 'claude-opus-5',
      subagent_type: 'developer',
      description: 'DEV-1 fix the thing',
    });

    // SubagentStart: Claude Code assigns an agent_id following the documented
    // named-spawn shape a<roster>-<16 hex> (design §3.2, verified 211/211).
    const namedAgentId = 'adev-opus5-0123456789abcdef';
    startAgent(cwd, namedAgentId, 'developer');

    // SubagentStop: this is the real-world defect (§2a) — the `name:` param
    // ("dev-opus5") has overwritten agent_type by the time this payload
    // arrives, exactly like the 135/166 unresolved rows in production.
    const { status } = stopAgent(cwd, namedAgentId, 'dev-opus5');
    assert.equal(status, 0);

    const events = readEventsJsonl(cwd);
    const agentStop = events.find(e => e.type === 'agent_stop');
    assert.ok(agentStop, 'agent_stop event must be emitted');

    // This is the assertion that fails against pre-W4 code: a join on
    // (orchestration_id, agent_type="dev-opus5") can never match a
    // routing_outcome row keyed by the canonical role "developer".
    assert.equal(agentStop.model_used, 'claude-opus-5', 'model must resolve despite the broken agent_type');
    assert.equal(agentStop.model_source, 'registry', 'resolution must come from the agent_id-keyed registry, not a type join');
    assert.equal(agentStop.lifecycle_registered, true);
  });

  test('control: without a registry entry, the same broken agent_type is unresolved', () => {
    // Proves the assertion above is not vacuous — with no registry row to
    // consult, a broken roster-name agent_type genuinely cannot resolve.
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-name-case-control');

    const { status } = stopAgent(cwd, 'a-unregistered-named-agent', 'dev-opus5-unregistered');
    assert.equal(status, 0);

    const events = readEventsJsonl(cwd);
    const agentStop = events.find(e => e.type === 'agent_stop');
    assert.notEqual(agentStop.model_source, 'registry');
    assert.ok(
      agentStop.model_used === null || agentStop.model_used === 'unknown_team_member',
      'an unregistered spawn with a non-canonical agent_type must not resolve a model'
    );
  });

});

// ---------------------------------------------------------------------------
// Acceptance criterion 3 — kill switch
// ---------------------------------------------------------------------------

describe('acceptance 3 — kill switch (ORCHESTRAY_DISABLE_AGENT_LIFECYCLE=1)', () => {

  test('no registry file is created and agent_stop field set reverts to pre-change shape', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-killswitch');
    const killEnv = { ORCHESTRAY_DISABLE_AGENT_LIFECYCLE: '1' };

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'developer' }, {}, killEnv);
    startAgent(cwd, 'a-killswitch-agent', 'developer', {}, killEnv);
    const { status } = stopAgent(cwd, 'a-killswitch-agent', 'developer', {}, killEnv);
    assert.equal(status, 0);

    assert.equal(fs.existsSync(registryPath(cwd)), false, 'no registry file may be created with the master switch on');

    const events = readEventsJsonl(cwd);
    const agentStop = events.find(e => e.type === 'agent_stop');
    assert.ok(agentStop, 'agent_stop must still be emitted with the kill switch on');
    assert.equal(agentStop.version, 1, 'version must NOT bump when the feature is disabled');
    for (const field of ['task_id', 'roster_name', 'model_source', 'lifecycle_registered']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(agentStop, field),
        false,
        'field "' + field + '" must be entirely absent with the kill switch on, not merely null'
      );
    }
  });

  test('control: the same sequence WITHOUT the kill switch does bump version and add fields', () => {
    // Proves the kill-switch test discriminates rather than passing for any input.
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-no-killswitch');

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'developer' });
    startAgent(cwd, 'a-no-killswitch-agent', 'developer');
    stopAgent(cwd, 'a-no-killswitch-agent', 'developer');

    const events = readEventsJsonl(cwd);
    const agentStop = events.find(e => e.type === 'agent_stop');
    assert.equal(agentStop.version, 2);
    assert.ok(Object.prototype.hasOwnProperty.call(agentStop, 'model_source'));
  });

  test('per-registry-only switch (ORCHESTRAY_AGENT_REGISTRY_DISABLED=1) also suppresses the registry file', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-registry-only-killswitch');
    const killEnv = { ORCHESTRAY_AGENT_REGISTRY_DISABLED: '1' };

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'developer' }, {}, killEnv);
    startAgent(cwd, 'a-registry-only-agent', 'developer', {}, killEnv);
    stopAgent(cwd, 'a-registry-only-agent', 'developer', {}, killEnv);

    assert.equal(fs.existsSync(registryPath(cwd)), false);
  });

});

// ---------------------------------------------------------------------------
// Regression — the extractSpawnTaskId crash bug found this session
// ---------------------------------------------------------------------------

describe('regression — gate-agent-spawn.js must not crash on the routing.jsonl path', () => {

  const GATE_SCRIPT = path.resolve(__dirname, '../gate-agent-spawn.js');

  function linkSchemas(dir) {
    const schemaDir = path.resolve(__dirname, '../../agents', 'pm-reference');
    const sandboxSchemaDir = path.join(dir, 'agents', 'pm-reference');
    fs.mkdirSync(sandboxSchemaDir, { recursive: true });
    for (const f of ['event-schemas.md', 'event-schemas.shadow.json']) {
      const src = path.join(schemaDir, f);
      const dst = path.join(sandboxSchemaDir, f);
      try { fs.symlinkSync(src, dst); } catch (_e) { try { fs.copyFileSync(src, dst); } catch (_e2) {} }
    }
  }

  test('a spawn with a description-embedded task_id and an existing routing.jsonl does not crash', () => {
    // extractSpawnTaskId is only reached on this code path (routing.jsonl
    // present). Before the fix, gate-agent-spawn.js called it without
    // requiring the module — a guaranteed ReferenceError at runtime,
    // silently swallowed by fail-open error handling. A crash there means
    // stdout is empty/malformed, not just exit 0 — assert BOTH.
    const cwd = makeTmpDir();
    linkSchemas(cwd);
    writeOrchestrationId(cwd, 'orch-gate-regression');

    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      JSON.stringify({
        timestamp: '2026-08-12T10:00:00.000Z',
        orchestration_id: 'orch-gate-regression',
        task_id: 'DEV-1',
        agent_type: 'developer',
        model: 'claude-sonnet-5',
      }) + '\n'
    );

    const { status, stdout, stderr } = run(GATE_SCRIPT, null, {
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        model: 'claude-sonnet-5',
        description: 'DEV-1 fix the thing',
      },
    });

    assert.equal(status, 0, 'must exit 0, not crash, on the routing.jsonl validation path');
    // The routing.jsonl entry matches (task_id, agent_type, model tier) exactly,
    // so this is a clean allow path -- the gate only writes to stdout on the
    // anti-pattern-advisory or block paths (see gate-agent-spawn.js:1580,
    // process.exit(0) with no stdout write), so an empty stdout here is the
    // documented allow shape, not evidence of a crash. The regression this
    // guards against is the ReferenceError from calling extractSpawnTaskId
    // without requiring _lib/spawn-task-id.js -- that would surface as a
    // "routing.jsonl validation error (extractSpawnTaskId is not defined)"
    // fail-open message on stderr even though the process still exits 0
    // (the call sites are wrapped in try/catch), so assert on stderr content
    // instead of stdout shape.
    assert.equal(stdout, '', 'clean allow path writes nothing to stdout');
    assert.ok(
      !/extractSpawnTaskId is not defined/.test(stderr) &&
      !/ReferenceError/.test(stderr),
      'must not fail open due to a ReferenceError on extractSpawnTaskId; stderr=' + stderr
    );
  });

});
