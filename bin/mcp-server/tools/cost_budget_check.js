'use strict';

/**
 * `cost_budget_check` MCP tool.
 *
 * Projects the cost of a proposed Agent() spawn against the orchestration's
 * running cost and the configured cost caps. Returns a structured advisory
 * (not an enforcement gate) so the PM can make an informed pre-spawn decision.
 *
 * Per 2014-scope-proposal.md §W3. This tool is intended for PM callers only.
 * Subagents should not call it — there is no parent-orchestration-id routing
 * for subagent contexts (OQ1 decision: PM-only in 2.0.14, deferred for 2.0.15).
 */

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { loadCostBudgetCheckConfig } = require('../../_lib/config-schema');
const { resolveSafeCwd } = require('../../_lib/resolve-project-cwd');

// ---------------------------------------------------------------------------
// Built-in pricing table (fall-back when config is missing or malformed).
// Values must match bin/collect-agent-metrics.js PRICING constant.
//   haiku:  input $1.00/1M, output $5.00/1M
//   sonnet: input $3.00/1M, output $15.00/1M
//   opus:   input $5.00/1M, output $25.00/1M
// ---------------------------------------------------------------------------
const BUILTIN_PRICING_TABLE = deepFreeze({
  haiku:  { input_per_1m: 1.00,  output_per_1m: 5.00  },
  sonnet: { input_per_1m: 3.00,  output_per_1m: 15.00 },
  opus:   { input_per_1m: 5.00,  output_per_1m: 25.00 },
});

// Historical-average token estimates (conservative defaults when history is
// absent — chosen to over-estimate rather than under-estimate cost).
const DEFAULT_TOKEN_ESTIMATES = deepFreeze({
  haiku:  { input: 50_000,  output: 8_000  },
  sonnet: { input: 80_000,  output: 12_000 },
  opus:   { input: 100_000, output: 15_000 },
});

// Supported model aliases. We accept full model IDs and normalize them to
// tier keys (haiku | sonnet | opus). Unknown values default to sonnet.
const MODEL_TIERS = ['haiku', 'sonnet', 'opus'];

const EFFORT_VALUES = ['low', 'medium', 'high', 'max'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['model', 'orchestration_id'],
  properties: {
    model: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Model name or tier (haiku, sonnet, opus, or full model ID).',
    },
    effort: {
      type: 'string',
      enum: EFFORT_VALUES,
      // Advisory-only in 2.0.14: effort is captured and echoed in result.effort
      // but no cost multiplier is applied. Multiplier support is deferred to 2.0.15.
      description: 'Effort level (low, medium, high, max). Optional — advisory only.',
    },
    orchestration_id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Orchestration ID for context (used to look up running cost if available).',
    },
    estimated_input_tokens: {
      type: 'integer',
      minimum: 0,
      maximum: 2_000_000,
      description: 'Estimated input tokens. If omitted, historical averages are used.',
    },
    estimated_output_tokens: {
      type: 'integer',
      minimum: 0,
      maximum: 2_000_000,
      description: 'Estimated output tokens. If omitted, historical averages are used.',
    },
  },
};

const definition = deepFreeze({
  name: 'cost_budget_check',
  description:
    'Project the cost of a proposed Agent() spawn against the orchestration\'s running ' +
    'cost and the configured cost caps (daily_cost_limit_usd, weekly_cost_limit_usd, ' +
    'max_cost_usd). Returns projected_cost_usd, pricing_source, last_verified, ' +
    'would_exceed_* booleans, and advisory warnings. ' +
    'INTENDED FOR PM CALLERS ONLY — do not call from subagents. ' +
    'Per 2014-scope-proposal.md §W3 (OQ1 decision: PM-only in 2.0.14).',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Model tier normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a model string to one of the three tier keys.
 * Checks for substring containment (case-insensitive).
 * Defaults to 'sonnet' for unknown models.
 *
 * @param {string} model
 * @returns {'haiku' | 'sonnet' | 'opus'}
 */
function resolveModelTier(model) {
  const lower = (model || '').toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'sonnet'; // conservative default for unknown models
}

// ---------------------------------------------------------------------------
// Pricing table resolution
// ---------------------------------------------------------------------------

/**
 * Read the pricing table from config.
 * Returns { table, source, last_verified } where:
 *   source = 'config' | 'builtin'
 *   last_verified = ISO date string from config, or today's date for builtin
 *
 * @param {object|null} config - The loaded server config (or null)
 * @returns {{ table: object, source: string, last_verified: string }}
 */
function resolvePricingTable(config) {
  try {
    if (
      config &&
      config.mcp_server &&
      config.mcp_server.cost_budget_check &&
      config.mcp_server.cost_budget_check.pricing_table &&
      typeof config.mcp_server.cost_budget_check.pricing_table === 'object'
    ) {
      const pt = config.mcp_server.cost_budget_check.pricing_table;
      const lastVerified =
        (config.mcp_server.cost_budget_check.last_verified &&
          typeof config.mcp_server.cost_budget_check.last_verified === 'string')
          ? config.mcp_server.cost_budget_check.last_verified
          : new Date().toISOString().slice(0, 10);
      return { table: pt, source: 'config', last_verified: lastVerified };
    }
  } catch (_e) {
    // fall through to builtin
  }
  // Builtin fallback
  const today = new Date().toISOString().slice(0, 10);
  return { table: BUILTIN_PRICING_TABLE, source: 'builtin', last_verified: today };
}

/**
 * Get per-1M-token rates for a given model tier from the pricing table.
 * Falls back to builtin rates if the config table is missing the tier.
 *
 * @param {object} table - The pricing table (from config or builtin)
 * @param {string} tier  - One of 'haiku' | 'sonnet' | 'opus'
 * @returns {{ input_per_1m: number, output_per_1m: number }}
 */
function getRatesForTier(table, tier) {
  const entry = table && table[tier];
  if (
    entry &&
    typeof entry.input_per_1m === 'number' &&
    typeof entry.output_per_1m === 'number'
  ) {
    return { input_per_1m: entry.input_per_1m, output_per_1m: entry.output_per_1m };
  }
  // Fall back to builtin for this tier
  return BUILTIN_PRICING_TABLE[tier] || BUILTIN_PRICING_TABLE.sonnet;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Return token estimates for a given tier. If the caller provided explicit
 * estimates, use those; otherwise use DEFAULT_TOKEN_ESTIMATES.
 *
 * @param {string} tier
 * @param {number|undefined} inputTokens
 * @param {number|undefined} outputTokens
 * @returns {{ input: number, output: number, from_history: boolean }}
 */
function resolveTokenEstimates(tier, inputTokens, outputTokens) {
  const defaults = DEFAULT_TOKEN_ESTIMATES[tier] || DEFAULT_TOKEN_ESTIMATES.sonnet;
  const input = (typeof inputTokens === 'number' && inputTokens >= 0) ? inputTokens : defaults.input;
  const output = (typeof outputTokens === 'number' && outputTokens >= 0) ? outputTokens : defaults.output;
  const fromHistory = !(typeof inputTokens === 'number' && typeof outputTokens === 'number');
  return { input, output, from_history: fromHistory };
}

// ---------------------------------------------------------------------------
// Cost projection
// ---------------------------------------------------------------------------

/**
 * Compute projected cost in USD.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {{ input_per_1m: number, output_per_1m: number }} rates
 * @returns {number}
 */
function computeCost(inputTokens, outputTokens, rates) {
  return (inputTokens / 1_000_000) * rates.input_per_1m +
         (outputTokens / 1_000_000) * rates.output_per_1m;
}

// ---------------------------------------------------------------------------
// Budget limit checks
// ---------------------------------------------------------------------------

/**
 * Read cost caps from config. All values may be null (unconfigured).
 *
 * @param {object|null} config
 * @returns {{ max_cost_usd: number|null, daily_cost_limit_usd: number|null, weekly_cost_limit_usd: number|null }}
 */
function readCostCaps(config) {
  const maxCost =
    (config && typeof config.max_cost_usd === 'number') ? config.max_cost_usd : null;
  const daily =
    (config && typeof config.daily_cost_limit_usd === 'number') ? config.daily_cost_limit_usd : null;
  const weekly =
    (config && typeof config.weekly_cost_limit_usd === 'number') ? config.weekly_cost_limit_usd : null;
  return { max_cost_usd: maxCost, daily_cost_limit_usd: daily, weekly_cost_limit_usd: weekly };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('cost_budget_check: ' + validation.errors.join('; '));
  }

  const config = (context && context.config) || null;

  // Resolve pricing table — prefer loadCostBudgetCheckConfig (single source of
  // truth via config-schema.js) when a project root is available (production
  // path). Fall back to reading from context.config directly when projectRoot
  // is absent (e.g. unit tests that inject config without a filesystem).
  let table, pricingSource, lastVerified;
  const projectRoot = (context && context.projectRoot) || null;
  if (projectRoot) {
    const cwd = resolveSafeCwd(projectRoot);
    const loaded = loadCostBudgetCheckConfig(cwd);
    table = loaded.pricing_table;
    lastVerified = loaded.last_verified;
    // Determine source: if the loaded table differs from the builtin, it came
    // from the config file. loadCostBudgetCheckConfig always merges/falls back,
    // so we check whether the config file actually had a cost_budget_check block.
    const hasCbcBlock = config &&
      config.mcp_server &&
      config.mcp_server.cost_budget_check &&
      typeof config.mcp_server.cost_budget_check.pricing_table === 'object';
    pricingSource = hasCbcBlock ? 'config' : 'builtin';
  } else {
    ({ table, source: pricingSource, last_verified: lastVerified } = resolvePricingTable(config));
  }

  // Resolve model tier
  const tier = resolveModelTier(input.model);

  // Resolve rates
  const rates = getRatesForTier(table, tier);

  // Resolve token estimates
  const { input: inputTokens, output: outputTokens, from_history: fromHistory } =
    resolveTokenEstimates(tier, input.estimated_input_tokens, input.estimated_output_tokens);

  // Compute projected cost
  const projectedCostUsd = computeCost(inputTokens, outputTokens, rates);

  // Read cost caps
  const caps = readCostCaps(config);
  const anyCap = caps.max_cost_usd !== null ||
                 caps.daily_cost_limit_usd !== null ||
                 caps.weekly_cost_limit_usd !== null;

  // Build warnings
  const warnings = [];

  if (!anyCap) {
    warnings.push(
      'no cost cap configured; recommendation is informational only'
    );
  }

  if (fromHistory) {
    warnings.push(
      'token estimates are conservative defaults (no explicit estimated_input_tokens / estimated_output_tokens provided)'
    );
  }

  if (pricingSource === 'builtin') {
    warnings.push(
      'pricing table not found in config; using built-in defaults (set mcp_server.cost_budget_check.pricing_table to use custom rates)'
    );
  }

  // Budget limit checks (only meaningful when caps are configured)
  const wouldExceedMaxCost =
    caps.max_cost_usd !== null && projectedCostUsd > caps.max_cost_usd;
  const wouldExceedDailyLimit =
    caps.daily_cost_limit_usd !== null && projectedCostUsd > caps.daily_cost_limit_usd;
  const wouldExceedWeeklyLimit =
    caps.weekly_cost_limit_usd !== null && projectedCostUsd > caps.weekly_cost_limit_usd;

  if (wouldExceedMaxCost) {
    warnings.push(
      `projected cost $${projectedCostUsd.toFixed(4)} exceeds max_cost_usd $${caps.max_cost_usd}`
    );
  }
  if (wouldExceedDailyLimit) {
    warnings.push(
      `projected cost $${projectedCostUsd.toFixed(4)} exceeds daily_cost_limit_usd $${caps.daily_cost_limit_usd}`
    );
  }
  if (wouldExceedWeeklyLimit) {
    warnings.push(
      `projected cost $${projectedCostUsd.toFixed(4)} exceeds weekly_cost_limit_usd $${caps.weekly_cost_limit_usd}`
    );
  }

  const result = {
    orchestration_id: input.orchestration_id,
    model: input.model,
    model_tier: tier,
    effort: input.effort || null,
    projected_cost_usd: projectedCostUsd,
    pricing_source: pricingSource,
    last_verified: lastVerified,
    input_tokens_used: inputTokens,
    output_tokens_used: outputTokens,
    token_estimates_from_defaults: fromHistory,
    would_exceed_max_cost: wouldExceedMaxCost,
    would_exceed_daily_limit: wouldExceedDailyLimit,
    would_exceed_weekly_limit: wouldExceedWeeklyLimit,
    warnings,
  };

  return toolSuccess(result);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function toolSuccess(structuredContent) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

module.exports = {
  definition,
  handle,
  BUILTIN_PRICING_TABLE,
  resolveModelTier,
  resolvePricingTable,
  computeCost,
};
