#!/usr/bin/env node
'use strict';

/**
 * LL6 regression tests: routing_decision merged event.
 *
 * Tests the correlation logic in bin/emit-routing-outcome.js (PostToolUse hook)
 * and bin/collect-agent-metrics.js (SubagentStop hook), the on-the-fly synthesis
 * in bin/mcp-server/tools/routing_lookup.js, and the completion_volume_ratio math.
 *
 * Correlation sequence (real production order):
 *   1. SubagentStop fires → collect-agent-metrics.js writes routing-pending.jsonl
 *      entry with stop-side data (agent_id, turns, tokens, result).
 *   2. PostToolUse:Agent fires → emit-routing-outcome.js reads routing-pending.jsonl,
 *      pops matching (orchestration_id, agent_type) entry, emits routing_decision.
 *
 * Test cases:
 *   1. Happy path: spawn + stop → one routing_decision with merged fields.
 *   2. Duplicate stop for same agent_id → only one routing_decision emitted (idempotency).
 *   3. Orphaned stop (no spawn) → no routing_decision; stop-only Variant C remains.
 *   4. Orphaned spawn (no stop) → no routing_decision; Variant A remains, no warning.
 *   5. routing_lookup synthesises merged rows from historical Variant A + C pairs.
 *   6. completion_volume_ratio math: output_tokens=5000 for sonnet → 5000/32768.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EMIT_SCRIPT = path.resolve(__dirname, '../bin/emit-routing-outcome.js');
const COLLECT_SCRIPT = path.resolve(__dirname, '../bin/collect-agent-metrics.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a temp project dir with the necessary sub-directories.
 * Writes current-orchestration.json if orchestrationId is provided.
 */
function makeTmpProject({ orchestrationId = 'orch-test-001' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ll6-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchestrationId })
  );
  return { dir, auditDir, stateDir };
}

/** Run emit-routing-outcome.js (PostToolUse hook) synchronously. */
function runEmit(payload) {
  return spawnSync(process.execPath, [EMIT_SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ORCHESTRAY_METRICS_DISABLED: '1' },
  });
}

/** Run collect-agent-metrics.js (SubagentStop hook) synchronously. */
function runCollect(payload) {
  return spawnSync(process.execPath, [COLLECT_SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ORCHESTRAY_METRICS_DISABLED: '1' },
  });
}

/** Read and parse all lines from events.jsonl. Returns [] if file absent. */
function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l));
}

/** Read and parse all lines from routing-pending.jsonl. Returns [] if absent. */
function readPending(stateDir) {
  const p = path.join(stateDir, 'routing-pending.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Simulate the production event sequence for one agent:
//   1. runCollect (SubagentStop) → writes pending entry + Variant C event
//   2. runEmit (PostToolUse:Agent) → reads pending, emits Variant A + routing_decision
// ---------------------------------------------------------------------------

function runFullCycle({ dir, orchestrationId = 'orch-test-001', agentId = 'agent-abc', agentType = 'developer', model = 'sonnet', description = 'Implement X', outputTokens = 5000, inputTokens = 10000, turnsUsed = 42 } = {}) {
  // Step 1: SubagentStop
  runCollect({
    hook_event_name: 'SubagentStop',
    cwd: dir,
    agent_id: agentId,
    agent_type: agentType,
    agent_transcript_path: null,
  });

  // Step 2: PostToolUse:Agent
  runEmit({
    tool_name: 'Agent',
    cwd: dir,
    tool_input: { model, subagent_type: agentType, description },
  });
}

// ---------------------------------------------------------------------------
// Case 1: Happy path — spawn + stop → one routing_decision with merged fields
// ---------------------------------------------------------------------------

describe('Case 1: happy path — spawn + stop → one routing_decision', () => {

  test('emits routing_decision with merged fields when stop precedes spawn hook', () => {
    const { dir, auditDir, stateDir } = makeTmpProject({ orchestrationId: 'orch-ll6-001' });

    // SubagentStop fires first (writes pending entry + Variant C)
    runCollect({
      hook_event_name: 'SubagentStop',
      cwd: dir,
      agent_id: 'agent-xyz',
      agent_type: 'developer',
      agent_transcript_path: null,
    });

    // Verify pending entry was written
    const pendingBefore = readPending(stateDir);
    assert.equal(pendingBefore.length, 1, 'pending entry must be written by SubagentStop');
    assert.equal(pendingBefore[0].orchestration_id, 'orch-ll6-001');
    assert.equal(pendingBefore[0].agent_type, 'developer');
    assert.equal(pendingBefore[0].agent_id, 'agent-xyz');

    // PostToolUse:Agent fires after (reads pending, emits Variant A + routing_decision)
    runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', subagent_type: 'developer', description: 'Implement feature Y' },
    });

    const events = readEvents(auditDir);
    const decisions = events.filter(e => e.type === 'routing_decision');
    assert.equal(decisions.length, 1, 'exactly one routing_decision must be emitted');

    const d = decisions[0];
    assert.equal(d.orchestration_id, 'orch-ll6-001');
    assert.equal(d.agent_id, 'agent-xyz', 'agent_id must come from the stop-side pending entry');
    assert.equal(d.agent_type, 'developer');
    assert.equal(d.model_assigned, 'sonnet', 'model_assigned must come from spawn-side');
    assert.equal(d.description, 'Implement feature Y', 'description must come from spawn-side');
    assert.ok(typeof d.turns_used === 'number', 'turns_used must be a number');
    assert.ok(typeof d.input_tokens === 'number', 'input_tokens must be a number');
    assert.ok(typeof d.output_tokens === 'number', 'output_tokens must be a number');
    assert.ok(d.result !== undefined, 'result must be present');
    assert.ok(typeof d.spawn_timestamp === 'string', 'spawn_timestamp must be present');
    assert.ok(typeof d.duration_ms === 'number' && d.duration_ms >= 0, 'duration_ms must be a non-negative number');
    assert.ok(!isNaN(Date.parse(d.timestamp)), 'timestamp must be valid ISO 8601');

    // Verify the legacy Variant A row is still present (not removed)
    const variantA = events.filter(e => e.type === 'routing_outcome' && e.source === 'hook');
    assert.equal(variantA.length, 1, 'Variant A routing_outcome must still be emitted');

    // Verify pending file was consumed (empty after merge)
    const pendingAfter = readPending(stateDir);
    assert.equal(pendingAfter.length, 0, 'pending entry must be removed after successful merge');
  });

});

// ---------------------------------------------------------------------------
// Case 2: Duplicate stop for same agent_id → idempotency (only one routing_decision)
// ---------------------------------------------------------------------------

describe('Case 2: duplicate stop — only one routing_decision emitted', () => {

  test('second SubagentStop for same agent_id produces a second pending entry but emit only merges once per pending', () => {
    const { dir, auditDir, stateDir } = makeTmpProject({ orchestrationId: 'orch-ll6-dup' });

    // Two SubagentStop events for same agent_id (shouldn't happen in prod, but test it)
    for (let i = 0; i < 2; i++) {
      runCollect({
        hook_event_name: 'SubagentStop',
        cwd: dir,
        agent_id: 'agent-dup',
        agent_type: 'reviewer',
        agent_transcript_path: null,
      });
    }

    // One PostToolUse:Agent — should consume the OLDEST pending entry only
    runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'opus', subagent_type: 'reviewer', description: 'Review PR' },
    });

    const events = readEvents(auditDir);
    const decisions = events.filter(e => e.type === 'routing_decision');
    // Only one routing_decision should be emitted per PostToolUse invocation
    assert.equal(decisions.length, 1, 'only one routing_decision must be emitted per PostToolUse invocation');
    assert.equal(decisions[0].agent_type, 'reviewer');
    assert.equal(decisions[0].model_assigned, 'opus');

    // One pending entry should remain (the second SubagentStop's entry was not consumed)
    const pendingAfter = readPending(stateDir);
    assert.equal(pendingAfter.length, 1, 'one unconsumed pending entry must remain');
  });

});

// ---------------------------------------------------------------------------
// Case 3: Orphaned stop (no spawn) → no routing_decision; Variant C remains
// ---------------------------------------------------------------------------

describe('Case 3: orphaned stop (no spawn hook) — no routing_decision', () => {

  test('SubagentStop without PostToolUse does not emit routing_decision', () => {
    const { dir, auditDir } = makeTmpProject({ orchestrationId: 'orch-ll6-orphan-stop' });

    // Only SubagentStop fires; no PostToolUse:Agent follows
    runCollect({
      hook_event_name: 'SubagentStop',
      cwd: dir,
      agent_id: 'agent-orphan-stop',
      agent_type: 'architect',
      agent_transcript_path: null,
    });

    const events = readEvents(auditDir);
    const decisions = events.filter(e => e.type === 'routing_decision');
    assert.equal(decisions.length, 0, 'no routing_decision must be emitted without PostToolUse');

    // Variant C routing_outcome must still be present (unaffected)
    const variantC = events.filter(e => e.type === 'routing_outcome' && e.source === 'subagent_stop');
    assert.ok(variantC.length >= 1, 'Variant C routing_outcome must still be emitted by SubagentStop');
  });

});

// ---------------------------------------------------------------------------
// Case 4: Orphaned spawn (no stop) → no routing_decision; no stderr warning
// ---------------------------------------------------------------------------

describe('Case 4: orphaned spawn (no SubagentStop) — no routing_decision, no warning', () => {

  test('PostToolUse without prior SubagentStop emits Variant A only, no routing_decision, no stderr warning', () => {
    const { dir, auditDir, stateDir } = makeTmpProject({ orchestrationId: 'orch-ll6-orphan-spawn' });

    // Only PostToolUse:Agent fires; SubagentStop never fired, so pending file is empty
    const result = runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'haiku', subagent_type: 'tester', description: 'Write tests' },
    });

    const events = readEvents(auditDir);
    const decisions = events.filter(e => e.type === 'routing_decision');
    assert.equal(decisions.length, 0, 'no routing_decision when no stop-side data is available');

    // Variant A must still be emitted
    const variantA = events.filter(e => e.type === 'routing_outcome' && e.source === 'hook');
    assert.equal(variantA.length, 1, 'Variant A routing_outcome must be emitted');

    // No "unmatched" warning in stderr for an orphaned spawn
    // (warning is only relevant for orphaned stop, which may arrive later)
    assert.ok(
      !result.stderr.includes('unmatched'),
      'no "unmatched" warning must be emitted for an orphaned spawn; got stderr: ' + result.stderr
    );
  });

});

// ---------------------------------------------------------------------------
// Case 5: routing_lookup synthesises merged rows from historical Variant A + C pairs
// ---------------------------------------------------------------------------

describe('Case 5: routing_lookup synthesises routing_decision from historical pairs', () => {

  test('synthesises routing_decision row from Variant A + Variant C pair in events.jsonl', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ll6-lookup-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Write a fixture events.jsonl with a Variant A and Variant C pair
    const variantA = {
      timestamp: '2026-04-15T10:00:00.000Z',
      type: 'routing_outcome',
      orchestration_id: 'orch-hist-001',
      agent_type: 'developer',
      tool_name: 'Agent',
      model_assigned: 'sonnet',
      effort_assigned: 'medium',
      description: 'Implement feature Z',
      score: null,
      source: 'hook',
    };
    const variantC = {
      timestamp: '2026-04-15T10:00:45.000Z',
      type: 'routing_outcome',
      orchestration_id: 'orch-hist-001',
      agent_type: 'developer',
      agent_id: 'agent-hist-001',
      model_assigned: 'sonnet',
      result: 'success',
      turns_used: 15,
      input_tokens: 8000,
      output_tokens: 3500,
      source: 'subagent_stop',
    };
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      [variantA, variantC].map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    // Call routing_lookup via the module directly (not via MCP RPC)
    const { handle } = require('../bin/mcp-server/tools/routing_lookup.js');
    const result = await handle(
      { orchestration_id: 'orch-hist-001' },
      { projectRoot: dir }
    );

    assert.ok(result && result.content, 'tool must return a result with content');
    const body = JSON.parse(result.content[0].text);
    assert.ok(body.matches, 'result must have matches array');

    const decisions = body.matches.filter(m => m.model_assigned || m.description);
    assert.ok(decisions.length >= 1, 'at least one synthesised routing_decision must be returned');

    // Find the synthesised row
    const synthesised = body.matches.find(m => m.synthesised === true);
    assert.ok(synthesised, 'a synthesised row must be present');
    assert.equal(synthesised.orchestration_id, 'orch-hist-001');
    assert.equal(synthesised.agent_type, 'developer');
    assert.equal(synthesised.model_assigned, 'sonnet');
    assert.equal(synthesised.description, 'Implement feature Z');
    assert.equal(synthesised.turns_used, 15);
    assert.equal(synthesised.output_tokens, 3500);
    assert.equal(synthesised.result, 'success');
    assert.equal(synthesised.merged, false, 'synthesised row must have merged:false');
    assert.equal(synthesised.synthesised, true);
  });

});

// ---------------------------------------------------------------------------
// Case 6: completion_volume_ratio math
// ---------------------------------------------------------------------------

describe('Case 6: completion_volume_ratio math', () => {

  test('output_tokens=5000, model=sonnet → ratio ≈ 5000/32768', () => {
    // The MODEL_OUTPUT_CAPS table in emit-routing-outcome.js sets sonnet cap to 32768.
    // completion_volume_ratio = round(5000/32768, 4 decimal places) = 0.1526
    const expected = Math.round((5000 / 32768) * 10000) / 10000; // 0.1526

    const { dir, auditDir } = makeTmpProject({ orchestrationId: 'orch-ll6-ratio' });

    // Simulate SubagentStop with 5000 output tokens.
    // Since we cannot inject exact token counts via transcript (no real transcript),
    // we use the events.jsonl fixture approach to test the lookup side.
    // For the emit side, write a mock pending entry directly.
    const stateDir = path.join(dir, '.orchestray', 'state');
    const pendingPath = path.join(stateDir, 'routing-pending.jsonl');
    const pendingEntry = {
      orchestration_id: 'orch-ll6-ratio',
      agent_id: 'agent-ratio-test',
      agent_type: 'developer',
      stop_timestamp: '2026-04-15T12:00:30.000Z',
      turns_used: 10,
      input_tokens: 8000,
      output_tokens: 5000,
      result: 'success',
    };
    fs.writeFileSync(pendingPath, JSON.stringify(pendingEntry) + '\n');

    // PostToolUse:Agent fires → reads pending, emits routing_decision
    runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', subagent_type: 'developer', description: 'Ratio test' },
    });

    const events = readEvents(auditDir);
    const decision = events.find(e => e.type === 'routing_decision');
    assert.ok(decision, 'routing_decision must be emitted');
    assert.equal(decision.output_tokens, 5000);
    assert.equal(decision.model_assigned, 'sonnet');
    assert.ok(typeof decision.completion_volume_ratio === 'number',
      'completion_volume_ratio must be a number');
    assert.equal(decision.completion_volume_ratio, expected,
      `completion_volume_ratio must equal ${expected} (5000/32768 rounded to 4 dp); got: ${decision.completion_volume_ratio}`);
  });

  test('output_tokens=0 → completion_volume_ratio is null', () => {
    const { dir, auditDir } = makeTmpProject({ orchestrationId: 'orch-ll6-zero-ratio' });
    const stateDir = path.join(dir, '.orchestray', 'state');
    const pendingPath = path.join(stateDir, 'routing-pending.jsonl');
    const pendingEntry = {
      orchestration_id: 'orch-ll6-zero-ratio',
      agent_id: 'agent-zero-ratio',
      agent_type: 'reviewer',
      stop_timestamp: '2026-04-15T12:00:00.000Z',
      turns_used: 0,
      input_tokens: 0,
      output_tokens: 0,
      result: 'error',
    };
    fs.writeFileSync(pendingPath, JSON.stringify(pendingEntry) + '\n');

    runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'opus', subagent_type: 'reviewer', description: 'Empty review' },
    });

    const events = readEvents(auditDir);
    const decision = events.find(e => e.type === 'routing_decision');
    assert.ok(decision, 'routing_decision must be emitted');
    assert.equal(decision.completion_volume_ratio, null,
      'completion_volume_ratio must be null when output_tokens is 0');
  });

  test('output_tokens=5000, unknown model → completion_volume_ratio is null', () => {
    const { dir, auditDir } = makeTmpProject({ orchestrationId: 'orch-ll6-unknown-model' });
    const stateDir = path.join(dir, '.orchestray', 'state');
    const pendingPath = path.join(stateDir, 'routing-pending.jsonl');
    const pendingEntry = {
      orchestration_id: 'orch-ll6-unknown-model',
      agent_id: 'agent-unk-model',
      agent_type: 'developer',
      stop_timestamp: '2026-04-15T12:00:00.000Z',
      turns_used: 5,
      input_tokens: 1000,
      output_tokens: 5000,
      result: 'success',
    };
    fs.writeFileSync(pendingPath, JSON.stringify(pendingEntry) + '\n');

    // No model specified → model_assigned will be null
    runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', description: 'Unknown model test' },
    });

    const events = readEvents(auditDir);
    const decision = events.find(e => e.type === 'routing_decision');
    assert.ok(decision, 'routing_decision must be emitted');
    assert.equal(decision.completion_volume_ratio, null,
      'completion_volume_ratio must be null when model is unknown');
  });

});

// ---------------------------------------------------------------------------
// Backward compatibility: existing routing_outcome events are not modified
// ---------------------------------------------------------------------------

describe('backward compatibility: existing routing_outcome events unchanged', () => {

  test('both Variant A and Variant C routing_outcome events are still emitted alongside routing_decision', () => {
    const { dir, auditDir, stateDir } = makeTmpProject({ orchestrationId: 'orch-ll6-compat' });

    // SubagentStop
    runCollect({
      hook_event_name: 'SubagentStop',
      cwd: dir,
      agent_id: 'agent-compat',
      agent_type: 'developer',
      agent_transcript_path: null,
    });

    // PostToolUse:Agent
    runEmit({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', subagent_type: 'developer', description: 'Compat check' },
    });

    const events = readEvents(auditDir);

    const variantA = events.filter(e => e.type === 'routing_outcome' && e.source === 'hook');
    assert.ok(variantA.length >= 1, 'Variant A routing_outcome must still be emitted');

    const variantC = events.filter(e => e.type === 'routing_outcome' && e.source === 'subagent_stop');
    assert.ok(variantC.length >= 1, 'Variant C routing_outcome must still be emitted');

    const decisions = events.filter(e => e.type === 'routing_decision');
    assert.ok(decisions.length >= 1, 'routing_decision must also be emitted');
  });

});
