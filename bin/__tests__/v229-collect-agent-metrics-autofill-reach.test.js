#!/usr/bin/env node
'use strict';

/**
 * v229-collect-agent-metrics-autofill-reach.test.js — W2 autofill reach.
 *
 * Verifies that the agent_stop event emitted by collect-agent-metrics.js
 * contains version: 1 (required by schema), closing the F1-reach gap where
 * the emit previously lacked the field and caused 86% schema validation blocks.
 *
 * Test 1: SubagentStop path → events.jsonl row has version: 1.
 * Test 2: ORCHESTRAY_AUDIT_AUTOFILL_DISABLED=1 env — version: 1 still present
 *         (set explicitly at emit site, not via autofill; this proves the field
 *         is not reliant on a separate autofill mechanism that could be toggled).
 * Test 3: No schema_shadow_validation_block surrogate row appears for the
 *         agent_stop event (schema validator accepts the row).
 *
 * NOTE: audit-event-writer.js does NOT autofill version (comment at line 107
 * confirms "version is NOT auto-filled — explicit emit-site responsibility").
 * W2 fixes the emit site. An `audit_event_autofilled` event type does not exist
 * in the current codebase; tests are written against what actually ships.
 *
 * Runner: node --test bin/__tests__/v229-collect-agent-metrics-autofill-reach.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'collect-agent-metrics.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-v229-autofill-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed current-orchestration.json. */
function seedOrch(orchId) {
  const dir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

/** Spawn hook with stdin payload. Returns spawnSync result. */
function runHook(payload, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  delete env.ORCHESTRAY_METRICS_DISABLED;
  return spawnSync('node', [SCRIPT], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });
}

/** Read events.jsonl rows. */
function readEvents() {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/** Build minimal SubagentStop hook payload. */
function buildPayload(overrides) {
  return Object.assign({
    hook_event_name: 'SubagentStop',
    cwd: tmpDir,
    agent_type: 'developer',
    agent_id: 'agent-w2-test-001',
    session_id: 'sess-w2-001',
    last_assistant_message: 'done',
  }, overrides || {});
}

// ---------------------------------------------------------------------------

test('Test 1: agent_stop row has version: 1 (W2 emit-site fix)', () => {
  const orchId = 'orch-v229-w2-t1';
  seedOrch(orchId);

  const result = runHook(buildPayload({ cwd: tmpDir }));
  assert.equal(result.status, 0, 'hook exited non-zero: ' + result.stderr);

  const events = readEvents();
  const stop = events.find((e) => e.type === 'agent_stop');
  assert.ok(stop, 'no agent_stop row found in events.jsonl');
  assert.equal(stop.version, 1, 'agent_stop must have version: 1');
});

test('Test 2: version: 1 present even with ORCHESTRAY_AUDIT_AUTOFILL_DISABLED=1', () => {
  // version is set explicitly at emit site, not via a toggleable autofill
  // mechanism. This test documents that the fix is intrinsic to the event
  // construction, not dependent on a secondary autofill path.
  const orchId = 'orch-v229-w2-t2';
  seedOrch(orchId);

  const result = runHook(buildPayload({ cwd: tmpDir }), {
    ORCHESTRAY_AUDIT_AUTOFILL_DISABLED: '1',
  });
  assert.equal(result.status, 0, 'hook exited non-zero: ' + result.stderr);

  const events = readEvents();
  const stop = events.find((e) => e.type === 'agent_stop');
  assert.ok(stop, 'no agent_stop row found in events.jsonl');
  assert.equal(
    stop.version,
    1,
    'version: 1 must be set at emit site, independent of any autofill toggle'
  );
});

test('Test 3: no schema_shadow_validation_block for agent_stop (schema accepts it)', () => {
  const orchId = 'orch-v229-w2-t3';
  seedOrch(orchId);

  const result = runHook(buildPayload({ cwd: tmpDir }));
  assert.equal(result.status, 0, 'hook exited non-zero: ' + result.stderr);

  const events = readEvents();
  const stop = events.find((e) => e.type === 'agent_stop');
  assert.ok(stop, 'no agent_stop row found in events.jsonl');

  // Check no surrogate block for the agent_stop
  const blocks = events.filter(
    (e) => e.type === 'schema_shadow_validation_block' && e.blocked_event_type === 'agent_stop'
  );
  assert.equal(
    blocks.length,
    0,
    'schema_shadow_validation_block appeared for agent_stop — version field still missing or schema rejected the row'
  );
});
