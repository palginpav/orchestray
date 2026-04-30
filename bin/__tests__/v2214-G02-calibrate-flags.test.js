#!/usr/bin/env node
'use strict';

/**
 * v2214-G02-calibrate-flags.test.js — G-02 regression (v2.2.14).
 *
 * Asserts that calibrate-role-budgets.js correctly implements:
 *   --if-stale  : exits 0 silently when cache mtime < window-days old;
 *                 recomputes when cache is missing or older than window.
 *   --quiet     : suppresses all stdout (table + emit-cache confirmation).
 *
 * Canonical hook command (wired by G-03):
 *   node bin/calibrate-role-budgets.js --emit-cache --if-stale --quiet
 */

const { test, describe, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN_PATH  = path.join(REPO_ROOT, 'bin', 'calibrate-role-budgets.js');

// ---------------------------------------------------------------------------
// Helper: build minimal tmp project with empty events.jsonl
// ---------------------------------------------------------------------------
function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g02-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');
  return dir;
}

function cachePath(dir) {
  return path.join(dir, '.orchestray', 'state', 'role-budgets.json');
}

function run(dir, extraArgs) {
  return spawnSync(
    'node',
    [BIN_PATH, '--cwd', dir, ...extraArgs],
    { encoding: 'utf8', timeout: 30000 },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.14 G-02 — --if-stale and --quiet flags', () => {

  test('--if-stale with fresh cache: exits 0 silently, no recompute', () => {
    const dir = mkProject();
    try {
      // Write a fresh cache (mtime = now). Default window = 14 days.
      const freshCache = JSON.stringify({
        calibrated_at: new Date().toISOString(),
        window_days: 14,
        min_samples: 10,
        source: 'test',
        role_budgets: { developer: { budget_tokens: 50000, source: 'test', calibrated_at: 'today' } },
      });
      fs.writeFileSync(cachePath(dir), freshCache, 'utf8');

      const r = run(dir, ['--emit-cache', '--if-stale', '--quiet']);
      assert.equal(r.status, 0, '--if-stale with fresh cache must exit 0; stderr: ' + r.stderr);
      assert.equal(r.stdout, '', '--if-stale with fresh cache must produce no stdout');
      assert.equal(r.stderr, '', '--if-stale with fresh cache must produce no stderr');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--if-stale with stale cache (30 days old): recomputes and writes cache', () => {
    const dir = mkProject();
    try {
      // Write cache with mtime set 30 days in the past.
      const staleCache = JSON.stringify({ role_budgets: {}, calibrated_at: 'old', source: 'test' });
      const cp = cachePath(dir);
      fs.writeFileSync(cp, staleCache, 'utf8');
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      fs.utimesSync(cp, new Date(thirtyDaysAgo), new Date(thirtyDaysAgo));

      const r = run(dir, ['--emit-cache', '--if-stale', '--quiet']);
      assert.equal(r.status, 0, '--if-stale stale cache must exit 0; stderr: ' + r.stderr);

      // Cache must have been overwritten with fresh content.
      const written = JSON.parse(fs.readFileSync(cp, 'utf8'));
      assert.ok(written.role_budgets && typeof written.role_budgets === 'object',
        'recomputed cache must have role_budgets');
      assert.ok(Object.keys(written.role_budgets).length > 0,
        'recomputed cache must have at least one role');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--if-stale with missing cache: recomputes and writes cache', () => {
    const dir = mkProject();
    try {
      // No cache file at all.
      const cp = cachePath(dir);
      assert.ok(!fs.existsSync(cp), 'pre-condition: cache must not exist');

      const r = run(dir, ['--emit-cache', '--if-stale', '--quiet']);
      assert.equal(r.status, 0, '--if-stale missing cache must exit 0; stderr: ' + r.stderr);

      assert.ok(fs.existsSync(cp), '--if-stale missing cache must create role-budgets.json');
      const written = JSON.parse(fs.readFileSync(cp, 'utf8'));
      assert.ok(written.role_budgets && typeof written.role_budgets === 'object',
        'written cache must have role_budgets');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--quiet --emit-cache: no stdout regardless of cache state', () => {
    const dir = mkProject();
    try {
      const r = run(dir, ['--emit-cache', '--quiet']);
      assert.equal(r.status, 0, '--quiet --emit-cache must exit 0; stderr: ' + r.stderr);
      assert.equal(r.stdout, '', '--quiet --emit-cache must produce no stdout');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without flags: table printed to stdout (existing behaviour preserved)', () => {
    const dir = mkProject();
    try {
      const r = run(dir, []);
      assert.equal(r.status, 0, 'baseline invocation must exit 0; stderr: ' + r.stderr);
      assert.ok(r.stdout.includes('calibrate-role-budgets.js'),
        'stdout must contain the report header');
      assert.ok(r.stdout.includes('Role'),
        'stdout must contain the table header');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
