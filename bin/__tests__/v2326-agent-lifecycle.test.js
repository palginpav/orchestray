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

// ---------------------------------------------------------------------------
// W5 (v2.3.28) — task_id resolves via routing.jsonl even when the
// description does not lead with a SCREAMING-CASE task-id token.
// ---------------------------------------------------------------------------

describe('W5 — task_id lands on the registry for non-conforming descriptions', () => {

  test('a description with no leading task-id token still resolves task_id via routing.jsonl match', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-w5');

    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // A routing row the PM wrote at decomposition time, keyed by task_id,
    // whose description does NOT start with a SCREAMING-CASE token --
    // exactly the real-world pattern this session diagnosed.
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      JSON.stringify({
        timestamp: '2026-08-12T10:00:00.000Z',
        orchestration_id: 'orch-w5',
        task_id: 'W5',
        agent_type: 'developer',
        description: 'Fix the thing (sonnet/medium)',
        model: 'sonnet',
      }) + '\n'
    );

    const { status } = preSpawn(cwd, {
      subagent_type: 'developer',
      model: 'claude-sonnet-5',
      description: 'Fix the thing (sonnet/medium)',
    });
    assert.equal(status, 0);

    const rows = readRegistryRows(cwd);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].task_id, 'W5',
      'task_id must be resolved from the routing.jsonl description match, not left null ' +
      'just because the description does not lead with a SCREAMING-CASE token'
    );
  });

  test('control: extractSpawnTaskId alone (no routing.jsonl) still returns null for the same description', () => {
    // Proves the fix is doing real work, not passing on a heuristic fluke.
    const { extractSpawnTaskId } = require('../_lib/spawn-task-id');
    assert.equal(extractSpawnTaskId({ description: 'Fix the thing (sonnet/medium)' }), null);
  });

});

// ---------------------------------------------------------------------------
// W5 follow-up (v2.3.28) — running/completed transitions also carry task_id,
// via matchPendingSpawn's binding when it succeeds and a routing.jsonl
// roster-name fallback when it does not (see spawn-task-id.js
// resolveTaskIdFromRoster doc).
// ---------------------------------------------------------------------------

describe('W5 follow-up — task_id on running and completed transitions', () => {

  test('a normal pre-spawn -> start -> stop sequence carries task_id onto running and completed', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-w5f-happy');

    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      JSON.stringify({
        timestamp: '2026-08-12T10:00:00.000Z',
        orchestration_id: 'orch-w5f-happy',
        task_id: 'W7',
        agent_type: 'developer',
        description: 'Wire task_id into running and completed',
        model: 'sonnet',
      }) + '\n'
    );

    preSpawn(cwd, {
      subagent_type: 'developer',
      model: 'claude-sonnet-5',
      description: 'Wire task_id into running and completed',
    });
    startAgent(cwd, 'aW7-259a3a66374e11e2', 'developer');
    stopAgent(cwd, 'aW7-259a3a66374e11e2', 'developer');

    const rows = readRegistryRows(cwd);
    assert.equal(rows.find(r => r.event === 'running').task_id, 'W7', 'running must inherit task_id from the matched registered row');
    assert.equal(rows.find(r => r.event === 'completed').task_id, 'W7', 'completed must inherit task_id from the registry row');
  });

  test('no matching pending row (registered was missed/TTL-expired): roster name resolves task_id via routing.jsonl', () => {
    // Simulates matchPendingSpawn finding nothing to bind (no pre-spawn call
    // at all here) -- the fallback must still land the correct task_id by
    // confirming the agent_id's roster label against routing.jsonl, exactly
    // the "name: <task-id>" convention this repo's own PM spawns use.
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-w5f-fallback');

    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      JSON.stringify({
        timestamp: '2026-08-12T10:00:00.000Z',
        orchestration_id: 'orch-w5f-fallback',
        task_id: 'W7',
        agent_type: 'developer',
        description: 'do the thing',
        model: 'sonnet',
      }) + '\n'
    );

    startAgent(cwd, 'aW7-259a3a66374e11e2', 'W7');
    stopAgent(cwd, 'aW7-259a3a66374e11e2', 'W7');

    const rows = readRegistryRows(cwd);
    assert.equal(rows.find(r => r.event === 'running').task_id, 'W7', 'running must resolve task_id from the roster-name fallback when no pending row matched');
    assert.equal(rows.find(r => r.event === 'completed').task_id, 'W7', 'completed must resolve task_id from the roster-name fallback when the registry row has none');
  });

  test('control: a roster name that is not a real routing.jsonl task_id is left null, and the hook still exits 0', () => {
    // Proves the fallback is confirmation-only -- it never invents an id,
    // and unresolved task_id must fail open rather than throw.
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-w5f-control');
    // No routing.jsonl at all.

    const { status: startStatus } = startAgent(cwd, 'adev-opus5-0123456789abcdef', 'dev-opus5');
    assert.equal(startStatus, 0);
    const { status: stopStatus } = stopAgent(cwd, 'adev-opus5-0123456789abcdef', 'dev-opus5');
    assert.equal(stopStatus, 0);

    const rows = readRegistryRows(cwd);
    assert.equal(rows.find(r => r.event === 'running').task_id, null);
    assert.equal(rows.find(r => r.event === 'completed').task_id, null);
  });

});

// ---------------------------------------------------------------------------
// agent_type namespace fix — running/completed must carry the canonical
// role, not the roster name, while roster_name keeps carrying the roster
// name (the defect described in .orchestray/kb/facts, v2.3.27 follow-up).
// ---------------------------------------------------------------------------

describe('agent_type namespace fix — running/completed carry the canonical role', () => {

  test('a roster-named spawn: running and completed record the canonical role in agent_type, and roster_name stays the roster name', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-agenttype-named');

    preSpawn(cwd, {
      subagent_type: 'developer',
      model: 'claude-sonnet-5',
      description: 'W7 fix the thing',
    });

    // SubagentStart/SubagentStop payloads carry the roster name in
    // agent_type ("W7"), exactly the real-world defect -- the registered
    // row above is the only place the canonical role ("developer") lives.
    startAgent(cwd, 'aW7-259a3a66374e11e3', 'W7');
    stopAgent(cwd, 'aW7-259a3a66374e11e3', 'W7');

    const rows = readRegistryRows(cwd);
    const registered = rows.find(r => r.event === 'registered');
    const running = rows.find(r => r.event === 'running');
    const completed = rows.find(r => r.event === 'completed');

    assert.equal(registered.agent_type, 'developer', 'registered row is unchanged (already correct)');
    assert.equal(registered.roster_name, null, 'registered row never carries roster_name');

    assert.equal(running.agent_type, 'developer', 'running must carry the canonical role, not the roster name');
    assert.equal(running.roster_name, 'W7', 'running must still carry the roster name in roster_name');

    assert.equal(completed.agent_type, 'developer', 'completed must carry the canonical role, not the roster name');
    assert.equal(completed.roster_name, 'W7', 'completed must still carry the roster name in roster_name');
  });

  test('an unnamed spawn: agent_type is unaffected (no roster name in play) and roster_name is null', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-agenttype-unnamed');

    preSpawn(cwd, {
      subagent_type: 'reviewer',
      model: 'claude-sonnet-5',
      description: 'plain unnamed spawn',
    });

    const plainAgentId = 'a0123456789abcdef0123456789abcd';
    startAgent(cwd, plainAgentId, 'reviewer');
    stopAgent(cwd, plainAgentId, 'reviewer');

    const rows = readRegistryRows(cwd);
    const running = rows.find(r => r.event === 'running');
    const completed = rows.find(r => r.event === 'completed');

    assert.equal(running.agent_type, 'reviewer');
    assert.equal(running.roster_name, null);
    assert.equal(completed.agent_type, 'reviewer');
    assert.equal(completed.roster_name, null);
  });

  test('fail-open: no registered row to recover the canonical role from -- running/completed still write, falling back to the payload value instead of throwing', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-agenttype-failopen');
    // No preSpawn call at all -- matchPendingSpawn/registryRow lookups have
    // nothing to bind to, so there is no canonical role to recover.

    const agentId = 'aW9-259a3a66374e11e4';
    const { status: startStatus } = startAgent(cwd, agentId, 'W9');
    assert.equal(startStatus, 0, 'start must exit 0 even with no canonical role to resolve');
    const { status: stopStatus } = stopAgent(cwd, agentId, 'W9');
    assert.equal(stopStatus, 0, 'stop must exit 0 even with no canonical role to resolve');

    const rows = readRegistryRows(cwd);
    const running = rows.find(r => r.event === 'running');
    const completed = rows.find(r => r.event === 'completed');
    assert.ok(running, 'running row must still be written when the canonical role cannot be resolved');
    assert.ok(completed, 'completed row must still be written when the canonical role cannot be resolved');
    // Fail-open: falls back to today's (imperfect) payload value rather than
    // inventing a role or dropping the row.
    assert.equal(running.agent_type, 'W9');
    assert.equal(completed.agent_type, 'W9');
  });

});
