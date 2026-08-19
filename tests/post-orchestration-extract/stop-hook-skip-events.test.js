#!/usr/bin/env node
'use strict';

/**
 * stop-hook-skip-events.test.js — v2.3.30 W-fix.
 *
 * Covers: `bin/post-orchestration-extract-on-stop.js`'s bare-return branch
 * (`processStop()`) now emits a `pattern_extraction_skipped` event
 * distinguishing skip reasons, instead of returning silently with zero
 * audit trace (see .orchestray/kb/artifacts/v2330-learn-extraction-diagnosis.md F3).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const { findFreshArchive, processStop } = require(
  path.join(PROJECT_ROOT, 'bin', 'post-orchestration-extract-on-stop')
);

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-stop-hook-'));
  cleanup.push(dir);
  return dir;
}

function readEvents(projectRoot) {
  const p = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

describe('post-orchestration-extract-on-stop skip events', () => {
  test('no .orchestray/history/ at all -> skip event with reason no_history_dir', () => {
    const root = mkProject();
    processStop(root);
    const events = readEvents(root).filter(e => e.type === 'pattern_extraction_skipped');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'no_history_dir');
    assert.equal(events[0].source, 'stop_hook_scan');
  });

  test('history/ exists but empty -> skip event with reason no_fresh_candidate', () => {
    const root = mkProject();
    fs.mkdirSync(path.join(root, '.orchestray', 'history'), { recursive: true });
    processStop(root);
    const events = readEvents(root).filter(e => e.type === 'pattern_extraction_skipped');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'no_fresh_candidate');
  });

  test('fresh archive already has .extracted marker -> skip event with reason already_extracted', () => {
    const root = mkProject();
    const archiveDir = path.join(root, '.orchestray', 'history', 'orch-test-1');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'events.jsonl'),
      JSON.stringify({ type: 'orchestration_complete', orchestration_id: 'orch-test-1' }) + '\n'
    );
    fs.writeFileSync(path.join(archiveDir, '.extracted'), new Date().toISOString() + '\n');
    processStop(root);
    const events = readEvents(root).filter(e => e.type === 'pattern_extraction_skipped');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'already_extracted');
  });

  test('emit failure inside skip path does not throw / does not break the caller', () => {
    const root = mkProject();
    // Force writeEvent to fail by pointing cwd resolution at an unwritable path
    // via an invalid audit dir (file where a directory is expected).
    const auditParent = path.join(root, '.orchestray');
    fs.mkdirSync(auditParent, { recursive: true });
    // Make '.orchestray/audit' a file, not a dir, so mkdirSync inside writeEvent fails.
    fs.writeFileSync(path.join(auditParent, 'audit'), 'not a directory');
    assert.doesNotThrow(() => processStop(root));
  });

  test('findFreshArchive return shape includes archive:null + skipReason string', () => {
    const root = mkProject();
    const result = findFreshArchive(root);
    assert.equal(result.archive, null);
    assert.equal(typeof result.skipReason, 'string');
  });
});
