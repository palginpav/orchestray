'use strict';

/**
 * v2.3.12 W8 (B5) — state-gc deletes per-orchestration litter files
 * (roi-missing-dedup-*.lock, dossier-orphan-counter.*) once mtime > TTL,
 * keeps fresh ones, and honors the kill switch.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateGc = require('../bin/_lib/state-gc');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gc-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

function touch(stateDir, name, ageMs) {
  const fp = path.join(stateDir, name);
  fs.writeFileSync(fp, 'x');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(fp, t, t);
  return fp;
}

const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

test('_globToRegExp matches litter patterns, not unrelated files', () => {
  const re = stateGc._globToRegExp('roi-missing-dedup-*.lock');
  assert.ok(re.test('roi-missing-dedup-orch-abc.lock'));
  assert.ok(!re.test('roi-snapshot.json'));
  const re2 = stateGc._globToRegExp('dossier-orphan-counter.*');
  assert.ok(re2.test('dossier-orphan-counter.orch-xyz'));
  assert.ok(!re2.test('dossier.json'));
});

test('_pruneByMtime deletes stale litter, keeps fresh + unrelated', () => {
  const root = mkProject();
  const stateDir = path.join(root, '.orchestray', 'state');
  const oldLock = touch(stateDir, 'roi-missing-dedup-orch-old.lock', EIGHT_DAYS);
  const freshLock = touch(stateDir, 'roi-missing-dedup-orch-fresh.lock', ONE_HOUR);
  const oldCounter = touch(stateDir, 'dossier-orphan-counter.orch-old', EIGHT_DAYS);
  const unrelated = touch(stateDir, 'routing.jsonl', EIGHT_DAYS);

  const cutoff = Date.now() - stateGc.DEFAULT_TTL_MS;
  const summary = stateGc._pruneByMtime(stateDir, stateGc.MTIME_TTL_GLOBS, cutoff);

  assert.strictEqual(fs.existsSync(oldLock), false, 'stale lock deleted');
  assert.strictEqual(fs.existsSync(freshLock), true, 'fresh lock kept');
  assert.strictEqual(fs.existsSync(oldCounter), false, 'stale counter deleted');
  assert.strictEqual(fs.existsSync(unrelated), true, 'unrelated file untouched');
  assert.strictEqual(summary.deleted, 2);
  assert.strictEqual(summary.kept, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test('runOnce invokes mtime litter prune and respects kill switch', () => {
  const root = mkProject();
  const stateDir = path.join(root, '.orchestray', 'state');
  touch(stateDir, 'roi-missing-dedup-orch-old.lock', EIGHT_DAYS);

  const prev = process.env.ORCHESTRAY_STATE_GC_DISABLED;
  process.env.ORCHESTRAY_STATE_GC_DISABLED = '1';
  const skipped = stateGc.runOnce(root);
  assert.strictEqual(skipped.skipped, true);
  assert.ok(fs.existsSync(path.join(stateDir, 'roi-missing-dedup-orch-old.lock')), 'kill switch leaves litter');

  delete process.env.ORCHESTRAY_STATE_GC_DISABLED;
  if (prev !== undefined) process.env.ORCHESTRAY_STATE_GC_DISABLED = prev;

  const res = stateGc.runOnce(root);
  assert.ok(res.results._mtime_litter, 'mtime litter result present');
  assert.strictEqual(res.results._mtime_litter.deleted, 1);
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'roi-missing-dedup-orch-old.lock')), false);

  fs.rmSync(root, { recursive: true, force: true });
});
