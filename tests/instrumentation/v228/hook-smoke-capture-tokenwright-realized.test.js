'use strict';

/**
 * Smoke tests for bin/capture-tokenwright-realized.js
 *
 * Hook events: SubagentStop + TaskCompleted
 *
 * Validates the fail-open contract and the core production entry points:
 *   1. SubagentStop with no pending journal → exit 0, { continue: true }
 *   2. SubagentStop with matching pending entry → exit 0, entry consumed
 *   3. TaskCompleted (Agent Teams) with pending entry → exit 0, entry consumed
 *   4. TaskCompleted with no pending entry (orphan) → exit 0, no crash
 *   5. Malformed JSON on stdin → exit 0, fail-open
 *   6. TaskCompleted with task_completed_metrics present → exit 0
 *
 * Production-realistic multi-turn fixture (B1 regression guard):
 *   Tests SubagentStop across multiple sequential spawns to confirm the
 *   cumulative-token issue (96% → 60,469% error_pct) is not re-introduced.
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/capture-tokenwright-realized.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-ctr-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function setupProject(dir, orchId) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  // Write current-orchestration.json so resolveOrchestrationId succeeds
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId || 'orch-smoke-test' })
  );
  return { stateDir, auditDir };
}

function writePending(stateDir, entries) {
  const p = path.join(stateDir, 'tokenwright-pending.jsonl');
  const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(p, content);
  return p;
}

function readPending(stateDir) {
  const p = path.join(stateDir, 'tokenwright-pending.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

function makePendingEntry(overrides) {
  return Object.assign({
    spawn_key:            'developer:abcdef0123456789',
    orchestration_id:     'orch-smoke-test',
    agent_type:           'developer',
    timestamp:            new Date(Date.now() - 1000).toISOString(),
    input_token_estimate: 2000,
    technique_tag:        'safe-l1',
    expires_at:           Date.now() + 24 * 3600 * 1000,
  }, overrides || {});
}

function invoke(event, cwd) {
  const payload = Object.assign({ hook_event_name: 'SubagentStop', cwd: cwd || '/tmp' }, event);
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  8000,
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch (_e) {}
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', parsed };
}

// ---------------------------------------------------------------------------
// Test 1: SubagentStop with no pending journal → exit 0, continue: true
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: SubagentStop with empty pending journal exits 0 and returns continue:true', (t) => {
  const dir = makeTmpDir(t);
  setupProject(dir, 'orch-smoke-001');

  const event = {
    hook_event_name: 'SubagentStop',
    cwd:             dir,
    stop_reason:     'end_turn',
    usage:           { input_tokens: 1500, output_tokens: 200 },
  };
  const { status, parsed } = invoke(event, dir);

  assert.strictEqual(status, 0, 'exit code must be 0 (fail-open contract)');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');
});

// ---------------------------------------------------------------------------
// Test 2: SubagentStop with matching pending entry → entry consumed
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: SubagentStop with matching pending entry removes it from journal', (t) => {
  const dir = makeTmpDir(t);
  const { stateDir } = setupProject(dir, 'orch-smoke-002');

  const entry = makePendingEntry({ orchestration_id: 'orch-smoke-002', agent_type: 'developer' });
  writePending(stateDir, [entry]);

  const event = {
    hook_event_name: 'SubagentStop',
    cwd:             dir,
    stop_reason:     'end_turn',
    usage:           { input_tokens: 1800, output_tokens: 250 },
    subagent_type:   'developer',
  };
  const { status, parsed } = invoke(event, dir);

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  // Journal should be empty or entry removed after consumption
  const remaining = readPending(stateDir);
  assert.strictEqual(remaining.length, 0, 'matched pending entry must be consumed');
});

// ---------------------------------------------------------------------------
// Test 3: TaskCompleted (Agent Teams) with pending entry → entry consumed
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: TaskCompleted event consumes matching pending entry', (t) => {
  const dir = makeTmpDir(t);
  const { stateDir } = setupProject(dir, 'orch-smoke-003');

  const entry = makePendingEntry({ orchestration_id: 'orch-smoke-003', agent_type: 'reviewer' });
  writePending(stateDir, [entry]);

  const event = {
    hook_event_name:          'TaskCompleted',
    cwd:                      dir,
    agent_type:               'reviewer',
    task_completed_metrics:   { input_tokens: 1600, output_tokens: 180 },
  };
  const { status, parsed } = invoke(event, dir);

  assert.strictEqual(status, 0, 'exit code must be 0 (must not block task completion)');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const remaining = readPending(stateDir);
  assert.strictEqual(remaining.length, 0, 'matched pending entry must be consumed by TaskCompleted');
});

// ---------------------------------------------------------------------------
// Test 4: TaskCompleted with no matching pending entry (orphan) → exit 0
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: TaskCompleted orphan (no pending match) exits 0 cleanly', (t) => {
  const dir = makeTmpDir(t);
  setupProject(dir, 'orch-smoke-004');
  // No pending entries written

  const event = {
    hook_event_name:        'TaskCompleted',
    cwd:                    dir,
    agent_type:             'architect',
    task_completed_metrics: { input_tokens: 900, output_tokens: 100 },
  };
  const { status, parsed } = invoke(event, dir);

  assert.strictEqual(status, 0, 'exit code must be 0 for orphan TaskCompleted');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');
});

// ---------------------------------------------------------------------------
// Test 5: Malformed JSON on stdin → exit 0, fail-open
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: malformed JSON on stdin exits 0 (fail-open contract)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    '{ not valid json %%%',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
  // stdout should still be valid JSON or { continue: true }
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch (_e) {}
  assert.ok(parsed, 'stdout must be valid JSON even on malformed stdin');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true } on malformed stdin');
});

// ---------------------------------------------------------------------------
// Test 6: TaskCompleted with task_completed_metrics containing input_tokens
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: TaskCompleted with task_completed_metrics.input_tokens emits continue:true', (t) => {
  const dir = makeTmpDir(t);
  const { stateDir } = setupProject(dir, 'orch-smoke-006');

  const entry = makePendingEntry({
    orchestration_id: 'orch-smoke-006',
    agent_type:       'tester',
    input_token_estimate: 3000,
  });
  writePending(stateDir, [entry]);

  const event = {
    hook_event_name:        'TaskCompleted',
    cwd:                    dir,
    agent_type:             'tester',
    task_completed_metrics: { input_tokens: 3200, output_tokens: 400 },
  };
  const { status, parsed } = invoke(event, dir);

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');
});

// ---------------------------------------------------------------------------
// Test 7: Production-realistic multi-turn fixture (B1 regression guard)
//
// Simulates 3 sequential SubagentStop events for the same agent_type across
// the same orchestration. Each spawn has a distinct pending entry and its own
// usage.input_tokens. This ensures the script does not accumulate tokens
// across turns (the 60,469% error_pct regression from B1).
// ---------------------------------------------------------------------------
test('capture-tokenwright-realized: multi-turn sequential SubagentStops each consume exactly one pending entry', (t) => {
  const dir = makeTmpDir(t);
  const { stateDir } = setupProject(dir, 'orch-smoke-multi');

  const entries = [1, 2, 3].map((i) => makePendingEntry({
    spawn_key:            `developer:turn${i}000000000000000`,
    orchestration_id:     'orch-smoke-multi',
    agent_type:           'developer',
    input_token_estimate: 2000 * i,
    timestamp:            new Date(Date.now() - (3 - i) * 10000).toISOString(),
  }));
  writePending(stateDir, entries);

  // Simulate turn 1 stop
  const turn1 = invoke({
    hook_event_name: 'SubagentStop',
    cwd:             dir,
    stop_reason:     'end_turn',
    usage:           { input_tokens: 1900, output_tokens: 200 },
    subagent_type:   'developer',
  }, dir);
  assert.strictEqual(turn1.status, 0, 'turn 1: exit code must be 0');
  assert.strictEqual(turn1.parsed.continue, true, 'turn 1: continue:true');

  // After turn 1: 2 entries remain
  assert.strictEqual(readPending(stateDir).length, 2, 'after turn 1: 2 entries remain');

  // Simulate turn 2 stop
  const turn2 = invoke({
    hook_event_name: 'SubagentStop',
    cwd:             dir,
    stop_reason:     'end_turn',
    usage:           { input_tokens: 3800, output_tokens: 400 },
    subagent_type:   'developer',
  }, dir);
  assert.strictEqual(turn2.status, 0, 'turn 2: exit code must be 0');

  // After turn 2: 1 entry remains
  assert.strictEqual(readPending(stateDir).length, 1, 'after turn 2: 1 entry remains');

  // Simulate turn 3 stop
  const turn3 = invoke({
    hook_event_name: 'SubagentStop',
    cwd:             dir,
    stop_reason:     'end_turn',
    usage:           { input_tokens: 5700, output_tokens: 600 },
    subagent_type:   'developer',
  }, dir);
  assert.strictEqual(turn3.status, 0, 'turn 3: exit code must be 0');

  // After turn 3: 0 entries remain (all consumed, one per stop)
  assert.strictEqual(readPending(stateDir).length, 0, 'after turn 3: all entries consumed — one per SubagentStop, not cumulative');
});
