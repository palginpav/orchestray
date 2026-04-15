#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/tools/cost_budget_check.js
 *
 * Per 2014-scope-proposal.md §W3 AC5.
 *
 * Coverage:
 *   A — default-config path (no mcp_server.cost_budget_check in config)
 *   B — custom-config path (pricing_table present in config)
 *   C — missing config fallback to builtin (null context or no config key)
 *   D — budget-warning shape (daily_cost_limit_usd set and would be exceeded)
 *   E — input validation (missing required fields, bad enum values)
 *   F — model tier normalization (full model IDs, unknown models)
 *   G — effort field accepted as optional
 *   H — no cost cap configured → advisory warning only
 *   I — both would_exceed_* booleans false when cap not exceeded
 *   J — token estimate defaults used when estimated_* fields omitted
 *   K — explicit token estimates used when provided
 *   W1 — running-cost accumulation from events.jsonl
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handle,
  BUILTIN_PRICING_TABLE,
  resolveModelTier,
  resolvePricingTable,
  computeCost,
  readAccumulatedCost,
} = require('../../../bin/mcp-server/tools/cost_budget_check');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid input. */
function baseInput(overrides = {}) {
  return Object.assign(
    { model: 'sonnet', orchestration_id: 'orch-test-001' },
    overrides
  );
}

/** Build a context with a config object. */
function makeContext(config = {}) {
  return { config };
}

// ---------------------------------------------------------------------------
// A: default-config path
// ---------------------------------------------------------------------------

describe('A: default-config path (no pricing_table in config)', () => {
  test('returns success with pricing_source=builtin when config has no cost_budget_check key', async () => {
    const input = baseInput({ model: 'sonnet' });
    const ctx = makeContext({ mcp_server: { enabled: true } });
    const result = await handle(input, ctx);

    assert.equal(result.isError, false, 'must not be an error');
    const body = result.structuredContent;
    assert.equal(body.pricing_source, 'builtin', 'should fall back to builtin');
    assert.match(body.last_verified, /^\d{4}-\d{2}-\d{2}$/, 'last_verified must be YYYY-MM-DD');
    assert.ok(typeof body.projected_cost_usd === 'number', 'projected_cost_usd must be a number');
    assert.ok(body.projected_cost_usd >= 0, 'projected_cost_usd must be non-negative');
  });

  test('returns model_tier=sonnet for sonnet model', async () => {
    const result = await handle(baseInput({ model: 'sonnet' }), makeContext({}));
    assert.equal(result.structuredContent.model_tier, 'sonnet');
  });

  test('returns model_tier=haiku for haiku model', async () => {
    const result = await handle(baseInput({ model: 'haiku' }), makeContext({}));
    assert.equal(result.structuredContent.model_tier, 'haiku');
  });

  test('returns model_tier=opus for opus model', async () => {
    const result = await handle(baseInput({ model: 'opus' }), makeContext({}));
    assert.equal(result.structuredContent.model_tier, 'opus');
  });

  test('returns all required output fields (exact key set)', async () => {
    const result = await handle(baseInput(), makeContext({}));
    const body = result.structuredContent;
    // deepEqual on sorted key set catches both missing AND unexpected extra keys.
    // W1 adds accumulated_cost_usd; T2 F10 adds agent_type.
    assert.deepEqual(Object.keys(body).sort(), [
      'accumulated_cost_usd',
      'agent_type',
      'effort',
      'input_tokens_used',
      'last_verified',
      'model',
      'model_tier',
      'orchestration_id',
      'output_tokens_used',
      'pricing_source',
      'projected_cost_usd',
      'token_estimates_from_defaults',
      'warnings',
      'would_exceed_daily_limit',
      'would_exceed_max_cost',
      'would_exceed_weekly_limit',
    ].sort());
    assert.ok(Array.isArray(body.warnings), 'warnings must be an array');
  });
});

// ---------------------------------------------------------------------------
// B: custom-config path
// ---------------------------------------------------------------------------

describe('B: custom-config path (pricing_table present in config)', () => {
  const customPricingTable = {
    haiku:  { input_per_1m: 2.00,  output_per_1m: 10.00 },
    sonnet: { input_per_1m: 6.00,  output_per_1m: 30.00 },
    opus:   { input_per_1m: 10.00, output_per_1m: 50.00 },
  };

  const configWithCustomPricing = {
    mcp_server: {
      cost_budget_check: {
        pricing_table: customPricingTable,
        last_verified: '2026-01-15',
      },
    },
  };

  test('uses config pricing_table when present', async () => {
    const input = baseInput({
      model: 'sonnet',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const ctx = makeContext(configWithCustomPricing);
    const result = await handle(input, ctx);

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.pricing_source, 'config', 'must use config pricing source');
    // 1M input * $6 + 1M output * $30 = $36
    assert.ok(Math.abs(body.projected_cost_usd - 36.00) < 0.001,
      `expected $36 projected cost, got $${body.projected_cost_usd}`);
  });

  test('returns last_verified from config', async () => {
    const result = await handle(baseInput(), makeContext(configWithCustomPricing));
    assert.equal(result.structuredContent.last_verified, '2026-01-15');
  });

  test('pricing_source is "config" not "builtin"', async () => {
    const result = await handle(baseInput(), makeContext(configWithCustomPricing));
    assert.equal(result.structuredContent.pricing_source, 'config');
  });

  test('no builtin-fallback warning when config pricing is present', async () => {
    const result = await handle(baseInput(), makeContext(configWithCustomPricing));
    const body = result.structuredContent;
    const hasFallbackWarning = body.warnings.some(w => w.includes('built-in defaults'));
    assert.equal(hasFallbackWarning, false, 'should not warn about builtin fallback when config is present');
  });
});

// ---------------------------------------------------------------------------
// C: missing config fallback to builtin
// ---------------------------------------------------------------------------

describe('C: missing config fallback to builtin', () => {
  test('null context falls back to builtin', async () => {
    const result = await handle(baseInput(), null);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.pricing_source, 'builtin');
  });

  test('empty config object falls back to builtin', async () => {
    const result = await handle(baseInput(), makeContext({}));
    assert.equal(result.structuredContent.pricing_source, 'builtin');
  });

  test('config without mcp_server falls back to builtin', async () => {
    const result = await handle(baseInput(), makeContext({ auto_review: true }));
    assert.equal(result.structuredContent.pricing_source, 'builtin');
  });

  test('config with mcp_server but no cost_budget_check falls back to builtin', async () => {
    const result = await handle(baseInput(), makeContext({ mcp_server: { enabled: true } }));
    assert.equal(result.structuredContent.pricing_source, 'builtin');
  });

  test('warnings include builtin-fallback notice when config is missing', async () => {
    const result = await handle(baseInput(), makeContext({}));
    const hasBuiltinWarning = result.structuredContent.warnings.some(w => w.includes('built-in defaults'));
    assert.ok(hasBuiltinWarning, 'must warn about builtin fallback when config is absent');
  });

  test('builtin pricing matches BUILTIN_PRICING_TABLE for sonnet', async () => {
    const input = baseInput({
      model: 'sonnet',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const result = await handle(input, makeContext({}));
    const expected =
      BUILTIN_PRICING_TABLE.sonnet.input_per_1m +
      BUILTIN_PRICING_TABLE.sonnet.output_per_1m;
    assert.ok(Math.abs(result.structuredContent.projected_cost_usd - expected) < 0.001,
      `expected $${expected}, got $${result.structuredContent.projected_cost_usd}`);
  });
});

// ---------------------------------------------------------------------------
// D: budget-warning shape
// ---------------------------------------------------------------------------

describe('D: budget-warning shape', () => {
  test('would_exceed_daily_limit=true when projected cost > daily_cost_limit_usd', async () => {
    const input = baseInput({
      model: 'opus',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    // opus: 1M input * $5 + 1M output * $25 = $30
    const ctx = makeContext({ daily_cost_limit_usd: 1.00 }); // limit is $1, cost is $30
    const result = await handle(input, ctx);

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.would_exceed_daily_limit, true, 'must flag daily limit exceeded');
    const hasBudgetWarning = body.warnings.some(w => w.includes('daily_cost_limit_usd'));
    assert.ok(hasBudgetWarning, 'must include a warning about daily_cost_limit_usd');
  });

  test('would_exceed_weekly_limit=true when projected cost > weekly_cost_limit_usd', async () => {
    const input = baseInput({
      model: 'opus',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const ctx = makeContext({ weekly_cost_limit_usd: 1.00 });
    const result = await handle(input, ctx);

    const body = result.structuredContent;
    assert.equal(body.would_exceed_weekly_limit, true);
    const hasWarning = body.warnings.some(w => w.includes('weekly_cost_limit_usd'));
    assert.ok(hasWarning, 'must include weekly limit warning');
  });

  test('would_exceed_max_cost=true when projected cost > max_cost_usd', async () => {
    const input = baseInput({
      model: 'opus',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const ctx = makeContext({ max_cost_usd: 1.00 });
    const result = await handle(input, ctx);

    const body = result.structuredContent;
    assert.equal(body.would_exceed_max_cost, true);
    const hasWarning = body.warnings.some(w => w.includes('max_cost_usd'));
    assert.ok(hasWarning, 'must include max_cost warning');
  });

  test('all would_exceed_* false when cost is within all limits', async () => {
    const input = baseInput({
      model: 'haiku',
      estimated_input_tokens: 1_000,
      estimated_output_tokens: 500,
    });
    // haiku: 1K input * $1/1M + 500 output * $5/1M = $0.001 + $0.0025 = $0.0035
    const ctx = makeContext({
      max_cost_usd: 10.00,
      daily_cost_limit_usd: 10.00,
      weekly_cost_limit_usd: 10.00,
    });
    const result = await handle(input, ctx);
    const body = result.structuredContent;
    assert.equal(body.would_exceed_max_cost, false);
    assert.equal(body.would_exceed_daily_limit, false);
    assert.equal(body.would_exceed_weekly_limit, false);
    // No budget exceeded → no budget warnings (only possible default-estimate warning)
    const budgetWarnings = body.warnings.filter(w =>
      w.includes('max_cost_usd') ||
      w.includes('daily_cost_limit_usd') ||
      w.includes('weekly_cost_limit_usd')
    );
    assert.equal(budgetWarnings.length, 0, 'no budget warnings when within limits');
  });

  test('budget warning includes dollar amounts', async () => {
    const input = baseInput({
      model: 'opus',
      estimated_input_tokens: 2_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const ctx = makeContext({ daily_cost_limit_usd: 1.00 });
    const result = await handle(input, ctx);
    const body = result.structuredContent;
    const dailyWarning = body.warnings.find(w => w.includes('daily_cost_limit_usd'));
    assert.ok(dailyWarning, 'must have daily warning');
    assert.ok(dailyWarning.includes('$'), 'warning must include dollar amount');
  });
});

// ---------------------------------------------------------------------------
// E: input validation
// ---------------------------------------------------------------------------

describe('E: input validation', () => {
  test('missing orchestration_id returns isError=true', async () => {
    const result = await handle({ model: 'sonnet' }, makeContext({}));
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('orchestration_id'), 'error must mention orchestration_id');
  });

  test('missing model returns isError=true', async () => {
    const result = await handle({ orchestration_id: 'orch-001' }, makeContext({}));
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('model'), 'error must mention model');
  });

  test('invalid effort enum returns isError=true', async () => {
    const result = await handle(
      baseInput({ effort: 'ultra-high' }),
      makeContext({})
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('effort'), 'error must mention effort');
  });

  test('empty orchestration_id returns isError=true', async () => {
    const result = await handle({ model: 'sonnet', orchestration_id: '' }, makeContext({}));
    assert.equal(result.isError, true);
  });

  test('estimated_input_tokens below minimum returns isError=true', async () => {
    const result = await handle(
      baseInput({ estimated_input_tokens: -1 }),
      makeContext({})
    );
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// F: model tier normalization
// ---------------------------------------------------------------------------

describe('F: model tier normalization', () => {
  test('claude-opus-4-6 normalizes to opus', () => {
    assert.equal(resolveModelTier('claude-opus-4-6'), 'opus');
  });

  test('claude-sonnet-4-6 normalizes to sonnet', () => {
    assert.equal(resolveModelTier('claude-sonnet-4-6'), 'sonnet');
  });

  test('claude-haiku-4-5 normalizes to haiku', () => {
    assert.equal(resolveModelTier('claude-haiku-4-5'), 'haiku');
  });

  test('bare "opus" normalizes to opus', () => {
    assert.equal(resolveModelTier('opus'), 'opus');
  });

  test('bare "sonnet" normalizes to sonnet', () => {
    assert.equal(resolveModelTier('sonnet'), 'sonnet');
  });

  test('bare "haiku" normalizes to haiku', () => {
    assert.equal(resolveModelTier('haiku'), 'haiku');
  });

  test('unknown model normalizes to sonnet (conservative default)', () => {
    assert.equal(resolveModelTier('some-unknown-model-v99'), 'sonnet');
  });

  test('undefined/null falls back to sonnet', () => {
    assert.equal(resolveModelTier(undefined), 'sonnet');
    assert.equal(resolveModelTier(null), 'sonnet');
  });

  test('case-insensitive matching: OPUS normalizes to opus', () => {
    assert.equal(resolveModelTier('OPUS'), 'opus');
  });
});

// ---------------------------------------------------------------------------
// G: effort field
// ---------------------------------------------------------------------------

describe('G: effort field', () => {
  test('effort=low is accepted', async () => {
    const result = await handle(baseInput({ effort: 'low' }), makeContext({}));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.effort, 'low');
  });

  test('effort=medium is accepted', async () => {
    const result = await handle(baseInput({ effort: 'medium' }), makeContext({}));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.effort, 'medium');
  });

  test('effort=high is accepted', async () => {
    const result = await handle(baseInput({ effort: 'high' }), makeContext({}));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.effort, 'high');
  });

  test('effort=max is accepted', async () => {
    const result = await handle(baseInput({ effort: 'max' }), makeContext({}));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.effort, 'max');
  });

  test('effort omitted is accepted (null in output)', async () => {
    const result = await handle(baseInput(), makeContext({}));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.effort, null);
  });
});

// ---------------------------------------------------------------------------
// H: no cost cap configured
// ---------------------------------------------------------------------------

describe('H: no cost cap configured', () => {
  test('all would_exceed_* are false when no caps configured', async () => {
    const result = await handle(baseInput({ model: 'opus' }), makeContext({}));
    const body = result.structuredContent;
    assert.equal(body.would_exceed_max_cost, false, 'would_exceed_max_cost must be false without cap');
    assert.equal(body.would_exceed_daily_limit, false, 'would_exceed_daily_limit must be false without cap');
    assert.equal(body.would_exceed_weekly_limit, false, 'would_exceed_weekly_limit must be false without cap');
  });

  test('warnings include "no cost cap configured" when no caps set', async () => {
    const result = await handle(baseInput(), makeContext({}));
    const hasNoCap = result.structuredContent.warnings.some(w => w.includes('no cost cap configured'));
    assert.ok(hasNoCap, 'must warn that no cost cap is configured');
  });

  test('result is advisory only (isError=false) even without caps', async () => {
    const result = await handle(baseInput({ model: 'opus' }), makeContext({}));
    assert.equal(result.isError, false);
  });
});

// ---------------------------------------------------------------------------
// I: would_exceed_* booleans false when within cap
// ---------------------------------------------------------------------------

describe('I: would_exceed_* booleans false when cost is within cap', () => {
  test('haiku with high cap → all false', async () => {
    const input = baseInput({
      model: 'haiku',
      estimated_input_tokens: 1000,
      estimated_output_tokens: 500,
    });
    const ctx = makeContext({ max_cost_usd: 100.00 });
    const result = await handle(input, ctx);
    const body = result.structuredContent;
    assert.equal(body.would_exceed_max_cost, false);
    assert.equal(body.would_exceed_daily_limit, false);
    assert.equal(body.would_exceed_weekly_limit, false);
  });
});

// ---------------------------------------------------------------------------
// J: token estimate defaults used when fields omitted
// ---------------------------------------------------------------------------

describe('J: token estimate defaults', () => {
  test('token_estimates_from_defaults=true when estimated_* omitted', async () => {
    const result = await handle(baseInput(), makeContext({}));
    assert.equal(result.structuredContent.token_estimates_from_defaults, true);
  });

  test('warnings include default-estimate notice when tokens omitted', async () => {
    const result = await handle(baseInput(), makeContext({}));
    const hasDefaultWarning = result.structuredContent.warnings.some(w =>
      w.includes('conservative defaults')
    );
    assert.ok(hasDefaultWarning, 'must warn about conservative defaults when tokens not provided');
  });
});

// ---------------------------------------------------------------------------
// K: explicit token estimates used when provided
// ---------------------------------------------------------------------------

describe('K: explicit token estimates', () => {
  test('token_estimates_from_defaults=false when both estimated_* provided', async () => {
    const input = baseInput({
      estimated_input_tokens: 50_000,
      estimated_output_tokens: 10_000,
    });
    const result = await handle(input, makeContext({}));
    assert.equal(result.structuredContent.token_estimates_from_defaults, false);
  });

  test('no default-estimate warning when explicit tokens provided', async () => {
    const input = baseInput({
      estimated_input_tokens: 50_000,
      estimated_output_tokens: 10_000,
    });
    const result = await handle(input, makeContext({}));
    const hasDefaultWarning = result.structuredContent.warnings.some(w =>
      w.includes('conservative defaults')
    );
    assert.equal(hasDefaultWarning, false, 'no default-estimate warning when explicit tokens given');
  });

  test('projected_cost_usd matches explicit token calculation', async () => {
    const input = baseInput({
      model: 'sonnet',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const result = await handle(input, makeContext({}));
    // builtin sonnet: $3/1M input + $15/1M output = $18 for 1M each
    const expected = BUILTIN_PRICING_TABLE.sonnet.input_per_1m + BUILTIN_PRICING_TABLE.sonnet.output_per_1m;
    assert.ok(Math.abs(result.structuredContent.projected_cost_usd - expected) < 0.001,
      `expected $${expected}, got $${result.structuredContent.projected_cost_usd}`);
  });
});

// ---------------------------------------------------------------------------
// L: partial token estimates (one field provided, one omitted)
// ---------------------------------------------------------------------------

describe('L: partial token estimates — one field provided, one omitted', () => {
  test('token_estimates_from_defaults=true when only estimated_input_tokens is provided', async () => {
    // Providing only one of the two token fields still triggers the default-estimate
    // warning — the "mixed" mode: caller supplied input tokens but output tokens
    // will use tier defaults. Non-obvious contract; this test documents it.
    const input = baseInput({ estimated_input_tokens: 500_000 });
    const result = await handle(input, makeContext({}));
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.token_estimates_from_defaults, true,
      'providing only one token field must still set token_estimates_from_defaults=true');
    const hasDefaultWarning = body.warnings.some(w => w.includes('conservative defaults'));
    assert.ok(hasDefaultWarning,
      'conservative defaults warning must fire even when only one token field is provided');
  });
});

// ---------------------------------------------------------------------------
// M: partial config pricing table — per-tier fallback to builtin
// ---------------------------------------------------------------------------

describe('M: partial config pricing table — per-tier builtin fallback', () => {
  test('opus falls back to builtin rate when config pricing_table lacks opus key', async () => {
    // Config supplies pricing for haiku and sonnet only; opus tier must fall back
    // to BUILTIN_PRICING_TABLE.opus while pricing_source remains 'config'.
    const partialPricingTable = {
      haiku:  { input_per_1m: 2.00, output_per_1m: 10.00 },
      sonnet: { input_per_1m: 6.00, output_per_1m: 30.00 },
      // opus intentionally omitted
    };
    const configWithPartialPricing = {
      mcp_server: {
        cost_budget_check: {
          pricing_table: partialPricingTable,
          last_verified: '2026-01-15',
        },
      },
    };
    const input = baseInput({
      model: 'opus',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 1_000_000,
    });
    const result = await handle(input, makeContext(configWithPartialPricing));
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    // Overall source is 'config' because the table came from config
    assert.equal(body.pricing_source, 'config', 'pricing_source must be config when table comes from config');
    // Cost must use builtin opus rate: 1M input * $5 + 1M output * $25 = $30
    const expectedCost =
      BUILTIN_PRICING_TABLE.opus.input_per_1m + BUILTIN_PRICING_TABLE.opus.output_per_1m;
    assert.ok(
      Math.abs(body.projected_cost_usd - expectedCost) < 0.001,
      `expected $${expectedCost} (builtin opus fallback), got $${body.projected_cost_usd}`
    );
  });
});

// ---------------------------------------------------------------------------
// N: zero-token inputs
// ---------------------------------------------------------------------------

describe('N: zero-token inputs', () => {
  test('projected_cost_usd=0 and token_estimates_from_defaults=false when both tokens are 0', async () => {
    // Zero is a valid schema value (minimum: 0). Both fields are explicitly provided
    // so token_estimates_from_defaults must be false, and cost must be exactly 0.
    const input = baseInput({
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
    });
    const result = await handle(input, makeContext({}));
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.projected_cost_usd, 0, 'projected_cost_usd must be 0 for zero tokens');
    assert.equal(body.token_estimates_from_defaults, false,
      'token_estimates_from_defaults must be false when both zero-value fields are explicitly provided');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for helper functions
// ---------------------------------------------------------------------------

describe('resolvePricingTable helper', () => {
  test('returns builtin source when config is null', () => {
    const { source } = resolvePricingTable(null);
    assert.equal(source, 'builtin');
  });

  test('returns config source when pricing_table is present', () => {
    const config = {
      mcp_server: {
        cost_budget_check: {
          pricing_table: { haiku: { input_per_1m: 2, output_per_1m: 10 } },
          last_verified: '2026-01-01',
        },
      },
    };
    const { source, last_verified } = resolvePricingTable(config);
    assert.equal(source, 'config');
    assert.equal(last_verified, '2026-01-01');
  });
});

describe('computeCost helper', () => {
  test('computes cost correctly for sonnet rates', () => {
    const rates = { input_per_1m: 3.00, output_per_1m: 15.00 };
    const cost = computeCost(1_000_000, 1_000_000, rates);
    assert.ok(Math.abs(cost - 18.00) < 0.001);
  });

  test('computes zero cost for zero tokens', () => {
    const rates = { input_per_1m: 3.00, output_per_1m: 15.00 };
    assert.equal(computeCost(0, 0, rates), 0);
  });
});

describe('BUILTIN_PRICING_TABLE constant', () => {
  test('haiku rates match collect-agent-metrics.js PRICING', () => {
    assert.equal(BUILTIN_PRICING_TABLE.haiku.input_per_1m, 1.00);
    assert.equal(BUILTIN_PRICING_TABLE.haiku.output_per_1m, 5.00);
  });

  test('sonnet rates match collect-agent-metrics.js PRICING', () => {
    assert.equal(BUILTIN_PRICING_TABLE.sonnet.input_per_1m, 3.00);
    assert.equal(BUILTIN_PRICING_TABLE.sonnet.output_per_1m, 15.00);
  });

  test('opus rates match collect-agent-metrics.js PRICING', () => {
    assert.equal(BUILTIN_PRICING_TABLE.opus.input_per_1m, 5.00);
    assert.equal(BUILTIN_PRICING_TABLE.opus.output_per_1m, 25.00);
  });
});

// ---------------------------------------------------------------------------
// W1: running-cost accumulation tests
// ---------------------------------------------------------------------------

/**
 * Create a temporary project root with events.jsonl pre-seeded with
 * agent_stop events for the given orchestration_id.
 */
function makeTmpProjectRoot(orchId, agentStopEvents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cbc-test-'));
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');
  const lines = agentStopEvents.map((ev) => JSON.stringify(
    Object.assign({ type: 'agent_stop', orchestration_id: orchId }, ev)
  ));
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n', 'utf8');
  return dir;
}

function cleanTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('W1: readAccumulatedCost helper', () => {
  test('returns 0 when events.jsonl is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cbc-test-empty-'));
    try {
      const result = await readAccumulatedCost('orch-x', dir, null);
      assert.equal(result.accumulated_usd, 0);
      assert.equal(result.warnings.length, 0, 'no warnings for absent file');
    } finally {
      cleanTmpDir(dir);
    }
  });

  test('sums cost_usd from matching agent_stop events', async () => {
    const dir = makeTmpProjectRoot('orch-001', [
      { cost_usd: 0.50, timestamp: '2026-04-13T10:00:00Z' },
      { cost_usd: 0.30, timestamp: '2026-04-13T11:00:00Z' },
    ]);
    try {
      const result = await readAccumulatedCost('orch-001', dir, null);
      assert.ok(Math.abs(result.accumulated_usd - 0.80) < 0.0001,
        `expected 0.80, got ${result.accumulated_usd}`);
    } finally {
      cleanTmpDir(dir);
    }
  });

  test('ignores events from other orchestration_ids', async () => {
    const dir = makeTmpProjectRoot('orch-001', [
      { cost_usd: 0.50, timestamp: '2026-04-13T10:00:00Z' },
    ]);
    // Add an event for a different orchestration.
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    fs.appendFileSync(eventsPath,
      JSON.stringify({ type: 'agent_stop', orchestration_id: 'orch-OTHER', cost_usd: 9.99 }) + '\n'
    );
    try {
      const result = await readAccumulatedCost('orch-001', dir, null);
      assert.ok(Math.abs(result.accumulated_usd - 0.50) < 0.0001,
        'should only count orch-001 events');
    } finally {
      cleanTmpDir(dir);
    }
  });

  test('ignores non-agent_stop events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cbc-test-types-'));
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');
    // agent_start should not be summed.
    fs.writeFileSync(eventsPath,
      JSON.stringify({ type: 'agent_start', orchestration_id: 'orch-001', cost_usd: 0.50 }) + '\n' +
      JSON.stringify({ type: 'agent_stop', orchestration_id: 'orch-001', cost_usd: 0.30 }) + '\n',
      'utf8'
    );
    try {
      const result = await readAccumulatedCost('orch-001', dir, null);
      assert.ok(Math.abs(result.accumulated_usd - 0.30) < 0.0001,
        'only agent_stop should be summed');
    } finally {
      cleanTmpDir(dir);
    }
  });

  test('returns 0 when no events match the orchestration_id', async () => {
    const dir = makeTmpProjectRoot('orch-OTHER', [
      { cost_usd: 0.50, timestamp: '2026-04-13T10:00:00Z' },
    ]);
    try {
      const result = await readAccumulatedCost('orch-001', dir, null);
      assert.equal(result.accumulated_usd, 0);
    } finally {
      cleanTmpDir(dir);
    }
  });
});

describe('W1: handle() — would_exceed_max_cost_usd with accumulated cost', () => {
  test('returns would_exceed_max_cost=true when accumulated+projected exceeds cap', async () => {
    // max_cost=1.0, accumulated=$0.99, projected≈$0.10 → total ≈ $1.09 > $1.00
    const orchId = 'orch-w1-test';
    const dir = makeTmpProjectRoot(orchId, [
      { cost_usd: 0.99, timestamp: '2026-04-13T10:00:00Z' },
    ]);
    try {
      const input = baseInput({
        model: 'haiku',
        orchestration_id: orchId,
        estimated_input_tokens: 50_000,
        estimated_output_tokens: 10_000,
        // haiku: 50K input * $1/1M = $0.05, 10K output * $5/1M = $0.05 → ~$0.10 projected
      });
      const ctx = { config: { max_cost_usd: 1.00 }, projectRoot: dir };
      const result = await handle(input, ctx);
      assert.equal(result.isError, false);
      const body = result.structuredContent;
      assert.equal(body.would_exceed_max_cost, true,
        'must flag exceeded when accumulated+projected > cap');
      assert.ok(body.accumulated_cost_usd > 0,
        'accumulated_cost_usd must be populated');
    } finally {
      cleanTmpDir(dir);
    }
  });

  test('returns would_exceed_max_cost=false when accumulated+projected is within cap', async () => {
    const orchId = 'orch-w1-ok';
    const dir = makeTmpProjectRoot(orchId, [
      { cost_usd: 0.10, timestamp: '2026-04-13T10:00:00Z' },
    ]);
    try {
      const input = baseInput({
        model: 'haiku',
        orchestration_id: orchId,
        estimated_input_tokens: 1_000,
        estimated_output_tokens: 500,
        // haiku: ~$0.003 projected
      });
      const ctx = { config: { max_cost_usd: 1.00 }, projectRoot: dir };
      const result = await handle(input, ctx);
      assert.equal(result.isError, false);
      const body = result.structuredContent;
      assert.equal(body.would_exceed_max_cost, false,
        'must be false when accumulated+projected < cap');
    } finally {
      cleanTmpDir(dir);
    }
  });

  test('accumulated_cost_usd is present and numeric in result', async () => {
    const result = await handle(baseInput(), makeContext({}));
    assert.equal(result.isError, false);
    assert.ok(typeof result.structuredContent.accumulated_cost_usd === 'number',
      'accumulated_cost_usd must be a number');
    assert.ok(result.structuredContent.accumulated_cost_usd >= 0,
      'accumulated_cost_usd must be non-negative');
  });
});
