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

const fs = require('node:fs');
const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { loadCostBudgetCheckConfig, DEFAULT_EFFORT_MULTIPLIERS } = require('../../_lib/config-schema');
const { resolveSafeCwd } = require('../../_lib/resolve-project-cwd');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { AGENT_ROLES } = require('../lib/constants');

// Shared cost helpers — canonical source for pricing table, token estimates,
// reservation reader, and cap helpers (F09: de-duplicated from three callers).
const {
  BUILTIN_PRICING_TABLE,
  DEFAULT_TOKEN_ESTIMATES,
  getRatesForTier,
  readCostCaps,
  readActiveReservations,
} = require('../../_lib/cost-helpers');

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
      // W15 (v2.0.16): effort multiplier is now applied to projected cost.
      // Multiplier table: low=0.7, medium=1.0, high=1.4, max=1.8.
      // Configurable via mcp_server.cost_budget_check.effort_multipliers in config.
      description: 'Effort level (low, medium, high, max). Optional — applies cost multiplier: low=0.7x, medium=1.0x, high=1.4x, max=1.8x.',
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
    // T2 F10: agent_type was documented in CHANGELOG but missing from the schema.
    // Optional — included for richer advisory output; does not affect cost projection.
    agent_type: {
      type: 'string',
      enum: AGENT_ROLES,
      description: 'Agent role for the proposed spawn (optional — informational only).',
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

// getRatesForTier is imported from ../../_lib/cost-helpers (F09).

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
// Effort multiplier
// ---------------------------------------------------------------------------

/**
 * Resolve the effort multiplier for a given effort level.
 *
 * Uses the configurable effort_multipliers table from
 * mcp_server.cost_budget_check.effort_multipliers in the loaded config;
 * falls back to DEFAULT_EFFORT_MULTIPLIERS if absent or malformed.
 *
 * @param {string|null|undefined} effort - Effort level string or null/undefined
 * @param {object|null} effortMultipliersConfig - Optional custom multipliers table
 * @returns {number} Multiplier value (1.0 when effort is absent)
 */
function resolveEffortMultiplier(effort, effortMultipliersConfig) {
  if (!effort) return 1.0;

  // Prefer caller-supplied config table; fall back to hardcoded defaults.
  const table =
    (effortMultipliersConfig &&
      typeof effortMultipliersConfig === 'object' &&
      !Array.isArray(effortMultipliersConfig))
      ? effortMultipliersConfig
      : DEFAULT_EFFORT_MULTIPLIERS;

  const multiplier = table[effort];
  if (typeof multiplier === 'number' && multiplier > 0) {
    return multiplier;
  }
  // Unknown effort value or bad config — fall back to 1.0 (no adjustment).
  return 1.0;
}

// ---------------------------------------------------------------------------
// Running-cost accumulation (W1)
// ---------------------------------------------------------------------------

// Maximum bytes to read from events.jsonl (same guard as record-pattern-skip.js).
const MAX_EVENTS_READ = 2 * 1024 * 1024; // 2 MB

/**
 * Sum `cost_usd` from `agent_stop` events in events.jsonl for the given
 * orchestration_id.
 *
 * Fail-open contract: any I/O or parse error returns
 * `{ accumulated_usd: 0, warnings: ['running_cost_unavailable'] }` rather
 * than throwing. The caller adds this to projectedCostUsd before cap checks.
 *
 * @param {string} orchId
 * @param {string|null} projectRoot
 * @param {string|null} dateFilter - ISO date string 'YYYY-MM-DD' for daily/weekly filter (or null for total)
 * @returns {Promise<{ accumulated_usd: number, warnings: string[] }>}
 */
async function readAccumulatedCost(orchId, projectRoot, dateFilter) {
  const unavailable = { accumulated_usd: 0, warnings: ['running_cost_unavailable'] };
  if (!projectRoot || !orchId) return unavailable;

  let eventsPath;
  try {
    eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
  } catch (_e) {
    return unavailable;
  }

  // Size guard — skip accumulation if file is too large to avoid blocking.
  try {
    const stat = fs.statSync(eventsPath);
    if (stat.size > MAX_EVENTS_READ) {
      return { accumulated_usd: 0, warnings: ['running_cost_unavailable'] };
    }
  } catch (_e) {
    // File absent or unreadable — no accumulated cost.
    return { accumulated_usd: 0, warnings: [] };
  }

  let totalUsd = 0;
  let parseOk = true;

  try {
    const raw = fs.readFileSync(eventsPath, 'utf8');
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.orchestration_id !== orchId) continue;
      if (ev.type !== 'agent_stop') continue;

      // Apply date filter for daily/weekly accumulation.
      if (dateFilter && typeof ev.timestamp === 'string') {
        if (!ev.timestamp.startsWith(dateFilter)) continue;
      }

      // Sum cost — try cost_usd first, then nested cost.cost_usd.
      const costField =
        (typeof ev.cost_usd === 'number') ? ev.cost_usd :
        (ev.cost && typeof ev.cost.cost_usd === 'number') ? ev.cost.cost_usd :
        0;
      totalUsd += costField;
    }
  } catch (_e) {
    parseOk = false;
  }

  if (!parseOk) return unavailable;
  return { accumulated_usd: totalUsd, warnings: [] };
}

// ---------------------------------------------------------------------------
// Budget limit checks
// ---------------------------------------------------------------------------

// readCostCaps is imported from ../../_lib/cost-helpers (F09).

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('cost_budget_check', context);
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

  // Compute projected cost (base, before effort multiplier)
  const baseCostUsd = computeCost(inputTokens, outputTokens, rates);

  // W15 (v2.0.16): apply effort multiplier.
  // Read configurable multipliers from mcp_server.cost_budget_check.effort_multipliers;
  // fall back to DEFAULT_EFFORT_MULTIPLIERS if absent.
  let effortMultipliersConfig = null;
  if (projectRoot) {
    try {
      const loaded = loadCostBudgetCheckConfig(resolveSafeCwd(projectRoot));
      effortMultipliersConfig = (loaded && loaded.effort_multipliers) || null;
    } catch (_e) {
      // Fail-open: use defaults
    }
  } else if (config && config.mcp_server && config.mcp_server.cost_budget_check &&
             config.mcp_server.cost_budget_check.effort_multipliers) {
    effortMultipliersConfig = config.mcp_server.cost_budget_check.effort_multipliers;
  }
  const effortMultiplier = resolveEffortMultiplier(input.effort, effortMultipliersConfig);
  const projectedCostUsd = baseCostUsd * effortMultiplier;

    // Read accumulated running cost (fail-open: warnings appended if unavailable).
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const [accTotal, accDaily] = await Promise.all([
    readAccumulatedCost(input.orchestration_id, projectRoot, null),
    readAccumulatedCost(input.orchestration_id, projectRoot, today),
  ]);

  // Add unexpired reservations to accumulated spend for parallel-spawn pre-checks.
  // readActiveReservations is synchronous and fail-open (returns 0 on error).
  const todayStartMs = new Date(today + 'T00:00:00.000Z').getTime();
  const activeRes = readActiveReservations(
    input.orchestration_id, projectRoot, { sinceTimestamp: todayStartMs }
  );
  for (const w of activeRes.warnings) {
    if (!accTotal.warnings.includes(w)) accTotal.warnings.push(w);
  }

  const accumulatedUsd = accTotal.accumulated_usd + activeRes.reserved_usd;
  const accumulatedDailyUsd = accDaily.accumulated_usd + activeRes.reserved_daily_usd;
  // Weekly accumulation: sum everything (no practical per-week filter without
  // knowing the week boundary; use total accumulated as conservative estimate).
  const accumulatedWeeklyUsd = accumulatedUsd;

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

  // Propagate running_cost_unavailable warnings from both accumulators.
  // Merge accDaily.warnings (daily scan can diverge from total on partial reads).
  for (const w of accTotal.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }
  for (const w of accDaily.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  // Cap comparisons include accumulated spend + projected cost.
  const totalForMaxCap = accumulatedUsd + projectedCostUsd;
  const totalForDailyCap = accumulatedDailyUsd + projectedCostUsd;
  const totalForWeeklyCap = accumulatedWeeklyUsd + projectedCostUsd;

  const wouldExceedMaxCost =
    caps.max_cost_usd !== null && totalForMaxCap > caps.max_cost_usd;
  const wouldExceedDailyLimit =
    caps.daily_cost_limit_usd !== null && totalForDailyCap > caps.daily_cost_limit_usd;
  const wouldExceedWeeklyLimit =
    caps.weekly_cost_limit_usd !== null && totalForWeeklyCap > caps.weekly_cost_limit_usd;

  if (wouldExceedMaxCost) {
    warnings.push(
      `accumulated+projected cost $${totalForMaxCap.toFixed(4)} exceeds max_cost_usd $${caps.max_cost_usd}`
    );
  }
  if (wouldExceedDailyLimit) {
    warnings.push(
      `accumulated+projected daily cost $${totalForDailyCap.toFixed(4)} exceeds daily_cost_limit_usd $${caps.daily_cost_limit_usd}`
    );
  }
  if (wouldExceedWeeklyLimit) {
    warnings.push(
      `accumulated+projected cost $${totalForWeeklyCap.toFixed(4)} exceeds weekly_cost_limit_usd $${caps.weekly_cost_limit_usd} (conservative estimate — true weekly filter not implemented)`
    );
  }

  const result = {
    orchestration_id: input.orchestration_id,
    model: input.model,
    model_tier: tier,
    effort: input.effort || null,
    effort_multiplier: effortMultiplier,
    agent_type: input.agent_type || null,
    accumulated_cost_usd: accumulatedUsd,
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

module.exports = {
  definition,
  handle,
  BUILTIN_PRICING_TABLE,
  resolveModelTier,
  resolvePricingTable,
  computeCost,
  readAccumulatedCost,
  resolveEffortMultiplier,
};
