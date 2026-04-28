#!/usr/bin/env node
'use strict';

/**
 * v229-archive-orch-events.test.js — F2 acceptance test.
 *
 * Anti-regression contract:
 *   1. Live `.orchestray/audit/events.jsonl` with mixed orchestration_ids is
 *      filtered correctly by the active orchestration_id from
 *      `.orchestray/audit/current-orchestration.json`.
 *   2. Archive lands at `.orchestray/history/<orch_id>/events.jsonl`.
 *   3. Atomic write — no `.tmp` file lingers on success.
 *   4. Idempotent re-run is a no-op when `.archived` marker is present.
 *   5. `orchestration_events_archived` row appears in the live audit log.
 *   6. `ORCHESTRAY_ORCH_ARCHIVE_DISABLED=1` short-circuits.
 *   7. Missing current-orchestration.json → silent exit-0 (no archive write).
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const SCRIPT     = path.join(REPO_ROOT, 'bin', 'archive-orch-events.js');
const ORCH_ID    = 'orch-20260428T000000Z-test-f2';
const OTHER_ID   = 'orch-20260101T000000Z-other';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-f2-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  return dir;
}

function writeCurrentMarker(dir, orchId) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId, started_at: new Date().toISOString(), phase: 'execute' }),
  );
}

/**
 * Write 10 lines: 5 matching ORCH_ID, 5 with OTHER_ID. Mixed event types.
 * One garbage line to test fail-open.
 */
function writeLiveEvents(dir, orchId, otherId, options = {}) {
  const lines = [
    JSON.stringify({ type: 'orchestration_start',  version: 1, timestamp: '2026-04-28T00:00:00.000Z', orchestration_id: orchId }),
    JSON.stringify({ type: 'agent_start',          version: 2, timestamp: '2026-04-28T00:00:01.000Z', orchestration_id: orchId, agent_type: 'developer' }),
    JSON.stringify({ type: 'agent_stop',           version: 1, timestamp: '2026-04-28T00:00:02.000Z', orchestration_id: orchId, agent_type: 'developer' }),
    JSON.stringify({ type: 'agent_start',          version: 2, timestamp: '2026-04-28T00:00:03.000Z', orchestration_id: otherId, agent_type: 'reviewer' }),
    JSON.stringify({ type: 'agent_start',          version: 2, timestamp: '2026-04-28T00:00:04.000Z', orchestration_id: orchId, agent_type: 'reviewer' }),
    JSON.stringify({ type: 'agent_stop',           version: 1, timestamp: '2026-04-28T00:00:05.000Z', orchestration_id: otherId, agent_type: 'reviewer' }),
    'this-is-not-json-it-must-be-skipped',
    JSON.stringify({ type: 'routing_outcome',      version: 7, timestamp: '2026-04-28T00:00:06.000Z', orchestration_id: otherId }),
    JSON.stringify({ type: 'routing_outcome',      version: 7, timestamp: '2026-04-28T00:00:07.000Z', orchestration_id: otherId }),
    JSON.stringify({ type: 'routing_outcome',      version: 7, timestamp: '2026-04-28T00:00:08.000Z', orchestration_id: otherId }),
  ];
  if (options.withComplete) {
    lines.push(JSON.stringify({
      type: 'orchestration_complete', version: 1,
      timestamp: '2026-04-28T00:00:09.000Z', orchestration_id: orchId,
      tasks_total: 2, tasks_succeeded: 2, tasks_failed: 0, duration_ms: 9000, status: 'success',
    }));
  }
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
    lines.join('\n') + '\n',
  );
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  });
}

function runScript(repoDir, env = {}) {
  return spawnSync('node', [SCRIPT], {
    cwd: repoDir,
    env: { ...process.env, ...env },
    input: JSON.stringify({ cwd: repoDir }),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.9 F2 — archive-orch-events.js', () => {
  test('filters live events.jsonl by orchestration_id and writes archive', () => {
    const dir = makeRepo();
    writeCurrentMarker(dir, ORCH_ID);
    writeLiveEvents(dir, ORCH_ID, OTHER_ID);

    const r = runScript(dir);
    assert.equal(r.status, 0, `script exit=${r.status} stderr=${r.stderr}`);

    const archive = path.join(dir, '.orchestray', 'history', ORCH_ID, 'events.jsonl');
    assert.ok(fs.existsSync(archive), 'archive file must exist');

    const lines = readJsonlLines(archive);
    assert.equal(lines.length, 4, 'archive must contain exactly 4 ORCH_ID lines (no orchestration_complete in this fixture)');
    for (const obj of lines) {
      assert.equal(obj.orchestration_id, ORCH_ID, 'every line must match ORCH_ID');
    }
  });

  test('atomic write — no .tmp file lingers after success', () => {
    const dir = makeRepo();
    writeCurrentMarker(dir, ORCH_ID);
    writeLiveEvents(dir, ORCH_ID, OTHER_ID);

    const r = runScript(dir);
    assert.equal(r.status, 0);

    const archiveDir = path.join(dir, '.orchestray', 'history', ORCH_ID);
    const tmpPath    = path.join(archiveDir, 'events.jsonl.tmp');
    assert.ok(!fs.existsSync(tmpPath), '.tmp file must NOT exist on success');
  });

  test('writes .archived marker when orchestration_complete is present, then re-run is a no-op', () => {
    const dir = makeRepo();
    writeCurrentMarker(dir, ORCH_ID);
    writeLiveEvents(dir, ORCH_ID, OTHER_ID, { withComplete: true });

    // First run — should freeze archive.
    let r = runScript(dir);
    assert.equal(r.status, 0);

    const archiveDir = path.join(dir, '.orchestray', 'history', ORCH_ID);
    const archive    = path.join(archiveDir, 'events.jsonl');
    const marker     = path.join(archiveDir, '.archived');
    assert.ok(fs.existsSync(marker), '.archived marker must exist after orchestration_complete in fixture');

    const firstMtime  = fs.statSync(archive).mtimeMs;
    const firstLines  = readJsonlLines(archive);
    assert.equal(firstLines.length, 5, 'must include orchestration_complete row → 5 lines total');

    // Sanity: emit row in live log.
    const liveAfterFirst = readJsonlLines(path.join(dir, '.orchestray', 'audit', 'events.jsonl'));
    const emitRows = liveAfterFirst.filter(e => e && e.type === 'orchestration_events_archived');
    assert.ok(emitRows.length >= 1, 'orchestration_events_archived row must appear in live audit log');
    assert.equal(emitRows[0].orchestration_id, ORCH_ID);
    assert.equal(emitRows[0].event_count,      5);
    assert.equal(typeof emitRows[0].byte_size, 'number');
    assert.ok(emitRows[0].byte_size > 0);

    // Sleep a tick so any stat mtime change would be observable.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

    // Second run — must be a no-op (no new emit, no archive change).
    r = runScript(dir);
    assert.equal(r.status, 0);

    const secondMtime = fs.statSync(archive).mtimeMs;
    assert.equal(secondMtime, firstMtime, 'archive mtime must NOT change on idempotent re-run');

    const liveAfterSecond = readJsonlLines(path.join(dir, '.orchestray', 'audit', 'events.jsonl'));
    const emitRowsAfter   = liveAfterSecond.filter(e => e && e.type === 'orchestration_events_archived');
    assert.equal(emitRowsAfter.length, emitRows.length, 'no additional emit on idempotent re-run');
  });

  test('mid-orchestration re-run (no orchestration_complete yet) re-archives and grows', () => {
    const dir = makeRepo();
    writeCurrentMarker(dir, ORCH_ID);
    writeLiveEvents(dir, ORCH_ID, OTHER_ID); // no withComplete

    // First run — archives 4 ORCH_ID lines, no marker.
    let r = runScript(dir);
    assert.equal(r.status, 0);
    const archiveDir = path.join(dir, '.orchestray', 'history', ORCH_ID);
    assert.ok(!fs.existsSync(path.join(archiveDir, '.archived')), 'no marker without orchestration_complete');
    assert.equal(readJsonlLines(path.join(archiveDir, 'events.jsonl')).length, 4);

    // Append a new ORCH_ID line to live log.
    fs.appendFileSync(
      path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
      JSON.stringify({ type: 'agent_start', version: 2, timestamp: '2026-04-28T00:00:99.000Z', orchestration_id: ORCH_ID, agent_type: 'tester' }) + '\n',
    );

    // Second run — archive grows. Final count = 4 (originals) + 1 (newly appended)
    // + 1 (orchestration_events_archived emit row from the first run, which
    // itself carries orchestration_id: ORCH_ID and now lives in the live log).
    // The growth-on-re-run invariant is what matters.
    r = runScript(dir);
    assert.equal(r.status, 0);
    const finalLines = readJsonlLines(path.join(archiveDir, 'events.jsonl'));
    assert.ok(finalLines.length >= 5, `archive must grow on re-run (got ${finalLines.length})`);
    for (const obj of finalLines) {
      assert.equal(obj.orchestration_id, ORCH_ID, 'every archived line must match ORCH_ID');
    }
  });

  test('ORCHESTRAY_ORCH_ARCHIVE_DISABLED=1 short-circuits', () => {
    const dir = makeRepo();
    writeCurrentMarker(dir, ORCH_ID);
    writeLiveEvents(dir, ORCH_ID, OTHER_ID);

    const r = runScript(dir, { ORCHESTRAY_ORCH_ARCHIVE_DISABLED: '1' });
    assert.equal(r.status, 0);

    const archive = path.join(dir, '.orchestray', 'history', ORCH_ID, 'events.jsonl');
    assert.ok(!fs.existsSync(archive), 'kill switch must prevent archive creation');
  });

  test('missing current-orchestration.json → silent exit-0, no archive', () => {
    const dir = makeRepo();
    writeLiveEvents(dir, ORCH_ID, OTHER_ID);
    // No current-orchestration.json written.

    const r = runScript(dir);
    assert.equal(r.status, 0);

    const historyDir = path.join(dir, '.orchestray', 'history');
    const entries    = fs.readdirSync(historyDir);
    assert.equal(entries.length, 0, 'no orchestration_id resolved → no archive dir');
  });

  test('atomic write → tmp file is removed even on no-match path (defence-in-depth)', () => {
    const dir = makeRepo();
    writeCurrentMarker(dir, ORCH_ID);
    // Live log has zero ORCH_ID matches.
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
      JSON.stringify({ type: 'agent_start', version: 2, timestamp: '2026-04-28T00:00:01.000Z', orchestration_id: OTHER_ID, agent_type: 'reviewer' }) + '\n',
    );

    const r = runScript(dir);
    assert.equal(r.status, 0);

    const archiveDir = path.join(dir, '.orchestray', 'history', ORCH_ID);
    // No matches → no archive dir created at all.
    assert.ok(!fs.existsSync(archiveDir), 'no matches must not create archive dir');
  });
});
