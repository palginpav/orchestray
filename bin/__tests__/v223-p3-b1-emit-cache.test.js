#!/usr/bin/env node
'use strict';

/**
 * v223-p3-b1-emit-cache.test.js — P3 B1 (v2.2.3):
 *
 *   1. `--emit-cache` writes a valid role-budgets.json from synthetic
 *      `budget_warn` telemetry, populating `p95` (the field
 *      `bin/_lib/output-shape.js getRoleLengthCap()` prefers).
 *   2. p95 calculation is correct on a known-input fixture.
 *   3. `--if-stale` preserves a fresh cache (no rewrite) and refreshes
 *      a stale (>= --window-days old) cache.
 *   4. `--if-stale` is silent (exit 0) when the cache is missing AND
 *      events.jsonl is missing — required for SessionStart-hook safety
 *      on a brand-new install.
 *   5. CLI smoke: `node bin/calibrate-role-budgets.js --emit-cache`
 *      runs to completion and exits 0 against an empty events.jsonl.
 *   6. SessionStart hook entry is registered in hooks/hooks.json.
 *
 * Without B1 wiring, length caps stay frozen at v2.1.16 fallback seed
 * indefinitely and `output_shape_applied.baseline_source` never flips
 * from `budget_tokens_cache` to `p95_cache`.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const BIN_PATH   = path.join(REPO_ROOT, 'bin', 'calibrate-role-budgets.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p3-b1-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

// Synthesise budget_warn rows: each role gets `n` samples drawn from the
// caller-supplied array. Timestamps are now() so the calibrator's window
// filter passes.
function writeBudgetWarnEvents(dir, roleSamples) {
  const lines = [];
  const now = new Date().toISOString();
  for (const role of Object.keys(roleSamples)) {
    for (const computed_size of roleSamples[role]) {
      lines.push(JSON.stringify({
        event_type: 'budget_warn',
        timestamp: now,
        agent_role: role,
        computed_size,
      }));
    }
  }
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
    lines.join('\n') + (lines.length ? '\n' : ''),
    'utf8',
  );
}

function runCalibrator(args, opts) {
  return spawnSync('node', [BIN_PATH, ...args], Object.assign(
    { encoding: 'utf8', timeout: 30000 },
    opts || {},
  ));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P3 B1 — calibrate-role-budgets --emit-cache wiring', () => {

  test('--emit-cache produces valid role-budgets.json with p95 from telemetry', () => {
    const dir = makeTmpProject();
    try {
      // 12 samples for developer (>= default min_samples=10) so the
      // calibrator emits a real p95 (NOT a tier-default fallback).
      // p95 of [10,20,...,120] sorted = ceil(0.95 * 12) - 1 = 11th index = 120.
      writeBudgetWarnEvents(dir, {
        developer: [10000, 20000, 30000, 40000, 50000, 60000,
                    70000, 80000, 90000, 100000, 110000, 120000],
      });

      const r = runCalibrator(['--cwd', dir, '--emit-cache']);
      assert.equal(r.status, 0, '--emit-cache exit nonzero: ' + r.stderr);

      const cachePath = path.join(dir, '.orchestray', 'state', 'role-budgets.json');
      assert.ok(fs.existsSync(cachePath), 'cache file must exist');

      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.ok(cache.role_budgets, 'wrapped form (role_budgets key) required');

      const dev = cache.role_budgets.developer;
      assert.ok(dev, 'developer entry required');
      assert.equal(typeof dev.p95, 'number',
        'developer must carry p95 — not just budget_tokens (P2-W2 prefers p95)');
      assert.equal(dev.p95, 120000, 'p95 of 12 samples [10K..120K] is 120K');
      assert.equal(typeof dev.budget_tokens, 'number',
        'developer must also carry budget_tokens (legacy fallback)');
      assert.ok(dev.budget_tokens >= dev.p95,
        'budget_tokens (1.2x p95 rounded up) must be >= p95');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('p95 calculation correct on known-input fixture', () => {
    // Direct unit test on the exported percentile function.
    const { percentile } = require(BIN_PATH);
    // 20 samples 1..20 sorted. p95 idx = ceil(0.95 * 20) - 1 = 18 → value 19.
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(samples, 95), 19,
      'p95 of [1..20] must be 19 (ceil(0.95*N)-1 indexing)');
    assert.equal(percentile(samples, 50), 10,
      'p50 of [1..20] must be 10');
    assert.equal(percentile([], 95), null,
      'percentile of empty array must be null');
  });

  test('cross-check: getRoleLengthCap consumes p95 (source: p95_cache)', () => {
    const dir = makeTmpProject();
    try {
      writeBudgetWarnEvents(dir, {
        developer: Array.from({ length: 12 }, (_, i) => (i + 1) * 10000),
      });
      const r = runCalibrator(['--cwd', dir, '--emit-cache']);
      assert.equal(r.status, 0, '--emit-cache exit nonzero: ' + r.stderr);

      // Force fresh require so cache writes from prior test do not leak.
      delete require.cache[require.resolve(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'))];
      const { getRoleLengthCap } = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));

      const cap = getRoleLengthCap('developer', { cwd: dir });
      assert.equal(cap.source, 'p95_cache',
        'baseline_source must be p95_cache when calibrator wrote p95; got ' + cap.source);
      assert.equal(cap.cap, 120000, 'cap must equal p95 value (120K)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--if-stale preserves a FRESH cache (no rewrite, exit 0)', () => {
    const dir = makeTmpProject();
    try {
      // Pre-populate a fresh cache file with a sentinel marker; --if-stale
      // must NOT touch it.
      const cachePath = path.join(dir, '.orchestray', 'state', 'role-budgets.json');
      const sentinel = { role_budgets: { developer: { budget_tokens: 999999, p95: 999999 } }, _sentinel: 'do-not-overwrite' };
      fs.writeFileSync(cachePath, JSON.stringify(sentinel, null, 2), 'utf8');
      // Touch mtime to NOW so 14-day window passes.
      const now = Date.now();
      fs.utimesSync(cachePath, now / 1000, now / 1000);

      // events.jsonl present but irrelevant — --if-stale must short-circuit.
      writeBudgetWarnEvents(dir, { developer: [50000, 60000] });

      const r = runCalibrator(['--cwd', dir, '--emit-cache', '--if-stale']);
      assert.equal(r.status, 0, '--if-stale on fresh cache must exit 0: ' + r.stderr);

      const after = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.equal(after._sentinel, 'do-not-overwrite',
        'fresh cache MUST be preserved by --if-stale');
      assert.equal(after.role_budgets.developer.p95, 999999,
        'fresh cache p95 must be unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--if-stale REFRESHES a stale cache (mtime older than --window-days)', () => {
    const dir = makeTmpProject();
    try {
      const cachePath = path.join(dir, '.orchestray', 'state', 'role-budgets.json');
      const sentinel = { role_budgets: { developer: { budget_tokens: 999999, p95: 999999 } }, _sentinel: 'should-be-overwritten' };
      fs.writeFileSync(cachePath, JSON.stringify(sentinel, null, 2), 'utf8');
      // Backdate mtime by 30 days — well past 14-day default window.
      const oldTimeSec = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(cachePath, oldTimeSec, oldTimeSec);

      writeBudgetWarnEvents(dir, {
        developer: Array.from({ length: 12 }, (_, i) => (i + 1) * 10000),
      });

      const r = runCalibrator(['--cwd', dir, '--emit-cache', '--if-stale']);
      assert.equal(r.status, 0, '--if-stale on stale cache must exit 0: ' + r.stderr);

      const after = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.notEqual(after._sentinel, 'should-be-overwritten',
        'stale cache MUST be overwritten by --if-stale');
      assert.equal(after.role_budgets.developer.p95, 120000,
        'refreshed cache must carry the new p95 (120K)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--if-stale is silent (exit 0) on brand-new install (no events file)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p3-b1-empty-'));
    try {
      // Bare project — no .orchestray/audit, no .orchestray/state.
      // SessionStart hook MUST NOT error here.
      const r = runCalibrator(['--cwd', dir, '--emit-cache', '--if-stale']);
      assert.equal(r.status, 0,
        '--if-stale on brand-new install must exit 0; stderr: ' + r.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI smoke: --emit-cache against empty events.jsonl exits 0', () => {
    const dir = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
        '', 'utf8',
      );
      const r = runCalibrator(['--cwd', dir, '--emit-cache']);
      assert.equal(r.status, 0,
        '--emit-cache against empty events must succeed: ' + r.stderr);

      const cache = JSON.parse(fs.readFileSync(
        path.join(dir, '.orchestray', 'state', 'role-budgets.json'),
        'utf8',
      ));
      assert.ok(cache.role_budgets, 'cache must always emit role_budgets shape');
      assert.ok(cache.role_budgets.developer,
        'developer entry must exist (tier-default fallback)');
      // Empty telemetry → no p95 emitted, but budget_tokens present.
      assert.equal(typeof cache.role_budgets.developer.budget_tokens, 'number',
        'budget_tokens must always be present');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SessionStart hook is registered in hooks/hooks.json', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const sessionStart = hooks.hooks && hooks.hooks.SessionStart;
    assert.ok(Array.isArray(sessionStart),
      'hooks.SessionStart must be an array');

    let found = false;
    for (const group of sessionStart) {
      for (const h of (group.hooks || [])) {
        if (h.command && h.command.includes('calibrate-role-budgets.js') &&
            h.command.includes('--emit-cache') &&
            h.command.includes('--if-stale')) {
          found = true;
        }
      }
    }
    assert.ok(found,
      'SessionStart must invoke calibrate-role-budgets.js --emit-cache --if-stale');
  });

});
