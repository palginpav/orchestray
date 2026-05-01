#!/usr/bin/env node
'use strict';

/**
 * Tests: pricing table single-source-of-truth enforcement.
 *
 * Asserts that:
 *   1. BUILTIN_PRICING_TABLE is exported from cost-helpers.js.
 *   2. collect-agent-metrics.js does NOT redeclare a local pricing table
 *      (no `const PRICING = {` or `const BUILTIN_PRICING_TABLE = {` in that file).
 *
 * F-12 fix — v2.2.21 T24.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const COST_HELPERS_PATH = path.resolve(__dirname, '../bin/_lib/cost-helpers.js');
const COLLECT_METRICS_PATH = path.resolve(__dirname, '../bin/collect-agent-metrics.js');

describe('pricing table single-source-of-truth', () => {
  test('cost-helpers.js exports BUILTIN_PRICING_TABLE', () => {
    const { BUILTIN_PRICING_TABLE } = require(COST_HELPERS_PATH);
    assert.ok(
      BUILTIN_PRICING_TABLE && typeof BUILTIN_PRICING_TABLE === 'object',
      'BUILTIN_PRICING_TABLE must be exported from cost-helpers.js'
    );
    // Spot-check: all three tiers present with numeric rates.
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      assert.ok(
        BUILTIN_PRICING_TABLE[tier] &&
        typeof BUILTIN_PRICING_TABLE[tier].input_per_1m === 'number' &&
        typeof BUILTIN_PRICING_TABLE[tier].output_per_1m === 'number',
        `BUILTIN_PRICING_TABLE must have numeric rates for tier "${tier}"`
      );
    }
  });

  test('collect-agent-metrics.js does not redeclare a local pricing table', () => {
    const src = fs.readFileSync(COLLECT_METRICS_PATH, 'utf8');

    // Patterns that would indicate a local pricing table redeclaration.
    const forbidden = [
      /const\s+PRICING\s*=\s*\{/,
      /const\s+BUILTIN_PRICING_TABLE\s*=\s*\{/,
    ];

    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(src),
        `collect-agent-metrics.js must not redeclare a local pricing table ` +
        `(found pattern: ${pattern}). Use cost-helpers.js as the single source.`
      );
    }
  });

  test('collect-agent-metrics.js imports getPricing from cost-helpers.js', () => {
    const src = fs.readFileSync(COLLECT_METRICS_PATH, 'utf8');
    assert.ok(
      src.includes('cost-helpers'),
      'collect-agent-metrics.js must import from cost-helpers.js'
    );
  });
});
