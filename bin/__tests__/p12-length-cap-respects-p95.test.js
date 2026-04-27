#!/usr/bin/env node
'use strict';

/**
 * p12-length-cap-respects-p95.test.js — P1.2 Risk #3 contract: length caps
 * source from `bin/calibrate-role-budgets.js` p95 cache, not hard-coded
 * literals.
 *
 * Verifies:
 *   1. Cache hit: a role with `p95` in role-budgets.json yields exactly
 *      that integer as length_cap, with reason "length_cap=p95_cache".
 *   2. Cache miss (no file): falls back to model-tier default (haiku 30K
 *      / sonnet 50K / opus 80K), with reason "length_cap=tier_default".
 *   3. Wrapped form (`role_budgets.<role>.budget_tokens`) is honored as
 *      a backward-compat fallback.
 *   4. structured-only roles → length_cap is null regardless of cache.
 *   5. length_cap_enabled=false suppresses caps for hybrid + prose-heavy.
 *
 * Runner: node --test bin/__tests__/p12-length-cap-respects-p95.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const {
  decideShape,
  getRoleLengthCap,
  MODEL_TIER_DEFAULTS,
  ROLE_MODEL_TIER,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-budget-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  // Seed an empty config so config-file fallback is exercised.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'config.json'),
    JSON.stringify({
      output_shape: {
        enabled: true,
        caveman_enabled: true,
        structured_outputs_enabled: true,
        length_cap_enabled: true,
        staged_flip_allowlist: ['researcher', 'tester'],
      },
    }),
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getRoleLengthCap unit
// ---------------------------------------------------------------------------

describe('getRoleLengthCap — cache resolution', () => {
  test('flat-form cache hit reads p95 directly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'state', 'role-budgets.json'),
      JSON.stringify({ developer: { p95: 42000 } }),
      'utf8',
    );
    const out = getRoleLengthCap('developer', { cwd: tmpDir });
    assert.equal(out.cap, 42000);
    assert.equal(out.source, 'p95_cache');
  });

  test('flat-form budget_tokens fallback when no p95', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'state', 'role-budgets.json'),
      JSON.stringify({ reviewer: { budget_tokens: 33000 } }),
      'utf8',
    );
    const out = getRoleLengthCap('reviewer', { cwd: tmpDir });
    assert.equal(out.cap, 33000);
    assert.equal(out.source, 'budget_tokens_cache');
  });

  test('wrapped form (role_budgets.<role>.budget_tokens) honored', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'state', 'role-budgets.json'),
      JSON.stringify({
        role_budgets: { architect: { budget_tokens: 65000 } },
      }),
      'utf8',
    );
    const out = getRoleLengthCap('architect', { cwd: tmpDir });
    assert.equal(out.cap, 65000);
    assert.equal(out.source, 'budget_tokens_cache');
  });

  test('cache miss → model-tier default', () => {
    // No role-budgets.json file present.
    const out = getRoleLengthCap('developer', { cwd: tmpDir });
    assert.equal(out.cap, MODEL_TIER_DEFAULTS[ROLE_MODEL_TIER['developer']]);
    assert.equal(out.source, 'tier_default');
  });

  test('cache miss for opus role → 80000', () => {
    const out = getRoleLengthCap('architect', { cwd: tmpDir });
    assert.equal(out.cap, MODEL_TIER_DEFAULTS.opus);
    assert.equal(out.source, 'tier_default');
  });
});

// ---------------------------------------------------------------------------
// decideShape integration
// ---------------------------------------------------------------------------

describe('decideShape — length_cap integration', () => {
  test('developer cache hit: length_cap === cached p95', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'state', 'role-budgets.json'),
      JSON.stringify({ developer: { p95: 42000 } }),
      'utf8',
    );
    const out = decideShape('developer', { cwd: tmpDir });
    assert.equal(out.length_cap, 42000);
    assert.match(out.reason, /length_cap=p95_cache/);
  });

  test('developer cache miss: length_cap === sonnet tier default', () => {
    const out = decideShape('developer', { cwd: tmpDir });
    assert.equal(out.length_cap, MODEL_TIER_DEFAULTS.sonnet);
    assert.match(out.reason, /length_cap=tier_default/);
  });

  test('researcher (structured-only) → length_cap is null', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'state', 'role-budgets.json'),
      JSON.stringify({ researcher: { p95: 99999 } }),
      'utf8',
    );
    const out = decideShape('researcher', { cwd: tmpDir });
    assert.equal(out.length_cap, null,
      'structured-only roles must not receive a length cap');
    assert.match(out.reason, /length_cap=off_structured-only/);
  });

  test('length_cap_enabled=false suppresses caps for hybrid roles', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'config.json'),
      JSON.stringify({
        output_shape: {
          enabled: true,
          caveman_enabled: true,
          length_cap_enabled: false,
        },
      }),
      'utf8',
    );
    const out = decideShape('developer', { cwd: tmpDir });
    assert.equal(out.length_cap, null);
    assert.match(out.reason, /length_cap=off_disabled/);
  });
});
