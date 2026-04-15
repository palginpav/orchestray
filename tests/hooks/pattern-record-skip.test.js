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
    assert.equal(ev.type, 'pattern_record_skipped');
    assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0,
      'Event must include an ISO-8601 timestamp field');
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
    const skipEvents = events.filter(e => e.type === 'pattern_record_skipped');
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
    const skipEvents = events.filter(e => e.type === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 1,
      'Idempotency must still hold when events.jsonl has pre-existing entries');
    // The unrelated event must be preserved
    const otherEvents = events.filter(e => e.type === 'routing_outcome');
    assert.equal(otherEvents.length, 1, 'Pre-existing events must not be removed');
  });

});

// ---------------------------------------------------------------------------
// BUG-A-2.0.13 — advisory now functional with real result_count values
// Before the BUG-A fix, result_count was permanently null (classifyOutcome/
// extractResultCount read tool_result which was always undefined in Claude Code
// 2.1.59). The advisory gate condition (result_count >= 1) was therefore never
// satisfied — the advisory was silently broken. These tests verify post-fix
// behavior using the new real result_count semantics.
// ---------------------------------------------------------------------------

describe('BUG-A-2.0.13 — advisory gate with real result_count from fixed extractor', () => {

  test('advisory fires when pattern_find row has result_count=1 (minimum threshold)', () => {
    // Pre-2.0.13: result_count was always null → advisory never fired.
    // Post-2.0.13: result_count is populated from matches.length → advisory fires.
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-buga-001' });
    writeCheckpointRows(stateDir, 'orch-buga-001', ['pattern_find'], 1);

    run(dir);
    const events = readEvents(auditDir);
    const skipEvents = events.filter(e => e.type === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 1,
      'Advisory must fire when result_count === 1 (BUG-A-2.0.13 A-2 path)');
    assert.equal(skipEvents[0].pattern_find_result_count_total, 1);
  });

  test('advisory does NOT fire when result_count=0 (no patterns found)', () => {
    // result_count=0 means pattern_find returned no matches — nothing to record.
    // The null-tolerance pre-fix path must not be present.
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-buga-002' });
    writeCheckpointRows(stateDir, 'orch-buga-002', ['pattern_find'], 0);

    run(dir);
    const events = readEvents(auditDir);
    const skipEvents = events.filter(e => e.type === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 0,
      'Advisory must NOT fire when result_count === 0');
  });

  test('advisory does NOT fire when result_count is null (pre-2.0.13 rows — historically accurate)', () => {
    // Pre-2.0.13 rows have null result_count because BUG-A was present.
    // Null must NOT be treated as "unknown = fire anyway" — that would be wrong
    // under A-2. Null rows are pre-2.0.13 rows and advisory does not fire for them.
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-buga-003' });
    // Write a pattern_find row with null result_count (simulates pre-2.0.13 row)
    fs.writeFileSync(
      path.join(stateDir, 'mcp-checkpoint.jsonl'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orchestration_id: 'orch-buga-003',
        tool: 'pattern_find',
        outcome: 'skipped',
        phase: 'pre-decomposition',
        result_count: null,
      }) + '\n'
    );

    run(dir);
    const events = readEvents(auditDir);
    const skipEvents = events.filter(e => e.type === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 0,
      'Advisory must NOT fire for null result_count (pre-2.0.13 rows; no null-tolerance path)');
  });

  test('advisory does NOT fire when pattern_record_application row also exists', () => {
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-buga-004' });
    writeCheckpointRows(stateDir, 'orch-buga-004', [
      'pattern_find',
      'pattern_record_application',
    ], 3);

    run(dir);
    const events = readEvents(auditDir);
    const skipEvents = events.filter(e => e.type === 'pattern_record_skipped');
    assert.equal(skipEvents.length, 0,
      'Advisory must NOT fire when PM called pattern_record_application');
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

// ---------------------------------------------------------------------------
// W16 P1 — 2MB guard stderr warning (T3 P1 regression)
// ---------------------------------------------------------------------------
// Verifies that when events.jsonl exceeds the 2MB read guard, the script
// emits a one-line stderr warning naming the orchestration ID and the bypass.
// Without this warning the silent degradation is invisible to operators.
// Source: v2015-reviewer-final.md T3 P1 FAIL; fix shipped in record-pattern-skip.js:161-165.

describe('W16 P1 — 2MB guard: stderr warning emitted when events.jsonl exceeds guard', () => {

  test('oversized events.jsonl emits "[orchestray] record-pattern-skip:" warning on stderr', () => {
    // Arrange: active orchestration with a pattern_find checkpoint row (condition 2),
    // no pattern_record_application row (condition 3), and an events.jsonl that is
    // larger than the 2MB guard so the skip-reason scan is bypassed.
    const orchId = 'orch-2mb-guard-001';
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true, orchestrationId: orchId });
    writeCheckpointRows(stateDir, orchId, ['pattern_find'], 2);

    // Write a synthetic events.jsonl that exceeds 2 MB (2 * 1024 * 1024 = 2097152 bytes).
    // We use a padded JSON line repeated to cross the threshold.
    const MAX_EVENTS_READ = 2 * 1024 * 1024;
    const singleLine = JSON.stringify({ type: 'mcp_tool_call', orchestration_id: orchId, padding: 'x'.repeat(200) }) + '\n';
    const repeatCount = Math.ceil((MAX_EVENTS_READ + 1) / singleLine.length);
    const oversizedContent = singleLine.repeat(repeatCount);
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), oversizedContent);

    // Act: run the script.
    const { stderr, status } = run(dir);

    // Assert: must exit 0 (fail-open discipline).
    assert.equal(status, 0, 'Must exit 0 even when events.jsonl exceeds guard (fail-open)');

    // Assert: stderr must contain the [orchestray] prefix + script name + guard mention.
    assert.ok(
      stderr.includes('[orchestray] record-pattern-skip:'),
      'stderr must include [orchestray] record-pattern-skip: prefix; got: ' + stderr
    );
    assert.ok(
      stderr.toLowerCase().includes('exceeds'),
      'stderr must mention "exceeds" (the guard bypass); got: ' + stderr
    );
    assert.ok(
      stderr.includes(orchId),
      'stderr warning must name the orchestration ID (' + orchId + '); got: ' + stderr
    );
  });

  test('undersized events.jsonl does NOT emit the 2MB guard warning', () => {
    // Regression complement: a small events.jsonl must not trigger the warning.
    // This prevents false positives from the guard in the normal case.
    const orchId = 'orch-2mb-guard-002';
    const { dir, stateDir } = makeDir({ withOrch: true, orchestrationId: orchId });
    writeCheckpointRows(stateDir, orchId, ['pattern_find'], 1);
    // No events.jsonl created — the file does not exist (well below 2MB).
    const { stderr, status } = run(dir);
    assert.equal(status, 0, 'Must exit 0 when events.jsonl is small/absent');
    assert.ok(
      !stderr.includes('exceeds'),
      'stderr must NOT mention "exceeds" for a small/absent events.jsonl; got: ' + stderr
    );
  });

});
