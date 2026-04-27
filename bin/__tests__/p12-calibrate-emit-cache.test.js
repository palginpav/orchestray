#!/usr/bin/env node
'use strict';

/**
 * p12-calibrate-emit-cache.test.js — F-003 regression (W7, v2.2.0).
 *
 * W1 design (v220-impl-p12-design.md §2.1) prescribed:
 *   1. `bin/_lib/output-shape.js` exports `getRoleLengthCap` so external
 *      callers (tests, future tools) can consume it.
 *   2. `bin/calibrate-role-budgets.js` accepts a `--emit-cache` flag that
 *      writes `.orchestray/state/role-budgets.json` in the wrapped form
 *      consumed by `getRoleLengthCap`.
 *
 * This test asserts both contracts. Without them, v2.2.1 telemetry rollups
 * cannot auto-refresh the cache and the doc claim ("caps from p95") drifts
 * from the live source.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const BIN_PATH   = path.join(REPO_ROOT, 'bin', 'calibrate-role-budgets.js');

describe('P1.2 F-003 regression — getRoleLengthCap export + --emit-cache flag', () => {
  test('output-shape.js exports getRoleLengthCap', () => {
    const mod = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));
    assert.equal(
      typeof mod.getRoleLengthCap, 'function',
      'output-shape.js must export getRoleLengthCap for external callers',
    );
    // Smoke call — must return { cap, source } shape on a real role.
    const res = mod.getRoleLengthCap('developer', { cwd: REPO_ROOT });
    assert.ok(res && typeof res.cap === 'number',
      'getRoleLengthCap("developer") must return numeric cap');
    assert.ok(typeof res.source === 'string',
      'getRoleLengthCap result must declare source');
  });

  test('calibrate-role-budgets.js exports its main function for programmatic use', () => {
    const mod = require(BIN_PATH);
    assert.equal(typeof mod.main, 'function', 'main must be exported');
    assert.ok(mod.MODEL_TIER_DEFAULTS && typeof mod.MODEL_TIER_DEFAULTS.haiku === 'number',
      'MODEL_TIER_DEFAULTS must be exported');
  });

  test('--emit-cache writes .orchestray/state/role-budgets.json (wrapped form)', () => {
    // Build a minimal tmp project with an empty events.jsonl so the tool
    // hits the "no telemetry, fall back to tier defaults" path. We don't
    // need real telemetry for the smoke; we only assert file shape.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-emit-cache-'));
    try {
      fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');

      const r = spawnSync(
        'node', [BIN_PATH, '--cwd', dir, '--emit-cache'],
        { encoding: 'utf8', timeout: 30000 },
      );
      assert.equal(r.status, 0, '--emit-cache invocation failed: ' + r.stderr);

      const cachePath = path.join(dir, '.orchestray', 'state', 'role-budgets.json');
      assert.ok(fs.existsSync(cachePath),
        '--emit-cache must create role-budgets.json at ' + cachePath);

      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.ok(cache && typeof cache === 'object', 'cache must be an object');
      assert.ok(cache.role_budgets && typeof cache.role_budgets === 'object',
        'cache must use the wrapped form (role_budgets key)');

      // Spot-check a role: it must have budget_tokens (and optionally p95)
      // in the shape getRoleLengthCap consumes.
      const dev = cache.role_budgets.developer;
      assert.ok(dev && typeof dev === 'object', 'developer entry must exist');
      assert.equal(typeof dev.budget_tokens, 'number',
        'developer.budget_tokens must be a number');
      assert.equal(typeof dev.calibrated_at, 'string',
        'developer.calibrated_at must be present (ISO date)');

      // Cross-check getRoleLengthCap reads the just-written cache.
      const { getRoleLengthCap } = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));
      const cap = getRoleLengthCap('developer', { cwd: dir });
      assert.ok(cap && typeof cap.cap === 'number',
        'getRoleLengthCap must return numeric cap from the emitted cache');
      // The source should reflect a cache hit (budget_tokens_cache or p95_cache),
      // not tier_default — proving the file was actually consumed.
      assert.ok(
        cap.source === 'budget_tokens_cache' || cap.source === 'p95_cache',
        'getRoleLengthCap source must indicate cache hit; got ' + cap.source,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
