#!/usr/bin/env node
'use strict';

/**
 * v2214-G16-lifecycle-emit.test.js — G-16 end-to-end lifecycle emit fixture.
 *
 * v2.2.13 G-05 claimed to lift orchestration_start and orchestration_complete
 * from o:0 to o:>=1. This fixture drives both emit paths end-to-end and
 * asserts events actually land in events.jsonl.
 *
 * Coverage:
 *   1. orchestration_start: drive gate-agent-spawn.js with an Agent() spawn;
 *      assert events.jsonl receives the row with all schema-required fields.
 *   2. orchestration_complete: drive emit-orchestration-complete.js with a
 *      SubagentStop payload; assert events.jsonl receives the row.
 *   3. Idempotency: firing each hook twice for the same orchestration_id
 *      must NOT produce duplicate rows (atomic sentinel).
 *   4. Kill switch: ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED=1 suppresses
 *      both events entirely.
 *
 * If test cases 1 or 2 fail because the row is absent from events.jsonl,
 * that is a v2.2.13 G-05 regression — see structured-result issues[].
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT         = path.resolve(__dirname, '..', '..');
const GATE_PATH         = path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js');
const COMPLETE_PATH     = path.join(REPO_ROOT, 'bin', 'emit-orchestration-complete.js');
const SCHEMA_PATH       = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const SHADOW_PATH       = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const NODE              = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project root wired for lifecycle-emit tests.
 * @param {string} orchId  - orchestration_id to seed in current-orchestration.json
 * @param {object} [opts]
 * @param {boolean} [opts.shadowEnabled=false] - whether to enable schema-shadow validation
 */
function makeTmpRoot(orchId, opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-G16-'));

  // Required directories
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });

  // Copy event-schemas.md so audit-event-writer's validator can load it
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  if (fs.existsSync(SHADOW_PATH)) {
    fs.copyFileSync(SHADOW_PATH, path.join(pmRefDir, 'event-schemas.shadow.json'));
  }

  // Disable schema-shadow validation by default (mirrors production installs
  // and prevents emit -> surrogate conversion masking the real rows).
  const shadowEnabled = opts.shadowEnabled === true;
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ event_schema_shadow: { enabled: shadowEnabled } }),
    'utf8'
  );

  // Routing config: disable the MCP-checkpoint pre-decomp gate (avoids
  // needing to populate mcp-checkpoint.jsonl for test purposes).
  fs.writeFileSync(
    path.join(root, '.orchestray', 'routing.jsonl'),
    '',
    'utf8'
  );

  // current-orchestration.json — required by both scripts to read orchId
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );

  return root;
}

/**
 * Parse events.jsonl and return all rows as objects.
 */
function readEvents(root) {
  const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(e => e !== null);
}

/**
 * Find rows matching event_type (supports both `type` and `event_type` fields).
 */
function findByType(events, type) {
  return events.filter(e =>
    e.event_type === type || e.type === type
  );
}

/**
 * Run gate-agent-spawn.js (PreToolUse hook) with a minimal Agent() payload.
 * Returns { status, stdout, stderr }.
 */
function runGate(root, orchId, envOverrides) {
  const payload = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: {
      model: 'claude-sonnet-4-6',
      prompt: 'test task',
    },
  };
  const env = Object.assign({}, process.env, envOverrides || {}, {
    ORCHESTRAY_PROJECT_ROOT: root,
    // Disable all secondary gates that need more state than we provide
    ORCHESTRAY_MCP_ENFORCEMENT_DISABLED: '1',
    ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
    ORCHESTRAY_HOUSEKEEPER_SPAWN_GATE_DISABLED: '1',
    ORCHESTRAY_PATTERN_DECAY_GATE_DISABLED: '1',
    ORCHESTRAY_ANTI_PATTERN_GATE_DISABLED: '1',
  });
  return cp.spawnSync(NODE, [GATE_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

/**
 * Run emit-orchestration-complete.js (SubagentStop hook) with a minimal payload.
 * Returns { status, stdout, stderr }.
 */
function runComplete(root, envOverrides) {
  const payload = { cwd: root };
  const env = Object.assign({}, process.env, envOverrides || {}, {
    ORCHESTRAY_PROJECT_ROOT: root,
  });
  return cp.spawnSync(NODE, [COMPLETE_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

/** Assert orchestration_start has all schema-required fields. */
function assertOrchStartFields(row, orchId) {
  const eventType = row.event_type || row.type;
  assert.equal(eventType, 'orchestration_start',
    'event_type must be orchestration_start');
  assert.equal(row.orchestration_id, orchId,
    'orchestration_id must match');
  assert.ok(typeof row.started_at === 'string' && row.started_at.length > 0,
    'started_at must be a non-empty string');
  assert.ok(typeof row.timestamp === 'string' && row.timestamp.length > 0,
    'timestamp must be a non-empty string');
  assert.equal(typeof row.version, 'number',
    'version must be a number');
  assert.equal(row.schema_version, 1,
    'schema_version must be 1');
}

/** Assert orchestration_complete has all schema-required fields. */
function assertOrchCompleteFields(row, orchId) {
  const eventType = row.event_type || row.type;
  assert.equal(eventType, 'orchestration_complete',
    'event_type must be orchestration_complete');
  assert.equal(row.orchestration_id, orchId,
    'orchestration_id must match');
  assert.ok(typeof row.completed_at === 'string' && row.completed_at.length > 0,
    'completed_at must be a non-empty string');
  assert.ok(typeof row.timestamp === 'string' && row.timestamp.length > 0,
    'timestamp must be a non-empty string');
  assert.equal(typeof row.version, 'number',
    'version must be a number');
  assert.equal(row.schema_version, 1,
    'schema_version must be 1');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('G-16 lifecycle emit — orchestration_start via gate-agent-spawn', () => {

  test('orchestration_start row appears in events.jsonl after first Agent() spawn', () => {
    const orchId = 'orch-g16-start-1';
    const root = makeTmpRoot(orchId);

    const result = runGate(root, orchId);
    // Hook must not crash (fail-open contract)
    assert.equal(result.status, 0,
      `gate-agent-spawn.js exited non-zero: stderr=${result.stderr}`);

    const events = readEvents(root);
    const startRows = findByType(events, 'orchestration_start');
    assert.equal(startRows.length, 1,
      `expected exactly 1 orchestration_start row; got ${startRows.length}. ` +
      `All events: ${JSON.stringify(events.map(e => e.event_type || e.type))}`);

    assertOrchStartFields(startRows[0], orchId);
  });

  test('orchestration_start row has started_at that is a valid ISO 8601 timestamp', () => {
    const orchId = 'orch-g16-start-iso';
    const root = makeTmpRoot(orchId);
    runGate(root, orchId);

    const events = readEvents(root);
    const startRows = findByType(events, 'orchestration_start');
    assert.equal(startRows.length, 1,
      'expected 1 orchestration_start row');

    const ts = startRows[0].started_at;
    const parsed = new Date(ts);
    assert.ok(!isNaN(parsed.getTime()),
      `started_at '${ts}' must be a parseable ISO 8601 date`);
  });

});

describe('G-16 lifecycle emit — orchestration_complete via emit-orchestration-complete', () => {

  test('orchestration_complete row appears in events.jsonl after SubagentStop', () => {
    const orchId = 'orch-g16-complete-1';
    const root = makeTmpRoot(orchId);

    const result = runComplete(root);
    assert.equal(result.status, 0,
      `emit-orchestration-complete.js exited non-zero: stderr=${result.stderr}`);

    const events = readEvents(root);
    const completeRows = findByType(events, 'orchestration_complete');
    assert.equal(completeRows.length, 1,
      `expected exactly 1 orchestration_complete row; got ${completeRows.length}. ` +
      `All events: ${JSON.stringify(events.map(e => e.event_type || e.type))}`);

    assertOrchCompleteFields(completeRows[0], orchId);
  });

  test('orchestration_complete row has completed_at that is a valid ISO 8601 timestamp', () => {
    const orchId = 'orch-g16-complete-iso';
    const root = makeTmpRoot(orchId);
    runComplete(root);

    const events = readEvents(root);
    const completeRows = findByType(events, 'orchestration_complete');
    assert.equal(completeRows.length, 1,
      'expected 1 orchestration_complete row');

    const ts = completeRows[0].completed_at;
    const parsed = new Date(ts);
    assert.ok(!isNaN(parsed.getTime()),
      `completed_at '${ts}' must be a parseable ISO 8601 date`);
  });

});

describe('G-16 idempotency — sentinel prevents double-fire', () => {

  test('running gate-agent-spawn twice for same orchestration_id writes only one orchestration_start row', () => {
    const orchId = 'orch-g16-idem-start';
    const root = makeTmpRoot(orchId);

    runGate(root, orchId);
    runGate(root, orchId); // second fire must be blocked by sentinel

    const events = readEvents(root);
    const startRows = findByType(events, 'orchestration_start');
    assert.equal(startRows.length, 1,
      `sentinel did not prevent double-fire: found ${startRows.length} orchestration_start rows`);
  });

  test('running emit-orchestration-complete twice for same orchestration_id writes only one orchestration_complete row', () => {
    const orchId = 'orch-g16-idem-complete';
    const root = makeTmpRoot(orchId);

    runComplete(root);
    runComplete(root); // second fire must be blocked by sentinel

    const events = readEvents(root);
    const completeRows = findByType(events, 'orchestration_complete');
    assert.equal(completeRows.length, 1,
      `sentinel did not prevent double-fire: found ${completeRows.length} orchestration_complete rows`);
  });

});

describe('G-16 kill switch — ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED=1', () => {

  test('orchestration_start is NOT written when kill switch is set', () => {
    const orchId = 'orch-g16-ks-start';
    const root = makeTmpRoot(orchId);

    runGate(root, orchId, { ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED: '1' });

    const events = readEvents(root);
    const startRows = findByType(events, 'orchestration_start');
    assert.equal(startRows.length, 0,
      `kill switch should have suppressed orchestration_start but found ${startRows.length} rows`);
  });

  test('orchestration_complete is NOT written when kill switch is set', () => {
    const orchId = 'orch-g16-ks-complete';
    const root = makeTmpRoot(orchId);

    runComplete(root, { ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED: '1' });

    const events = readEvents(root);
    const completeRows = findByType(events, 'orchestration_complete');
    assert.equal(completeRows.length, 0,
      `kill switch should have suppressed orchestration_complete but found ${completeRows.length} rows`);
  });

  test('kill switch active: neither event fires even when both hooks are driven', () => {
    const orchId = 'orch-g16-ks-both';
    const root = makeTmpRoot(orchId);
    const ksEnv = { ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED: '1' };

    runGate(root, orchId, ksEnv);
    runComplete(root, ksEnv);

    const events = readEvents(root);
    const lifecycleRows = events.filter(e => {
      const t = e.event_type || e.type;
      return t === 'orchestration_start' || t === 'orchestration_complete';
    });
    assert.equal(lifecycleRows.length, 0,
      `kill switch should suppress all lifecycle rows; found: ${JSON.stringify(lifecycleRows.map(e => e.event_type || e.type))}`);
  });

});

describe('G-16 no-orchestration guard — hooks are silent without current-orchestration.json', () => {

  test('gate-agent-spawn does not write orchestration_start when no current-orchestration.json exists', () => {
    // Create root WITHOUT writing current-orchestration.json
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-G16-noorch-'));
    fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
    const pmRefDir = path.join(root, 'agents', 'pm-reference');
    fs.mkdirSync(pmRefDir, { recursive: true });
    fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
    fs.writeFileSync(
      path.join(root, '.orchestray', 'config.json'),
      JSON.stringify({ event_schema_shadow: { enabled: false } }),
      'utf8'
    );

    const env = Object.assign({}, process.env, {
      ORCHESTRAY_PROJECT_ROOT: root,
      ORCHESTRAY_MCP_ENFORCEMENT_DISABLED: '1',
      ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
      ORCHESTRAY_HOUSEKEEPER_SPAWN_GATE_DISABLED: '1',
      ORCHESTRAY_PATTERN_DECAY_GATE_DISABLED: '1',
      ORCHESTRAY_ANTI_PATTERN_GATE_DISABLED: '1',
    });
    const payload = {
      cwd: root,
      tool_name: 'Agent',
      tool_input: { model: 'claude-sonnet-4-6', prompt: 'test' },
    };
    const result = cp.spawnSync(NODE, [GATE_PATH], {
      input: JSON.stringify(payload),
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    // Hook must exit cleanly (fail-open)
    assert.equal(result.status, 0,
      `unexpected non-zero exit: stderr=${result.stderr}`);

    const events = readEvents(root);
    const startRows = findByType(events, 'orchestration_start');
    assert.equal(startRows.length, 0,
      'no orchestration_start should fire when there is no active orchestration');
  });

  test('emit-orchestration-complete does not write when no current-orchestration.json exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-G16-noorch-complete-'));
    fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });

    const result = runComplete(root);
    assert.equal(result.status, 0,
      `unexpected non-zero exit: stderr=${result.stderr}`);

    const events = readEvents(root);
    const completeRows = findByType(events, 'orchestration_complete');
    assert.equal(completeRows.length, 0,
      'no orchestration_complete should fire when there is no active orchestration');
  });

});
