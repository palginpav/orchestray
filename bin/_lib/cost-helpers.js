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
 *   fable:  input $10.00/1M, output $50.00/1M  (Claude Fable 5 — GA 2026-06-09)
 *   haiku:  input $1.00/1M,  output $5.00/1M
 *   sonnet: input $3.00/1M,  output $15.00/1M
 *   opus:   input $5.00/1M,  output $25.00/1M
 */
const BUILTIN_PRICING_TABLE = deepFreeze({
  fable:  { input_per_1m: 10.00, output_per_1m: 50.00 },
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
  fable:  { input: 100_000, output: 15_000 },
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
 * Opus 4.7-and-later tokenizer multiplier (also applies to Fable 5 and Opus 5).
 *
 * Opus 4.7 introduced a new tokenizer (carried over unchanged by Opus 4.8,
 * Opus 5, and Fable 5) that consumes ~35% more tokens than Opus 4.6 for the same
 * text. Per-token pricing is unchanged for each model, but effective cost is ~35%
 * higher for the same prompt vs. the Opus 4.6 baseline.
 *
 * Source: platform-oracle Opus 4.7 research — see
 *   .orchestray/kb/artifacts/v218-claude-design-research.md §"Risks and Gotchas" item 5.
 *   Fable 5 confirmation: .orchestray/kb/facts/2026-06-fable-5-rollout.md §5.
 */
const OPUS_47_TOKENIZER_MULTIPLIER = 1.35;

/**
 * Sonnet 5 tokenizer multiplier — same newer-tokenizer family as Opus 4.7+/Fable 5,
 * but Sonnet 5 consumes ~30% more tokens for the same text (vs ~35% for the others).
 * Per-token pricing is unchanged ($3/$15, same as Sonnet 4.6); effective cost is
 * ~30% higher for the same prompt vs. the Sonnet 4.6 baseline.
 *
 * Source: platform-oracle Sonnet 5 research (v2.3.15).
 */
const SONNET_5_TOKENIZER_MULTIPLIER = 1.30;

/**
 * Return per-1M-token rates for a model ID string.
 *
 * Recognises full model IDs (e.g. `claude-fable-5`, `claude-opus-5`,
 * `claude-opus-4-7`, `claude-opus-4.7`, `claude-opus-4-8`, `claude-sonnet-5`,
 * `claude-sonnet-4-6`, `claude-haiku-4-5`) and short aliases (`fable`, `opus`,
 * `sonnet`, `haiku`). Falls back to sonnet rates for unknown strings.
 *
 * Fable 5, Opus 4.7, Opus 4.8, and Opus 5 apply a 1.35× tokenizer multiplier to
 * both input and output rates (all use the same Opus 4.7-era tokenizer).
 * Sonnet 5 applies a 1.30× multiplier (newer tokenizer, smaller inflation).
 *
 * @param {string} modelId - Model ID or alias string.
 * @returns {{ input_per_1m: number, output_per_1m: number }}
 */
function getPricing(modelId) {
  const m = (modelId || '').toLowerCase();
  // Fable 5 uses the Opus 4.7-era tokenizer — apply the same 1.35× multiplier.
  if (m.includes('fable')) {
    const base = BUILTIN_PRICING_TABLE.fable;
    return {
      input_per_1m: base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
      output_per_1m: base.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
    };
  }
  // Check for Opus 4.7 / 4.8 / 5 (shared tokenizer) — must come before the generic opus check.
  // Opus 5 ($5/$25, unchanged from 4.8) reuses the Opus 4.7-era tokenizer, so it applies the
  // same 1.35× multiplier and does NOT need a new coefficient.
  if (m.includes('opus-4-7') || m.includes('opus-4.7') || m.includes('opus-4-8') || m.includes('opus-4.8') || m.includes('opus-5')) {
    const base = BUILTIN_PRICING_TABLE.opus;
    return {
      input_per_1m: base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
      output_per_1m: base.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
    };
  }
  // Sonnet 5 (newer tokenizer) — must come before the generic sonnet check, which
  // would otherwise also match claude-sonnet-4-6 (older tokenizer, no multiplier).
  if (m.includes('sonnet-5')) {
    const base = BUILTIN_PRICING_TABLE.sonnet;
    return {
      input_per_1m: base.input_per_1m * SONNET_5_TOKENIZER_MULTIPLIER,
      output_per_1m: base.output_per_1m * SONNET_5_TOKENIZER_MULTIPLIER,
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
 * @param {string} tier - One of 'haiku' | 'sonnet' | 'opus' | 'fable'
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
 * True when a raw model ID uses the Opus-4.7-era tokenizer (Opus 4.7, Opus 4.8,
 * Opus 5, Fable 5), which consumes ~35% more tokens for the same text.
 *
 * Matches only concrete Opus-5 IDs (e.g. `claude-opus-5`, `claude-opus-5[1m]`),
 * NOT the bare `opus` alias. The bare `opus` alias resolves to Opus 5 only on
 * Claude Code v2.1.219+ (and to Opus 4.6 on Microsoft Foundry), so its tokenizer
 * is provider/version-dependent — enforcement leaves it at base rate, matching
 * pre-existing behaviour for the whole Opus 4.8 era. See getPricing note above.
 *
 * @param {string} modelRaw
 * @returns {boolean}
 */
function usesOpus47Tokenizer(modelRaw) {
  const m = (modelRaw || '').toLowerCase();
  return (
    m.includes('fable') ||
    m.includes('opus-4-7') || m.includes('opus-4.7') ||
    m.includes('opus-4-8') || m.includes('opus-4.8') ||
    m.includes('opus-5')
  );
}

/**
 * True when a raw model ID is Sonnet 5, which uses its own newer tokenizer
 * (~30% more tokens for the same text vs Sonnet 4.6). Kept separate from
 * usesOpus47Tokenizer because the multiplier differs (1.30× vs 1.35×).
 *
 * @param {string} modelRaw
 * @returns {boolean}
 */
function usesSonnet5Tokenizer(modelRaw) {
  return (modelRaw || '').toLowerCase().includes('sonnet-5');
}

/**
 * Enforcement-only: cost-CAP projection uses fixed baseline token estimates
 * (not actual tokens). The bare `sonnet` alias now resolves to Sonnet 5 (newer
 * tokenizer), so it must be projected at 1.30x; explicit `claude-sonnet-4-6`
 * keeps the old tokenizer (1.0x). Distinct from usesSonnet5Tokenizer(), which is
 * a factual test on concrete model IDs (used where ACTUAL token counts apply —
 * getPricing() must NOT apply this multiplier there, or already-inflated actual
 * token counts get double-counted).
 *
 * @param {string} modelRaw
 * @returns {boolean}
 */
function enforcementUsesSonnet5Tokenizer(modelRaw) {
  const m = (modelRaw || '').toLowerCase();
  if (m.includes('sonnet-4')) return false;        // explicit Sonnet 4.6 → old tokenizer
  return m === 'sonnet' || m.includes('sonnet-5'); // bare alias (now Sonnet 5) or explicit 5
}

/**
 * v2.3.12 W4 (A3): tokenizer-aware enforcement rates.
 *
 * The cost-cap ENFORCEMENT path (gate-cost-budget.js, cost_budget_check.js)
 * previously collapsed the raw model ID to a bare tier via resolveModelTier and
 * looked up base rates with getRatesForTier — dropping the 1.35× Opus-4.7+/Fable
 * tokenizer multiplier that the REPORTING path (getPricing) applies. That made
 * enforcement under-project Opus-4.8/Fable spawns by ~35%, so orchestrations
 * could run past the intended cap. This helper resolves base rates from the
 * (operator-overridable) config pricing table for the model's tier, then applies
 * the multiplier when the raw model ID uses the new tokenizer — keeping
 * enforcement and reporting in agreement.
 *
 * @param {object|null} table - Pricing table (from config or builtin)
 * @param {string} modelRaw - Raw model ID or alias (e.g. 'claude-opus-4-8', 'fable')
 * @returns {{ input_per_1m: number, output_per_1m: number }}
 */
function getEnforcementRates(table, modelRaw) {
  const m = (modelRaw || '').toLowerCase();
  let tier;
  if (m.includes('fable')) tier = 'fable';
  else if (m.includes('haiku')) tier = 'haiku';
  else if (m.includes('opus')) tier = 'opus';
  else if (m.includes('sonnet')) tier = 'sonnet';
  else tier = 'sonnet'; // conservative default — mirrors resolveModelTier
  const base = getRatesForTier(table, tier);
  if (usesOpus47Tokenizer(modelRaw)) {
    return {
      input_per_1m: base.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
      output_per_1m: base.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER,
    };
  }
  if (enforcementUsesSonnet5Tokenizer(modelRaw)) {
    return {
      input_per_1m: base.input_per_1m * SONNET_5_TOKENIZER_MULTIPLIER,
      output_per_1m: base.output_per_1m * SONNET_5_TOKENIZER_MULTIPLIER,
    };
  }
  return base;
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
  SONNET_5_TOKENIZER_MULTIPLIER,
  loadReservationTTLMs,
  getPricing,
  getRatesForTier,
  getEnforcementRates,
  usesOpus47Tokenizer,
  usesSonnet5Tokenizer,
  enforcementUsesSonnet5Tokenizer,
  readCostCaps,
  loadRawConfig,
  readActiveReservations,
  gcReservations,
};
