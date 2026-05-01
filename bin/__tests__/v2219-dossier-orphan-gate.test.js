#!/usr/bin/env node
'use strict';

/**
 * v2219-dossier-orphan-gate.test.js — v2.2.19 T8 Fix 1 tests.
 *
 * Tests the two new gates added to `bin/audit-dossier-orphan.js`:
 *   (a) Resume-opportunity gate: skip emission when no SessionStart(compact|resume)
 *       event exists for the orchestration_id.
 *   (b) Dedup gate: emit at most once per orchestration_id lifetime.
 *
 * 4 cases:
 *   Case 1: No SessionStart(compact|resume) in orch → orphan detector skips emission.
 *   Case 2: SessionStart(compact) present + no inject → emits exactly one orphan event.
 *   Case 3: Multiple Stop fires within same orch → emits at most one orphan event.
 *   Case 4: Different orchs → each emits independently.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const ORPHAN_MODULE = path.resolve(__dirname, '..', 'audit-dossier-orphan.js');
const {
  runAudit,
  _hasResumeOpportunity,
  _hasEmittedOrphan,
} = require(ORPHAN_MODULE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2219-orphan-gate-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
  return tmp;
}

function writeEvents(cwd, events) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const lines = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  fs.writeFileSync(eventsPath, lines, 'utf8');
}

function readEmittedOrphanEvents(cwd) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.type === 'dossier_write_without_inject_detected') out.push(ev);
    } catch (_e) { /* skip malformed */ }
  }
  return out;
}

function counterValue(cwd, orchId) {
  const counterPath = path.join(cwd, '.orchestray', 'state', `dossier-orphan-counter.${orchId}`);
  try {
    const raw = fs.readFileSync(counterPath, 'utf8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  } catch (_e) { return 0; }
}

/**
 * Build a minimal set of events that look like an orphan (writes present,
 * no inject) but with NO SessionStart(compact|resume).
 */
function buildOrphanEventsNoResume(orchId) {
  return [
    {
      type: 'dossier_written',
      orchestration_id: orchId,
      timestamp: new Date().toISOString(),
    },
    {
      type: 'dossier_written',
      orchestration_id: orchId,
      timestamp: new Date().toISOString(),
    },
    // No SessionStart with source=compact|resume, no inject event.
  ];
}

/**
 * Build events that include a SessionStart(compact) event for the orchId —
 * simulates a post-compact session where an orphan IS meaningful.
 */
function buildOrphanEventsWithCompact(orchId) {
  return [
    {
      type: 'session_start',
      orchestration_id: orchId,
      source: 'compact',
      timestamp: new Date().toISOString(),
    },
    {
      type: 'dossier_written',
      orchestration_id: orchId,
      timestamp: new Date().toISOString(),
    },
    // No dossier_injected row — this is a real orphan.
  ];
}

// ---------------------------------------------------------------------------
// Case 1: No SessionStart(compact|resume) → orphan detector skips emission
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 1a — resume-opportunity gate', () => {
  test('no SessionStart(compact|resume) in orch events → runAudit emits zero orphan events', () => {
    const cwd   = makeTmpDir();
    const orchId = 'orch-gate-case1';

    writeEvents(cwd, buildOrphanEventsNoResume(orchId));

    const result = runAudit({ cwd, orchestrationIds: [orchId] });

    assert.equal(result.scanned, 1, 'should scan 1 orchestration');
    assert.equal(result.orphans.length, 0,
      'orphan list should be empty — no resume opportunity');

    const emitted = readEmittedOrphanEvents(cwd);
    assert.equal(emitted.length, 0,
      'no dossier_write_without_inject_detected events should be written to events.jsonl');
  });

  test('_hasResumeOpportunity returns false when no SessionStart(compact|resume) in event list', () => {
    const events = [
      { type: 'dossier_written', orchestration_id: 'orch-x' },
      { type: 'session_start', orchestration_id: 'orch-x', source: 'fresh' },
    ];
    assert.equal(_hasResumeOpportunity(events), false,
      'source=fresh is not a resume opportunity');
  });

  test('_hasResumeOpportunity returns true when SessionStart with source=compact present', () => {
    const events = [
      { type: 'dossier_written', orchestration_id: 'orch-y' },
      { type: 'session_start', orchestration_id: 'orch-y', source: 'compact' },
    ];
    assert.equal(_hasResumeOpportunity(events), true);
  });

  test('_hasResumeOpportunity returns true when SessionStart with source=resume present', () => {
    const events = [
      { type: 'session_start', source: 'resume' },
      { type: 'dossier_written' },
    ];
    assert.equal(_hasResumeOpportunity(events), true);
  });
});

// ---------------------------------------------------------------------------
// Case 2: SessionStart(compact) present + no inject → emits exactly one orphan
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 1 — Case 2: compact event present, no inject → one orphan emitted', () => {
  test('runAudit emits exactly one dossier_write_without_inject_detected for real orphan', () => {
    const cwd    = makeTmpDir();
    const orchId = 'orch-gate-case2';

    writeEvents(cwd, buildOrphanEventsWithCompact(orchId));

    const result = runAudit({ cwd, orchestrationIds: [orchId] });

    assert.equal(result.scanned, 1, 'should scan 1 orchestration');
    assert.equal(result.orphans.length, 1, 'exactly one orphan should be detected');

    const emitted = readEmittedOrphanEvents(cwd);
    assert.equal(emitted.length, 1, 'exactly one orphan event written to events.jsonl');
    assert.equal(emitted[0].orchestration_id, orchId, 'orphan event should reference orchId');
    assert.equal(emitted[0].write_count, 1, 'write_count should be 1');
    assert.equal(emitted[0].inject_count, 0, 'inject_count should be 0');
  });
});

// ---------------------------------------------------------------------------
// Case 3: Multiple Stop fires within same orch → at most one orphan emitted
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 1b — dedup gate: multiple Stop fires → at most one orphan event', () => {
  test('calling runAudit twice for same orchId only emits one orphan event total', () => {
    const cwd    = makeTmpDir();
    const orchId = 'orch-gate-case3';

    writeEvents(cwd, buildOrphanEventsWithCompact(orchId));

    // First Stop fire — should emit the orphan event.
    const result1 = runAudit({ cwd, orchestrationIds: [orchId] });
    assert.equal(result1.orphans.length, 1, 'first Stop should detect 1 orphan');

    // Second Stop fire — same orchestration, same events. Should NOT re-emit.
    const result2 = runAudit({ cwd, orchestrationIds: [orchId] });
    assert.equal(result2.orphans.length, 0, 'second Stop should detect 0 orphans (deduped)');

    // Only one orphan event in events.jsonl total.
    const emitted = readEmittedOrphanEvents(cwd);
    assert.equal(emitted.length, 1,
      'only one dossier_write_without_inject_detected event should exist across both runs');

    // Counter file should reflect exactly 1 (from maybeEmitThreshold on first run).
    assert.ok(counterValue(cwd, orchId) >= 1, 'counter sentinel must be > 0 after first emission');
  });

  test('_hasEmittedOrphan returns false when counter sentinel is absent', () => {
    const cwd    = makeTmpDir();
    const orchId = 'orch-no-sentinel';
    assert.equal(_hasEmittedOrphan(cwd, orchId), false, 'no sentinel → has not emitted');
  });

  test('_hasEmittedOrphan returns true after maybeEmitThreshold increments the counter', () => {
    const { maybeEmitThreshold } = require(ORPHAN_MODULE);
    const cwd    = makeTmpDir();
    const orchId = 'orch-sentinel-check';

    // Prime the counter by calling maybeEmitThreshold once (simulates prior orphan emission).
    maybeEmitThreshold(cwd, orchId);

    assert.equal(_hasEmittedOrphan(cwd, orchId), true,
      'sentinel present with count=1 → already emitted');
  });
});

// ---------------------------------------------------------------------------
// Case 4: Different orchs → each emits independently
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 1b — different orchestration_ids emit independently', () => {
  test('two separate orchIds each emit their own orphan event independently', () => {
    const cwd     = makeTmpDir();
    const orchId1 = 'orch-gate-case4a';
    const orchId2 = 'orch-gate-case4b';

    // Write events for both orchestrations into the same events.jsonl.
    const events = [
      ...buildOrphanEventsWithCompact(orchId1),
      ...buildOrphanEventsWithCompact(orchId2),
    ];
    writeEvents(cwd, events);

    const result = runAudit({ cwd, orchestrationIds: [orchId1, orchId2] });

    assert.equal(result.scanned, 2, 'should scan 2 orchestrations');
    assert.equal(result.orphans.length, 2, 'each orch should produce one orphan');

    const emitted = readEmittedOrphanEvents(cwd);
    assert.equal(emitted.length, 2, 'two orphan events written — one per orchestration');

    const ids = emitted.map((ev) => ev.orchestration_id).sort();
    assert.deepEqual(ids, [orchId1, orchId2].sort(),
      'each orphan event references its own orchestration_id');
  });

  test('dedup is per-orchestration: after both orchIds emit, each is independently deduped', () => {
    const cwd     = makeTmpDir();
    const orchId1 = 'orch-gate-dedup4a';
    const orchId2 = 'orch-gate-dedup4b';

    const events = [
      ...buildOrphanEventsWithCompact(orchId1),
      ...buildOrphanEventsWithCompact(orchId2),
    ];
    writeEvents(cwd, events);

    // First run — both emit.
    runAudit({ cwd, orchestrationIds: [orchId1, orchId2] });

    // Second run — both should be deduped.
    const result2 = runAudit({ cwd, orchestrationIds: [orchId1, orchId2] });
    assert.equal(result2.orphans.length, 0,
      'second run should produce zero orphans (both already emitted)');

    const emitted = readEmittedOrphanEvents(cwd);
    assert.equal(emitted.length, 2,
      'only 2 total orphan events across both runs (one per orch)');
  });
});
