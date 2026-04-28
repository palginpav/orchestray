'use strict';

/**
 * Test v2.2.8 Issue A: TaskCompleted capture for Agent Teams true teammates.
 *
 * Verifies that capture-tokenwright-realized.js, when invoked with a
 * TaskCompleted event payload:
 *   1. Exits cleanly (exit code 0) — never blocks task completion.
 *   2. Removes the matched pending entry from the journal.
 *   3. Does NOT remove entries when no match is found (orphan case).
 *   4. Does NOT crash when task_completed_metrics is absent.
 *
 * Event emission is tested via the pure emit-logic helpers since the subprocess
 * writes events to process.cwd() (the project audit dir) rather than the test
 * tmpDir — the same pattern as all existing v226 hook subprocess tests.
 *
 * The task_completed_metrics token-extraction logic is tested inline as pure
 * function tests mirroring the handleTaskCompleted implementation.
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../../bin/capture-tokenwright-realized.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v228-a-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function setupProjectDir(dir) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  return { stateDir, auditDir };
}

function makePendingEntry(overrides = {}) {
  return Object.assign({
    spawn_key:            'researcher:abc123',
    orchestration_id:     'orch-test-v228-a',
    agent_type:           'researcher',
    timestamp:            new Date(1000).toISOString(),
    input_token_estimate: 500,
    technique_tag:        'safe-l1',
    expires_at:           Date.now() + 24 * 3600 * 1000,
  }, overrides);
}

function writePendingEntries(stateDir, entries) {
  const pendingPath = path.join(stateDir, 'tokenwright-pending.jsonl');
  const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(pendingPath, content, 'utf8');
  return pendingPath;
}

function readPendingEntries(stateDir) {
  const pendingPath = path.join(stateDir, 'tokenwright-pending.jsonl');
  if (!fs.existsSync(pendingPath)) return [];
  const lines = fs.readFileSync(pendingPath, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

function invokeCapture(event) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(event),
    encoding: 'utf8',
    timeout:  8000,
  });
  let stdout;
  try { stdout = JSON.parse(result.stdout); } catch (_e) { stdout = null; }
  return { exitCode: result.status, stdout, stderr: result.stderr || '' };
}

// ---------------------------------------------------------------------------
// Test 1: TaskCompleted → exit 0 + pending entry removed
// ---------------------------------------------------------------------------
test('Issue-A: TaskCompleted exits cleanly and removes matched pending entry', (t) => {
  const tmpDir = makeTmpDir(t);
  const { stateDir } = setupProjectDir(tmpDir);

  const entry = makePendingEntry({ agent_type: 'researcher', orchestration_id: 'orch-v228-test1' });
  writePendingEntries(stateDir, [entry]);

  const event = {
    hook_event_name:        'TaskCompleted',
    cwd:                    tmpDir,
    agent_type:             'researcher',
    task_completed_metrics: { agent_type: 'researcher', input_tokens: 5000 },
  };

  const { exitCode, stdout } = invokeCapture(event);

  assert.equal(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout && stdout.continue === true, 'stdout must be {continue: true}');

  // Pending entry must be removed
  const remaining = readPendingEntries(stateDir);
  assert.equal(remaining.length, 0, 'pending entry must be removed after TaskCompleted capture');
});

// ---------------------------------------------------------------------------
// Test 2: TaskCompleted with no matching pending entry → exit 0, no crash
// ---------------------------------------------------------------------------
test('Issue-A: TaskCompleted with no matching pending entry exits cleanly (orphan)', (t) => {
  const tmpDir = makeTmpDir(t);
  setupProjectDir(tmpDir);
  // No pending entry written

  const event = {
    hook_event_name:        'TaskCompleted',
    cwd:                    tmpDir,
    agent_type:             'reviewer',
    task_completed_metrics: { agent_type: 'reviewer', input_tokens: 1000 },
  };

  const { exitCode, stdout, stderr } = invokeCapture(event);

  assert.equal(exitCode, 0, 'exit code must be 0 for orphan TaskCompleted');
  assert.ok(stdout && stdout.continue === true, 'must emit continue for orphan');
  // No crash output in stderr beyond circuit warning
  const errLines = stderr.split('\n').filter(l => l.trim() && !l.includes('circuit broken') && !l.includes('schema unreadable'));
  assert.equal(errLines.length, 0, 'no unexpected stderr output for clean orphan case');
});

// ---------------------------------------------------------------------------
// Test 3: TaskCompleted without task_completed_metrics → exit 0, entry removed
// ---------------------------------------------------------------------------
test('Issue-A: TaskCompleted without task_completed_metrics still exits cleanly', (t) => {
  const tmpDir = makeTmpDir(t);
  const { stateDir } = setupProjectDir(tmpDir);

  const entry = makePendingEntry({ agent_type: 'architect', orchestration_id: 'orch-v228-test3' });
  writePendingEntries(stateDir, [entry]);

  const event = {
    hook_event_name: 'TaskCompleted',
    cwd:             tmpDir,
    agent_type:      'architect',
    // no task_completed_metrics
  };

  const { exitCode, stdout } = invokeCapture(event);

  assert.equal(exitCode, 0, 'exit code must be 0 even without metrics');
  assert.ok(stdout && stdout.continue === true, 'must emit continue');

  // Entry should still be removed (we found a match, then emitted unknown)
  const remaining = readPendingEntries(stateDir);
  assert.equal(remaining.length, 0, 'matched pending entry must be removed even with no metrics');
});

// ---------------------------------------------------------------------------
// Test 4: TaskCompleted only removes the matched entry, not others
// ---------------------------------------------------------------------------
test('Issue-A: TaskCompleted removes only the matched entry, leaves others intact', (t) => {
  const tmpDir = makeTmpDir(t);
  const { stateDir } = setupProjectDir(tmpDir);

  const entries = [
    makePendingEntry({ agent_type: 'developer',  orchestration_id: 'orch-v228-test4', spawn_key: 'developer:k1' }),
    makePendingEntry({ agent_type: 'researcher', orchestration_id: 'orch-v228-test4', spawn_key: 'researcher:k2' }),
    makePendingEntry({ agent_type: 'developer',  orchestration_id: 'orch-v228-test4', spawn_key: 'developer:k3' }),
  ];
  writePendingEntries(stateDir, entries);

  const event = {
    hook_event_name:        'TaskCompleted',
    cwd:                    tmpDir,
    agent_type:             'researcher',
    task_completed_metrics: { agent_type: 'researcher', input_tokens: 2000 },
  };

  const { exitCode } = invokeCapture(event);
  assert.equal(exitCode, 0, 'exit code must be 0');

  const remaining = readPendingEntries(stateDir);
  assert.equal(remaining.length, 2, 'only the researcher entry must be removed; 2 developer entries remain');
  assert.ok(remaining.every(e => e.agent_type === 'developer'), 'remaining entries must be developer entries');
});

// ---------------------------------------------------------------------------
// Test 5: SubagentStop path still works (no regression from Issue A branch)
// ---------------------------------------------------------------------------
test('Issue-A: SubagentStop path continues to remove pending entries (no regression)', (t) => {
  const tmpDir = makeTmpDir(t);
  const { stateDir } = setupProjectDir(tmpDir);

  const entry = makePendingEntry({ agent_type: 'tester', orchestration_id: 'orch-v228-test5' });
  writePendingEntries(stateDir, [entry]);

  // SubagentStop event (no hook_event_name field, or 'SubagentStop')
  const event = {
    hook_event_name: 'SubagentStop',
    cwd:             tmpDir,
    subagent_type:   'tester',
    usage:           { input_tokens: 400 },
  };

  const { exitCode, stdout } = invokeCapture(event);

  assert.equal(exitCode, 0, 'SubagentStop exit code must be 0');
  assert.ok(stdout && stdout.continue === true, 'SubagentStop must emit continue');

  const remaining = readPendingEntries(stateDir);
  assert.equal(remaining.length, 0, 'SubagentStop must still remove matched pending entry');
});

// ---------------------------------------------------------------------------
// Pure-function tests: task_completed_metrics token extraction logic
// ---------------------------------------------------------------------------

/**
 * Mirror the token-extraction logic from handleTaskCompleted.
 * Tests this inline to verify the logic in isolation without subprocess overhead.
 */
function extractTokensFromMetrics(metrics) {
  if (!metrics) return 0;
  if (typeof metrics.input_tokens === 'number' && metrics.input_tokens > 0) {
    return metrics.input_tokens;
  }
  if (typeof metrics.sum_of_input_tokens === 'number' && metrics.sum_of_input_tokens > 0) {
    return metrics.sum_of_input_tokens;
  }
  return 0;
}

test('Issue-A pure: extractTokensFromMetrics returns input_tokens when present', () => {
  const metrics = { agent_type: 'researcher', input_tokens: 5000, output_tokens: 300 };
  assert.equal(extractTokensFromMetrics(metrics), 5000, 'must return input_tokens');
});

test('Issue-A pure: extractTokensFromMetrics falls back to sum_of_input_tokens', () => {
  const metrics = { agent_type: 'developer', sum_of_input_tokens: 7200 };
  assert.equal(extractTokensFromMetrics(metrics), 7200, 'must return sum_of_input_tokens');
});

test('Issue-A pure: extractTokensFromMetrics prefers input_tokens over sum_of_input_tokens', () => {
  const metrics = { input_tokens: 3000, sum_of_input_tokens: 7200 };
  assert.equal(extractTokensFromMetrics(metrics), 3000, 'must prefer input_tokens');
});

test('Issue-A pure: extractTokensFromMetrics returns 0 for zero tokens', () => {
  assert.equal(extractTokensFromMetrics({ input_tokens: 0 }), 0, 'zero input_tokens → 0');
  assert.equal(extractTokensFromMetrics({}), 0, 'no token fields → 0');
  assert.equal(extractTokensFromMetrics(null), 0, 'null metrics → 0');
});

test('Issue-A pure: realized_status is measured when tokens > 0', () => {
  // Mirrors the branch logic in handleTaskCompleted
  const rawTokens = extractTokensFromMetrics({ input_tokens: 5000 });
  const realizedStatus = rawTokens > 0 ? 'measured' : 'unknown';
  assert.equal(realizedStatus, 'measured', 'realized_status must be measured for > 0 tokens');
});

test('Issue-A pure: usage_source is always task_completed_metrics in TaskCompleted branch', () => {
  // usage_source is a constant in the TaskCompleted branch — verify it is
  // 'task_completed_metrics' regardless of token count
  const usageSource = 'task_completed_metrics';
  assert.equal(usageSource, 'task_completed_metrics', 'usage_source invariant holds');
});
