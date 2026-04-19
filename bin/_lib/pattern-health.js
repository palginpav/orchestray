'use strict';

/**
 * pattern-health.js — Pure function for computing pattern health scores.
 *
 * Used by the /orchestray:patterns dashboard (skills/orchestray:patterns/SKILL.md)
 * to surface a single composite health metric per pattern.
 *
 * Formula
 * -------
 *   health = clamp(base × usage × freshness × (1 - penalty), 0.0, 1.0)
 *
 *   base      = decayed_confidence                          // ∈ [0, 1]
 *   usage     = usage_boost(times_applied)                  // ∈ [0.5, 1.0]
 *   freshness = freshness_factor(age_days)                  // ∈ [0.3, 1.0]
 *   penalty   = skip_penalty(skipEventsForSlug, now)        // ∈ [0.0, 0.6]
 *
 * Health tiers
 * ------------
 *   healthy        health ≥ 0.60
 *   stale          0.40 ≤ health < 0.60
 *   needs-attention  health < 0.40
 *
 * All functions are pure (no I/O). Deterministic given the same inputs.
 * The SKILL.md layer is responsible for reading events.jsonl and calling
 * annotatePatterns(); this module stays easy to test.
 *
 * v2.1.2 — Item #6 (pattern health score).
 */

// ---------------------------------------------------------------------------
// Component functions
// ---------------------------------------------------------------------------

/**
 * Reward field-tested patterns; treat zero-application patterns as neutral (not broken).
 *
 * @param {number} n - times_applied
 * @returns {number} multiplier ∈ [0.5, 1.0]
 */
function usage_boost(n) {
  if (n <= 0) return 0.5;   // unused → neutral multiplier
  if (n === 1) return 0.7;
  if (n <= 3) return 0.85;
  return 1.0;               // ≥ 4 applications: full credit
}

/**
 * Decay for staleness independent of confidence.
 * More aggressive than the 90-day half-life in decayed_confidence so the
 * dashboard flags stale patterns sooner.
 *
 * @param {number|null} ageDays - days since last_applied, or null if never applied
 * @returns {number} multiplier ∈ [0.3, 1.0]
 */
function freshness_factor(ageDays) {
  if (ageDays == null) return 0.5;   // never applied, unknown age
  if (ageDays <= 14)   return 1.0;
  if (ageDays <= 45)   return 0.85;
  if (ageDays <= 90)   return 0.6;
  return 0.3;                        // > 90 days stale
}

/**
 * Penalty based on recent contextual-mismatch and superseded skip events
 * attributed to this slug (last 90 days).
 *
 * Only contextual-mismatch and superseded count — mirroring curator.md §4.3.
 * Events with pattern_name: null are ignored (pre-A2 state, no per-slug attribution).
 *
 * @param {SkipEvent[]} skipEventsForSlug - events already filtered to this slug by the caller
 * @param {Date|number} now
 * @returns {number} penalty ∈ [0.0, 0.6]
 */
function skip_penalty(skipEventsForSlug, now) {
  const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;
  const nowMs = (now instanceof Date) ? now.getTime() : Number(now);

  const relevant = skipEventsForSlug.filter(ev =>
    ev.pattern_name &&
    (ev.skip_category === 'contextual-mismatch' || ev.skip_category === 'superseded') &&
    (nowMs - new Date(ev.timestamp).getTime()) <= NINETY_DAYS_MS
  );

  if (relevant.length === 0) return 0.0;
  if (relevant.length === 1) return 0.2;
  if (relevant.length === 2) return 0.4;
  return 0.6;                          // 3+ skips: heavy penalty (cap)
}

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

/**
 * Map a numeric health score to a tier string.
 *
 * @param {number} score
 * @returns {'healthy'|'stale'|'needs-attention'}
 */
function scoreTier(score) {
  if (score >= 0.60) return 'healthy';
  if (score >= 0.40) return 'stale';
  return 'needs-attention';
}

// ---------------------------------------------------------------------------
// Reason string
// ---------------------------------------------------------------------------

/**
 * Produce a single human-readable reason for the dominant health drag.
 * Logic: pick the highest-impact factor in priority order.
 *
 * @param {object} components
 * @param {number} components.penaltyValue   - raw penalty value (0–0.6)
 * @param {number} components.relevantSkips  - count of qualifying skip events
 * @param {number} components.freshnessValue - freshness_factor result
 * @param {number} components.ageDays        - age_days (may be null)
 * @param {number} components.usageValue     - usage_boost result
 * @param {number} components.timesApplied
 * @param {number} components.base           - decayed_confidence
 * @returns {string}
 */
function _computeReason(components) {
  const { penaltyValue, relevantSkips, freshnessValue, ageDays, usageValue, timesApplied, base } = components;

  if (penaltyValue > 0.0) {
    return relevantSkips + ' contextual-mismatch/superseded skip(s) in last 90d';
  }
  if (freshnessValue < 0.5) {
    const days = (ageDays != null) ? ageDays + 'd since last application' : 'never applied (unknown age)';
    return days;
  }
  if (usageValue < 0.8) {
    return 'low field use (times_applied=' + timesApplied + ')';
  }
  if (base < 0.5) {
    return 'low decayed_confidence (' + base.toFixed(2) + ')';
  }
  return 'composite score (no dominant factor)';
}

// ---------------------------------------------------------------------------
// Public API — types (JSDoc only, no runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PatternHealthInput
 * @property {string}       slug
 * @property {number}       confidence
 * @property {number}       decayed_confidence
 * @property {number|null}  age_days         - null if never applied and no mtime
 * @property {number}       times_applied
 * @property {string}       category
 */

/**
 * @typedef {Object} SkipEvent
 * @property {string}      timestamp
 * @property {string|null} pattern_name
 * @property {string}      skip_category   - contextual-mismatch | stale | superseded | ...
 */

/**
 * @typedef {Object} PatternHealthResult
 * @property {number} score   - ∈ [0, 1]
 * @property {'healthy'|'stale'|'needs-attention'} tier
 * @property {string} reason
 */

// ---------------------------------------------------------------------------
// computeHealth
// ---------------------------------------------------------------------------

/**
 * Pure function. No I/O. Deterministic given (pattern, events, now).
 *
 * @param {PatternHealthInput} pattern
 * @param {SkipEvent[]} skipEvents - events filtered to this slug (caller's responsibility)
 * @param {Date|number} [now] - defaults to Date.now() for test injection
 * @returns {PatternHealthResult}
 */
function computeHealth(pattern, skipEvents, now) {
  const nowMs = (now != null)
    ? ((now instanceof Date) ? now.getTime() : Number(now))
    : Date.now();

  const base       = (typeof pattern.decayed_confidence === 'number') ? pattern.decayed_confidence : 0;
  const usageValue = usage_boost(pattern.times_applied);
  const freshValue = freshness_factor(pattern.age_days);
  const penalty    = skip_penalty(skipEvents || [], nowMs);

  // Count relevant skips for the reason string (re-compute to keep it pure).
  const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;
  const relevantSkips = (skipEvents || []).filter(ev =>
    ev.pattern_name &&
    (ev.skip_category === 'contextual-mismatch' || ev.skip_category === 'superseded') &&
    (nowMs - new Date(ev.timestamp).getTime()) <= NINETY_DAYS_MS
  ).length;

  const raw   = base * usageValue * freshValue * (1 - penalty);
  const score = Math.min(1.0, Math.max(0.0, raw));
  const tier  = scoreTier(score);
  const reason = _computeReason({
    penaltyValue:   penalty,
    relevantSkips,
    freshnessValue: freshValue,
    ageDays:        pattern.age_days,
    usageValue,
    timesApplied:   pattern.times_applied,
    base,
  });

  return { score: Math.round(score * 100) / 100, tier, reason };
}

// ---------------------------------------------------------------------------
// annotatePatterns
// ---------------------------------------------------------------------------

/**
 * Convenience: given a full patterns list and a full skip-events list,
 * returns an array of patterns with { health, health_tier, health_reason }
 * attached. Also pure (no I/O).
 *
 * @param {PatternHealthInput[]} patterns
 * @param {SkipEvent[]} allSkipEvents
 * @param {Date|number} [now]
 * @returns {Array<PatternHealthInput & { health: number, health_tier: string, health_reason: string }>}
 */
function annotatePatterns(patterns, allSkipEvents, now) {
  const eventsForSlug = new Map();

  for (const ev of (allSkipEvents || [])) {
    if (!ev.pattern_name) continue;
    if (!eventsForSlug.has(ev.pattern_name)) {
      eventsForSlug.set(ev.pattern_name, []);
    }
    eventsForSlug.get(ev.pattern_name).push(ev);
  }

  return patterns.map(p => {
    const slugEvents = eventsForSlug.get(p.slug) || [];
    const result = computeHealth(p, slugEvents, now);
    return Object.assign({}, p, {
      health:        result.score,
      health_tier:   result.tier,
      health_reason: result.reason,
    });
  });
}

module.exports = { computeHealth, annotatePatterns };
