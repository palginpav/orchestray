#!/usr/bin/env node
'use strict';

/**
 * p11-m01-dedup.test.js — P1.1 M0.1 Variant-C dedupe + metrics-row dedupe.
 *
 * Verifies:
 *   1. Variant-C routing_outcome is suppressed when a Variant-A row already
 *      exists in events.jsonl for the same (orch_id, agent_type).
 *   2. Variant-C is emitted normally when no prior routing_outcome exists.
 *   3. Metrics-row dedupe is a no-op in single-invocation runs (the seen-set
 *      starts empty and one row is appended).
 *   4. Kill switch ORCHESTRAY_DISABLE_VARIANT_C_DEDUP=1 disables the gate.
 *
 * Runner: node --test bin/__tests__/p11-m01-dedup.test.js
 *
 * Convention matches v216-shadow-mode-integration.test.js.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-p11-m01-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed `.orchestray/audit/events.jsonl` with the given events. */
function seedEvents(events) {
  const dir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines, 'utf8');
}

/** Seed the current-orchestration.json. */
function seedOrchestration(orchId) {
  const dir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

/** Spawn the hook script with stdin pipe; return parsed stdout + spawn result. */
function runHook(payload, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  // Force-disable any unrelated config that might fail-open noisily.
  delete env.ORCHESTRAY_METRICS_DISABLED;
  const r = spawnSync('node', [SCRIPT], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  return r;
}

/** Read events.jsonl rows. */
function readEvents() {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

/** Read agent_metrics.jsonl rows. */
function readMetrics() {
  const p = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

/** Read dropped-duplicates.jsonl rows. */
function readDropped() {
  const p = path.join(tmpDir, '.orchestray', 'state', 'dropped-duplicates.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

// --- Tests ------------------------------------------------------------------

test('Variant-C suppressed when Variant-A row already in routingOutcomes', () => {
  seedOrchestration('O1');
  // Seed a Variant-A row (source: 'hook') for (O1, developer).
  seedEvents([
    {
      timestamp: '2026-04-26T17:00:00.000Z',
      type: 'routing_outcome',
      orchestration_id: 'O1',
      agent_type: 'developer',
      tool_name: 'Agent',
      model_assigned: 'sonnet',
      source: 'hook',
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    cwd: tmpDir,
    agent_id: 'A1',
    agent_type: 'developer',
    session_id: 's1',
    last_assistant_message: 'done',
  };
  const r = runHook(payload);
  assert.equal(r.status, 0, 'hook exits 0; stderr=' + (r.stderr || ''));
  const stdout = JSON.parse(r.stdout);
  assert.equal(stdout.continue, true);

  const events = readEvents();
  // Original Variant-A row still present.
  const variantA = events.filter(
    (e) => e.type === 'routing_outcome' && e.source === 'hook'
  );
  assert.equal(variantA.length, 1, 'Variant-A row preserved');
  // No new Variant-C (source: subagent_stop) row appended.
  const variantC = events.filter(
    (e) => e.type === 'routing_outcome' && e.source === 'subagent_stop'
  );
  assert.equal(variantC.length, 0, 'Variant-C suppressed');
  // agent_stop row written.
  const agentStop = events.filter((e) => e.type === 'agent_stop');
  assert.equal(agentStop.length, 1, 'agent_stop row appended');

  // dropped-duplicates.jsonl has one variant_c_suppressed entry.
  const dropped = readDropped();
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason_code, 'variant_c_suppressed');

  // agent_metrics.jsonl has exactly one agent_spawn row.
  const metrics = readMetrics();
  const spawns = metrics.filter((m) => m.row_type === 'agent_spawn');
  assert.equal(spawns.length, 1);
});

test('Variant-C emitted when no prior routing_outcome exists', () => {
  seedOrchestration('O2');
  seedEvents([]); // empty events.jsonl

  const payload = {
    hook_event_name: 'SubagentStop',
    cwd: tmpDir,
    agent_id: 'A2',
    agent_type: 'developer',
    session_id: 's2',
  };
  const r = runHook(payload);
  assert.equal(r.status, 0);

  const events = readEvents();
  const variantC = events.filter(
    (e) => e.type === 'routing_outcome' && e.source === 'subagent_stop'
  );
  assert.equal(variantC.length, 1, 'Variant-C emitted');
  const agentStop = events.filter((e) => e.type === 'agent_stop');
  assert.equal(agentStop.length, 1);

  const dropped = readDropped();
  assert.equal(dropped.length, 0, 'no dropped rows in clean run');
});

test('metrics-row dedupe is a no-op in single-invocation runs', () => {
  seedOrchestration('O3');
  seedEvents([]);

  const payload = {
    hook_event_name: 'SubagentStop',
    cwd: tmpDir,
    agent_id: 'A3',
    agent_type: 'developer',
    session_id: 's3',
  };
  const r = runHook(payload);
  assert.equal(r.status, 0);

  const metrics = readMetrics();
  const spawns = metrics.filter((m) => m.row_type === 'agent_spawn');
  assert.equal(spawns.length, 1, 'exactly one agent_spawn row');

  const dropped = readDropped();
  const collisions = dropped.filter((d) => d.reason_code === 'metrics_dedup_collision');
  assert.equal(collisions.length, 0, 'no metrics_dedup_collision entries');
});

test('kill switch ORCHESTRAY_DISABLE_VARIANT_C_DEDUP=1 disables the gate', () => {
  seedOrchestration('O4');
  // Seed a Variant-A row that would normally trigger suppression.
  seedEvents([
    {
      timestamp: '2026-04-26T17:00:00.000Z',
      type: 'routing_outcome',
      orchestration_id: 'O4',
      agent_type: 'developer',
      tool_name: 'Agent',
      model_assigned: 'sonnet',
      source: 'hook',
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    cwd: tmpDir,
    agent_id: 'A4',
    agent_type: 'developer',
    session_id: 's4',
  };
  const r = runHook(payload, { ORCHESTRAY_DISABLE_VARIANT_C_DEDUP: '1' });
  assert.equal(r.status, 0);

  const events = readEvents();
  const variantC = events.filter(
    (e) => e.type === 'routing_outcome' && e.source === 'subagent_stop'
  );
  assert.equal(variantC.length, 1, 'Variant-C emitted because kill switch active');

  const dropped = readDropped();
  const suppressed = dropped.filter((d) => d.reason_code === 'variant_c_suppressed');
  assert.equal(suppressed.length, 0, 'no suppressed rows when kill switch active');
});
