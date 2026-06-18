'use strict';

/**
 * v2.3.12 W4 (A3) — cost-cap enforcement must apply the 1.35× Opus-4.7+/Fable
 * tokenizer multiplier (previously dropped by tier-collapse, under-projecting
 * Opus-4.8/Fable spawns by ~35%).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  getEnforcementRates,
  getRatesForTier,
  usesOpus47Tokenizer,
  OPUS_47_TOKENIZER_MULTIPLIER,
  BUILTIN_PRICING_TABLE,
} = require('../bin/_lib/cost-helpers');

const T = BUILTIN_PRICING_TABLE;

test('usesOpus47Tokenizer detects new-tokenizer models only', () => {
  assert.strictEqual(usesOpus47Tokenizer('claude-opus-4-8'), true);
  assert.strictEqual(usesOpus47Tokenizer('claude-opus-4.7'), true);
  assert.strictEqual(usesOpus47Tokenizer('claude-fable-5'), true);
  assert.strictEqual(usesOpus47Tokenizer('fable'), true);
  assert.strictEqual(usesOpus47Tokenizer('claude-opus-4-6'), false);
  assert.strictEqual(usesOpus47Tokenizer('opus'), false);
  assert.strictEqual(usesOpus47Tokenizer('sonnet'), false);
  assert.strictEqual(usesOpus47Tokenizer('haiku'), false);
});

test('opus-4-8 enforcement rates are 1.35x bare opus base', () => {
  const base = getRatesForTier(T, 'opus');
  const enf = getEnforcementRates(T, 'claude-opus-4-8');
  assert.ok(Math.abs(enf.input_per_1m - base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
  assert.ok(Math.abs(enf.output_per_1m - base.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
});

test('fable enforcement rates are 1.35x fable base', () => {
  const base = getRatesForTier(T, 'fable');
  const enf = getEnforcementRates(T, 'claude-fable-5');
  assert.ok(Math.abs(enf.input_per_1m - base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
});

test('sonnet / haiku / opus-4-6 unchanged (no multiplier)', () => {
  assert.deepStrictEqual(getEnforcementRates(T, 'sonnet'), getRatesForTier(T, 'sonnet'));
  assert.deepStrictEqual(getEnforcementRates(T, 'haiku'), getRatesForTier(T, 'haiku'));
  assert.deepStrictEqual(getEnforcementRates(T, 'claude-opus-4-6'), getRatesForTier(T, 'opus'));
});

test('config pricing table is respected as the base before multiplier', () => {
  const customTable = { opus: { input_per_1m: 10, output_per_1m: 40 } };
  const enf = getEnforcementRates(customTable, 'claude-opus-4-8');
  assert.ok(Math.abs(enf.input_per_1m - 10 * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
  assert.ok(Math.abs(enf.output_per_1m - 40 * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
});
