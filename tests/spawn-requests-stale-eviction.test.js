#!/usr/bin/env node
'use strict';

/**
 * spawn-requests-stale-eviction.test.js — v2.2.21 W1-T2 (T4 F8 closure)
 *
 * Verifies the TTL-eviction sweep in bin/process-spawn-requests.js:
 *   1. A pending row whose `orchestration_id` does not match the active
 *      orch AND whose `ts` is > 5 min old is evicted from spawn-requests.jsonl
 *      and a `spawn_request_evicted` audit event is emitted.
 *   2. A pending row whose `orchestration_id` matches the active orch is
 *      kept regardless of age (still actionable).
 *   3. A recent row from a different orchestration is kept (within TTL —
 *      may be a legitimate cross-boundary request).
 *
 * Each test stubs $HOME so the HMAC key file does not collide with the
 * developer's real ~/.claude/orchestray/.
 *
 * Runner: node --test tests/spawn-requests-stale-eviction.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', 'process-spawn-requests.js');

function makeSandbox(activeOrchId) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-evict-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-evict-home-'));
  fs.mkdirSync(path.join(proj, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: activeOrchId })
  );
  fs.writeFileSync(
    path.join(proj, '.orchestray', 'config.json'),
    JSON.stringify({
      reactive_spawn: {
        enabled: true,
        per_orchestration_quota: 10,
        auto_approve_threshold_pct: 0.25,
        max_depth: 3,
      },
    })
  );
  return { proj, home };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
}

function writeRows(proj, rows) {
  const p = path.join(proj, '.orchestray', 'state', 'spawn-requests.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readRows(proj) {
  const p = path.join(proj, '.orchestray', 'state', 'spawn-requests.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function readEvents(proj) {
  const p = path.join(proj, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function runDrainer(proj, home) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd: proj, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
    timeout: 10_000,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    cwd: proj,
  });
}

// ---------------------------------------------------------------------------
// Test 1: stale row from a different orchestration is evicted
// ---------------------------------------------------------------------------
test('stale orchestration_id row > 5 min old is evicted on drain', () => {
  const { proj, home } = makeSandbox('orch-current');
  try {
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    writeRows(proj, [
      {
        request_id: 'stale-1',
        orchestration_id: 'orch-old',
        requester_agent: 'worker:dev',
        requested_agent: 'developer',
        max_cost_usd: 0.10,
        spawn_depth: 0,
        status: 'pending',
        ts: sixMinAgo,
      },
    ]);

    const r = runDrainer(proj, home);
    assert.equal(r.status, 0, 'drainer must exit 0; stderr=' + (r.stderr || ''));

    const remaining = readRows(proj);
    assert.equal(remaining.length, 0, 'stale row must be evicted; remaining=' + JSON.stringify(remaining));

    const events = readEvents(proj);
    const evicted = events.filter((e) => e.type === 'spawn_request_evicted' && e.request_id === 'stale-1');
    assert.equal(evicted.length, 1, 'expected one spawn_request_evicted event');
    assert.equal(evicted[0].reason, 'stale_orchestration_id_ttl');
    assert.equal(evicted[0].evicted_orchestration_id, 'orch-old');
  } finally {
    cleanup(proj, home);
  }
});

// ---------------------------------------------------------------------------
// Test 2: row matching active orch is kept regardless of age
// ---------------------------------------------------------------------------
test('row matching active orchestration_id is kept regardless of age', () => {
  const { proj, home } = makeSandbox('orch-current');
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeRows(proj, [
      {
        request_id: 'active-old-1',
        orchestration_id: 'orch-current',
        requester_agent: 'worker:dev',
        requested_agent: 'developer',
        max_cost_usd: 0.10,
        spawn_depth: 0,
        status: 'pending',
        ts: tenMinAgo,
      },
    ]);

    const r = runDrainer(proj, home);
    assert.equal(r.status, 0);

    const remaining = readRows(proj);
    // Row may have moved to denied (no auto_approve, no budget config quirks)
    // but must still be present in the file.
    const found = remaining.find((row) => row.request_id === 'active-old-1');
    assert.ok(found, 'active-orch row must NOT be evicted; rows=' + JSON.stringify(remaining));
    assert.equal(found.orchestration_id, 'orch-current');

    const events = readEvents(proj);
    const evicted = events.filter((e) => e.type === 'spawn_request_evicted' && e.request_id === 'active-old-1');
    assert.equal(evicted.length, 0, 'active-orch row must NOT generate spawn_request_evicted');
  } finally {
    cleanup(proj, home);
  }
});

// ---------------------------------------------------------------------------
// Test 3: recent row from a different orch is kept (within TTL window)
// ---------------------------------------------------------------------------
test('recent row from different orchestration_id stays within TTL', () => {
  const { proj, home } = makeSandbox('orch-current');
  try {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    writeRows(proj, [
      {
        request_id: 'recent-other-1',
        orchestration_id: 'orch-other',
        requester_agent: 'worker:dev',
        requested_agent: 'developer',
        max_cost_usd: 0.10,
        spawn_depth: 0,
        status: 'pending',
        ts: oneMinAgo,
      },
    ]);

    const r = runDrainer(proj, home);
    assert.equal(r.status, 0);

    const remaining = readRows(proj);
    const found = remaining.find((row) => row.request_id === 'recent-other-1');
    assert.ok(found, 'recent cross-orch row must NOT be evicted within TTL');

    const events = readEvents(proj);
    const evicted = events.filter((e) => e.type === 'spawn_request_evicted' && e.request_id === 'recent-other-1');
    assert.equal(evicted.length, 0);
  } finally {
    cleanup(proj, home);
  }
});

// ---------------------------------------------------------------------------
// Test 4: terminal-status rows (approved/denied) are preserved (not pending)
// ---------------------------------------------------------------------------
test('terminal-status (approved/denied) rows are preserved regardless of orch_id and age', () => {
  const { proj, home } = makeSandbox('orch-current');
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeRows(proj, [
      {
        request_id: 'old-approved-1',
        orchestration_id: 'orch-old',
        requester_agent: 'worker:dev',
        requested_agent: 'developer',
        status: 'approved',
        decided_at: tenMinAgo,
        ts: tenMinAgo,
      },
    ]);

    const r = runDrainer(proj, home);
    assert.equal(r.status, 0);

    const remaining = readRows(proj);
    const found = remaining.find((row) => row.request_id === 'old-approved-1');
    assert.ok(found, 'terminal-status row must be preserved; eviction is pending-only');
  } finally {
    cleanup(proj, home);
  }
});
