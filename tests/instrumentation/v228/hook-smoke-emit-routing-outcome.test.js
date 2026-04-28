'use strict';

/**
 * Smoke tests for bin/emit-routing-outcome.js
 *
 * Hook event: PostToolUse:Agent|Explore|Task
 *
 * Validates:
 *   1. Agent tool inside orchestration → exit 0, { continue: true }, routing_outcome event written
 *   2. Non-Agent tool (Bash) → exit 0, { continue: true }, NO event written
 *   3. Agent tool outside orchestration (no current-orchestration.json) → exit 0, continue
 *   4. Malformed JSON on stdin → exit 0, fail-open
 *   5. Explore tool → exit 0, routing_outcome event written (2.0.12 extension)
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/emit-routing-outcome.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-ero-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function setupOrchestration(dir, orchId) {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId || 'orch-smoke-ero' })
  );
  return auditDir;
}

function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

function invoke(payload) {
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
// Test 1: Agent tool inside orchestration → routing_outcome event written
// ---------------------------------------------------------------------------
test('emit-routing-outcome: Agent tool inside orchestration writes routing_outcome event to events.jsonl', (t) => {
  const dir = makeTmpDir(t);
  const auditDir = setupOrchestration(dir, 'orch-ero-001');

  const payload = {
    tool_name: 'Agent',
    cwd:       dir,
    tool_input: {
      subagent_type: 'developer',
      model:         'claude-sonnet-4-6',
      effort:        'medium',
      prompt:        'Implement the feature according to the design doc',
    },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const events = readEvents(auditDir);
  const routingEvents = events.filter(e => e.type === 'routing_outcome');
  assert.ok(routingEvents.length >= 1, 'at least one routing_outcome event must be written');

  const ev = routingEvents[0];
  assert.strictEqual(ev.orchestration_id, 'orch-ero-001', 'routing_outcome.orchestration_id must match');
  assert.strictEqual(ev.agent_type, 'developer', 'routing_outcome.agent_type must match tool_input.subagent_type');
  assert.strictEqual(ev.model_assigned, 'sonnet', 'routing_outcome.model_assigned must be normalized model tier');
  assert.strictEqual(ev.tool_name, 'Agent', 'routing_outcome.tool_name must be Agent');
});

// ---------------------------------------------------------------------------
// Test 2: Non-Agent tool (Bash) → NO event written
// ---------------------------------------------------------------------------
test('emit-routing-outcome: non-Agent tool (Bash) produces no routing_outcome event', (t) => {
  const dir = makeTmpDir(t);
  const auditDir = setupOrchestration(dir, 'orch-ero-002');

  const payload = {
    tool_name:  'Bash',
    cwd:        dir,
    tool_input: { command: 'ls /' },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 for non-Agent tool');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const events = readEvents(auditDir);
  const routingEvents = events.filter(e => e.type === 'routing_outcome');
  assert.strictEqual(routingEvents.length, 0, 'Bash tool must NOT produce a routing_outcome event');
});

// ---------------------------------------------------------------------------
// Test 3: Agent tool outside orchestration (no current-orchestration.json)
// ---------------------------------------------------------------------------
test('emit-routing-outcome: Agent tool outside orchestration exits 0 without writing events', (t) => {
  const dir = makeTmpDir(t);
  // No orchestration setup — no current-orchestration.json

  const payload = {
    tool_name: 'Agent',
    cwd:       dir,
    tool_input: {
      subagent_type: 'reviewer',
      model:         'opus',
      prompt:        'Review this code',
    },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 outside orchestration');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true } outside orchestration');

  // No events.jsonl created for non-orchestration runs
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    const events = readEvents(path.dirname(eventsPath));
    const routingEvents = events.filter(e => e.type === 'routing_outcome');
    assert.strictEqual(routingEvents.length, 0, 'routing_outcome must not be written outside orchestration');
  }
});

// ---------------------------------------------------------------------------
// Test 4: Malformed JSON on stdin → exit 0, fail-open
// ---------------------------------------------------------------------------
test('emit-routing-outcome: malformed JSON on stdin exits 0 (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    'this is not json',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch (_e) {}
  assert.ok(parsed, 'stdout must be valid JSON on malformed stdin');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true } on malformed stdin');
});

// ---------------------------------------------------------------------------
// Test 5: Explore tool → routing_outcome event written (2.0.12 Variant A)
// ---------------------------------------------------------------------------
test('emit-routing-outcome: Explore tool inside orchestration writes routing_outcome with tool_name=Explore', (t) => {
  const dir = makeTmpDir(t);
  const auditDir = setupOrchestration(dir, 'orch-ero-005');

  const payload = {
    tool_name: 'Explore',
    cwd:       dir,
    tool_input: {
      agent_type: 'researcher',
      model:      'haiku',
      prompt:     'Search the codebase for X',
    },
  };
  const { status, parsed } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 for Explore tool');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const events = readEvents(auditDir);
  const routingEvents = events.filter(e => e.type === 'routing_outcome');
  assert.ok(routingEvents.length >= 1, 'Explore dispatch must produce routing_outcome event');
  assert.strictEqual(routingEvents[0].tool_name, 'Explore', 'tool_name must be Explore in event');
});
