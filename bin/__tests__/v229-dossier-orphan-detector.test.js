#!/usr/bin/env node
'use strict';

/**
 * v2.2.9 B-3.3 — Orphan-detector test.
 *
 * Anti-regression demonstration: synthetic events.jsonl with `dossier_written`
 * and no follow-up `dossier_injected` / non-kill-switch
 * `dossier_injection_skipped` → `dossier_write_without_inject_detected` fires.
 *
 * Also confirms:
 *   - kill-switch skips do NOT count as a paired outcome (operator deliberately
 *     suppressed inject — not a regression).
 *   - non-kill-switch skips DO count (the inject side ran and reported why).
 *   - paired writes/injects do NOT trigger the orphan event.
 *   - per-orch archive (F2) is preferred over live filter when present.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const ORPHAN = path.resolve(__dirname, '..', 'audit-dossier-orphan.js');
const {
  runAudit,
  tallyDossierEvents,
  isOrphan,
} = require(ORPHAN);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-orphan-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
  return tmp;
}

function writeLiveEvents(cwd, events) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(eventsPath, lines);
}

function writePerOrchArchive(cwd, orchId, events) {
  const dir = path.join(cwd, '.orchestray', 'history', orchId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines);
}

function readEvents(cwd) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe('v2.2.9 B-3.3 — tallyDossierEvents + isOrphan', () => {
  test('write without paired inject or skip is orphan', () => {
    const events = [
      { type: 'dossier_written', orchestration_id: 'orch-A' },
      { type: 'dossier_written', orchestration_id: 'orch-A' },
    ];
    const tally = tallyDossierEvents(events);
    assert.equal(tally.write_count, 2);
    assert.equal(tally.inject_count, 0);
    assert.equal(tally.skip_count, 0);
    assert.equal(isOrphan(tally), true);
  });

  test('write paired with inject is NOT orphan', () => {
    const events = [
      { type: 'dossier_written', orchestration_id: 'orch-B' },
      { type: 'dossier_injected', orchestration_id: 'orch-B' },
    ];
    assert.equal(isOrphan(tallyDossierEvents(events)), false);
  });

  test('write with only kill_switch skip IS orphan (operator-suppression does not pair)', () => {
    const events = [
      { type: 'dossier_written', orchestration_id: 'orch-C' },
      { type: 'dossier_injection_skipped', skip_reason: 'kill_switch_set', orchestration_id: 'orch-C' },
    ];
    const tally = tallyDossierEvents(events);
    assert.equal(tally.kill_switch_skip_count, 1);
    assert.equal(tally.non_kill_switch_skip_count, 0);
    assert.equal(isOrphan(tally), true,
      'kill_switch_set skips do not satisfy the pair-emit invariant');
  });

  test('write with non-kill-switch skip is NOT orphan', () => {
    const events = [
      { type: 'dossier_written', orchestration_id: 'orch-D' },
      { type: 'dossier_injection_skipped', skip_reason: 'dossier_file_corrupt', orchestration_id: 'orch-D' },
    ];
    assert.equal(isOrphan(tallyDossierEvents(events)), false,
      'non-kill-switch skip is a legitimate inject-side report');
  });

  test('zero writes is never orphan', () => {
    const events = [
      { type: 'dossier_injection_skipped', skip_reason: 'not_session_start', orchestration_id: 'orch-E' },
    ];
    assert.equal(isOrphan(tallyDossierEvents(events)), false);
  });
});

// ---------------------------------------------------------------------------
// runAudit integration: synthetic write-without-inject scenario
// ---------------------------------------------------------------------------

describe('v2.2.9 B-3.3 — runAudit emits dossier_write_without_inject_detected', () => {
  test('Anti-regression: dossier_written without paired inject → orphan event fires', () => {
    const cwd = makeProjectDir();
    writeLiveEvents(cwd, [
      { type: 'dossier_written', orchestration_id: 'orch-orphan-1', version: 1, timestamp: '2026-04-28T18:00:00.000Z' },
      { type: 'dossier_written', orchestration_id: 'orch-orphan-1', version: 1, timestamp: '2026-04-28T18:01:00.000Z' },
      // No dossier_injected, no non-kill-switch skip.
      { type: 'dossier_written', orchestration_id: 'orch-healthy-1', version: 1, timestamp: '2026-04-28T18:00:00.000Z' },
      { type: 'dossier_injected', orchestration_id: 'orch-healthy-1', version: 1, timestamp: '2026-04-28T18:00:01.000Z' },
    ]);

    const result = runAudit({ cwd });

    assert.equal(result.scanned, 2, 'should scan both orchestrations with writes');
    assert.equal(result.orphans.length, 1, 'exactly one orchestration is orphan');
    assert.equal(result.orphans[0].orchestration_id, 'orch-orphan-1');
    assert.equal(result.orphans[0].write_count, 2);
    assert.equal(result.orphans[0].inject_count, 0);

    const orphanEvents = readEvents(cwd).filter((ev) => ev.type === 'dossier_write_without_inject_detected');
    assert.equal(orphanEvents.length, 1, 'exactly one orphan event written to events.jsonl');
    assert.equal(orphanEvents[0].orchestration_id, 'orch-orphan-1');
    assert.equal(orphanEvents[0].write_count, 2);
    assert.equal(orphanEvents[0].inject_count, 0);
    assert.equal(orphanEvents[0].version, 1);
    assert.equal(orphanEvents[0].archive_source, 'live_events_filter');
  });

  test('Kill-switch-only skips → STILL fires orphan (the regression class we are fixing)', () => {
    const cwd = makeProjectDir();
    writeLiveEvents(cwd, [
      { type: 'dossier_written', orchestration_id: 'orch-kill-only', version: 1, timestamp: '2026-04-28T18:00:00.000Z' },
      { type: 'dossier_injection_skipped', skip_reason: 'kill_switch_set', orchestration_id: 'orch-kill-only', version: 1, timestamp: '2026-04-28T18:00:01.000Z' },
    ]);
    const result = runAudit({ cwd });
    assert.equal(result.orphans.length, 1, 'kill_switch_set does not pair — still orphan');
    assert.equal(result.orphans[0].kill_switch_skip_count, 1);
  });

  test('Non-kill-switch skip → no orphan event', () => {
    const cwd = makeProjectDir();
    writeLiveEvents(cwd, [
      { type: 'dossier_written', orchestration_id: 'orch-pair-skip', version: 1, timestamp: '2026-04-28T18:00:00.000Z' },
      { type: 'dossier_injection_skipped', skip_reason: 'dossier_file_corrupt', orchestration_id: 'orch-pair-skip', version: 1, timestamp: '2026-04-28T18:00:01.000Z' },
    ]);
    const result = runAudit({ cwd });
    assert.equal(result.orphans.length, 0,
      'non-kill-switch skip is a legitimate inject-side report');
    const orphanEvents = readEvents(cwd).filter((ev) => ev.type === 'dossier_write_without_inject_detected');
    assert.equal(orphanEvents.length, 0);
  });

  test('Per-orch archive (F2) is preferred over live filter when present', () => {
    const cwd = makeProjectDir();
    // Live log says "no inject" but the per-orch archive says "injected".
    // The auditor should trust the archive.
    writeLiveEvents(cwd, [
      { type: 'dossier_written', orchestration_id: 'orch-archive', version: 1, timestamp: '2026-04-28T18:00:00.000Z' },
    ]);
    writePerOrchArchive(cwd, 'orch-archive', [
      { type: 'dossier_written', orchestration_id: 'orch-archive', version: 1, timestamp: '2026-04-28T18:00:00.000Z' },
      { type: 'dossier_injected', orchestration_id: 'orch-archive', version: 1, timestamp: '2026-04-28T18:00:01.000Z' },
    ]);
    const result = runAudit({ cwd });
    assert.equal(result.source_breakdown.per_orch_archive, 1,
      'archive should be the source of truth when present');
    assert.equal(result.orphans.length, 0,
      'archive shows the inject — not orphan');
  });

  test('runAudit on empty audit log is a no-op', () => {
    const cwd = makeProjectDir();
    const result = runAudit({ cwd });
    assert.equal(result.scanned, 0);
    assert.equal(result.orphans.length, 0);
  });
});
