#!/usr/bin/env node
'use strict';

/**
 * P3.1 audit-round archive — determinism gate (AR-6).
 *
 * Byte-stable digest for byte-stable input. Fixture has three
 * verify_fix_* rows for round 2; archiveRound is invoked twice
 * in-process AND once in a fresh node process — all three runs
 * must produce a byte-identical digest body.
 *
 * The deterministic-extractor decision (design §"Digest computation
 * choice") rests on this guarantee. If the test fails it means a
 * non-deterministic field (timestamp, ordering, JSON.stringify key
 * order, etc.) leaked into the digest body.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { archiveRound } = require('../_lib/audit-round-archive.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIB_PATH  = path.join(REPO_ROOT, 'bin', '_lib', 'audit-round-archive.js');

let tmpDir;
const ORCH = 'orch-determinism-test';
const ROUND = 2;

function makeFixtureEvents() {
  return [
    {
      version: 1,
      type: 'verify_fix_fail',
      timestamp: '2026-04-26T10:00:00.000Z',
      orchestration_id: ORCH,
      round: ROUND,
      task_id: 'task-12',
      message: 'three lint errors remain',
      remaining_errors: 3,
    },
    {
      version: 1,
      type: 'verify_fix_oscillation',
      timestamp: '2026-04-26T10:05:00.000Z',
      orchestration_id: ORCH,
      round: ROUND,
      task_id: 'task-12',
      errors_current: 3,
      errors_previous: 2,
    },
    {
      version: 1,
      type: 'verify_fix_pass',
      timestamp: '2026-04-26T10:10:00.000Z',
      orchestration_id: ORCH,
      round: ROUND,
      task_id: 'task-12',
      rounds_total: 2,
    },
  ];
}

function setupFixture() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-determinism-'));
  // Disable schema-shadow validation so synthesised events can be appended without
  // surrogate-path interference (also documented in design §6 fixture-caveat).
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'kb', 'artifacts'), { recursive: true });

  const events = makeFixtureEvents();
  const lines  = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
                   lines, 'utf8');
}

function cleanup() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

describe('P3.1 archiveRound — determinism', () => {
  beforeEach(setupFixture);
  afterEach(cleanup);

  test('two in-process invocations against same fixture produce byte-identical digest', () => {
    const r1 = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.equal(r1.skipped, undefined, 'first run should succeed: ' + JSON.stringify(r1));
    const digest1 = fs.readFileSync(path.join(tmpDir, r1.digestPath), 'utf8');

    // Delete digest and re-run — second call should produce the same bytes.
    fs.unlinkSync(path.join(tmpDir, r1.digestPath));

    const r2 = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.equal(r2.skipped, undefined, 'second run should succeed: ' + JSON.stringify(r2));
    const digest2 = fs.readFileSync(path.join(tmpDir, r2.digestPath), 'utf8');

    assert.equal(digest1, digest2, 'digest body must be byte-identical across re-runs');
  });

  test('fresh-process re-run produces byte-identical digest', () => {
    const r1 = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.equal(r1.skipped, undefined);
    const digest1 = fs.readFileSync(path.join(tmpDir, r1.digestPath), 'utf8');

    fs.unlinkSync(path.join(tmpDir, r1.digestPath));

    // Spawn a fresh node process invoking archiveRound. We use a thin
    // wrapper so the test does not depend on a public CLI surface.
    const wrapperJs =
      'const { archiveRound } = require(' + JSON.stringify(LIB_PATH) + ');\n' +
      'const r = archiveRound(' + JSON.stringify(ORCH) + ', ' + ROUND + ', ' +
        '{ cwd: ' + JSON.stringify(tmpDir) + ' });\n' +
      'process.stdout.write(JSON.stringify(r));\n';
    const r = spawnSync('node', ['-e', wrapperJs], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, 'fresh-process run failed: ' + r.stderr);

    const digest2 = fs.readFileSync(path.join(tmpDir, r1.digestPath), 'utf8');
    assert.equal(digest1, digest2, 'digest body must be byte-identical across processes');
  });
});
