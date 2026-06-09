#!/usr/bin/env node
'use strict';

/**
 * Tests: Claude Fable 5 pricing in bin/_lib/cost-helpers.js and bin/_lib/models.js
 *
 * Asserts that getPricing("claude-fable-5") and getPricing("fable") both return
 * input_per_1m and output_per_1m with the 1.35× tokenizer multiplier applied to
 * the nominal $10/$50 Fable 5 rates.
 *
 * Also verifies the models.js registry entry resolves correctly.
 *
 * GA date: 2026-06-09.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  getPricing,
  BUILTIN_PRICING_TABLE,
  OPUS_47_TOKENIZER_MULTIPLIER,
} = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));

const {
  lookupModel,
  resolveContextWindow,
} = require(path.resolve(__dirname, '../bin/_lib/models'));

const FABLE_BASE = BUILTIN_PRICING_TABLE.fable;
const OPUS_BASE  = BUILTIN_PRICING_TABLE.opus;

describe('getPricing — Fable 5 tokenizer multiplier', () => {
  test('BUILTIN_PRICING_TABLE.fable nominal rates are $10/$50', () => {
    assert.strictEqual(FABLE_BASE.input_per_1m, 10.00);
    assert.strictEqual(FABLE_BASE.output_per_1m, 50.00);
  });

  test('getPricing("claude-fable-5") input === 10 × 1.35 (within 1e-9)', () => {
    const rates = getPricing('claude-fable-5');
    const expected = 10.00 * OPUS_47_TOKENIZER_MULTIPLIER;
    assert.ok(
      Math.abs(rates.input_per_1m - expected) < 1e-9,
      `Expected input_per_1m=${expected}, got ${rates.input_per_1m}`
    );
  });

  test('getPricing("claude-fable-5") output === 50 × 1.35 (within 1e-9)', () => {
    const rates = getPricing('claude-fable-5');
    const expected = 50.00 * OPUS_47_TOKENIZER_MULTIPLIER;
    assert.ok(
      Math.abs(rates.output_per_1m - expected) < 1e-9,
      `Expected output_per_1m=${expected}, got ${rates.output_per_1m}`
    );
  });

  test('getPricing("claude-fable-5") input === 13.5 (concrete value check)', () => {
    const rates = getPricing('claude-fable-5');
    assert.ok(
      Math.abs(rates.input_per_1m - 13.5) < 1e-9,
      `Expected 13.5, got ${rates.input_per_1m}`
    );
  });

  test('getPricing("claude-fable-5") output === 67.5 (concrete value check)', () => {
    const rates = getPricing('claude-fable-5');
    assert.ok(
      Math.abs(rates.output_per_1m - 67.5) < 1e-9,
      `Expected 67.5, got ${rates.output_per_1m}`
    );
  });

  test('getPricing("fable") (short alias) input equals full-ID result', () => {
    const full  = getPricing('claude-fable-5');
    const alias = getPricing('fable');
    assert.ok(
      Math.abs(alias.input_per_1m - full.input_per_1m) < 1e-9,
      `Short alias input_per_1m (${alias.input_per_1m}) should equal full-ID (${full.input_per_1m})`
    );
  });

  test('getPricing("fable") (short alias) output equals full-ID result', () => {
    const full  = getPricing('claude-fable-5');
    const alias = getPricing('fable');
    assert.ok(
      Math.abs(alias.output_per_1m - full.output_per_1m) < 1e-9,
      `Short alias output_per_1m (${alias.output_per_1m}) should equal full-ID (${full.output_per_1m})`
    );
  });

  test('getPricing("claude-fable-5") !== opus rates (no fall-through to generic branch)', () => {
    const fableRates = getPricing('claude-fable-5');
    // Opus 4.6 base: $5/$25
    assert.notStrictEqual(fableRates.input_per_1m, OPUS_BASE.input_per_1m,
      'Fable 5 input rate must not equal Opus 4.6 base rate ($5)');
    assert.notStrictEqual(fableRates.output_per_1m, OPUS_BASE.output_per_1m,
      'Fable 5 output rate must not equal Opus 4.6 base rate ($25)');
    // Also verify it does not equal opus-4.7/4.8 effective rate (5 × 1.35 = 6.75)
    const opus47Effective = OPUS_BASE.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER;
    assert.notStrictEqual(fableRates.input_per_1m, opus47Effective,
      'Fable 5 input rate must not equal Opus 4.7/4.8 effective rate');
  });

  test('getPricing("claude-fable-5") deep-equals getPricing("fable")', () => {
    assert.deepStrictEqual(getPricing('claude-fable-5'), getPricing('fable'));
  });

  test('getPricing("claude-fable-5[1m]") returns input 13.5 / output 67.5 (within 1e-9)', () => {
    const rates = getPricing('claude-fable-5[1m]');
    assert.ok(
      Math.abs(rates.input_per_1m - 13.5) < 1e-9,
      `Expected input_per_1m=13.5, got ${rates.input_per_1m}`
    );
    assert.ok(
      Math.abs(rates.output_per_1m - 67.5) < 1e-9,
      `Expected output_per_1m=67.5, got ${rates.output_per_1m}`
    );
  });
});

describe('models.js — claude-fable-5 registry entry', () => {
  test('lookupModel("claude-fable-5") returns short "fab-5"', () => {
    const meta = lookupModel('claude-fable-5');
    assert.strictEqual(meta.short, 'fab-5');
  });

  test('lookupModel("claude-fable-5") returns display "Fable 5"', () => {
    const meta = lookupModel('claude-fable-5');
    assert.strictEqual(meta.display, 'Fable 5');
  });

  test('resolveContextWindow("claude-fable-5") returns 1000000', () => {
    const window = resolveContextWindow('claude-fable-5', null);
    assert.strictEqual(window, 1000000);
  });

  test('resolveContextWindow("claude-fable-5") is 1M even without [1m] suffix (1M is the default)', () => {
    // Fable 5 has window_default=1000000 and no window_1m — the 1M window is always active
    const window = resolveContextWindow('claude-fable-5', null);
    assert.strictEqual(window, 1000000,
      'Fable 5 context window should be 1M by default (no [1m] suffix needed)');
  });

  test('opus [1m] handling is unaffected (regression guard)', () => {
    // Verify opus-4-8 still resolves its [1m] variant correctly
    const opusDefault = resolveContextWindow('claude-opus-4-8', null);
    const opus1m = resolveContextWindow('claude-opus-4-8[1m]', null);
    assert.strictEqual(opusDefault, 200000, 'Opus 4.8 default window should be 200000');
    assert.strictEqual(opus1m, 1000000, 'Opus 4.8 [1m] window should be 1000000');
  });
});
