'use strict';

/**
 * scorer-skip-down.js — H2a: skip-signal down-rank scorer.
 *
 * Reads `pattern_skip_enriched` events from the project's audit stream,
 * applies Laplace-smoothed skip-ratio penalty to each candidate's baseline
 * score, and returns a ranked list.
 *
 * Only `contextual-mismatch` and `superseded` skip categories are counted
 * as penalty signal. `forgotten` and `operator-override` are excluded (noisy).
 * `stale` is excluded (redundant with decay).
 *
 * Time window: 180 days (2× default decay half-life).
 *
 * Formula:
 *   skip_rate = skips / (applies + skips + 1)          # Laplace smoothed
 *   penalty   = 1 - (skip_rate * 0.6)                  # max 60% shrinkage
 *   score     = baseline_score * penalty
 *   floor     = 0.01 * baseline_score                  # prevents zero-out
 *
 * Bundle RS (v2.1.3): H2a scorer.
 */

const { getEventWindow } = require('./scorer-telemetry');

const SCORER_NAME    = 'skip-down';
const SCORER_VERSION = 1;

// Skip categories that count as negative signal.
const COUNTED_CATEGORIES = new Set(['contextual-mismatch', 'superseded']);

// Event window: 180 days (matches 2× default decay half-life).
const WINDOW_DAYS = 180;
const WINDOW_MS   = WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Maximum shrinkage factor (60%).
const MAX_PENALTY = 0.6;

// Floor: never reduce a score below this fraction of baseline.
const SCORE_FLOOR_RATIO = 0.01;

// Threshold below which we suppress the per-slug reason string.
const REASON_THRESHOLD = 0.05;

/**
 * Scorer function.
 *
 * @param {string} _query - task_summary (unused by this scorer).
 * @param {import('./scorer-shadow').Candidate[]} candidates
 * @param {import('./scorer-shadow').ScorerContext} context
 * @returns {import('./scorer-shadow').ScoredResult[]}
 */
function score(_query, candidates, context) {
  const sinceMs = context.nowMs - WINDOW_MS;

  const events = getEventWindow(context.projectRoot, {
    types:   new Set(['pattern_skip_enriched']),
    sinceMs,
  });

  // Build per-slug counts: { contextual-mismatch: N, superseded: N }
  /** @type {Map<string, { 'contextual-mismatch': number, superseded: number }>} */
  const skipCounts = new Map();

  for (const ev of events) {
    // Drop events with null / missing pattern_name (pre-W11 enrichment).
    if (!ev.pattern_name || typeof ev.pattern_name !== 'string') continue;
    const cat = ev.skip_category;
    if (!COUNTED_CATEGORIES.has(cat)) continue;

    const slug = ev.pattern_name;
    if (!skipCounts.has(slug)) {
      skipCounts.set(slug, { 'contextual-mismatch': 0, superseded: 0 });
    }
    skipCounts.get(slug)[cat]++;
  }

  const results = [];

  for (const candidate of candidates) {
    const slug        = candidate.slug;
    const baseScore   = typeof candidate.baseline_score === 'number'
      ? candidate.baseline_score
      : 0;
    const timesApplied = typeof candidate.times_applied === 'number'
      ? candidate.times_applied
      : 0;

    const counts  = skipCounts.get(slug) || { 'contextual-mismatch': 0, superseded: 0 };
    const totalSkips = counts['contextual-mismatch'] + counts['superseded'];

    // Laplace-smoothed skip rate.
    const skipRate  = totalSkips / (timesApplied + totalSkips + 1);
    const rawPenalty = skipRate * MAX_PENALTY;
    const penalty   = 1 - rawPenalty;

    const floor      = SCORE_FLOOR_RATIO * baseScore;
    const rawScore   = baseScore * penalty;
    const finalScore = Math.max(rawScore, floor);

    const reasons = [];
    if (skipRate > REASON_THRESHOLD) {
      // Dominant category: contextual-mismatch wins ties (per design Step 5).
      const topCategory = counts['contextual-mismatch'] >= counts['superseded']
        ? 'contextual-mismatch'
        : 'superseded';
      reasons.push('skip-penalty:' + topCategory);
      reasons.push('ratio=' + skipRate.toFixed(2));
    }

    results.push({ slug, score: finalScore, reasons });
  }

  // Sort descending by score.
  results.sort((a, b) => b.score - a.score);

  return results;
}

const scorerModule = {
  name:    SCORER_NAME,
  version: SCORER_VERSION,
  score,
};

// Self-register when loaded. scorer-shadow.js loads scorer modules lazily
// (inside the deferred closure), so this call happens at require() time
// inside that deferred closure — never on the hot path of pattern_find.
require('./scorer-shadow').registerScorer(scorerModule);

module.exports = scorerModule;
