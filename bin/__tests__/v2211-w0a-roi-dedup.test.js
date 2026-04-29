#!/usr/bin/env node
'use strict';

/**
 * v2211-w0a-roi-dedup.test.js — B6 per-orch dedup guard acceptance tests.
 *
 * Verifies that checkOrchRoiPresence emits orchestration_roi_missing at most
 * once per orchestration_id per session (dedup via lock file), and that
 * ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED=1 restores legacy per-invocation behaviour.
 *
 * Tests:
 *   1. 256-call spam, same orch_id, dedup ON  → exactly 1 emit.
 *   2. Two different orch_ids, dedup ON        → exactly 2 emits (1 each).
 *   3. 256-call spam, DEDUP_DISABLED=1         → 256 emits (legacy behaviour).
 *   4. Lock file present after dedup emit      → lock file exists in .orchestray/state/.
 *
 * Runner: cd /home/palgin/orchestray && npm test -- --testPathPattern=v2211-w0a-roi-dedup
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { checkOrchRoiPresence } = require(path.join(REPO_ROOT, 'bin', '_lib', 'pm-emit-state-watcher'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-roi-dedup-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  // Empty events.jsonl — no orchestration_roi → will always trigger missing path.
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');
  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/** Inject readLines that returns empty array (simulates no orchestration_roi). */
function emptyReadLines() { return []; }

/**
 * Save + restore env vars around a test body.
 * `vars` is an object of { KEY: value|undefined }.
 * undefined → delete the key.
 */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W0a — B6 per-orch dedup guard', () => {

  test('Test 1: 256-call spam, same orch_id, dedup ON → exactly 1 orchestration_roi_missing', () => {
    const dir    = makeRepo();
    const orchId = 'orch-20260429T111527Z-v2211-dedup-t1';

    withEnv({
      ORCHESTRAY_ROI_WATCHED_DISABLED:       undefined,
      ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED: undefined,
    }, () => {
      for (let i = 0; i < 256; i++) {
        checkOrchRoiPresence(dir, orchId, emptyReadLines);
      }
    });

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 1,
      'dedup must collapse 256 calls to exactly 1 emit; got ' + emitted.length);
    assert.strictEqual(emitted[0].orchestration_id, orchId,
      'emitted event must carry correct orchestration_id');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Test 2: two different orch_ids, dedup ON → exactly 2 emits (1 per orch)', () => {
    const dir    = makeRepo();
    const orchA  = 'orch-20260429T111527Z-v2211-dedup-t2a';
    const orchB  = 'orch-20260429T111527Z-v2211-dedup-t2b';

    withEnv({
      ORCHESTRAY_ROI_WATCHED_DISABLED:       undefined,
      ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED: undefined,
    }, () => {
      // Multiple calls for each — only 1 should survive per id.
      for (let i = 0; i < 10; i++) checkOrchRoiPresence(dir, orchA, emptyReadLines);
      for (let i = 0; i < 10; i++) checkOrchRoiPresence(dir, orchB, emptyReadLines);
    });

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 2,
      'expect exactly 2 emits (1 per orch_id); got ' + emitted.length);

    const ids = emitted.map(e => e.orchestration_id);
    assert.ok(ids.includes(orchA), 'orch-A must be in emitted ids');
    assert.ok(ids.includes(orchB), 'orch-B must be in emitted ids');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Test 3: ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED=1 → 256 emits (legacy behaviour)', () => {
    const dir    = makeRepo();
    const orchId = 'orch-20260429T111527Z-v2211-dedup-t3';

    withEnv({
      ORCHESTRAY_ROI_WATCHED_DISABLED:       undefined,
      ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED: '1',
    }, () => {
      for (let i = 0; i < 256; i++) {
        checkOrchRoiPresence(dir, orchId, emptyReadLines);
      }
    });

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 256,
      'kill switch must restore per-invocation behaviour (256 emits); got ' + emitted.length);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Test 4: lock file left in .orchestray/state/ after dedup emit', () => {
    const dir    = makeRepo();
    const orchId = 'orch-20260429T111527Z-v2211-dedup-t4';

    withEnv({
      ORCHESTRAY_ROI_WATCHED_DISABLED:       undefined,
      ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED: undefined,
    }, () => {
      checkOrchRoiPresence(dir, orchId, emptyReadLines);
    });

    const lockFile = path.join(dir, '.orchestray', 'state', 'roi-missing-dedup-' + orchId + '.lock');
    assert.ok(fs.existsSync(lockFile),
      'lock file must exist at .orchestray/state/roi-missing-dedup-<orchId>.lock after first emit');

    // Second call must not emit again (lock already present).
    withEnv({
      ORCHESTRAY_ROI_WATCHED_DISABLED:       undefined,
      ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED: undefined,
    }, () => {
      checkOrchRoiPresence(dir, orchId, emptyReadLines);
    });

    const emitted = readEvents(dir).filter(e => e.type === 'orchestration_roi_missing');
    assert.strictEqual(emitted.length, 1,
      'lock file must block second emit; expected 1, got ' + emitted.length);

    fs.rmSync(dir, { recursive: true, force: true });
  });

});
