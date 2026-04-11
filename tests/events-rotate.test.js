#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/events-rotate.js — durable events.jsonl rotation helper.
 *
 * Covers the three-state sentinel state machine (resolved OQ-T2-2):
 *
 *   T1 — fresh cleanup, no prior sentinel
 *   T2 — resumed from "started" (crashed before archive complete)
 *   T3 — resumed from "archived" (crashed after archive, before truncate)
 *   T4 — resumed from "truncated" (crashed after truncate, before sentinel delete)
 *   T5 — multi-orchestration live file (orch-A rows archived, orch-B/C kept)
 *   T6 — belt-and-braces guard (archive exists + live non-empty → skip re-write)
 *   T7 — empty live file (no events for target orch → archive is empty, live is empty)
 *   T8 — fs.truncateSync is NOT used anywhere in the helper source (regression guard)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');

const HELPER = path.resolve(__dirname, '../bin/_lib/events-rotate.js');
const {
  rotateEventsForOrchestration,
  getSentinelFilePath,
  _getLiveEventsPath,
  _getArchivePath,
} = require(HELPER);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmp directory with the standard .orchestray layout.
 */
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-events-rotate-test-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  return dir;
}

/**
 * Build a single JSONL line for an event belonging to the given orchestration.
 */
function makeEvent(orchId, type = 'agent_stop') {
  return JSON.stringify({ orchestration_id: orchId, type, timestamp: new Date().toISOString() });
}

/**
 * Write a JSONL file with the given lines (each on its own line).
 */
function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => l + '\n').join(''), { encoding: 'utf8' });
}

/**
 * Read a JSONL file and return parsed rows. Skips empty/malformed lines.
 */
function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// T1: fresh cleanup, no prior sentinel
// ---------------------------------------------------------------------------

describe('events-rotate', () => {

  test('T1: fresh cleanup — archives orch-A rows, live file retains orch-B rows', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const orchB    = 'orch-B';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);
    const sentinel = getSentinelFilePath(dir, orchA);

    // Plant two orchestrations' worth of events.
    writeJsonl(livePath, [
      makeEvent(orchA, 'orchestration_start'),
      makeEvent(orchB, 'orchestration_start'),
      makeEvent(orchA, 'agent_stop'),
      makeEvent(orchB, 'agent_stop'),
    ]);

    const result = rotateEventsForOrchestration(dir, orchA);

    assert.strictEqual(result.state, 'fresh');
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.archive_path, archPath);
    assert.strictEqual(result.rows_archived, 2);

    // Archive contains only orch-A rows.
    assert.ok(fs.existsSync(archPath), 'archive must exist');
    const archived = readJsonl(archPath);
    assert.strictEqual(archived.length, 2);
    assert.ok(archived.every(r => r.orchestration_id === orchA));

    // Live file contains only orch-B rows.
    const live = readJsonl(livePath);
    assert.strictEqual(live.length, 2);
    assert.ok(live.every(r => r.orchestration_id === orchB));

    // Sentinel is deleted after successful rotation.
    assert.ok(!fs.existsSync(sentinel), 'sentinel must be deleted after fresh rotation');
  });

  // -------------------------------------------------------------------------
  // T2: resumed from "started"
  // -------------------------------------------------------------------------

  test('T2: resumed-started — deletes partial archive, re-runs rotation cleanly', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);
    const sentinel = getSentinelFilePath(dir, orchA);

    // Plant events.
    writeJsonl(livePath, [
      makeEvent(orchA, 'agent_stop'),
      makeEvent(orchA, 'orchestration_complete'),
    ]);

    // Simulate a crash: "started" sentinel exists, partial (incomplete) archive exists.
    fs.mkdirSync(path.dirname(archPath), { recursive: true });
    fs.writeFileSync(archPath, 'PARTIAL_GARBAGE_FROM_CRASH\n');
    fs.writeFileSync(sentinel, JSON.stringify({
      state: 'started',
      orchestration_id: orchA,
      timestamp: new Date().toISOString(),
    }) + '\n');

    const result = rotateEventsForOrchestration(dir, orchA);

    // The recovery path returns 'resumed-started' after cleaning up and re-running.
    assert.strictEqual(result.state, 'resumed-started');
    assert.strictEqual(result.error, null);

    // Archive must now contain only valid orch-A rows (not the garbage from crash).
    assert.ok(fs.existsSync(archPath));
    const archived = readJsonl(archPath);
    assert.strictEqual(archived.length, 2);
    assert.ok(archived.every(r => r.orchestration_id === orchA));

    // Live file should be empty (only orch-A rows were in it).
    const liveContent = fs.readFileSync(livePath, 'utf8').trim();
    assert.strictEqual(liveContent, '', 'live file must be empty after rotating all rows');

    // Sentinel gone.
    assert.ok(!fs.existsSync(sentinel));
  });

  // -------------------------------------------------------------------------
  // T3: resumed from "archived"
  // -------------------------------------------------------------------------

  test('T3: resumed-archived — skips archive re-write, completes truncate', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);
    const sentinel = getSentinelFilePath(dir, orchA);

    // Simulate state just after archive write + fsync but before truncate:
    // - sentinel = "archived"
    // - archive exists with valid data
    // - live file still has orch-A rows (not yet truncated)
    const archiveEvent = makeEvent(orchA, 'agent_stop');
    fs.mkdirSync(path.dirname(archPath), { recursive: true });
    fs.writeFileSync(archPath, archiveEvent + '\n');

    writeJsonl(livePath, [archiveEvent]); // live file still has the un-truncated row

    fs.writeFileSync(sentinel, JSON.stringify({
      state: 'archived',
      orchestration_id: orchA,
      timestamp: new Date().toISOString(),
      archive_path: archPath,
    }) + '\n');

    // Record the archive mtime before calling rotate so we can assert it was NOT re-written.
    const archiveMtimeBefore = fs.statSync(archPath).mtimeMs;

    const result = rotateEventsForOrchestration(dir, orchA);

    assert.strictEqual(result.state, 'resumed-archived');
    assert.strictEqual(result.error, null);

    // Archive was NOT re-written (mtime unchanged).
    const archiveMtimeAfter = fs.statSync(archPath).mtimeMs;
    assert.strictEqual(archiveMtimeBefore, archiveMtimeAfter,
      'archive must not be re-written during resumed-archived recovery');

    // Archive still has the correct content.
    const archived = readJsonl(archPath);
    assert.strictEqual(archived.length, 1);
    assert.strictEqual(archived[0].orchestration_id, orchA);

    // Live file is now empty (truncated).
    const liveContent = fs.readFileSync(livePath, 'utf8').trim();
    assert.strictEqual(liveContent, '');

    // Sentinel gone.
    assert.ok(!fs.existsSync(sentinel));
  });

  // -------------------------------------------------------------------------
  // T4: resumed from "truncated"
  // -------------------------------------------------------------------------

  test('T4: resumed-truncated — only deletes sentinel, no file changes', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);
    const sentinel = getSentinelFilePath(dir, orchA);

    // Post-truncate state: archive exists, live file has only other-orch rows.
    const archiveEvent = makeEvent(orchA, 'orchestration_complete');
    fs.mkdirSync(path.dirname(archPath), { recursive: true });
    fs.writeFileSync(archPath, archiveEvent + '\n');

    // Live file is empty (truncate already done).
    fs.writeFileSync(livePath, '');

    // Plant "truncated" sentinel.
    fs.writeFileSync(sentinel, JSON.stringify({
      state: 'truncated',
      orchestration_id: orchA,
      timestamp: new Date().toISOString(),
    }) + '\n');

    const archiveMtimeBefore = fs.statSync(archPath).mtimeMs;
    const liveMtimeBefore    = fs.statSync(livePath).mtimeMs;

    const result = rotateEventsForOrchestration(dir, orchA);

    assert.strictEqual(result.state, 'resumed-truncated');
    assert.strictEqual(result.error, null);

    // Neither archive nor live file were modified.
    assert.strictEqual(fs.statSync(archPath).mtimeMs, archiveMtimeBefore,
      'archive must not be touched during resumed-truncated');
    assert.strictEqual(fs.statSync(livePath).mtimeMs, liveMtimeBefore,
      'live file must not be touched during resumed-truncated');

    // Sentinel is gone.
    assert.ok(!fs.existsSync(sentinel));
  });

  // -------------------------------------------------------------------------
  // T5: multi-orchestration live file
  // -------------------------------------------------------------------------

  test('T5: multi-orch live file — archives orch-A only, keeps orch-B + orch-C', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const orchB    = 'orch-B';
    const orchC    = 'orch-C';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);

    // Plant 6 events across three orchestrations.
    writeJsonl(livePath, [
      makeEvent(orchA, 'orchestration_start'),
      makeEvent(orchB, 'orchestration_start'),
      makeEvent(orchC, 'orchestration_start'),
      makeEvent(orchA, 'agent_stop'),
      makeEvent(orchB, 'agent_stop'),
      makeEvent(orchC, 'agent_stop'),
    ]);

    const result = rotateEventsForOrchestration(dir, orchA);

    assert.strictEqual(result.state, 'fresh');
    assert.strictEqual(result.rows_archived, 2);

    // Archive has only orch-A rows.
    const archived = readJsonl(archPath);
    assert.strictEqual(archived.length, 2);
    assert.ok(archived.every(r => r.orchestration_id === orchA));

    // Live file has exactly orch-B and orch-C rows (no orch-A rows).
    const live = readJsonl(livePath);
    assert.strictEqual(live.length, 4);
    assert.ok(live.every(r => r.orchestration_id === orchB || r.orchestration_id === orchC));
    assert.ok(!live.some(r => r.orchestration_id === orchA), 'orch-A rows must not remain in live file');

    // Sentinel is gone.
    const sentinel = getSentinelFilePath(dir, orchA);
    assert.ok(!fs.existsSync(sentinel));
  });

  // -------------------------------------------------------------------------
  // T6: belt-and-braces guard (archive exists + live non-empty → skip re-write)
  // -------------------------------------------------------------------------

  test('T6: belt-and-braces — existing archive + non-empty live skips archive re-write', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);

    // Plant a pre-existing archive (as if a previous rotation wrote it but the
    // sentinel was lost before the truncate step).
    const archiveEvent = makeEvent(orchA, 'agent_stop');
    fs.mkdirSync(path.dirname(archPath), { recursive: true });
    fs.writeFileSync(archPath, archiveEvent + '\n');
    const archiveMtimeBefore = fs.statSync(archPath).mtimeMs;

    // Live file still has the un-truncated orch-A row (no sentinel present).
    writeJsonl(livePath, [archiveEvent]);

    // No sentinel — rotation sees "no sentinel, but archive exists + live non-empty"
    // and should skip the archive-write (belt-and-braces path).
    const result = rotateEventsForOrchestration(dir, orchA);

    assert.ok(result.error === null, 'must succeed without error');

    // Archive was NOT re-written.
    const archiveMtimeAfter = fs.statSync(archPath).mtimeMs;
    assert.strictEqual(archiveMtimeBefore, archiveMtimeAfter,
      'archive must not be re-written in belt-and-braces path');

    // Live file is now empty after truncate.
    const liveContent = fs.readFileSync(livePath, 'utf8').trim();
    assert.strictEqual(liveContent, '');

    // Sentinel gone.
    assert.ok(!fs.existsSync(getSentinelFilePath(dir, orchA)));
  });

  // -------------------------------------------------------------------------
  // T7: empty live file (no events for target orch → empty archive, empty live)
  // -------------------------------------------------------------------------

  test('T7: empty live file — produces empty archive, live stays empty', () => {
    const dir      = makeDir();
    const orchA    = 'orch-A';
    const livePath = _getLiveEventsPath(dir);
    const archPath = _getArchivePath(dir, orchA);

    // Live file is present but empty.
    fs.writeFileSync(livePath, '');

    const result = rotateEventsForOrchestration(dir, orchA);

    assert.strictEqual(result.state, 'fresh');
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.rows_archived, 0);

    // Archive exists but is empty.
    assert.ok(fs.existsSync(archPath));
    assert.strictEqual(fs.readFileSync(archPath, 'utf8').trim(), '');

    // Live file is empty.
    assert.strictEqual(fs.readFileSync(livePath, 'utf8').trim(), '');

    // Sentinel gone.
    assert.ok(!fs.existsSync(getSentinelFilePath(dir, orchA)));
  });

  // -------------------------------------------------------------------------
  // T8: fs.truncateSync is NOT used — regression guard
  // -------------------------------------------------------------------------

  test('T8: events-rotate.js must not use fs.truncateSync in executable code (regression guard)', () => {
    const source = fs.readFileSync(HELPER, 'utf8');
    // Filter out comment lines (lines starting with // or * after optional whitespace)
    // so that documentation explicitly saying "do NOT use fs.truncateSync" doesn't
    // trip the test.
    const codeLines = source.split('\n').filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });
    const codeOnly = codeLines.join('\n');
    const hits = (codeOnly.match(/fs\.truncateSync/g) || []).length;
    assert.strictEqual(hits, 0,
      'events-rotate.js must not call fs.truncateSync in executable code; use rename-dance instead. ' +
      `Found ${hits} occurrence(s) in non-comment lines.`
    );
  });

});
