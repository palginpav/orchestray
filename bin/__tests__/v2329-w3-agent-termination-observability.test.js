#!/usr/bin/env node
'use strict';

/**
 * v2329-w3-agent-termination-observability.test.js — coverage for the three
 * coupled fixes described in
 * `.orchestray/kb/artifacts/v2329-w3-turn-budget-diagnosis.md` Finding 4:
 *
 *   A. `result_status` populated on the `completed` transition from the
 *      agent's Structured Result `status`, with a distinct sentinel
 *      (`no_structured_result`) when no block is found — never `null`.
 *   B. A missing Structured Result is detected at SubagentStop and emitted
 *      as an `agent_missing_structured_result` audit event.
 *   C. `reconciled_orphan` sweep — registry rows stuck at `running` past a
 *      quiescence threshold get reconciled; recently-active rows do not.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REGISTER_SCRIPT = path.resolve(__dirname, '../register-agent-spawn.js');
const METRICS_SCRIPT = path.resolve(__dirname, '../collect-agent-metrics.js');
const { registryPath, appendTransition } = require('../_lib/agent-registry');
const { sweepOrphanedAgents, ORPHAN_QUIESCENCE_MS, ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS } = require('../_lib/orphan-agent-sweep');
const { encodeProjectPath } = require('../_lib/path-containment');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-termobs-test-'));
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

function preSpawn(cwd, toolInput) {
  return run(REGISTER_SCRIPT, 'pre-spawn', {
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'tu-' + Math.random().toString(36).slice(2),
    tool_input: toolInput,
    session_id: 'sess-1',
  });
}

function startAgent(cwd, agentId, agentType) {
  return run(REGISTER_SCRIPT, 'start', {
    cwd,
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
    session_id: 'sess-1',
  });
}

function stopAgent(cwd, agentId, agentType, transcriptPath) {
  return run(METRICS_SCRIPT, null, {
    cwd,
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: agentType,
    session_id: 'sess-1',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'Task complete.',
  });
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

function writeTranscriptWithStructuredResult(transcriptPath, status) {
  const sr = {
    status,
    summary: 'test summary',
    files_changed: ['foo.js'],
    files_read: ['foo.js'],
    issues: [],
    assumptions: [],
  };
  const text = 'Done.\n\n## Structured Result\n```json\n' + JSON.stringify(sr) + '\n```\n';
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n');
}

// ---------------------------------------------------------------------------
// Fix A — result_status
// ---------------------------------------------------------------------------

describe('Fix A — result_status populated from Structured Result', () => {

  for (const status of ['success', 'partial', 'failure']) {
    test('status "' + status + '" propagates onto the completed registry row', () => {
      const cwd = makeTmpDir();
      writeOrchestrationId(cwd, 'orch-resultstatus-' + status);

      const transcriptPath = path.join(cwd, 'transcript.jsonl');
      writeTranscriptWithStructuredResult(transcriptPath, status);

      preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'developer', description: 'DEV-1 build the thing' });
      startAgent(cwd, 'a-result-' + status, 'developer');
      const { status: exitCode } = stopAgent(cwd, 'a-result-' + status, 'developer', transcriptPath);
      assert.equal(exitCode, 0);

      const rows = readRegistryRows(cwd);
      const completedRow = rows.find(r => r.agent_id === 'a-result-' + status && r.event === 'completed');
      assert.ok(completedRow, 'expected a completed row');
      assert.equal(completedRow.result_status, status);
    });
  }

  test('a transcript with NO Structured Result yields the distinct sentinel, not null', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-resultstatus-missing');

    const transcriptPath = path.join(cwd, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I forgot to emit a result.' }] },
    }) + '\n');

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'documenter', description: 'W10 append a section' });
    startAgent(cwd, 'a-no-result', 'documenter');
    const { status: exitCode } = stopAgent(cwd, 'a-no-result', 'documenter', transcriptPath);
    assert.equal(exitCode, 0);

    const rows = readRegistryRows(cwd);
    const completedRow = rows.find(r => r.agent_id === 'a-no-result' && r.event === 'completed');
    assert.ok(completedRow, 'expected a completed row');
    assert.notEqual(completedRow.result_status, null, 'must not collapse to null');
    assert.equal(completedRow.result_status, 'no_structured_result');
  });

});

// ---------------------------------------------------------------------------
// Fix B — missing-Structured-Result detection at SubagentStop
// ---------------------------------------------------------------------------

describe('Fix B — agent_missing_structured_result observability event', () => {

  test('fires when the transcript has no Structured Result block', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-missing-fires');

    const transcriptPath = path.join(cwd, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'no result here' }] },
    }) + '\n');

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'documenter', description: 'W10 append a section' });
    startAgent(cwd, 'a-missing-fires', 'documenter');
    stopAgent(cwd, 'a-missing-fires', 'documenter', transcriptPath);

    const events = readEventsJsonl(cwd);
    const missing = events.find(e => e.type === 'agent_missing_structured_result' && e.agent_id === 'a-missing-fires');
    assert.ok(missing, 'expected agent_missing_structured_result to be emitted');
    assert.equal(missing.transcript_path, transcriptPath);

    // The work record itself must still be written — a missing result must
    // never destroy the agent_stop / completed rows.
    const agentStop = events.find(e => e.type === 'agent_stop' && e.agent_id === 'a-missing-fires');
    assert.ok(agentStop, 'agent_stop must still be written');
    const rows = readRegistryRows(cwd);
    assert.ok(rows.find(r => r.agent_id === 'a-missing-fires' && r.event === 'completed'), 'completed row must still be written');
  });

  test('does NOT fire when the transcript has a valid Structured Result', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-missing-does-not-fire');

    const transcriptPath = path.join(cwd, 'transcript.jsonl');
    writeTranscriptWithStructuredResult(transcriptPath, 'success');

    preSpawn(cwd, { model: 'claude-sonnet-5', subagent_type: 'developer', description: 'DEV-2 build the thing' });
    startAgent(cwd, 'a-missing-absent', 'developer');
    stopAgent(cwd, 'a-missing-absent', 'developer', transcriptPath);

    const events = readEventsJsonl(cwd);
    const missing = events.find(e => e.type === 'agent_missing_structured_result' && e.agent_id === 'a-missing-absent');
    assert.equal(missing, undefined, 'must not fire when a Structured Result was found');
  });

});

// ---------------------------------------------------------------------------
// Fix C — reconciled_orphan sweep
// ---------------------------------------------------------------------------

describe('Fix C — orphan-agent-sweep reconciles genuinely stranded rows only', () => {

  function backdateFile(filePath, msAgo) {
    const t = new Date(Date.now() - msAgo);
    fs.utimesSync(filePath, t, t);
  }

  function writeRunningRow(cwd, opts) {
    appendTransition(cwd, Object.assign({
      event: 'running',
      orchestration_id: 'orch-orphan-sweep',
      agent_type: 'documenter',
      task_id: 'W10',
      model: 'claude-sonnet-5',
      effort: null,
      session_id: 'sess-1',
      spawn_key: null,
      spawn_tool: 'Agent',
      description: 'append a section',
      turns_used: null,
      estimated_cost_usd: null,
      result_status: null,
      hold_for_resume: null,
      resume_count: 0,
      reason: null,
    }, opts));
  }

  test('a row stuck at running past the threshold, with a quiescent transcript, reconciles', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const transcriptPath = path.join(cwd, 'stranded-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'partial work' }) + '\n');
    backdateFile(transcriptPath, ORPHAN_QUIESCENCE_MS + 60000);

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: 'a-stranded-orphan', transcript_path: transcriptPath, ts: oldTs });

    const result = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(result.reconciled, 1, 'expected exactly one reconciliation');

    const rows = readRegistryRows(cwd);
    const orphanRow = rows.find(r => r.agent_id === 'a-stranded-orphan' && r.event === 'reconciled_orphan');
    assert.ok(orphanRow, 'expected a reconciled_orphan transition row');
    assert.equal(orphanRow.turns_used, null, 'turns must be unavailable, not inferred/zeroed');
    assert.equal(orphanRow.estimated_cost_usd, null, 'cost must be unavailable, not inferred/zeroed');
    assert.equal(orphanRow.result_status, 'unavailable_orphaned');

    const events = readEventsJsonl(cwd);
    const reconciledEvent = events.find(e => e.type === 'agent_orphan_reconciled' && e.agent_id === 'a-stranded-orphan');
    assert.ok(reconciledEvent, 'expected an agent_orphan_reconciled audit event');
  });

  test('a recently-active running row is NOT reconciled (the guard that matters most)', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const transcriptPath = path.join(cwd, 'active-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'still working' }) + '\n');
    // No backdate — mtime is "now": an agent that is still actively writing.

    const recentTs = new Date().toISOString();
    writeRunningRow(cwd, { agent_id: 'a-still-alive', transcript_path: transcriptPath, ts: recentTs });

    const result = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(result.reconciled, 0, 'a live agent must never be reconciled as an orphan');

    const rows = readRegistryRows(cwd);
    assert.equal(rows.find(r => r.agent_id === 'a-still-alive' && r.event === 'reconciled_orphan'), undefined);
  });

  test('registry row is old but transcript was recently touched → NOT reconciled', () => {
    // Covers the case dirty-worktree-sweep's own doc calls out: the row's own
    // ts is stale (SubagentStart happened a while ago) but the agent is still
    // demonstrably alive because its transcript is still being written.
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const transcriptPath = path.join(cwd, 'long-running-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'still working, slow task' }) + '\n');
    // Fresh mtime — actively being written right now.

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: 'a-slow-but-alive', transcript_path: transcriptPath, ts: oldTs });

    const result = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(result.reconciled, 0, 'transcript activity must override the stale registry-row timestamp');
  });

  test('a row with no transcript_path at all is skipped (no corroborating liveness signal)', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: 'a-no-transcript', transcript_path: null, ts: oldTs });

    const result = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(result.reconciled, 0, 'fails toward not-quiescent when there is no way to verify death');
  });

  test('PRODUCTION DEFECT REGRESSION: a running row with transcript_path:null (as register-agent-spawn.js '
    + 'actually writes it — event.agent_transcript_path is not populated on the real SubagentStart payload) '
    + 'reconciles once its DERIVED transcript path is genuinely stale', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    // Simulate the on-disk layout `subagent-janitor.js`'s runJanitor (and now
    // this sweep) derive deterministically: <home>/.claude/projects/-<encoded-cwd>/<session>/subagents/agent-<id>.jsonl
    const fakeHome = makeTmpDir();
    const sessionId = 'sess-derived-1';
    const agentId = 'a-derived-orphan';
    const subagentsDir = path.join(fakeHome, '.claude', 'projects', '-' + encodeProjectPath(cwd), sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const derivedTranscriptPath = path.join(subagentsDir, 'agent-' + agentId + '.jsonl');
    fs.writeFileSync(derivedTranscriptPath, JSON.stringify({ role: 'assistant', content: 'partial work' }) + '\n');
    backdateFile(derivedTranscriptPath, ORPHAN_QUIESCENCE_MS + 60000);

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    // transcript_path: null — exactly what production writes (this is the regression this test guards).
    writeRunningRow(cwd, { agent_id: agentId, session_id: sessionId, transcript_path: null, ts: oldTs });

    const result = sweepOrphanedAgents(cwd, { force: true, homeDir: fakeHome });
    assert.equal(result.reconciled, 1, 'a null transcript_path must not block reconciliation once the derived path is stale');

    const rows = readRegistryRows(cwd);
    const orphanRow = rows.find(r => r.agent_id === agentId && r.event === 'reconciled_orphan');
    assert.ok(orphanRow, 'expected a reconciled_orphan transition row');
    assert.equal(orphanRow.turns_used, null);
    assert.equal(orphanRow.estimated_cost_usd, null);
    assert.match(orphanRow.reason, /liveness signal=derived_transcript_path/);
  });

  test('PRODUCTION DEFECT REGRESSION (negative): a running row with transcript_path:null and a FRESH derived '
    + 'transcript is NOT reconciled — the safety property survives the derivation change', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const fakeHome = makeTmpDir();
    const sessionId = 'sess-derived-2';
    const agentId = 'a-derived-alive';
    const subagentsDir = path.join(fakeHome, '.claude', 'projects', '-' + encodeProjectPath(cwd), sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const derivedTranscriptPath = path.join(subagentsDir, 'agent-' + agentId + '.jsonl');
    fs.writeFileSync(derivedTranscriptPath, JSON.stringify({ role: 'assistant', content: 'still working' }) + '\n');
    // No backdate — mtime is "now": the agent is still actively writing.

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: agentId, session_id: sessionId, transcript_path: null, ts: oldTs });

    const result = sweepOrphanedAgents(cwd, { force: true, homeDir: fakeHome });
    assert.equal(result.reconciled, 0, 'a live agent must never be reconciled, even via the derived-path signal');
  });

  test('no-transcript-at-all fallback: a row with NO transcript signal (row nor derived) DOES eventually '
    + 'reconcile once past the longer ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS window — "safe" must not mean "never fires"', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const fakeHome = makeTmpDir(); // empty — no subagents dir at all for this session/agent.
    const veryOldTs = new Date(Date.now() - (ORPHAN_NO_TRANSCRIPT_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: 'a-no-signal-ever', session_id: 'sess-none', transcript_path: null, ts: veryOldTs });

    const result = sweepOrphanedAgents(cwd, { force: true, homeDir: fakeHome });
    assert.equal(result.reconciled, 1, 'a row with no corroborating signal at all must still reconcile eventually');

    const rows = readRegistryRows(cwd);
    const orphanRow = rows.find(r => r.agent_id === 'a-no-signal-ever' && r.event === 'reconciled_orphan');
    assert.ok(orphanRow);
    assert.match(orphanRow.reason, /registry-timestamp-only fallback/);
  });

  test('debounce: a second sweep within MIN_SWEEP_INTERVAL_MS is a no-op', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const transcriptPath = path.join(cwd, 'debounce-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'x' }) + '\n');
    backdateFile(transcriptPath, ORPHAN_QUIESCENCE_MS + 60000);

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: 'a-debounce', transcript_path: transcriptPath, ts: oldTs });

    const r1 = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(r1.ran, true);

    const r2 = sweepOrphanedAgents(cwd, {});
    assert.equal(r2.ran, false, 'debounced sweep must not run at all');
  });

  test('re-sweep after reconciliation does not duplicate the reconciled_orphan row', () => {
    const cwd = makeTmpDir();
    writeOrchestrationId(cwd, 'orch-orphan-sweep');

    const transcriptPath = path.join(cwd, 're-sweep-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'x' }) + '\n');
    backdateFile(transcriptPath, ORPHAN_QUIESCENCE_MS + 60000);

    const oldTs = new Date(Date.now() - (ORPHAN_QUIESCENCE_MS + 60000)).toISOString();
    writeRunningRow(cwd, { agent_id: 'a-resweep', transcript_path: transcriptPath, ts: oldTs });

    const r1 = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(r1.reconciled, 1);

    const r2 = sweepOrphanedAgents(cwd, { force: true });
    assert.equal(r2.reconciled, 0, 'the row is now terminal in the fold; nothing left to reconcile');
  });

});
