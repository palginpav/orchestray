'use strict';

/**
 * cost-helpers.js — shared cost-projection helpers for the cost-budget subsystem.
 *
 * Extracted from cost_budget_check.js, cost_budget_reserve.js, and gate-cost-budget.js
 * per F09 (triple duplication of pricing helpers across three files).
 *
 * Consumers:
 *   bin/mcp-server/tools/cost_budget_check.js
 *   bin/mcp-server/tools/cost_budget_reserve.js
 *   bin/gate-cost-budget.js
 *
 * Per v2016-reviewer-audit.md F09.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { deepFreeze } = require('../mcp-server/lib/schemas');

// ---------------------------------------------------------------------------
// Pricing table (single source of truth — update here when Anthropic changes rates)
// ---------------------------------------------------------------------------

/**
 * Built-in pricing table (fall-back when config is missing or malformed).
 *   haiku:  input $1.00/1M, output $5.00/1M
 *   sonnet: input $3.00/1M, output $15.00/1M
 *   opus:   input $5.00/1M, output $25.00/1M
 */
const BUILTIN_PRICING_TABLE = deepFreeze({
  haiku:  { input_per_1m: 1.00,  output_per_1m: 5.00  },
  sonnet: { input_per_1m: 3.00,  output_per_1m: 15.00 },
  opus:   { input_per_1m: 5.00,  output_per_1m: 25.00 },
});

// ---------------------------------------------------------------------------
// Token estimates
// ---------------------------------------------------------------------------

/**
 * Conservative historical-average token estimates per model tier.
 * Over-estimates rather than under-estimates to be safe for cap comparisons.
 */
const DEFAULT_TOKEN_ESTIMATES = deepFreeze({
  haiku:  { input: 50_000,  output: 8_000  },
  sonnet: { input: 80_000,  output: 12_000 },
  opus:   { input: 100_000, output: 15_000 },
});

// ---------------------------------------------------------------------------
// Reservation TTL
// ---------------------------------------------------------------------------

/**
 * Default TTL for cost reservations in milliseconds (30 minutes).
 * A reservation is "unexpired" when expires_at > Date.now().
 * Config override available via mcp_server.cost_budget_reserve.ttl_minutes (D5 v2.0.16).
 */
const DEFAULT_RESERVATION_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// GC thresholds for the cost-reservations ledger (A2-I1 v2.0.16)
//
// Extracted as named constants so gcReservations() (here) and the opportunistic
// GC trigger in cost_budget_reserve.js share a single source of truth.
// ---------------------------------------------------------------------------

/** Skip GC when the reservations file is below this size (bytes). */
const GC_NOOP_BELOW_BYTES = 64 * 1024;       // 64 KB

/** Trigger opportunistic GC from cost_budget_reserve when the file exceeds this size (bytes). */
const GC_OPPORTUNISTIC_TRIGGER_BYTES = 512 * 1024; // 512 KB

/**
 * D5 (v2.0.16): Read the reservation TTL from config, returning milliseconds.
 *
 * Reads mcp_server.cost_budget_reserve.ttl_minutes from <cwd>/.orchestray/config.json.
 * Falls back to DEFAULT_RESERVATION_TTL_MS (30 min) when the key is absent or invalid.
 * This preserves existing behaviour for installs that have not set the key.
 *
 * @param {string} cwd - Absolute path to the project root.
 * @returns {number} TTL in milliseconds (minimum 60000 = 1 minute; maximum 86400000 = 24 hours).
 */
function loadReservationTTLMs(cwd) {
  try {
    const { loadCostBudgetReserveConfig } = require('./config-schema');
    const { ttl_minutes } = loadCostBudgetReserveConfig(cwd);
    return ttl_minutes * 60 * 1000;
  } catch (_e) {
    // Fail-open: any error (circular dep, missing file, etc.) returns the built-in default.
    return DEFAULT_RESERVATION_TTL_MS;
  }
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

/**
 * Opus 4.7 tokenizer multiplier.
 *
 * Anthropic's Opus 4.7 uses a new tokenizer that consumes ~35% more tokens
 * than Opus 4.6 for the same text. Per-token pricing is unchanged ($5/$25 per 1M),
 * but effective cost is ~35% higher for the same prompt.
 *
 * Source: platform-oracle Opus 4.7 research — see
 *   .orchestray/kb/artifacts/v218-claude-design-research.md §"Risks and Gotchas" item 5.
 */
const OPUS_47_TOKENIZER_MULTIPLIER = 1.35;

/**
 * Return per-1M-token rates for a model ID string.
 *
 * Recognises full model IDs (e.g. `claude-opus-4-7`, `claude-opus-4.7`,
 * `claude-sonnet-4-6`, `claude-haiku-4-5`) and short aliases (`opus`, `sonnet`,
 * `haiku`). Falls back to sonnet rates for unknown strings.
 *
 * Opus 4.7 applies a 1.35× tokenizer multiplier to both input and output rates.
 *
 * @param {string} modelId - Model ID or alias string.
 * @returns {{ input_per_1m: number, output_per_1m: number }}
 */
function getPricing(modelId) {
  const m = (modelId || '').toLowerCase();
  // Check for Opus 4.7 specifically — must come before the generic opus check.
  if (m.includes('opus-4-7') || m.includes('opus-4.7')) {
    const base = BUILTIN_PRICING_TABLE.opus;
    return {
      input_per_1m: base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
      output_per_1m: base.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
    };
  }
  if (m.includes('opus'))   return BUILTIN_PRICING_TABLE.opus;
  if (m.includes('haiku'))  return BUILTIN_PRICING_TABLE.haiku;
  if (m.includes('sonnet')) return BUILTIN_PRICING_TABLE.sonnet;
  // Default: sonnet rates for unknown model strings.
  return BUILTIN_PRICING_TABLE.sonnet;
}

/**
 * Get per-1M-token rates for a given model tier from the pricing table.
 * Falls back to BUILTIN_PRICING_TABLE when the config table is missing the tier.
 *
 * @param {object|null} table - Pricing table (from config or builtin)
 * @param {string} tier - One of 'haiku' | 'sonnet' | 'opus'
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
  return BUILTIN_PRICING_TABLE[tier] || BUILTIN_PRICING_TABLE.sonnet;
}

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

/**
 * Load the raw config object from <cwd>/.orchestray/config.json.
 * Fail-open: returns null on any I/O or parse error.
 *
 * @param {string} cwd
 * @returns {object|null}
 */
function loadRawConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_e) {
    // Fail-open: missing or malformed config returns null
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reservation reader (F01)
// ---------------------------------------------------------------------------

/**
 * Read unexpired cost reservations from cost-reservations.jsonl for a given
 * orchestration_id and return their total projected_cost_usd split by scope.
 *
 * "Unexpired" is defined as: expires_at > now AND orchestration_id === orchId.
 *
 * Returns both:
 *   - `reserved_usd`       — total across all unexpired reservations (for max-cap check)
 *   - `reserved_daily_usd` — only reservations whose `created_at` falls on or after
 *                            `sinceTimestamp` (for daily-cap check).
 *
 * Backward-compatible: records without `created_at` are conservatively counted in
 * BOTH totals (they might have been created today — don't under-count for the daily cap).
 *
 * Fail-open: any I/O or parse error returns all zeros.
 *
 * @param {string}      orchId        - The active orchestration ID to filter by
 * @param {string}      projectRoot   - Absolute path to project root
 * @param {object}      [opts]
 * @param {number|null} [opts.sinceTimestamp] - Unix ms timestamp for daily boundary.
 *   Only reservations with created_at >= sinceTimestamp count toward reserved_daily_usd.
 *   When null (default), reserved_daily_usd === reserved_usd (pre-A2-S2 behaviour).
 * @returns {{ reserved_usd: number, reserved_daily_usd: number, warnings: string[] }}
 */
function readActiveReservations(orchId, projectRoot, { sinceTimestamp = null } = {}) {
  if (!orchId || !projectRoot) {
    return { reserved_usd: 0, reserved_daily_usd: 0, warnings: [] };
  }

  const reservationsPath = path.join(
    projectRoot,
    '.orchestray',
    'state',
    'cost-reservations.jsonl'
  );

  let raw;
  try {
    // Size guard — avoid blocking on a very large file.
    const MAX_RESERVATIONS_READ = 2 * 1024 * 1024; // 2 MB
    const stat = fs.statSync(reservationsPath);
    if (stat.size > MAX_RESERVATIONS_READ) {
      return { reserved_usd: 0, reserved_daily_usd: 0, warnings: ['reservations_file_too_large'] };
    }
    raw = fs.readFileSync(reservationsPath, 'utf8');
  } catch (_e) {
    // File absent or unreadable — no reservations.
    return { reserved_usd: 0, reserved_daily_usd: 0, warnings: [] };
  }

  const now = Date.now();
  let totalUsd = 0;
  let dailyUsd = 0;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (row.orchestration_id !== orchId) continue;
    // Only count unexpired reservations.
    if (!row.expires_at || new Date(row.expires_at).getTime() <= now) continue;
    const cost = typeof row.projected_cost_usd === 'number' ? row.projected_cost_usd : 0;
    totalUsd += cost;

    // Daily-cap contribution: count when created_at is on or after the daily boundary,
    // OR when created_at is absent (conservative: always count toward daily to avoid
    // under-counting against the cap — backward-compatible with pre-A2-S2 records).
    if (sinceTimestamp === null) {
      // No date filter requested — match pre-A2-S2 behaviour.
      dailyUsd += cost;
    } else if (!row.created_at) {
      // No created_at field — conservatively count toward daily total.
      dailyUsd += cost;
    } else {
      const createdMs = new Date(row.created_at).getTime();
      if (!Number.isNaN(createdMs) && createdMs >= sinceTimestamp) {
        dailyUsd += cost;
      }
    }
  }

  return { reserved_usd: totalUsd, reserved_daily_usd: dailyUsd, warnings: [] };
}

// ---------------------------------------------------------------------------
// Reservation GC (D4 v2.0.16)
// ---------------------------------------------------------------------------

/**
 * Remove expired rows from cost-reservations.jsonl.
 *
 * A row is expired when its `expires_at` timestamp is <= Date.now().
 * Uses a temp-file + rename for atomicity.
 *
 * No-op conditions (fail-silent):
 *   - File does not exist
 *   - File is under 64 KB (avoid unnecessary I/O on small ledgers)
 *   - Any I/O or parse error (fail-open; the ledger is append-only safe)
 *
 * @param {string} projectRoot - Absolute path to project root
 */
function gcReservations(projectRoot) {
  if (!projectRoot) return;

  const reservationsPath = path.join(
    projectRoot,
    '.orchestray',
    'state',
    'cost-reservations.jsonl'
  );

  let stat;
  try {
    stat = fs.statSync(reservationsPath);
  } catch (_e) {
    // File absent — nothing to GC.
    return;
  }

  if (stat.size < GC_NOOP_BELOW_BYTES) {
    // Below threshold — skip to avoid unnecessary I/O.
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(reservationsPath, 'utf8');
  } catch (_e) {
    return;
  }

  const now = Date.now();
  const activeLines = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      // Preserve malformed lines (don't lose data on parse error)
      activeLines.push(rawLine);
      continue;
    }
    if (!row || typeof row !== 'object') {
      activeLines.push(rawLine);
      continue;
    }
    // Keep rows that are still unexpired (expires_at > now)
    if (row.expires_at && new Date(row.expires_at).getTime() > now) {
      activeLines.push(rawLine);
    }
    // Expired rows are dropped (GC)
  }

  // Atomic write via temp + rename.
  // Use a per-PID + timestamp + random suffix to prevent two concurrent GC sweeps
  // from overwriting each other's tmp file (A2-S1). If two GC calls race, each
  // writes its own tmp; only the first rename wins. The loser's rename fails silently
  // and leaves a stale tmp file, which the next GC sweep will clean up or overwrite.
  const tmpPath = reservationsPath +
    '.gc-tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  try {
    const content = activeLines.length > 0 ? activeLines.join('\n') + '\n' : '';
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, reservationsPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) { /* swallow */ }
    // Fail-silent: original file is intact; GC will retry next time.
  }
}

module.exports = {
  BUILTIN_PRICING_TABLE,
  DEFAULT_TOKEN_ESTIMATES,
  DEFAULT_RESERVATION_TTL_MS,
  GC_NOOP_BELOW_BYTES,
  GC_OPPORTUNISTIC_TRIGGER_BYTES,
  OPUS_47_TOKENIZER_MULTIPLIER,
  loadReservationTTLMs,
  getPricing,
  getRatesForTier,
  readCostCaps,
  loadRawConfig,
  readActiveReservations,
  gcReservations,
};
