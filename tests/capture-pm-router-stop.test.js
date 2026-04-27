#!/usr/bin/env node
'use strict';

/**
 * tests/capture-pm-router-stop.test.js — Integration tests for
 * bin/capture-pm-router-stop.js (SubagentStop hook, v2.2.3 P4 A3).
 *
 * Subtests:
 *  1. disagreement=false: agent decision matches predicate → field is false
 *  2. disagreement=true: agent decision differs from predicate → field is true
 *  3. missing prompt: tool_input.prompt absent → field is null, event passes schema
 *  4. null decisionTaken: structured result has no decision → field is null
 *  5. schema validation: emitted pm_router_complete event passes validator for
 *     all branches (disagreement=false, true, and null)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/capture-pm-router-stop.js');
const SCHEMA_VALIDATOR = path.resolve(__dirname, '../bin/_lib/schema-emit-validator.js');
const SCHEMA_PATH = path.resolve(__dirname, '../agents/pm-reference/event-schemas.md');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-router-stop-'));
  cleanup.push(d);
  return d;
}

function writeOrchestrationId(tmpDir, id) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

function makeStructuredResult(decision) {
  const sr = {
    status: 'success',
    decision,
    reason: 'all_signals_simple',
    routing_path: decision === 'solo' ? 'router_solo' : 'router_escalated',
    files_changed: [],
    files_read: [],
  };
  return '## Structured Result\n```json\n' + JSON.stringify(sr, null, 2) + '\n```';
}

function makeEvent(tmpDir, { decision, includePrompt = true, promptText = null } = {}) {
  const output = makeStructuredResult(decision);
  const event = {
    subagent_type: 'pm-router',
    cwd: tmpDir,
    session_id: 'test-session-001',
    result: output,
  };
  if (includePrompt) {
    // "fix typo in README.md" → solo per predicate (short, no escalate keywords)
    // "audit all bin scripts" → escalate per predicate (escalate keyword)
    event.tool_input = { prompt: promptText || 'fix typo in README.md' };
  }
  return event;
}

function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    cwd: payload.cwd || os.tmpdir(),
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function readEventsFile(tmpDir) {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function loadValidator() {
  // Clear module cache so each call gets a fresh schema parse.
  delete require.cache[require.resolve(SCHEMA_VALIDATOR)];
  return require(SCHEMA_VALIDATOR);
}

// ---------------------------------------------------------------------------
// Subtest 1: disagreement=false — agent solo matches predicate solo
// ---------------------------------------------------------------------------

describe('capture-pm-router-stop — disagreement=false', () => {
  test('agent solo + predicate solo → decision_disagreement is false', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-test-001');
    // prompt "fix typo in README.md" → predicate says solo; agent also says solo
    const event = makeEvent(dir, { decision: 'solo', includePrompt: true, promptText: 'fix typo in README.md' });
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0');

    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'pm_router_complete event must be emitted');
    assert.strictEqual(complete.decision_disagreement, false,
      'disagreement must be false when agent and predicate agree');
  });
});

// ---------------------------------------------------------------------------
// Subtest 2: disagreement=true — agent escalates but predicate says solo
// ---------------------------------------------------------------------------

describe('capture-pm-router-stop — disagreement=true', () => {
  test('agent escalate + predicate solo → decision_disagreement is true', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-test-002');
    // prompt "fix typo in README.md" → predicate says solo; agent says escalate → mismatch
    const event = makeEvent(dir, { decision: 'escalate', includePrompt: true, promptText: 'fix typo in README.md' });
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0');

    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'pm_router_complete event must be emitted');
    assert.strictEqual(complete.decision_disagreement, true,
      'disagreement must be true when agent and predicate disagree');
  });
});

// ---------------------------------------------------------------------------
// Subtest 3: missing prompt → field is null, event passes schema validation
// ---------------------------------------------------------------------------

describe('capture-pm-router-stop — missing prompt', () => {
  test('tool_input.prompt absent → decision_disagreement is null', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-test-003');
    // No tool_input.prompt field
    const event = makeEvent(dir, { decision: 'solo', includePrompt: false });
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0');

    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'pm_router_complete event must be emitted');
    assert.strictEqual(complete.decision_disagreement, null,
      'decision_disagreement must be null when prompt is unavailable');
  });

  test('null prompt → event passes schema validation (NEW-3 fix)', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-test-003b');
    const event = makeEvent(dir, { decision: 'solo', includePrompt: false });
    run(event);

    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'event must be emitted');

    // Validate with the real schema
    const { validateEvent, clearCache } = loadValidator();
    clearCache();
    const result = validateEvent(path.resolve(__dirname, '..'), complete);
    assert.ok(result.valid,
      'event with null decision_disagreement must pass schema validation. errors: ' +
      JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Subtest 4: null decisionTaken → field is null
// ---------------------------------------------------------------------------

describe('capture-pm-router-stop — null decisionTaken', () => {
  test('structured result has no decision → decision_disagreement is null', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-test-004');
    // Malformed structured result — no "decision" field
    const malformedSR = '## Structured Result\n```json\n{"status":"success","reason":"all_signals_simple"}\n```';
    const event = {
      subagent_type: 'pm-router',
      cwd: dir,
      session_id: 'test-session-004',
      result: malformedSR,
      tool_input: { prompt: 'fix typo in README.md' },
    };
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0 even with malformed result');

    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'pm_router_complete event must be emitted');
    assert.strictEqual(complete.decision_disagreement, null,
      'decision_disagreement must be null when decisionTaken is null');
  });
});

// ---------------------------------------------------------------------------
// Subtest 5: schema validation passes for all disagreement branches
// ---------------------------------------------------------------------------

describe('capture-pm-router-stop — schema validation all branches', () => {
  test('disagreement=false event passes schema', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-schema-false');
    const event = makeEvent(dir, { decision: 'solo', includePrompt: true, promptText: 'fix typo in README.md' });
    run(event);
    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'event must be emitted');
    const { validateEvent, clearCache } = loadValidator();
    clearCache();
    const result = validateEvent(path.resolve(__dirname, '..'), complete);
    assert.ok(result.valid, 'disagreement=false event must pass schema. errors: ' + JSON.stringify(result.errors));
  });

  test('disagreement=true event passes schema', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-schema-true');
    const event = makeEvent(dir, { decision: 'escalate', includePrompt: true, promptText: 'fix typo in README.md' });
    run(event);
    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'event must be emitted');
    const { validateEvent, clearCache } = loadValidator();
    clearCache();
    const result = validateEvent(path.resolve(__dirname, '..'), complete);
    assert.ok(result.valid, 'disagreement=true event must pass schema. errors: ' + JSON.stringify(result.errors));
  });

  test('disagreement=null event passes schema (missing prompt path)', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-schema-null');
    const event = makeEvent(dir, { decision: 'solo', includePrompt: false });
    run(event);
    const rows = readEventsFile(dir);
    const complete = rows.find(r => r.type === 'pm_router_complete');
    assert.ok(complete, 'event must be emitted');
    const { validateEvent, clearCache } = loadValidator();
    clearCache();
    const result = validateEvent(path.resolve(__dirname, '..'), complete);
    assert.ok(result.valid, 'disagreement=null event must pass schema. errors: ' + JSON.stringify(result.errors));
  });
});
