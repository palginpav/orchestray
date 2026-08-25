#!/usr/bin/env node
'use strict';

/**
 * calibrate-fresh-project-no-events.test.js
 *
 * Regression: when calibrate-role-budgets.js runs against a fresh project
 * with no `.orchestray/audit/events.jsonl` (the SessionStart hook on a brand
 * new project), the script must exit 0 silently rather than print a stderr
 * error. Mirrors the FN-27 cache-fresh branch's silent-with-telemetry
 * contract.
 *
 * Manual CLI invocation (no --if-stale, no --quiet) keeps the explicit
 * stderr error so direct users see why nothing computed.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN_PATH  = path.join(REPO_ROOT, 'bin', 'calibrate-role-budgets.js');

function mkFreshProject() {
  // Fresh project: no .orchestray/audit/events.jsonl, no role-budgets cache.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-fresh-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function run(dir, extraArgs) {
  return spawnSync(
    'node',
    [BIN_PATH, '--cwd', dir, ...extraArgs],
    { encoding: 'utf8', timeout: 30000 },
  );
}

describe('calibrate-role-budgets.js — fresh-project no-events branch', () => {

  test('--if-stale --quiet on fresh project: exits 0 silently (no stderr noise)', () => {
    const dir = mkFreshProject();
    try {
      const r = run(dir, ['--emit-cache', '--if-stale', '--quiet']);
      assert.equal(r.status, 0,
        'fresh project + --if-stale --quiet must exit 0; stderr was: ' + r.stderr);
      assert.equal(r.stderr, '',
        'fresh project + --if-stale --quiet must produce no stderr (was: ' + r.stderr + ')');
      assert.equal(r.stdout, '',
        'fresh project + --if-stale --quiet must produce no stdout (was: ' + r.stdout + ')');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--if-stale --quiet on fresh project: emits calibrate_skipped_no_events row', () => {
    const dir = mkFreshProject();
    try {
      run(dir, ['--emit-cache', '--if-stale', '--quiet']);
      const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath),
        'audit-event-writer must create events.jsonl when emitting telemetry');
      const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
      const matches = lines
        .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
        .filter(ev => ev && ev.type === 'calibrate_skipped_no_events');
      assert.ok(matches.length >= 1,
        'must emit at least one calibrate_skipped_no_events event; got: ' + JSON.stringify(lines));
      assert.equal(matches[0].mode, 'if_stale',
        'mode field must reflect the --if-stale invocation path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('manual CLI (no flags) on fresh project: keeps explicit stderr error and exit 1', () => {
    const dir = mkFreshProject();
    try {
      const r = run(dir, []);
      assert.equal(r.status, 1,
        'fresh project + no flags must exit 1 to preserve the manual-invocation error contract');
      assert.match(r.stderr, /events\.jsonl not found/,
        'manual invocation must print the explicit error to stderr');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
