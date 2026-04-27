#!/usr/bin/env node
'use strict';

/**
 * tests/validate-no-solo-violation.test.js — Integration tests for
 * bin/validate-no-solo-violation.js SubagentStop tripwire (F6, F4).
 *
 * Tests: non-pm pass-through, missing orch file, low complexity, violation
 * emission, no violation when spawns exist, F4 cross-orch stale decision.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/validate-no-solo-violation.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir({ orchId = 'orch-001', complexityScore = null, spawnRows = 0, routerDecisions = [], startedAt = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-violation-test-'));
  cleanup.push(dir);

  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Write current-orchestration.json
  const orchData = {
    orchestration_id: orchId,
    complexity_score: complexityScore,
    complexity_threshold: 4,
  };
  if (startedAt !== null) orchData.started_at = startedAt;
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify(orchData)
  );

  // Write routing.jsonl spawn rows
  if (spawnRows > 0) {
    const routingPath = path.join(stateDir, 'routing.jsonl');
    for (let i = 0; i < spawnRows; i++) {
      fs.appendFileSync(routingPath,
        JSON.stringify({ orchestration_id: orchId, decided_by: 'pm', agent: 'developer-' + i }) + '\n'
      );
    }
  }

  // Write events.jsonl with router decisions
  if (routerDecisions.length > 0) {
    const eventsPath = path.join(auditDir, 'events.jsonl');
    for (const d of routerDecisions) {
      fs.appendFileSync(eventsPath, JSON.stringify(d) + '\n');
    }
  }

  return { dir, auditDir, stateDir };
}

function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

describe('validate-no-solo-violation — non-pm agent', () => {
  test('developer agent_type → exit 0, no event', () => {
    const { dir, auditDir } = makeTmpDir({ complexityScore: 8 });
    const { status } = run({ agent_type: 'developer', cwd: dir });
    assert.equal(status, 0);
    const events = readEvents(auditDir).filter(e => e.type === 'solo_violation_detected');
    assert.equal(events.length, 0, 'no violation event for non-pm agent');
  });
});

describe('validate-no-solo-violation — missing orchestration', () => {
  test('pm + no current-orchestration.json → exit 0, no event', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-no-orch-'));
    cleanup.push(dir);
    const { status } = run({ agent_type: 'pm', cwd: dir });
    assert.equal(status, 0);
  });
});

describe('validate-no-solo-violation — below threshold', () => {
  test('pm + complexity_score < threshold → exit 0, no event', () => {
    const { dir, auditDir } = makeTmpDir({ complexityScore: 2 });
    const { status } = run({ agent_type: 'pm', cwd: dir });
    assert.equal(status, 0);
    const events = readEvents(auditDir).filter(e => e.type === 'solo_violation_detected');
    assert.equal(events.length, 0);
  });
});

describe('validate-no-solo-violation — violation emission', () => {
  test('pm + complexity >= threshold + 0 spawns + no router decision → emits violation', () => {
    const { dir, auditDir } = makeTmpDir({
      orchId: 'orch-viol-001',
      complexityScore: 6,
      spawnRows: 0,
      routerDecisions: [],
      // started 10s ago — outside grace window
      startedAt: new Date(Date.now() - 10000).toISOString(),
    });
    const { status } = run({ agent_type: 'pm', cwd: dir });
    assert.equal(status, 0, 'always exits 0 — tripwire never blocks');
    const events = readEvents(auditDir).filter(e => e.type === 'solo_violation_detected');
    assert.equal(events.length, 1, 'must emit exactly one violation event');
    assert.equal(events[0].orchestration_id, 'orch-viol-001');
    assert.equal(events[0].complexity_score, 6);
  });
});

describe('validate-no-solo-violation — no violation when spawns exist', () => {
  test('pm + complexity >= threshold + >=1 spawn rows → exit 0, no event', () => {
    const { dir, auditDir } = makeTmpDir({
      complexityScore: 8,
      spawnRows: 1,
      startedAt: new Date(Date.now() - 10000).toISOString(),
    });
    const { status } = run({ agent_type: 'pm', cwd: dir });
    assert.equal(status, 0);
    const events = readEvents(auditDir).filter(e => e.type === 'solo_violation_detected');
    assert.equal(events.length, 0, 'no violation when agents were spawned');
  });
});

describe('validate-no-solo-violation — F4 cross-orch stale decision', () => {
  test('pm + complexity >= threshold + 0 spawns + stale router decision from DIFFERENT orchId → still emits violation', () => {
    const currentOrchId = 'orch-current-001';
    const staleOrchId = 'orch-old-999';

    // Router decision from a DIFFERENT orchestration (stale — should NOT suppress).
    const staleDecision = {
      type: 'pm_router_decision',
      orchestration_id: staleOrchId,  // different!
      decision: 'solo',
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),  // 30 min ago
    };

    const { dir, auditDir } = makeTmpDir({
      orchId: currentOrchId,
      complexityScore: 6,
      spawnRows: 0,
      routerDecisions: [staleDecision],
      startedAt: new Date(Date.now() - 10000).toISOString(),
    });

    const { status } = run({ agent_type: 'pm', cwd: dir });
    assert.equal(status, 0);
    const events = readEvents(auditDir).filter(e => e.type === 'solo_violation_detected');
    assert.equal(events.length, 1,
      'stale router decision from different orchestration must NOT suppress violation');
  });

  test('pm + complexity >= threshold + 0 spawns + router solo decision for SAME orchId → no violation', () => {
    const orchId = 'orch-same-001';

    const matchingDecision = {
      type: 'pm_router_decision',
      orchestration_id: orchId,
      decision: 'solo',
      timestamp: new Date().toISOString(),
    };

    const { dir, auditDir } = makeTmpDir({
      orchId,
      complexityScore: 6,
      spawnRows: 0,
      routerDecisions: [matchingDecision],
      startedAt: new Date(Date.now() - 10000).toISOString(),
    });

    const { status } = run({ agent_type: 'pm', cwd: dir });
    assert.equal(status, 0);
    const events = readEvents(auditDir).filter(e => e.type === 'solo_violation_detected');
    assert.equal(events.length, 0,
      'matching same-orch router solo decision must suppress violation');
  });
});
