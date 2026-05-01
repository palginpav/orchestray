#!/usr/bin/env node
'use strict';

/**
 * Tests: Opus 4.7 tokenizer multiplier in bin/_lib/cost-helpers.js
 *
 * Asserts that getPricing("claude-opus-4-7") returns input_per_1m and
 * output_per_1m that are 35% above the Opus 4.6 baseline.
 *
 * F-11 fix — v2.2.21 T24.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  getPricing,
  BUILTIN_PRICING_TABLE,
  OPUS_47_TOKENIZER_MULTIPLIER,
} = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));

const OPUS_46_BASE = BUILTIN_PRICING_TABLE.opus;

describe('getPricing — Opus 4.7 tokenizer multiplier', () => {
  test('OPUS_47_TOKENIZER_MULTIPLIER is 1.35', () => {
    assert.strictEqual(OPUS_47_TOKENIZER_MULTIPLIER, 1.35);
  });

  test('getPricing("claude-opus-4-7") applies 1.35× to input rate', () => {
    const rates = getPricing('claude-opus-4-7');
    const expected = OPUS_46_BASE.input_per_1m * 1.35;
    assert.ok(
      Math.abs(rates.input_per_1m - expected) < 1e-9,
      `Expected input_per_1m=${expected}, got ${rates.input_per_1m}`
    );
  });

  test('getPricing("claude-opus-4-7") applies 1.35× to output rate', () => {
    const rates = getPricing('claude-opus-4-7');
    const expected = OPUS_46_BASE.output_per_1m * 1.35;
    assert.ok(
      Math.abs(rates.output_per_1m - expected) < 1e-9,
      `Expected output_per_1m=${expected}, got ${rates.output_per_1m}`
    );
  });

  test('getPricing("claude-opus-4.7") (dot variant) also applies 1.35×', () => {
    const rates = getPricing('claude-opus-4.7');
    const expectedInput = OPUS_46_BASE.input_per_1m * 1.35;
    const expectedOutput = OPUS_46_BASE.output_per_1m * 1.35;
    assert.ok(Math.abs(rates.input_per_1m - expectedInput) < 1e-9);
    assert.ok(Math.abs(rates.output_per_1m - expectedOutput) < 1e-9);
  });

  test('getPricing("claude-opus-4-6") returns the unmodified Opus 4.6 baseline', () => {
    const rates = getPricing('claude-opus-4-6');
    assert.strictEqual(rates.input_per_1m, OPUS_46_BASE.input_per_1m);
    assert.strictEqual(rates.output_per_1m, OPUS_46_BASE.output_per_1m);
  });

  test('getPricing("opus") returns the unmodified Opus baseline (short alias)', () => {
    const rates = getPricing('opus');
    assert.strictEqual(rates.input_per_1m, OPUS_46_BASE.input_per_1m);
    assert.strictEqual(rates.output_per_1m, OPUS_46_BASE.output_per_1m);
  });

  test('getPricing("claude-sonnet-4-6") is unaffected by Opus 4.7 branch', () => {
    const rates = getPricing('claude-sonnet-4-6');
    assert.strictEqual(rates.input_per_1m, BUILTIN_PRICING_TABLE.sonnet.input_per_1m);
    assert.strictEqual(rates.output_per_1m, BUILTIN_PRICING_TABLE.sonnet.output_per_1m);
  });

  test('getPricing("claude-haiku-4-5") returns Haiku rates', () => {
    const rates = getPricing('claude-haiku-4-5');
    assert.strictEqual(rates.input_per_1m, BUILTIN_PRICING_TABLE.haiku.input_per_1m);
    assert.strictEqual(rates.output_per_1m, BUILTIN_PRICING_TABLE.haiku.output_per_1m);
  });

  test('getPricing with unknown model falls back to sonnet rates', () => {
    const rates = getPricing('claude-unknown-model');
    assert.strictEqual(rates.input_per_1m, BUILTIN_PRICING_TABLE.sonnet.input_per_1m);
    assert.strictEqual(rates.output_per_1m, BUILTIN_PRICING_TABLE.sonnet.output_per_1m);
  });
});
