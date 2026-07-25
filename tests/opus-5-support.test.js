'use strict';

/**
 * Opus 5 support — resolver, pricing, and allowlist coverage.
 *
 * Fixtures are seeded from the authoritative fact sheet
 * .orchestray/kb/facts/2026-07-opus-5-rollout.md, NOT from resolver output:
 *   - full ID: claude-opus-5 (dateless, pinned)
 *   - context window: 1,000,000 (native/only size; no separate 1M variant)
 *   - pricing: $5 / $25 per MTok (unchanged from Opus 4.8)
 *   - tokenizer: SAME as Opus 4.7/4.8/Fable 5 → 1.35× effective-cost multiplier
 *
 * The load-bearing regression this guards against is anti-pattern
 * `model-variant-suffix-missed-in-resolver`: the `claude-opus-5[1m]` runtime
 * suffix must resolve to the same model, 1M context window, and pricing as the
 * bare `claude-opus-5` ID.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  lookupModel,
  resolveContextWindow,
  modelShort,
} = require(path.resolve(__dirname, '../bin/_lib/models'));

const {
  getPricing,
  getEnforcementRates,
  getRatesForTier,
  usesOpus47Tokenizer,
  BUILTIN_PRICING_TABLE,
  OPUS_47_TOKENIZER_MULTIPLIER,
} = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));

const { ALLOWED_MODEL_FULL } = require(path.resolve(__dirname, '../bin/_lib/custom-agents'));

// --- Fixtures from the fact sheet (ground truth) ---------------------------
const OPUS_5_ID = 'claude-opus-5';
const OPUS_5_1M = 'claude-opus-5[1m]';
const OPUS_5_WINDOW = 1_000_000;
const OPUS_5_SHORT = 'opu-5';
const OPUS_5_DISPLAY = 'Opus 5';
const OPUS_BASE = BUILTIN_PRICING_TABLE.opus; // $5 / $25

describe('models.js — Opus 5 resolver (context window + display)', () => {
  test('lookupModel(claude-opus-5) returns Opus 5 metadata with 1M window', () => {
    const meta = lookupModel(OPUS_5_ID);
    assert.equal(meta.short, OPUS_5_SHORT);
    assert.equal(meta.display, OPUS_5_DISPLAY);
    assert.equal(meta.window_default, OPUS_5_WINDOW);
  });

  test('lookupModel(claude-opus-5[1m]) resolves to the same entry (suffix trap)', () => {
    const meta = lookupModel(OPUS_5_1M);
    assert.equal(meta.short, OPUS_5_SHORT);
    assert.equal(meta.display, OPUS_5_DISPLAY);
    assert.equal(meta.window_default, OPUS_5_WINDOW);
  });

  test('resolveContextWindow returns 1M for both bare and [1m] variants', () => {
    // 1M is native/only; window_default is already 1M, so no window_1m bump needed.
    assert.equal(resolveContextWindow(OPUS_5_ID, 'Opus 5'), OPUS_5_WINDOW);
    assert.equal(resolveContextWindow(OPUS_5_1M, 'Opus 5'), OPUS_5_WINDOW);
    assert.equal(resolveContextWindow(OPUS_5_ID, null), OPUS_5_WINDOW);
  });

  test('modelShort resolves opu-5 for both variants', () => {
    assert.equal(modelShort(OPUS_5_ID), OPUS_5_SHORT);
    assert.equal(modelShort(OPUS_5_1M), OPUS_5_SHORT);
  });
});

describe('cost-helpers.js — Opus 5 pricing (same tokenizer branch as 4.7/4.8)', () => {
  test('getPricing(claude-opus-5) applies the 1.35× multiplier to $5/$25', () => {
    const rates = getPricing(OPUS_5_ID);
    assert.ok(Math.abs(rates.input_per_1m - OPUS_BASE.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
    assert.ok(Math.abs(rates.output_per_1m - OPUS_BASE.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
  });

  test('getPricing(claude-opus-5[1m]) equals getPricing(claude-opus-5) (suffix trap)', () => {
    assert.deepStrictEqual(getPricing(OPUS_5_1M), getPricing(OPUS_5_ID));
  });

  test('getPricing(claude-opus-5) deep-equals getPricing(claude-opus-4-8) — same branch, no new coefficient', () => {
    assert.deepStrictEqual(getPricing(OPUS_5_ID), getPricing('claude-opus-4-8'));
  });

  test('usesOpus47Tokenizer detects concrete Opus 5 IDs but NOT the bare opus alias', () => {
    assert.strictEqual(usesOpus47Tokenizer(OPUS_5_ID), true);
    assert.strictEqual(usesOpus47Tokenizer(OPUS_5_1M), true);
    assert.strictEqual(usesOpus47Tokenizer('opus'), false); // bare alias handled in enforcement only
  });
});

describe('cost-helpers.js — enforcement (fixed-baseline cap projection)', () => {
  test('getEnforcementRates(claude-opus-5) applies 1.35× to the opus tier base', () => {
    const base = getRatesForTier(BUILTIN_PRICING_TABLE, 'opus');
    const enf = getEnforcementRates(BUILTIN_PRICING_TABLE, OPUS_5_ID);
    assert.ok(Math.abs(enf.input_per_1m - base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
    assert.ok(Math.abs(enf.output_per_1m - base.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER) < 1e-9);
  });

  test('getEnforcementRates(claude-opus-5[1m]) matches the bare ID (suffix trap)', () => {
    assert.deepStrictEqual(
      getEnforcementRates(BUILTIN_PRICING_TABLE, OPUS_5_1M),
      getEnforcementRates(BUILTIN_PRICING_TABLE, OPUS_5_ID)
    );
  });

  test('legacy Opus 4.6 enforcement stays at base (no multiplier) — regression guard', () => {
    assert.deepStrictEqual(
      getEnforcementRates(BUILTIN_PRICING_TABLE, 'claude-opus-4-6'),
      getRatesForTier(BUILTIN_PRICING_TABLE, 'opus')
    );
  });

  // The bare `opus` alias's tokenizer is provider/version-dependent (Opus 5 on
  // Claude Code v2.1.219+, Opus 4.6 on Microsoft Foundry), so enforcement leaves
  // it at base rate — unchanged from the whole Opus 4.8 era. Adding a multiplier
  // here would change opus-tier alias cost semantics (out of scope for this task).
  test('getEnforcementRates(opus) stays at base — bare alias tier semantics unchanged', () => {
    assert.deepStrictEqual(
      getEnforcementRates(BUILTIN_PRICING_TABLE, 'opus'),
      getRatesForTier(BUILTIN_PRICING_TABLE, 'opus')
    );
  });
});

describe('cost-helpers.js — bare opus reporting unchanged', () => {
  test('getPricing(opus) stays at the unmodified base (tier semantics unchanged)', () => {
    const rates = getPricing('opus');
    assert.strictEqual(rates.input_per_1m, OPUS_BASE.input_per_1m);
    assert.strictEqual(rates.output_per_1m, OPUS_BASE.output_per_1m);
  });
});

describe('custom-agents.js — Opus 5 accepted in the full-ID allowlist', () => {
  test('ALLOWED_MODEL_FULL contains claude-opus-5', () => {
    assert.ok(ALLOWED_MODEL_FULL.has(OPUS_5_ID));
  });

  test('legacy Opus 4.8 still validates (api-compat regression guard)', () => {
    assert.ok(ALLOWED_MODEL_FULL.has('claude-opus-4-8'));
  });

  // Surfaced during orch-20260725T-opus5-zod verification: claude-sonnet-5 was in
  // models.js and CLAUDE.md but missing from both allowlists (same enum-drift class).
  test('ALLOWED_MODEL_FULL contains claude-sonnet-5 (allowlist drift guard)', () => {
    assert.ok(ALLOWED_MODEL_FULL.has('claude-sonnet-5'));
  });
});
