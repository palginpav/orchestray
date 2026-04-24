'use strict';

/**
 * scorer-variants.js — W8 (v2.1.13 R-RET-PROMOTE): usage-aware ranking variants.
 *
 * Four pure scoring functions that can be plugged into pattern_find in place of
 * the legacy inline `confidence * (overlapRatio + roleBonus + fileBonus)` formula.
 *
 *   - scoreBaseline(pattern, ctx)       — current default; preserved 1:1.
 *   - scoreSkipDown(pattern, ctx)       — baseline × skip-rate penalty.
 *   - scoreLocalSuccess(pattern, ctx)   — baseline × project-local success boost.
 *   - scoreComposite(pattern, ctx)      — baseline × skip penalty × success boost.
 *
 * Each function is pure (no file I/O of its own — all event data is carried on
 * the `ctx.skipCounts` / `ctx.successCounts` maps built once per pattern_find
 * call) and deterministic given the same inputs.
 *
 * The formulas for skip-down and local-success match the shadow-mode scorers
 * shipped in v2.1.3 (bin/_lib/scorer-skip-down.js, scorer-local-success.js),
 * but with the event-loading side-effect lifted out so callers can batch the
 * load once per invocation.
 *
 * Results are expected to land in the same [0,1]-ish range as the legacy
 * baseline (it is already `confidence * (<=~1+0.3+0.4)` — i.e. nominally in
 * [0, ~1.7]; callers that truncate with Math.min(1, ...) should do so at the
 * call site, not here). Variant multipliers (penalty ∈ [0.4, 1], boost ∈ [1, 1.4])
 * keep variants within the same order of magnitude as baseline.
 */

// Max shrinkage factor for skip-down (60%).
const SKIP_MAX_PENALTY = 0.6;

// Floor multiplier: never let penalty push score below 1% of baseline.
const SKIP_FLOOR_RATIO = 0.01;

// Skip categories that contribute to the penalty signal.
const COUNTED_SKIP_CATEGORIES = ['contextual-mismatch', 'superseded'];

// Max success boost (+40%).
const SUCCESS_MAX_BOOST = 0.4;

// ---------------------------------------------------------------------------
// Core scoring helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the baseline retrieval score for a pattern.
 *
 * Mirrors the legacy formula in pattern_find.handle():
 *   score = confidence * (overlapRatio + roleBonus + fileBonus)
 *
 * @param {{ confidence: number, overlapRatio: number, roleBonus: number, fileBonus: number }} pattern
 *   Precomputed scoring inputs. Pattern_find builds these per entry.
 * @param {object} _ctx — unused for baseline (kept for signature symmetry).
 * @returns {number}
 */
function scoreBaseline(pattern, _ctx) {
  const confidence  = _safeNumber(pattern && pattern.confidence, 0);
  const overlap     = _safeNumber(pattern && pattern.overlapRatio, 0);
  const roleBonus   = _safeNumber(pattern && pattern.roleBonus, 0);
  const fileBonus   = _safeNumber(pattern && pattern.fileBonus, 0);
  return confidence * (overlap + roleBonus + fileBonus);
}

/**
 * Compute the skip-down penalty multiplier for a pattern.
 *
 * Formula (matches scorer-skip-down.js v1):
 *   skip_rate = skips / (times_applied + skips + 1)      # Laplace smoothed
 *   penalty   = 1 - (skip_rate * 0.6)                    # max 60% shrinkage
 *   raw       = baseline * penalty
 *   score     = max(raw, baseline * 0.01)                # floor at 1% baseline
 *
 * Only `contextual-mismatch` and `superseded` events count as skip signal.
 *
 * @param {object} pattern — same shape as baseline, plus `slug` and `timesApplied`.
 * @param {{ skipCounts: Map<string, { 'contextual-mismatch': number, superseded: number }> }} ctx
 * @returns {number}
 */
function scoreSkipDown(pattern, ctx) {
  const baseline      = scoreBaseline(pattern, ctx);
  const slug          = pattern && pattern.slug;
  const timesApplied  = _safeInt(pattern && pattern.timesApplied, 0);

  const counts = (ctx && ctx.skipCounts && slug && ctx.skipCounts.get(slug)) ||
                 { 'contextual-mismatch': 0, superseded: 0 };
  const totalSkips = _safeInt(counts['contextual-mismatch'], 0) +
                     _safeInt(counts['superseded'], 0);

  // Laplace-smoothed skip rate, bounded to [0, 1).
  const skipRate = totalSkips / (timesApplied + totalSkips + 1);
  const penalty  = 1 - (skipRate * SKIP_MAX_PENALTY);

  const raw   = baseline * penalty;
  const floor = baseline * SKIP_FLOOR_RATIO;
  return Math.max(raw, floor);
}

/**
 * Compute the local-success boost multiplier for a pattern.
 *
 * Formula (matches scorer-local-success.js v1):
 *   success_rate = success_events / (times_applied + 1)   # bounded [0, 1]
 *   boost        = 1 + (success_rate * 0.4)               # max +40%
 *   score        = baseline * boost
 *
 * @param {object} pattern
 * @param {{ successCounts: Map<string, number> }} ctx
 * @returns {number}
 */
function scoreLocalSuccess(pattern, ctx) {
  const baseline     = scoreBaseline(pattern, ctx);
  const slug         = pattern && pattern.slug;
  const timesApplied = _safeInt(pattern && pattern.timesApplied, 0);

  const successEvents = (ctx && ctx.successCounts && slug)
    ? _safeInt(ctx.successCounts.get(slug), 0)
    : 0;

  const rawRate     = successEvents / (timesApplied + 1);
  const successRate = Math.min(Math.max(rawRate, 0), 1);

  const boost = 1 + (successRate * SUCCESS_MAX_BOOST);
  return baseline * boost;
}

/**
 * Compute the composite score: baseline × skip penalty × success boost.
 *
 * Factored so the two adjustments stack multiplicatively. A pattern that is
 * both frequently skipped AND rarely successful gets compounded down-ranking;
 * one that is both successful AND rarely skipped gets compounded up-ranking.
 *
 * @param {object} pattern
 * @param {object} ctx
 * @returns {number}
 */
function scoreComposite(pattern, ctx) {
  const baseline     = scoreBaseline(pattern, ctx);
  if (baseline === 0) return 0;

  // Extract multipliers by dividing the sub-scores by baseline. Safer than
  // recomputing each multiplier inline (keeps the formula owned by the
  // individual functions).
  const skipScore    = scoreSkipDown(pattern, ctx);
  const successScore = scoreLocalSuccess(pattern, ctx);

  const skipMult    = skipScore    / baseline;
  const successMult = successScore / baseline;

  return baseline * skipMult * successMult;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _safeNumber(v, fallback) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
}

function _safeInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Skip / success count aggregators (pure — callers pass in loaded events)
// ---------------------------------------------------------------------------

/**
 * Fold pattern_skip_enriched events into a per-slug count map.
 * Only `contextual-mismatch` and `superseded` categories are counted.
 *
 * @param {object[]} events — raw event records.
 * @returns {Map<string, { 'contextual-mismatch': number, superseded: number }>}
 */
function buildSkipCounts(events) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  const counted = new Set(COUNTED_SKIP_CATEGORIES);
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (!ev.pattern_name || typeof ev.pattern_name !== 'string') continue;
    const cat = ev.skip_category;
    if (!counted.has(cat)) continue;
    if (!out.has(ev.pattern_name)) {
      out.set(ev.pattern_name, { 'contextual-mismatch': 0, superseded: 0 });
    }
    out.get(ev.pattern_name)[cat]++;
  }
  return out;
}

/**
 * Fold mcp_tool_call events (pattern_record_application / applied-success)
 * into a per-slug success count map.
 *
 * @param {object[]} events
 * @returns {Map<string, number>}
 */
function buildSuccessCounts(events) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.tool_name !== 'pattern_record_application') continue;
    if (ev.outcome !== 'applied-success') continue;
    const slug = (ev.input && ev.input.slug) ||
                 ev.slug ||
                 (ev.result && ev.result.slug) ||
                 null;
    if (!slug || typeof slug !== 'string') continue;
    out.set(slug, (out.get(slug) || 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------

const VALID_VARIANTS = ['baseline', 'skip-down', 'local-success', 'composite'];

/**
 * Map a variant name to the appropriate scoring function.
 * Unknown / missing / non-string names fall back to baseline.
 *
 * @param {string} name
 * @returns {function(object, object): number}
 */
function scorerForVariant(name) {
  switch (name) {
    case 'skip-down':     return scoreSkipDown;
    case 'local-success': return scoreLocalSuccess;
    case 'composite':     return scoreComposite;
    case 'baseline':
    default:
      return scoreBaseline;
  }
}

module.exports = {
  scoreBaseline,
  scoreSkipDown,
  scoreLocalSuccess,
  scoreComposite,
  scorerForVariant,
  buildSkipCounts,
  buildSuccessCounts,
  VALID_VARIANTS,
  // Constants exported for tests.
  SKIP_MAX_PENALTY,
  SKIP_FLOOR_RATIO,
  SUCCESS_MAX_BOOST,
  COUNTED_SKIP_CATEGORIES,
};
