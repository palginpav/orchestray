#!/usr/bin/env node
'use strict';

/**
 * tests/inject-pm-router-decision.test.js — Integration tests for
 * bin/inject-pm-router-decision.js (PreToolUse:Agent hook, v2.2.3 P4 A3).
 *
 * Subtests:
 *  1. version:1 present — emitted pm_router_decision event has version field set to 1
 *  2. schema validation passes — event passes full schema validator
 *  3. non-pm-router Agent spawn → no event emitted (hook exits early)
 *  4. fail-open: malformed input → exit 0, no crash
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/inject-pm-router-decision.js');
const SCHEMA_VALIDATOR = path.resolve(__dirname, '../bin/_lib/schema-emit-validator.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-pm-router-decision-'));
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

function makePmRouterAgentEvent(cwd, prompt) {
  return {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'pm-router',
      prompt: prompt,
    },
    cwd: cwd,
    session_id: 'test-session-inject-001',
  };
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
  delete require.cache[require.resolve(SCHEMA_VALIDATOR)];
  return require(SCHEMA_VALIDATOR);
}

// ---------------------------------------------------------------------------
// 1. version:1 present in emitted event
// ---------------------------------------------------------------------------

describe('inject-pm-router-decision — version:1 field', () => {
  test('emitted pm_router_decision event has version=1', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-inject-001');
    const event = makePmRouterAgentEvent(dir, 'fix typo in README.md');
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0');

    const rows = readEventsFile(dir);
    const decision = rows.find(r => r.type === 'pm_router_decision');
    assert.ok(decision, 'pm_router_decision event must be emitted');
    assert.strictEqual(decision.version, 1,
      'version field must equal 1 (schema requirement, NEW-6 fix)');
  });

  test('version is the first emitted key in the record', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-inject-001b');
    const event = makePmRouterAgentEvent(dir, 'fix typo in README.md');
    run(event);

    const rows = readEventsFile(dir);
    const decision = rows.find(r => r.type === 'pm_router_decision');
    assert.ok(decision, 'pm_router_decision event must be emitted');
    const keys = Object.keys(decision);
    assert.equal(keys[0], 'version',
      'version must be the first key in the emitted record');
  });
});

// ---------------------------------------------------------------------------
// 2. Schema validation passes
// ---------------------------------------------------------------------------

describe('inject-pm-router-decision — schema validation', () => {
  test('emitted pm_router_decision event passes full schema validator', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-inject-schema-001');
    const event = makePmRouterAgentEvent(dir, 'fix typo in README.md');
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0');

    const rows = readEventsFile(dir);
    const decision = rows.find(r => r.type === 'pm_router_decision');
    assert.ok(decision, 'pm_router_decision event must be emitted');

    const { validateEvent, clearCache } = loadValidator();
    clearCache();
    const result = validateEvent(path.resolve(__dirname, '..'), decision);
    assert.ok(result.valid,
      'pm_router_decision event must pass schema validation. errors: ' +
      JSON.stringify(result.errors));
  });

  test('escalate-path event also passes schema', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-inject-schema-002');
    // "audit all scripts" triggers escalate keyword
    const event = makePmRouterAgentEvent(dir, 'audit all bin scripts');
    run(event);

    const rows = readEventsFile(dir);
    const decision = rows.find(r => r.type === 'pm_router_decision');
    assert.ok(decision, 'pm_router_decision event must be emitted for escalate path');
    assert.equal(decision.version, 1, 'version must be 1 on escalate path');

    const { validateEvent, clearCache } = loadValidator();
    clearCache();
    const result = validateEvent(path.resolve(__dirname, '..'), decision);
    assert.ok(result.valid,
      'escalate-path pm_router_decision event must pass schema. errors: ' +
      JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// 3. Non-pm-router Agent spawn → no event emitted
// ---------------------------------------------------------------------------

describe('inject-pm-router-decision — non-pm-router bypass', () => {
  test('Agent spawn with different subagent_type → exit 0, no event emitted', () => {
    const dir = makeTmpDir();
    writeOrchestrationId(dir, 'orch-inject-bypass-001');
    const event = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        prompt: 'fix typo in README.md',
      },
      cwd: dir,
      session_id: 'test-session-inject-bypass',
    };
    const { status } = run(event);
    assert.equal(status, 0, 'hook must exit 0');

    const rows = readEventsFile(dir);
    const decision = rows.find(r => r.type === 'pm_router_decision');
    assert.ok(!decision, 'no pm_router_decision event for non-pm-router spawn');
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-open: malformed input
// ---------------------------------------------------------------------------

describe('inject-pm-router-decision — fail-open', () => {
  test('malformed JSON input → exit 0, no crash', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: 'not-json{',
      encoding: 'utf8',
      timeout: 10000,
      cwd: os.tmpdir(),
    });
    assert.equal(result.status, 0, 'hook must exit 0 on malformed input');
  });

  test('empty input → exit 0', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
      cwd: os.tmpdir(),
    });
    assert.equal(result.status, 0, 'hook must exit 0 on empty input');
  });
});
