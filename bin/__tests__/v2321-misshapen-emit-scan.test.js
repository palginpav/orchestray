#!/usr/bin/env node
'use strict';

/**
 * v2321-misshapen-emit-scan.test.js — rot-detector-for-the-rot-detector.
 * Covers the two defects named in the misshapen-emit scanner's design note
 * (bin/audit-pm-emit-coverage.js): archive-preferred file selection blinds
 * it to live-only rows, and the detection never reaches a human.
 *
 * Runner: cd /home/palgin/orchestray && npm test -- --testPathPattern=v2321-misshapen-emit-scan
 * or:     node --require ./tests/helpers/setup.js --test bin/__tests__/v2321-misshapen-emit-scan.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'bin', 'audit-pm-emit-coverage.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misshapen-emit-scan-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function writeCurrentOrch(dir, orchId) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId, started_at: new Date().toISOString(), status: 'in_progress' }),
  );
}

function appendLive(dir, lines) {
  const file = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeArchive(dir, orchId, lines) {
  const archDir = path.join(dir, '.orchestray', 'history', orchId);
  fs.mkdirSync(archDir, { recursive: true });
  fs.writeFileSync(path.join(archDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function readLiveEvents(dir) {
  const file = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runHook(dir) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    input: '{}',
    encoding: 'utf8',
    timeout: 8000,
  });
}

// ---------------------------------------------------------------------------
// Defect 1: archive-preferred file selection blinds the scan to live rows
// ---------------------------------------------------------------------------

describe('scanMisshapenEmits: file selection', () => {
  test('detects a misshapen row present only in the live log when an archive for the current orch already exists', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    // Archive was frozen earlier (archive-orch-events.js's idempotent marker
    // means it never re-runs) and contains no misshapen rows.
    writeArchive(dir, 'orch-current', [
      { type: 'task_completed', orchestration_id: 'orch-current', timestamp: new Date().toISOString() },
    ]);
    // A misshapen row for the SAME orch landed in the live log after the
    // archive froze — this is the row the old archive-preferred read misses.
    appendLive(dir, [
      { event: 'task_completed', orchestration_id: 'orch-current', timestamp: new Date().toISOString() },
    ]);

    const result = runHook(dir);
    assert.equal(result.status, 0, `hook must exit 0 (stderr: ${result.stderr})`);

    const written = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    assert.equal(
      written.length, 1,
      `expected 1 pm_emit_prose_rotting row for task_completed; got ${written.length}. ` +
      `Archive-preferred read makes this fail on unfixed code because the live-only row is never scanned.`,
    );
    assert.equal(written[0].event_type, 'task_completed');
    assert.equal(written[0].misshapen_count, 1);
  });

  test('detects misshapen rows belonging to a past, already-completed orchestration (not the current one)', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    // These rows belong to orchestrations that finished days ago. They are
    // exactly the 46-row real-world shape: present in the live log, tagged
    // with an orchestration_id that is no longer "current".
    appendLive(dir, [
      { event: 'task_completed', orchestration_id: 'orch-old-1', timestamp: '2026-07-25T00:00:00Z' },
      { event: 'orchestration_start', orchestration_id: 'orch-old-2', timestamp: '2026-08-06T00:00:00Z' },
    ]);

    const result = runHook(dir);
    assert.equal(result.status, 0, `hook must exit 0 (stderr: ${result.stderr})`);

    const written = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    const byType = Object.fromEntries(written.map((e) => [e.event_type, e.misshapen_count]));
    assert.equal(
      byType.task_completed, 1,
      `expected task_completed misshapen row from a past orchestration to be detected; got ${JSON.stringify(byType)}. ` +
      `orchId-scoped filtering makes this fail on unfixed code — rows from a non-current orchestration_id are skipped.`,
    );
    assert.equal(byType.orchestration_start, 1);
  });

  test('does not double-count a misshapen row that also exists in a per-orch archive (no history/ duplication)', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    const row = { event: 'task_completed', orchestration_id: 'orch-current', timestamp: new Date().toISOString() };
    appendLive(dir, [row]);
    // Simulate the archive having copied the same row (archive-orch-events.js
    // filters by orchestration_id only, so a misshapen row with a matching
    // id would be copied too).
    writeArchive(dir, 'orch-current', [row]);

    const result = runHook(dir);
    assert.equal(result.status, 0);

    const written = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    const taskCompleted = written.find((e) => e.event_type === 'task_completed');
    assert.ok(taskCompleted, 'expected a pm_emit_prose_rotting row for task_completed');
    assert.equal(taskCompleted.misshapen_count, 1, 'must not count the archive copy a second time');
  });

  test('is idempotent: a second run does not re-flag an already-flagged event type', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    appendLive(dir, [{ event: 'orchestration_start', orchestration_id: 'orch-old', timestamp: '2026-08-06T00:00:00Z' }]);

    runHook(dir);
    const afterFirst = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    assert.equal(afterFirst.length, 1);

    runHook(dir);
    const afterSecond = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    assert.equal(afterSecond.length, 1, 'second run must not duplicate the flag row');
  });

  test('kill switch ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED=1 suppresses detection', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    appendLive(dir, [{ event: 'task_completed', orchestration_id: 'orch-old', timestamp: '2026-08-06T00:00:00Z' }]);

    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      input: '{}',
      encoding: 'utf8',
      timeout: 8000,
      env: Object.assign({}, process.env, { ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED: '1' }),
    });
    assert.equal(result.status, 0);
    const written = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    assert.equal(written.length, 0, 'kill switch must suppress the scan entirely');
  });

  test('runs even when no orchestration is currently active (global rot check, not orchestration-scoped)', () => {
    const dir = makeDir();
    // No current-orchestration.json marker written at all.
    appendLive(dir, [{ event: 'task_completed', orchestration_id: 'orch-old', timestamp: '2026-08-06T00:00:00Z' }]);

    const result = runHook(dir);
    assert.equal(result.status, 0);
    const written = readLiveEvents(dir).filter((e) => e.type === 'pm_emit_prose_rotting');
    assert.equal(
      written.length, 1,
      'without an active orchestration the old main() bails via `if (!orchId) return` before ever scanning',
    );
  });

  test('never mutates the misshapen rows themselves — they remain event: shaped after detection', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    const before = { event: 'task_completed', orchestration_id: 'orch-current', timestamp: new Date().toISOString() };
    appendLive(dir, [before]);

    runHook(dir);

    const rows = readLiveEvents(dir).filter((e) => e.event === 'task_completed');
    assert.equal(rows.length, 1, 'the original misshapen row must still exist, unmutated');
    assert.equal(rows[0].type, undefined, 'must not rewrite the row to carry a type field');
  });
});

// ---------------------------------------------------------------------------
// Snapshot for the human-facing surface (dark-event-banner.js)
// ---------------------------------------------------------------------------

describe('scanMisshapenEmits: snapshot for the banner surface', () => {
  test('writes a fresh misshapen-emit-state snapshot the banner can read cheaply', () => {
    const dir = makeDir();
    writeCurrentOrch(dir, 'orch-current');
    appendLive(dir, [
      { event: 'task_completed', orchestration_id: 'orch-old-1', timestamp: '2026-07-25T00:00:00Z' },
      { event: 'task_completed', orchestration_id: 'orch-old-2', timestamp: '2026-08-06T00:00:00Z' },
      { event: 'verify_fix_attempt', orchestration_id: 'orch-old-2', timestamp: '2026-08-06T00:00:00Z' },
    ]);

    runHook(dir);

    const statePath = path.join(dir, '.orchestray', 'state', 'misshapen-emit-state.last-run.json');
    assert.ok(fs.existsSync(statePath), 'expected a misshapen-emit-state.last-run.json snapshot to be written');
    const snapshot = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(snapshot.total_misshapen, 3);
    const byName = Object.fromEntries(snapshot.misshapen_types.map((t) => [t.event_name, t.count]));
    assert.equal(byName.task_completed, 2);
    assert.equal(byName.verify_fix_attempt, 1);
    assert.ok(!isNaN(Date.parse(snapshot.generated_at)));
  });
});
