#!/usr/bin/env node
'use strict';

/**
 * Regression test for the redirect-kb-write.js index.json lost-update race
 * (.orchestray/kb/artifacts/v2330-kb-index-drift-diagnosis.md Finding 3).
 *
 * Reproduces the race with TWO REAL OS PROCESSES (spawned via
 * child_process.spawn, not in-process Promises — Node's single-threaded
 * event loop would mask an in-process race) against a disposable copy of
 * index.json in a temp dir. Never touches the live .orchestray/kb/index.json.
 *
 *   - "before" case: two "unlocked" workers (verbatim pre-fix logic) race —
 *     asserts one entry is lost (the proven bug).
 *   - "after" case: two "locked" workers (the real, fixed autoAppendKbIndex)
 *     race — asserts both entries survive (the fix).
 *   - fail-open on lock-timeout / stale-lock reclaim are covered separately
 *     below via direct, single-process calls.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const WORKER = path.resolve(__dirname, '_fixtures/kb-index-race-worker.js');
const { autoAppendKbIndex } = require('../../bin/redirect-kb-write.js');

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-race-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  const indexPath = path.join(dir, '.orchestray', 'kb', 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({ version: '1.0', entries: [] }, null, 2));
  return { dir, indexPath };
}

function spawnWorker(mode, indexPath, slug, delayMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, mode, indexPath, slug, String(delayMs)], {
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code));
  });
}

test('BEFORE FIX: two unlocked processes racing on index.json lose an entry (Finding 3, reproduced)', async () => {
  const { dir, indexPath } = mkTmpProject();
  try {
    // Same shape as the diagnosis's probe 2: one process 250ms slower than the other.
    const [codeA, codeB] = await Promise.all([
      spawnWorker('unlocked', indexPath, 'slugA', 300),
      spawnWorker('unlocked', indexPath, 'slugB', 50),
    ]);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);

    const final = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    // The proven bug: only one of the two entries survives.
    assert.equal(final.entries.length, 1, 'expected the unlocked race to lose one entry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AFTER FIX: two locked processes racing on index.json both survive (advisory lock closes the race)', async () => {
  const { dir, indexPath } = mkTmpProject();
  try {
    const [codeA, codeB] = await Promise.all([
      spawnWorker('locked', indexPath, 'slugA', 300),
      spawnWorker('locked', indexPath, 'slugB', 50),
    ]);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);

    const final = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const slugs = final.entries.map((e) => e.slug).sort();
    assert.deepEqual(slugs, ['slugA', 'slugB'], 'expected both entries to survive under the lock');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-open: lock acquisition timeout skips the append without throwing', () => {
  const { dir, indexPath } = mkTmpProject();
  try {
    const lockPath = indexPath + '.lock';
    // Simulate a live (non-stale) holder: fresh mtime, our own live PID.
    fs.writeFileSync(lockPath, String(process.pid));
    const before = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    assert.doesNotThrow(() => {
      autoAppendKbIndex(dir, path.join(dir, '.orchestray', 'kb', 'artifacts', 'blocked.md'), 'blocked', 'artifacts');
    });

    const after = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.deepEqual(after.entries, before.entries, 'index must be unchanged when the lock cannot be acquired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock (dead PID) is reclaimed, does not wedge future writes', () => {
  const { dir, indexPath } = mkTmpProject();
  try {
    const lockPath = indexPath + '.lock';
    // A PID that is virtually guaranteed dead, simulating a crashed holder.
    fs.writeFileSync(lockPath, '999999');
    // Backdate mtime beyond the stale threshold so reclaim triggers immediately
    // rather than waiting on the 10s window.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    autoAppendKbIndex(dir, path.join(dir, '.orchestray', 'kb', 'artifacts', 'reclaimed.md'), 'reclaimed', 'artifacts');

    const after = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.ok(after.entries.some((e) => e.slug === 'reclaimed'), 'expected the stale lock to be reclaimed and the append to succeed');
    assert.equal(fs.existsSync(lockPath), false, 'lock file must be released after the append');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
