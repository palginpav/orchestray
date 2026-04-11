#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/record-pattern-skip.js
 *
 * PreCompact hook — advisory emitter for pattern_record_skipped events.
 *
 * DESIGN NOTE: This is wired to PreCompact, NOT SubagentStop. The PM is the
 * main session agent and SubagentStop only fires for spawned children. The
 * DESIGN §D2 step 7 PM-only guard (Finding O2) is tested here as the
 * idempotency + three-condition guard on the PreCompact trigger.
 *
 * Coverage:
 *   D2 step 7 — three-condition guard (orch-active, pattern_find with results, zero record_application rows)
 *   D2 step 7 — happy path: all conditions met → pattern_record_skipped emitted once
 *   D2 step 7 — idempotency: running twice → only one event in events.jsonl
 *   D2 step 7 — PM-only-guard equivalent: orch-active but zero pattern_find rows → no event emitted
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../../bin/record-pattern-skip.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir with standard .orchestray layout.
 */
function makeDir({ withOrch = false, orchestrationId = 'orch-skip-test-001' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skip-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  if (withOrch) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchestrationId })
    );
  }
  return { dir, auditDir, stateDir };
}

function run(dir) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

/**
 * Write checkpoint rows to mcp-checkpoint.jsonl for the given tools.
 * patternFindResultCount: result_count for the pattern_find row (default 2).
 */
function writeCheckpointRows(stateDir, orchId, tools, patternFindResultCount = 2) {
  const now = new Date().toISOString();
  const lines = tools.map(tool => JSON.stringify({
    timestamp: now,
    orchestration_id: orchId,
    tool,
    outcome: 'answered',
    phase: 'pre-decomposition',
    result_count: tool === 'pattern_find' ? patternFindResultCount : null,
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), lines);
}

// ---------------------------------------------------------------------------
// D2 step 7 — three-condition guard: no event when conditions not met
// ---------------------------------------------------------------------------

describe('D2 step 7 — three-condition guard', () => {

  test('no orchestration active → no event emitted', () => {
    // Condition 1 not met: current-orchestration.json absent
    const { dir, auditDir } = makeDir({ withOrch: false });
    const { status } = run(dir);
    assert.equal(status, 0, 'Must exit 0 (fail-open)');
    const events = readEvents(auditDir);
    assert.equal(events.length, 0, 'No event when outside orchestration');
  });

  test('orch-active but zero pattern_find rows → no event emitted (PM-only-guard equivalent)', () => {
    // This covers the D2 step 7 PM-only guard (Finding O2) equivalence:
    // pattern_find never returned results → advisory not applicable.
    // An architect/developer stop would produce no pattern_find rows → no false event.
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true });
    // Write kb_search checkpoint but NO pattern_find row
    writeCheckpointRows(stateDir, 'orch-skip-test-001', ['kb_search']);
    const { status } = run(dir);
    assert.equal(status, 0);
    const events = readEvents(auditDir);
    assert.equal(events.length, 0,
      'No event when pattern_find row is absent (condition 2 not met)');
  });

  test('orch-active, pattern_find present but result_count=0 → no event emitted', () => {
    // result_count=0 means pattern_find returned nothing — advisory not meaningful
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true });
    writeCheckpointRows(stateDir, 'orch-skip-test-001', ['pattern_find'], 0);
    const { status } = run(dir);
    assert.equal(status, 0);
    const events = readEvents(auditDir);
    assert.equal(events.length, 0,
      'No event when pattern_find result_count is 0 (no patterns to record)');
  });

  test('orch-active, pattern_find with results, AND pattern_record_application present → no event', () => {
    // Condition 3 not met: PM DID call pattern_record_application
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true });
    writeCheckpointRows(stateDir, 'orch-skip-test-001', [
      'pattern_find',
      'pattern_record_application',
    ]);
    const { status } = run(dir);
    assert.equal(status, 0);
    const events = readEvents(auditDir);
    assert.equal(events.length, 0,
      'No event when pattern_record_application was called (condition 3 not met)');
  });

});

// ---------------------------------------------------------------------------
// D2 step 7 — happy path: all three conditions met → event emitted exactly once
// ---------------------------------------------------------------------------

describe('D2 step 7 — happy path', () => {

  test('all conditions met → pattern_record_skipped event emitted exactly once', () => {
    // Condition 1: orch active
    // Condition 2: pattern_find with result_count >= 1
    // Condition 3: zero pattern_record_application rows
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-skip-happy-001' });
    writeCheckpointRows(stateDir, 'orch-skip-happy-001', ['pattern_find'], 3);

    const { status } = run(dir);
    assert.equal(status, 0, 'Must exit 0 (advisory — never blocking)');

    const events = readEvents(auditDir);
    assert.equal(events.length, 1, 'Exactly one event must be emitted');
    const ev = events[0];
    // The event uses field name "event" (not "type") per source inspection
    assert.equal(ev.event, 'pattern_record_skipped');
    assert.equal(ev.orchestration_id, 'orch-skip-happy-001');
    assert.ok(typeof ev.pattern_find_result_count_total === 'number',
      'Event must include pattern_find_result_count_total');
    assert.ok(ev.pattern_find_result_count_total >= 1,
      'pattern_find_result_count_total must reflect the result count');
  });

  test('event contains orchestration_id from current-orchestration.json', () => {
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-anchor-xyz' });
    writeCheckpointRows(stateDir, 'orch-anchor-xyz', ['pattern_find'], 1);

    run(dir);
    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].orchestration_id, 'orch-anchor-xyz');
  });

});

// ---------------------------------------------------------------------------
// D2 step 7 — idempotency: running the script twice → only one event
// ---------------------------------------------------------------------------

describe('D2 step 7 — idempotency', () => {

  test('running record-pattern-skip.js twice emits only one event in events.jsonl', () => {
    // PreCompact may fire multiple times in a session (repeated compactions).
    // The idempotency guard must prevent double-emission.
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-skip-idem-001' });
    writeCheckpointRows(stateDir, 'orch-skip-idem-001', ['pattern_find'], 2);

    // Run the script twice
    run(dir);
    run(dir);

    const events = readEvents(auditDir);
    const skipEvents = events.filter(e => e.event === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 1,
      'Only one pattern_record_skipped event must exist after two runs (idempotency guard)');
  });

  test('idempotency holds even when events.jsonl already has other event types', () => {
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-skip-idem-002' });
    writeCheckpointRows(stateDir, 'orch-skip-idem-002', ['pattern_find'], 2);

    // Pre-populate events.jsonl with an unrelated event
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({ type: 'routing_outcome', orchestration_id: 'orch-skip-idem-002' }) + '\n'
    );

    run(dir);
    run(dir);

    const events = readEvents(auditDir);
    const skipEvents = events.filter(e => e.event === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 1,
      'Idempotency must still hold when events.jsonl has pre-existing entries');
    // The unrelated event must be preserved
    const otherEvents = events.filter(e => e.type === 'routing_outcome');
    assert.equal(otherEvents.length, 1, 'Pre-existing events must not be removed');
  });

});

// ---------------------------------------------------------------------------
// Fail-open discipline
// ---------------------------------------------------------------------------

describe('fail-open discipline', () => {

  test('malformed JSON on stdin exits 0 (fail-open)', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '{{not json}}',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse((result.stdout || '').trim()).continue, true);
  });

  test('empty stdin exits 0 (fail-open)', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
  });

  test('mcp-checkpoint.jsonl absent → exits 0 and emits no event', () => {
    // No checkpoint file at all — conditions 2 and 3 both fail gracefully
    const { dir, auditDir } = makeDir({ withOrch: true });
    const { status } = run(dir);
    assert.equal(status, 0);
    const events = readEvents(auditDir);
    assert.equal(events.length, 0);
  });

});
