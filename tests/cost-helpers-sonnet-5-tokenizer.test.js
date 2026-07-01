#!/usr/bin/env node
'use strict';

/**
 * Tests: Sonnet 5 tokenizer multiplier in bin/_lib/cost-helpers.js (v2.3.15).
 *
 * Sonnet 5 uses a newer tokenizer (~30% more tokens for the same text vs
 * Sonnet 4.6). Per-token pricing is unchanged ($3/$15); getPricing/
 * getEnforcementRates apply a 1.30x multiplier for effective-cost projection,
 * mirroring the Opus 4.7+/Fable 5 pattern but with Sonnet 5's own multiplier.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  getPricing,
  getEnforcementRates,
  getRatesForTier,
  usesSonnet5Tokenizer,
  BUILTIN_PRICING_TABLE,
  SONNET_5_TOKENIZER_MULTIPLIER,
} = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));

const SONNET_BASE = BUILTIN_PRICING_TABLE.sonnet;

describe('getPricing — Sonnet 5 tokenizer multiplier', () => {
  test('SONNET_5_TOKENIZER_MULTIPLIER is 1.30', () => {
    assert.strictEqual(SONNET_5_TOKENIZER_MULTIPLIER, 1.30);
  });

  test('usesSonnet5Tokenizer detects only claude-sonnet-5', () => {
    assert.strictEqual(usesSonnet5Tokenizer('claude-sonnet-5'), true);
    assert.strictEqual(usesSonnet5Tokenizer('claude-sonnet-4-6'), false);
    assert.strictEqual(usesSonnet5Tokenizer('sonnet'), false);
    assert.strictEqual(usesSonnet5Tokenizer('claude-opus-4-8'), false);
  });

  test('getPricing("claude-sonnet-5") applies 1.30x to both rates', () => {
    const rates = getPricing('claude-sonnet-5');
    assert.ok(Math.abs(rates.input_per_1m - SONNET_BASE.input_per_1m * 1.30) < 1e-9);
    assert.ok(Math.abs(rates.output_per_1m - SONNET_BASE.output_per_1m * 1.30) < 1e-9);
  });

  test('getPricing("claude-sonnet-4-6") is unaffected (no multiplier)', () => {
    assert.deepStrictEqual(getPricing('claude-sonnet-4-6'), SONNET_BASE);
  });

  test('getEnforcementRates applies 1.30x for claude-sonnet-5, not claude-sonnet-4-6', () => {
    const base = getRatesForTier(BUILTIN_PRICING_TABLE, 'sonnet');
    const enf5 = getEnforcementRates(BUILTIN_PRICING_TABLE, 'claude-sonnet-5');
    const enf46 = getEnforcementRates(BUILTIN_PRICING_TABLE, 'claude-sonnet-4-6');
    assert.ok(Math.abs(enf5.input_per_1m - base.input_per_1m * 1.30) < 1e-9);
    assert.deepStrictEqual(enf46, base);
  });
});

// ---------------------------------------------------------------------------
// v2.3.15 F1-F3: bare `sonnet` alias enforcement gap.
//
// The `sonnet` alias now resolves to Sonnet 5 at spawn time, so ENFORCEMENT
// (fixed-baseline-token-estimate cap projection) must treat it as 1.30x —
// otherwise cost caps under-project every plain `sonnet` spawn by ~30%.
// REPORTING (getPricing, driven by ACTUAL token counts that already reflect
// Sonnet 5's inflated tokenizer) must NOT apply the multiplier to `sonnet` —
// doing so would double-count the inflation already present in actual usage.
// This asymmetry is intentional; do not "fix" one to match the other.
// ---------------------------------------------------------------------------
describe('bare `sonnet` alias — enforcement vs reporting asymmetry', () => {
  test('getEnforcementRates("sonnet") applies 1.30x (bare alias now resolves to Sonnet 5)', () => {
    const base = getRatesForTier(BUILTIN_PRICING_TABLE, 'sonnet');
    const enf = getEnforcementRates(BUILTIN_PRICING_TABLE, 'sonnet');
    assert.ok(Math.abs(enf.input_per_1m - base.input_per_1m * 1.30) < 1e-9);
    assert.ok(Math.abs(enf.output_per_1m - base.output_per_1m * 1.30) < 1e-9);
  });

  test('getPricing("sonnet") stays at base — NO multiplier (reporting uses actual, already-inflated tokens)', () => {
    assert.deepStrictEqual(getPricing('sonnet'), SONNET_BASE);
  });

  test('usesSonnet5Tokenizer("sonnet") is false — unchanged factual predicate, distinct from enforcement', () => {
    assert.strictEqual(usesSonnet5Tokenizer('sonnet'), false);
  });

  test('getEnforcementRates("claude-sonnet-5") still applies 1.30x', () => {
    const base = getRatesForTier(BUILTIN_PRICING_TABLE, 'sonnet');
    const enf = getEnforcementRates(BUILTIN_PRICING_TABLE, 'claude-sonnet-5');
    assert.ok(Math.abs(enf.input_per_1m - base.input_per_1m * 1.30) < 1e-9);
  });

  test('getEnforcementRates stays at 1.0x for explicit sonnet-4-6, both spellings', () => {
    const base = getRatesForTier(BUILTIN_PRICING_TABLE, 'sonnet');
    assert.deepStrictEqual(getEnforcementRates(BUILTIN_PRICING_TABLE, 'claude-sonnet-4-6'), base);
    assert.deepStrictEqual(getEnforcementRates(BUILTIN_PRICING_TABLE, 'sonnet-4-6'), base);
  });
});

// ---------------------------------------------------------------------------
// F2: cost_budget_reserve reserve path must agree with enforcement (tokenizer-aware).
// ---------------------------------------------------------------------------
describe('cost_budget_reserve — reserve path is tokenizer-aware (F2)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { handle } = require(path.resolve(__dirname, '../bin/mcp-server/tools/cost_budget_reserve'));

  test('reserving with model "sonnet" reflects the 1.30x enforcement multiplier', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reserve-sonnet5-'));
    fs.mkdirSync(path.join(projectRoot, '.orchestray', 'state'), { recursive: true });
    try {
      const result = await handle(
        {
          orchestration_id: 'orch-sonnet5-test',
          task_id: 'task-1',
          agent_type: 'developer',
          model: 'sonnet',
        },
        { projectRoot, config: {} }
      );
      const projected = result.structuredContent.projected_cost_usd;
      // Recompute expected cost using the DEFAULT_TOKEN_ESTIMATES sonnet baseline at 1.30x.
      const { DEFAULT_TOKEN_ESTIMATES } = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));
      const est = DEFAULT_TOKEN_ESTIMATES.sonnet;
      const enf = getEnforcementRates(BUILTIN_PRICING_TABLE, 'sonnet');
      const expected =
        (est.input / 1_000_000) * enf.input_per_1m +
        (est.output / 1_000_000) * enf.output_per_1m;
      assert.ok(Math.abs(projected - expected) < 1e-6, `expected ~${expected}, got ${projected}`);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
