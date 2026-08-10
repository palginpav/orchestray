#!/usr/bin/env node
'use strict';

/**
 * Tests for `repairArchiveBareEventRows` — the v2.3.24 ARCHIVE-scoped sibling
 * of `repairBareEventRows` in bin/_lib/normalize-bare-event-rows.js.
 *
 * Runner: node --test bin/_lib/__tests__/repair-bare-event-archive.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const crypto = require('node:crypto');

const {
  repairArchiveBareEventRows,
  discoverArchiveEventFiles,
  isArchiveRepairDisabled,
  _verifyRepairedFile,
  ARCHIVE_ENV_DISABLED,
} = require('../normalize-bare-event-rows');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bare-event-archive-test-'));
});

afterEach(() => {
  delete process.env[ARCHIVE_ENV_DISABLED];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function historyEventsPath(runDir) {
  return path.join(tmpDir, '.orchestray', 'history', runDir, 'events.jsonl');
}

function writeArchive(runDir, lines) {
  const p = historyEventsPath(runDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return p;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readEvents(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return { __malformed: l }; }
  });
}

// ---------------------------------------------------------------------------
// discoverArchiveEventFiles
// ---------------------------------------------------------------------------

describe('discoverArchiveEventFiles', () => {
  test('missing history dir → empty array, no throw', () => {
    assert.deepEqual(discoverArchiveEventFiles(tmpDir), []);
  });

  test('finds one events.jsonl per run dir, ignores run dirs without one', () => {
    writeArchive('run-a', [JSON.stringify({ type: 'x' })]);
    writeArchive('run-b', [JSON.stringify({ type: 'y' })]);
    fs.mkdirSync(path.join(tmpDir, '.orchestray', 'history', 'run-c-no-events'), { recursive: true });

    const found = discoverArchiveEventFiles(tmpDir);
    assert.equal(found.length, 2);
    assert.ok(found.every((f) => f.endsWith('events.jsonl')));
  });
});

// ---------------------------------------------------------------------------
// repairArchiveBareEventRows — end to end
// ---------------------------------------------------------------------------

describe('repairArchiveBareEventRows', () => {
  test('no history dir → ran true, zero files, no-op', () => {
    const result = repairArchiveBareEventRows(tmpDir, {});
    assert.equal(result.ran, true);
    assert.equal(result.filesScanned, 0);
    assert.equal(result.filesChanged, 0);
    assert.equal(result.halted, false);
  });

  test('a fixture archive is repaired end-to-end: bare rows renamed, malformed/both-keys preserved, row count unchanged', () => {
    const bothKeysRow = { type: 'hook_chain_drift_detected', event: 'PreToolUse', x: 1 };
    const malformedLine = '{"event":"broken", not json';
    const p = writeArchive('orch-fixture-1', [
      JSON.stringify({ event: 'task_completed', orchestration_id: 'o-1' }),
      JSON.stringify({ type: 'orchestration_start', orchestration_id: 'o-2' }),
      JSON.stringify(bothKeysRow),
      malformedLine,
      JSON.stringify({ event: 'agent_stop', orchestration_id: 'o-3' }),
    ]);
    const beforeHash = sha256(p);

    const result = repairArchiveBareEventRows(tmpDir, {});

    assert.equal(result.ran, true);
    assert.equal(result.halted, false);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.filesChanged, 1);
    assert.equal(result.rowsRepaired, 2, 'two bare-event rows backfilled');
    assert.equal(result.rowsMalformed, 1);
    assert.equal(result.rowsBothKeys, 1);
    assert.equal(result.verificationFailures, 0);
    assert.equal(result.perFile.length, 1);
    assert.equal(result.perFile[0].verified, true);
    assert.equal(result.perFile[0].totalLines, 5, 'row count unchanged');
    assert.ok(result.reportPath, 'report written');
    assert.ok(fs.existsSync(path.join(tmpDir, result.reportPath)), 'report file exists on disk');

    const afterHash = sha256(p);
    assert.notEqual(beforeHash, afterHash, 'file content did change (backfill happened)');

    const events = readEvents(p);
    assert.equal(events.length, 5, 'row count unchanged after repair');
    assert.equal(events[0].type, 'task_completed');
    assert.equal(events[0].event, undefined);
    assert.equal(events[1].type, 'orchestration_start');
    assert.deepEqual(events[2], bothKeysRow, 'both-keys row byte-for-byte preserved');
    assert.equal(events[3].__malformed, malformedLine, 'malformed line preserved verbatim');
    assert.equal(events[4].type, 'agent_stop');

    // Backup exists and, restored, hashes back to the pre-repair content —
    // proves the backup is a faithful snapshot, not just "a file that exists".
    const auditDir = path.dirname(p);
    const backupFile = fs.readdirSync(auditDir).find((f) => f.startsWith('events.jsonl.bak-'));
    assert.ok(backupFile, 'backup file created');
    const backupPath = path.join(auditDir, backupFile);
    const backupHash = sha256(backupPath);
    assert.equal(backupHash, beforeHash, 'backup is byte-identical to the pre-repair file (verified by sha256)');
  });

  test('multiple archives: per-file counts are independent and correct', () => {
    const pA = writeArchive('run-a', [
      JSON.stringify({ event: 'x', orchestration_id: 'o-1' }),
      JSON.stringify({ event: 'y', orchestration_id: 'o-2' }),
    ]);
    const pB = writeArchive('run-b', [
      JSON.stringify({ type: 'clean', orchestration_id: 'o-3' }),
    ]);

    const result = repairArchiveBareEventRows(tmpDir, {});

    assert.equal(result.filesScanned, 2);
    assert.equal(result.filesChanged, 1, 'only run-a needed a rewrite');
    assert.equal(result.rowsRepaired, 2);

    const rowA = result.perFile.find((f) => f.relPath.includes('run-a'));
    const rowB = result.perFile.find((f) => f.relPath.includes('run-b'));
    assert.equal(rowA.changed, true);
    assert.equal(rowA.backfilled, 2);
    assert.equal(rowB.changed, false, 'already-clean file left untouched');
    assert.equal(rowB.backfilled, 0);

    assert.equal(readEvents(pA).length, 2);
    assert.equal(readEvents(pB).length, 1);
  });

  test('idempotent: second run is a no-op, byte-identical, no new backup', () => {
    const p = writeArchive('run-a', [
      JSON.stringify({ event: 'task_completed', orchestration_id: 'o-1' }),
      JSON.stringify({ type: 'clean', orchestration_id: 'o-2' }),
    ]);

    const first = repairArchiveBareEventRows(tmpDir, {});
    assert.equal(first.filesChanged, 1);
    const hashAfterFirst = sha256(p);

    const second = repairArchiveBareEventRows(tmpDir, {});
    assert.equal(second.filesChanged, 0, 'nothing left to backfill');
    assert.equal(second.rowsRepaired, 0);
    const hashAfterSecond = sha256(p);

    assert.equal(hashAfterFirst, hashAfterSecond, 'second run must not alter the file');

    const auditDir = path.dirname(p);
    const backups = fs.readdirSync(auditDir).filter((f) => f.startsWith('events.jsonl.bak-'));
    assert.equal(backups.length, 1, 'exactly one backup, from the first (real) run');
  });

  test('dry run: reports what would change, writes nothing, no backup, no report', () => {
    const p = writeArchive('run-a', [
      JSON.stringify({ event: 'task_completed', orchestration_id: 'o-1' }),
    ]);
    const beforeHash = sha256(p);

    const result = repairArchiveBareEventRows(tmpDir, { dryRun: true });

    assert.equal(result.filesChanged, 1, 'dry run still reports the file as WOULD change');
    assert.equal(result.rowsRepaired, 1);
    assert.equal(result.reportPath, null, 'dry run does not write a report');

    const afterHash = sha256(p);
    assert.equal(beforeHash, afterHash, 'dry run must not touch the file');

    const auditDir = path.dirname(p);
    assert.ok(!fs.existsSync(auditDir) || fs.readdirSync(auditDir).filter((f) => f.startsWith('events.jsonl.bak-')).length === 0);
  });

  test('kill switch (env): disables the repair, files left completely untouched', () => {
    const p = writeArchive('run-a', [JSON.stringify({ event: 'x', orchestration_id: 'o-1' })]);
    const beforeHash = sha256(p);

    process.env[ARCHIVE_ENV_DISABLED] = '1';
    const result = repairArchiveBareEventRows(tmpDir, {});

    assert.equal(result.disabled, true);
    assert.equal(result.ran, false);
    assert.equal(sha256(p), beforeHash, 'file untouched while disabled');
  });

  test('kill switch (config.json): disables the repair', () => {
    fs.mkdirSync(path.join(tmpDir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'config.json'),
      JSON.stringify({ bare_event_key_archive_repair: { enabled: false } }),
      'utf8'
    );
    writeArchive('run-a', [JSON.stringify({ event: 'x', orchestration_id: 'o-1' })]);

    assert.equal(isArchiveRepairDisabled(tmpDir), true);
    const result = repairArchiveBareEventRows(tmpDir, {});
    assert.equal(result.disabled, true);
  });

  test('kill switch is independent from the live-log repair kill switch', () => {
    // Setting the LIVE kill switch must not disable the archive repair.
    process.env.ORCHESTRAY_BARE_EVENT_REPAIR_DISABLED = '1';
    writeArchive('run-a', [JSON.stringify({ event: 'x', orchestration_id: 'o-1' })]);

    const result = repairArchiveBareEventRows(tmpDir, {});
    assert.equal(result.disabled, false, 'archive repair has its own independent kill switch');
    assert.equal(result.filesChanged, 1);

    delete process.env.ORCHESTRAY_BARE_EVENT_REPAIR_DISABLED;
  });

  test('an unreadable-history-dir edge case does not throw', () => {
    // history dir exists but is a file, not a directory — readdirSync throws ENOTDIR.
    fs.mkdirSync(path.join(tmpDir, '.orchestray'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.orchestray', 'history'), 'not a directory', 'utf8');

    const result = repairArchiveBareEventRows(tmpDir, {});
    assert.equal(result.filesScanned, 0);
    assert.equal(result.halted, false);
  });
});

// ---------------------------------------------------------------------------
// _verifyRepairedFile — independent post-write check
// ---------------------------------------------------------------------------

describe('_verifyRepairedFile', () => {
  test('passes when the repaired file matches classifyLine expectations exactly', () => {
    const backupPath = path.join(tmpDir, 'backup.jsonl');
    const repairedPath = path.join(tmpDir, 'repaired.jsonl');
    fs.writeFileSync(backupPath, '{"event":"x","o":1}\n{"type":"y","o":2}\n', 'utf8');
    fs.writeFileSync(repairedPath, '{"type":"x","o":1}\n{"type":"y","o":2}\n', 'utf8');

    const result = _verifyRepairedFile(backupPath, repairedPath);
    assert.equal(result.ok, true);
    assert.equal(result.rows, 2);
  });

  test('fails on row count mismatch', () => {
    const backupPath = path.join(tmpDir, 'backup.jsonl');
    const repairedPath = path.join(tmpDir, 'repaired.jsonl');
    fs.writeFileSync(backupPath, '{"event":"x","o":1}\n{"type":"y","o":2}\n', 'utf8');
    fs.writeFileSync(repairedPath, '{"type":"x","o":1}\n', 'utf8');

    const result = _verifyRepairedFile(backupPath, repairedPath);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'row_count_mismatch');
    assert.equal(result.expected, 2);
    assert.equal(result.actual, 1);
  });

  test('fails when a non-backfill line was unexpectedly mutated', () => {
    const backupPath = path.join(tmpDir, 'backup.jsonl');
    const repairedPath = path.join(tmpDir, 'repaired.jsonl');
    fs.writeFileSync(backupPath, '{"type":"y","o":2}\n', 'utf8');
    fs.writeFileSync(repairedPath, '{"type":"y","o":999}\n', 'utf8');

    const result = _verifyRepairedFile(backupPath, repairedPath);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'line_mismatch');
    assert.equal(result.line, 1);
  });
});
