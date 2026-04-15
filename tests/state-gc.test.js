#!/usr/bin/env node
'use strict';

/**
 * W5 tests — /orchestray:state gc subcommand (2018-UX4b)
 *
 * Tests:
 *   A — dry-run reports leaked dirs without mutation (mtimes unchanged)
 *   B — archive mode renames orch-X → orch-X-abandoned
 *   C — archive is idempotent: orch-X-abandoned stays orch-X-abandoned on second run
 *   D — discard mode (explicit) rm-rfs the dir
 *   E — --keep-days threshold: 1-hour-old dir with no orchestration_complete is NOT leaked
 *         under default keep_days=7
 *   F — completed dir (has orchestration_complete) is NEVER leaked regardless of age
 *   G — state_gc_run event appended after run (assert file contents)
 *   H — timestamp-only rows correctly detected (W1 symmetry)
 *   I — ts-only rows correctly detected (W1 symmetry / fallback)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const GC_SCRIPT = path.resolve(__dirname, '../bin/state-gc.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp project directory with a .orchestray/history structure.
 * Returns { projectDir, historyDir, auditEventsPath }.
 */
function makeProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w5-gc-'));
  cleanup.push(projectDir);
  const historyDir = path.join(projectDir, '.orchestray', 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const auditDir = path.join(projectDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const auditEventsPath = path.join(auditDir, 'events.jsonl');
  return { projectDir, historyDir, auditEventsPath };
}

/**
 * Create an `orch-*` directory under historyDir with an events.jsonl.
 *
 * @param {string} historyDir - path to .orchestray/history
 * @param {string} name - directory name (e.g. 'orch-abc123')
 * @param {object[]} events - array of event objects to write
 * @param {Date|null} overrideTimestamp - if provided, set the file mtime to this
 */
function makeOrchDir(historyDir, name, events, overrideTimestamp = null) {
  const dirPath = path.join(historyDir, name);
  fs.mkdirSync(dirPath, { recursive: true });
  const eventsPath = path.join(dirPath, 'events.jsonl');
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(eventsPath, content);
  if (overrideTimestamp) {
    // Set atime and mtime to simulate age. This is a best-effort; the
    // events.jsonl timestamp fields are what state-gc actually reads.
    try { fs.utimesSync(eventsPath, overrideTimestamp, overrideTimestamp); } catch (_e) {}
  }
  return dirPath;
}

/** Make a timestamp N days ago. */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/** Make a timestamp N hours ago. */
function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

/** Read JSONL file and return parsed event objects. */
function readEvents(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Run state-gc.js with given args, return spawnSync result. */
function runGc(args) {
  return spawnSync(process.execPath, [GC_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// Test A — dry-run reports leaked dirs without mutation
// ---------------------------------------------------------------------------

describe('W5 state-gc — dry-run', () => {

  test('A: dry-run lists leaked dirs and does NOT rename them', () => {
    const { projectDir, historyDir, auditEventsPath } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-leaked-001', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-leaked-001' },
    ]);

    const result = runGc(['--dry-run', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(result.stdout.includes('orch-leaked-001'), 'dry-run output must list the leaked dir');
    assert.ok(result.stdout.includes('[dry-run]'), 'dry-run output must carry the [dry-run] prefix');

    // The original dir must still exist (no mutation)
    assert.ok(fs.existsSync(dirPath), 'original dir must still exist after dry-run');
    assert.ok(!fs.existsSync(dirPath + '-abandoned'), 'no -abandoned dir must be created during dry-run');

    // state_gc_run audit event must be written
    const events = readEvents(auditEventsPath);
    const gcEvent = events.find((e) => e.type === 'state_gc_run');
    assert.ok(gcEvent, 'state_gc_run event must be written after dry-run');
    assert.equal(gcEvent.dry_run, true, 'dry_run field must be true');
    assert.equal(gcEvent.archived, 0, 'archived must be 0 in dry-run');
    assert.equal(gcEvent.discarded, 0, 'discarded must be 0 in dry-run');
  });

  test('A-variant: no --mode flag also triggers dry-run (safety default)', () => {
    const { projectDir, historyDir } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-safety-default', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-safety-default' },
    ]);

    // No --dry-run flag and no --mode flag → must default to dry-run
    const result = runGc([projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(result.stdout.includes('[dry-run]'), 'no --mode flag must trigger dry-run by default');
    assert.ok(fs.existsSync(dirPath), 'dir must not be renamed without explicit --mode');
  });

});

// ---------------------------------------------------------------------------
// Test B — archive mode renames orch-X → orch-X-abandoned
// ---------------------------------------------------------------------------

describe('W5 state-gc — archive mode', () => {

  test('B: archive mode renames leaked dir to <dir>-abandoned', () => {
    const { projectDir, historyDir, auditEventsPath } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-to-archive', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-to-archive' },
    ]);
    const expectedDest = dirPath + '-abandoned';

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(!fs.existsSync(dirPath), 'original dir must be gone after archive');
    assert.ok(fs.existsSync(expectedDest), 'abandoned dir must exist after archive');

    // events.jsonl must be preserved inside the archived dir
    assert.ok(
      fs.existsSync(path.join(expectedDest, 'events.jsonl')),
      'events.jsonl must be preserved inside archived dir'
    );

    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 1 dirs'), 'summary must report 1 archived');
    assert.ok(summaryLine.includes('discarded 0 dirs'), 'summary must report 0 discarded');

    // state_gc_run audit event
    const events = readEvents(auditEventsPath);
    const gcEvent = events.find((e) => e.type === 'state_gc_run');
    assert.ok(gcEvent, 'state_gc_run event must be written');
    assert.equal(gcEvent.dry_run, false, 'dry_run must be false for mutating run');
    assert.equal(gcEvent.archived, 1);
    assert.equal(gcEvent.discarded, 0);
  });

  // ---------------------------------------------------------------------------
  // Test C — archive is idempotent
  // ---------------------------------------------------------------------------

  test('C: archive is idempotent — orch-X-abandoned stays orch-X-abandoned on second run', () => {
    const { projectDir, historyDir } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    // Create the dir already with the -abandoned suffix (simulating a prior run).
    const abandonedPath = makeOrchDir(historyDir, 'orch-already-done-abandoned', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-already-done' },
    ]);

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');

    // The -abandoned dir must still exist unchanged
    assert.ok(fs.existsSync(abandonedPath), 'already-abandoned dir must still exist');
    // No double-suffix should be created
    assert.ok(!fs.existsSync(abandonedPath + '-abandoned'), 'must not double-suffix an already-abandoned dir');

    // archived count must reflect the idempotent re-archive as archived=1
    // (it was already leaked — just already renamed — so we count it as archived).
    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 1 dirs'), 'idempotent second run must report archived=1');
  });

});

// ---------------------------------------------------------------------------
// Test D — discard mode rm-rfs the dir
// ---------------------------------------------------------------------------

describe('W5 state-gc — discard mode', () => {

  test('D: discard mode rm-rfs the leaked dir (explicit --mode=discard required)', () => {
    const { projectDir, historyDir, auditEventsPath } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-to-discard', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-to-discard' },
    ]);

    const result = runGc(['--mode=discard', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(!fs.existsSync(dirPath), 'dir must be gone after discard');

    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('discarded 1 dirs'), 'summary must report 1 discarded');
    assert.ok(summaryLine.includes('archived 0 dirs'), 'summary must report 0 archived');

    // Per-directory state_gc_discarded event
    const events = readEvents(auditEventsPath);
    const discardedEvent = events.find((e) => e.type === 'state_gc_discarded');
    assert.ok(discardedEvent, 'state_gc_discarded event must be written per discarded dir');
    assert.equal(discardedEvent.dir, 'orch-to-discard', 'discarded event must name the dir');

    // Summary state_gc_run event
    const gcEvent = events.find((e) => e.type === 'state_gc_run');
    assert.ok(gcEvent, 'state_gc_run summary event must be written');
    assert.equal(gcEvent.discarded, 1);
    assert.equal(gcEvent.archived, 0);
  });

});

// ---------------------------------------------------------------------------
// Test E — --keep-days threshold respected
// ---------------------------------------------------------------------------

describe('W5 state-gc — keep-days threshold', () => {

  test('E: 1-hour-old dir with no orchestration_complete is NOT leaked under default keep_days=7', () => {
    const { projectDir, historyDir } = makeProject();

    const recentTs = hoursAgo(1).toISOString(); // only 1 hour old
    const dirPath = makeOrchDir(historyDir, 'orch-recent-no-complete', [
      { timestamp: recentTs, type: 'orchestration_start', orchestration_id: 'orch-recent' },
      // No orchestration_complete event
    ]);

    // Default keep_days=7: 1 hour < 7 days, so NOT leaked
    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    // Dir must NOT have been archived
    assert.ok(fs.existsSync(dirPath), 'recent dir must NOT be archived under default keep-days=7');
    assert.ok(!fs.existsSync(dirPath + '-abandoned'), 'no -abandoned dir must exist for recent dir');

    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 0 dirs'), 'no dirs must be archived when all are active');
    assert.ok(summaryLine.includes('skipped 1 active'), 'recent dir must be counted as skipped active');
  });

  test('E-variant: --keep-days=0 makes even 1-minute-old dirs leaked', () => {
    const { projectDir, historyDir } = makeProject();

    const veryRecentTs = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    makeOrchDir(historyDir, 'orch-very-recent', [
      { timestamp: veryRecentTs, type: 'orchestration_start', orchestration_id: 'orch-very-recent' },
    ]);

    const result = runGc(['--keep-days=0', '--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    const summaryLine = result.stdout.trim().split('\n').pop();
    // With keep-days=0, even very recent dirs are leaked
    assert.ok(summaryLine.includes('archived 1 dirs'), 'all dirs leaked when keep-days=0');
  });

});

// ---------------------------------------------------------------------------
// Test F — completed dir is NEVER leaked
// ---------------------------------------------------------------------------

describe('W5 state-gc — completed dir protection', () => {

  test('F: completed dir (has orchestration_complete) is never leaked regardless of age', () => {
    const { projectDir, historyDir } = makeProject();

    const oldTs = daysAgo(30).toISOString(); // very old
    const dirPath = makeOrchDir(historyDir, 'orch-completed', [
      { timestamp: daysAgo(31).toISOString(), type: 'orchestration_start', orchestration_id: 'orch-completed' },
      { timestamp: oldTs, type: 'orchestration_complete', orchestration_id: 'orch-completed', status: 'success' },
    ]);

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(fs.existsSync(dirPath), 'completed dir must NOT be archived regardless of age');
    assert.ok(!fs.existsSync(dirPath + '-abandoned'), 'no -abandoned dir for completed orch');

    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 0 dirs'), 'completed dir must not be archived');
    assert.ok(summaryLine.includes('skipped 1 active'), 'completed dir counted as skipped (active/complete)');
  });

});

// ---------------------------------------------------------------------------
// Test G — state_gc_run event appended after run
// ---------------------------------------------------------------------------

describe('W5 state-gc — audit event emission', () => {

  test('G: state_gc_run event is appended with correct fields after an archive run', () => {
    const { projectDir, historyDir, auditEventsPath } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    makeOrchDir(historyDir, 'orch-for-audit-test', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-for-audit-test' },
    ]);

    const beforeRunMs = Date.now();
    runGc(['--mode=archive', '--keep-days=7', projectDir]);
    const afterRunMs = Date.now();

    assert.ok(fs.existsSync(auditEventsPath), 'audit events file must exist after run');

    const events = readEvents(auditEventsPath);
    const gcEvent = events.find((e) => e.type === 'state_gc_run');
    assert.ok(gcEvent, 'state_gc_run event must be present');

    // Verify all required fields
    assert.equal(gcEvent.mode, 'archive', 'mode must be archive');
    assert.equal(gcEvent.dry_run, false, 'dry_run must be false');
    assert.equal(gcEvent.keep_days, 7, 'keep_days must match');
    assert.equal(gcEvent.archived, 1, 'archived must be 1');
    assert.equal(gcEvent.discarded, 0, 'discarded must be 0');
    assert.ok(typeof gcEvent.skipped_active === 'number', 'skipped_active must be a number');
    assert.ok(typeof gcEvent.timestamp === 'string', 'timestamp must be present');
    assert.ok(gcEvent.timestamp.endsWith('Z'), 'timestamp must be ISO 8601 UTC');

    // Timestamp must fall within the run window
    const evTs = new Date(gcEvent.timestamp).getTime();
    assert.ok(evTs >= beforeRunMs - 1000, 'timestamp must not be before run started');
    assert.ok(evTs <= afterRunMs + 1000, 'timestamp must not be after run ended');
  });

  test('G-variant: dry-run also appends state_gc_run event with dry_run=true', () => {
    const { projectDir, historyDir, auditEventsPath } = makeProject();

    makeOrchDir(historyDir, 'orch-for-dry-audit', [
      { timestamp: daysAgo(10).toISOString(), type: 'orchestration_start', orchestration_id: 'orch-dry' },
    ]);

    runGc(['--dry-run', projectDir]);

    const events = readEvents(auditEventsPath);
    const gcEvent = events.find((e) => e.type === 'state_gc_run');
    assert.ok(gcEvent, 'state_gc_run must be written even in dry-run');
    assert.equal(gcEvent.dry_run, true, 'dry_run must be true');
  });

});

// ---------------------------------------------------------------------------
// Test H — timestamp-only rows correctly detected (W1 symmetry)
// ---------------------------------------------------------------------------

describe('W5 state-gc — timestamp field normalization', () => {

  test('H: timestamp-only event rows (no ts field) are correctly detected', () => {
    const { projectDir, historyDir } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-timestamp-only', [
      // Uses canonical `timestamp` field only (W1 format)
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-ts-only' },
    ]);

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(!fs.existsSync(dirPath), 'timestamp-only old dir must be archived');
    assert.ok(fs.existsSync(dirPath + '-abandoned'), 'abandoned dir must exist');
  });

  // ---------------------------------------------------------------------------
  // Test I — ts-only rows correctly detected (fallback per history_scan pattern)
  // ---------------------------------------------------------------------------

  test('I: ts-only event rows (no timestamp field) are correctly detected via fallback', () => {
    const { projectDir, historyDir } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-ts-fallback', [
      // Uses legacy `ts` field only (old format, W1 fallback)
      { ts: oldTs, type: 'orchestration_start', orchestration_id: 'orch-ts-fallback' },
    ]);

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(!fs.existsSync(dirPath), 'ts-fallback old dir must be archived');
    assert.ok(fs.existsSync(dirPath + '-abandoned'), 'abandoned dir must exist for ts-fallback dir');
  });

  test('H+I symmetry: mixed timestamp/ts rows pick the latest across both fields', () => {
    const { projectDir, historyDir } = makeProject();

    const oldTs = daysAgo(10).toISOString();
    // Mix of timestamp and ts fields; the most recent one (ts) is only 1 hour old.
    const recentTs = hoursAgo(1).toISOString();
    const dirPath = makeOrchDir(historyDir, 'orch-mixed-ts', [
      { timestamp: oldTs, type: 'orchestration_start', orchestration_id: 'orch-mixed' },
      { ts: recentTs, type: 'agent_start' }, // ts-only, recent
    ]);

    // Default keep-days=7: latest event (1 hour ago) is active → NOT leaked
    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(fs.existsSync(dirPath), 'mixed-ts dir with recent ts event must NOT be archived');
    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 0 dirs'), 'recent ts event keeps the dir active');
  });

});

// ---------------------------------------------------------------------------
// Edge case: no history dir at all
// ---------------------------------------------------------------------------

describe('W5 state-gc — edge cases', () => {

  test('no .orchestray/history dir: exits 0 with zero counts', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w5-empty-'));
    cleanup.push(projectDir);
    // Don't create the history dir at all

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 0 dirs'), 'no dirs to archive');
    assert.ok(summaryLine.includes('discarded 0 dirs'), 'no dirs to discard');
    assert.ok(summaryLine.includes('skipped 0 active'), 'no active dirs');
  });

  test('non-orch-* dirs in history are ignored', () => {
    const { projectDir, historyDir } = makeProject();

    // Create a dir that does NOT match orch-* pattern
    const nonOrchDir = path.join(historyDir, 'other-dir');
    fs.mkdirSync(nonOrchDir, { recursive: true });
    const oldTs = daysAgo(10).toISOString();
    fs.writeFileSync(
      path.join(nonOrchDir, 'events.jsonl'),
      JSON.stringify({ timestamp: oldTs, type: 'orchestration_start' }) + '\n'
    );

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(fs.existsSync(nonOrchDir), 'non-orch-* dir must be ignored');
    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 0 dirs'), 'non-orch dir must not be counted');
  });

  test('dir without events.jsonl is skipped (conservative)', () => {
    const { projectDir, historyDir } = makeProject();

    // Create an orch-* dir but no events.jsonl
    const emptyOrchDir = path.join(historyDir, 'orch-no-events');
    fs.mkdirSync(emptyOrchDir, { recursive: true });

    const result = runGc(['--mode=archive', projectDir]);

    assert.equal(result.status, 0, 'exit code must be 0');
    assert.ok(fs.existsSync(emptyOrchDir), 'dir without events.jsonl must not be touched');
    const summaryLine = result.stdout.trim().split('\n').pop();
    assert.ok(summaryLine.includes('archived 0 dirs'), 'dir without events.jsonl is not archived');
  });

});
