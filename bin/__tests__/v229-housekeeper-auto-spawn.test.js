#!/usr/bin/env node
'use strict';

/**
 * v229-housekeeper-auto-spawn.test.js — B-1.1 + B-1.2 acceptance suite.
 *
 * Anti-regression contract:
 *   1. A single KB-write trigger enqueues exactly one synthetic
 *      `spawn-requests.jsonl` row for `orchestray-housekeeper` with
 *      requester `system:housekeeper-trigger`, `auto_approve: true`, and
 *      emits one `spawn_requested` audit row.
 *   2. Three KB-writes within the same orchestration enqueue exactly one
 *      synthetic request and emit two `housekeeper_trigger_debounced`
 *      events (one per collapsed duplicate).
 *   3. A `spawn_requested` row that gets `spawn_approved` does NOT trigger
 *      `housekeeper_trigger_orphaned` from the orphan auditor.
 *   4. A `spawn_requested` row older than 60 s with no follow-up emits
 *      `housekeeper_trigger_orphaned` exactly once and idempotently
 *      (re-running the auditor does not duplicate the emit).
 *   5. `ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED=1` short-circuits the
 *      trigger script — no row is enqueued and no event is emitted.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const TRIGGER_BIN   = path.join(REPO_ROOT, 'bin', 'spawn-housekeeper-on-trigger.js');
const ORPHAN_BIN    = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-orphan.js');
const ORCH_ID       = 'orch-20260428T180000Z-test-b1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b1-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: ORCH_ID, started_at: new Date().toISOString(), phase: 'execute' }),
  );
  return dir;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); }
    catch (_e) { /* skip */ }
  }
  return out;
}

function readSpawnRequests(dir) {
  return readJsonl(path.join(dir, '.orchestray', 'state', 'spawn-requests.jsonl'));
}

function readEvents(dir) {
  return readJsonl(path.join(dir, '.orchestray', 'audit', 'events.jsonl'));
}

function runTrigger(dir, payload, env = {}) {
  return spawnSync('node', [TRIGGER_BIN], {
    cwd: dir,
    env: { ...process.env, ...env },
    input: JSON.stringify({ cwd: dir, ...payload }),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runOrphanAuditor(dir, env = {}) {
  return spawnSync('node', [ORPHAN_BIN], {
    cwd: dir,
    env: { ...process.env, ...env },
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function kbWritePayload(filePath = 'kb/facts/example.md') {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__orchestray__kb_write',
    tool_input: { path: filePath, content: 'sample' },
    tool_response: { ok: true },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.9 B-1.1 — spawn-housekeeper-on-trigger.js (queue-based)', () => {
  test('1) one KB-write enqueues exactly one system housekeeper request', () => {
    const dir = makeRepo();
    const r = runTrigger(dir, kbWritePayload());
    assert.equal(r.status, 0, `trigger exit=${r.status} stderr=${r.stderr}`);

    const requests = readSpawnRequests(dir);
    assert.equal(requests.length, 1, 'exactly one row queued');
    const row = requests[0];
    assert.equal(row.requester_agent, 'system:housekeeper-trigger');
    assert.equal(row.requested_agent, 'orchestray-housekeeper');
    assert.equal(row.auto_approve, true);
    assert.equal(row.status, 'pending');
    assert.equal(row.orchestration_id, ORCH_ID);
    assert.equal(row.justification, 'kb_write');
    assert.equal(row.max_cost_usd, 0.50);

    const events = readEvents(dir);
    const requested = events.filter(e => e.type === 'spawn_requested');
    assert.equal(requested.length, 1, 'exactly one spawn_requested event emitted');
    assert.equal(requested[0].request_id, row.request_id);
    assert.equal(requested[0].requester_agent, 'system:housekeeper-trigger');
    assert.equal(requested[0].requested_agent, 'orchestray-housekeeper');
  });

  test('2) three KB-writes in same orch → 1 request + 2 debounced events', () => {
    const dir = makeRepo();
    const r1 = runTrigger(dir, kbWritePayload('kb/facts/a.md'));
    assert.equal(r1.status, 0);
    const r2 = runTrigger(dir, kbWritePayload('kb/facts/b.md'));
    assert.equal(r2.status, 0);
    const r3 = runTrigger(dir, kbWritePayload('kb/facts/c.md'));
    assert.equal(r3.status, 0);

    const requests = readSpawnRequests(dir);
    assert.equal(requests.length, 1, 'still only 1 enqueued (debounce N=1)');

    const events = readEvents(dir);
    const debounced = events.filter(e => e.type === 'housekeeper_trigger_debounced');
    assert.equal(debounced.length, 2, 'two collapse events for the two duplicates');
    for (const ev of debounced) {
      assert.equal(ev.orchestration_id, ORCH_ID);
      assert.equal(ev.trigger_reason, 'kb_write');
      assert.equal(typeof ev.debounced_count, 'number');
      assert.ok(ev.debounced_count >= 1);
    }

    const requested = events.filter(e => e.type === 'spawn_requested');
    assert.equal(requested.length, 1, 'exactly one spawn_requested across all three triggers');
  });

  test('3) ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED=1 short-circuits', () => {
    const dir = makeRepo();
    const r = runTrigger(dir, kbWritePayload(), {
      ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED: '1',
    });
    assert.equal(r.status, 0);

    const requests = readSpawnRequests(dir);
    assert.equal(requests.length, 0, 'kill switch must prevent enqueue');

    const events = readEvents(dir);
    const triggerEvents = events.filter(e =>
      e.type === 'spawn_requested'
      || e.type === 'housekeeper_trigger_debounced'
      || e.type === 'housekeeper_trigger_orphaned'
    );
    assert.equal(triggerEvents.length, 0, 'no events emitted under kill switch');
  });
});

describe('v2.2.9 B-1.2 — audit-housekeeper-orphan.js', () => {
  test('4) approved follow-up suppresses the orphan event', () => {
    const dir = makeRepo();
    const requestId = 'req-approved-001';
    const ts = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath, [
      JSON.stringify({
        type: 'spawn_requested', version: 1, timestamp: ts,
        orchestration_id: ORCH_ID, request_id: requestId,
        requester_agent: 'system:housekeeper-trigger',
        requested_agent: 'orchestray-housekeeper',
        justification: 'kb_write', max_cost_usd: 0.5,
      }),
      JSON.stringify({
        type: 'spawn_approved', version: 1, timestamp: new Date().toISOString(),
        orchestration_id: ORCH_ID, request_id: requestId,
        decision_source: 'auto', reason: 'system_auto_approve',
      }),
    ].join('\n') + '\n');

    const r = runOrphanAuditor(dir);
    assert.equal(r.status, 0, `orphan auditor stderr=${r.stderr}`);

    const events = readEvents(dir);
    const orphans = events.filter(e => e.type === 'housekeeper_trigger_orphaned');
    assert.equal(orphans.length, 0, 'approved request must not orphan-emit');
  });

  test('5) >60s without follow-up emits exactly one orphan event idempotently', () => {
    const dir = makeRepo();
    const requestId = 'req-orphan-002';
    const ts = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath, JSON.stringify({
      type: 'spawn_requested', version: 1, timestamp: ts,
      orchestration_id: ORCH_ID, request_id: requestId,
      requester_agent: 'system:housekeeper-trigger',
      requested_agent: 'orchestray-housekeeper',
      justification: 'schema_edit', max_cost_usd: 0.5,
    }) + '\n');

    // First fire — emits orphan.
    let r = runOrphanAuditor(dir);
    assert.equal(r.status, 0);
    let events = readEvents(dir);
    let orphans = events.filter(e => e.type === 'housekeeper_trigger_orphaned');
    assert.equal(orphans.length, 1, 'orphan emitted on first stop fire');
    assert.equal(orphans[0].request_id, requestId);
    assert.equal(orphans[0].trigger_reason, 'schema_edit');
    assert.ok(orphans[0].age_seconds >= 60, `age_seconds must be ≥ 60 (got ${orphans[0].age_seconds})`);

    // Second fire — must NOT duplicate (the prior orphan row is now in
    // events.jsonl and findOrphans excludes any already-emitted request_id).
    r = runOrphanAuditor(dir);
    assert.equal(r.status, 0);
    events = readEvents(dir);
    orphans = events.filter(e => e.type === 'housekeeper_trigger_orphaned');
    assert.equal(orphans.length, 1, 'second auditor pass must be idempotent');
  });

  test('findOrphans pure helper — request younger than 60s is NOT orphaned', () => {
    const { findOrphans } = require(ORPHAN_BIN);
    const now = Date.now();
    const events = [{
      type: 'spawn_requested', version: 1,
      timestamp: new Date(now - 30 * 1000).toISOString(),
      orchestration_id: ORCH_ID, request_id: 'fresh-001',
      requester_agent: 'system:housekeeper-trigger',
      requested_agent: 'orchestray-housekeeper',
      justification: 'kb_write',
    }];
    const result = findOrphans(events, ORCH_ID, now);
    assert.deepEqual(result, [], 'fresh request must not orphan');
  });
});
