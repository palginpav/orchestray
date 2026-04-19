'use strict';

/**
 * scorer-local-success.js — H2b: project-local success-rate boost scorer.
 *
 * Reads `mcp_tool_call` events with `tool_name === 'pattern_record_application'`
 * and `outcome === 'applied-success'` from the current project's audit stream.
 * Computes a Laplace-smoothed success rate and applies a boost of up to +40%
 * on top of the baseline score.
 *
 * Time window: 90 days (matches default decay half-life).
 *
 * Formula:
 *   success_rate = success_events / (times_applied + 1)   # [0, 1] bounded
 *   boost        = 1 + (success_rate * 0.4)               # max +40%
 *   score        = baseline_score * boost
 *
 * CAVEAT (H2b surface-count proxy): `times_applied` from frontmatter is used as
 * a coarse proxy for "number of times the pattern was surfaced and could have
 * succeeded." Since `success_events` counts audit events within a 90-day window
 * while `times_applied` is a lifetime counter written to the pattern file, the
 * ratio may slightly undercount recent success_rate for high-velocity patterns.
 * Additionally, every `applied-success` event also increments `times_applied`,
 * so `success_events <= times_applied` always holds by construction (meaning the
 * ratio is bounded at 1.0). This proxy is accepted for shadow-mode telemetry;
 * it should be revisited before any promotion to primary scorer.
 * (Deferred per architect design Step 6 — no audit event added in v2.1.3.)
 *
 * Bundle RS (v2.1.3): H2b scorer.
 */

const { getEventWindow } = require('./scorer-telemetry');

const SCORER_NAME    = 'local-success';
const SCORER_VERSION = 1;

// Event window: 90 days (default decay half-life).
const WINDOW_DAYS = 90;
const WINDOW_MS   = WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Maximum boost factor.
const MAX_BOOST_ADDEND = 0.4;

// Only this outcome contributes positive signal.
const SUCCESS_OUTCOME = 'applied-success';

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

  // mcp_tool_call events are written by the dispatcher for every tool call.
  const events = getEventWindow(context.projectRoot, {
    types:   new Set(['mcp_tool_call']),
    sinceMs,
  });

  // Build per-slug success counts from pattern_record_application / applied-success.
  /** @type {Map<string, number>} slug → count */
  const successCounts = new Map();

  for (const ev of events) {
    if (ev.tool_name !== 'pattern_record_application') continue;
    if (ev.outcome !== SUCCESS_OUTCOME) continue;

    // The slug is stored in the event's input or at top level depending on
    // how the dispatcher serialises it. Try common locations.
    const slug = (ev.input && ev.input.slug)
      || ev.slug
      || (ev.result && ev.result.slug)
      || null;
    if (!slug || typeof slug !== 'string') continue;

    successCounts.set(slug, (successCounts.get(slug) || 0) + 1);
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

    const successEvents = successCounts.get(slug) || 0;

    // Clamp to 1.0 for defensive paranoia (should be <= 1 by construction).
    const rawRate    = successEvents / (timesApplied + 1);
    const successRate = Math.min(rawRate, 1.0);

    const boost      = 1 + (successRate * MAX_BOOST_ADDEND);
    const finalScore = baseScore * boost;

    const reasons = [];
    if (successRate > 0) {
      reasons.push('proven-here:' + successEvents + '/' + timesApplied);
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

// Self-register when loaded.
require('./scorer-shadow').registerScorer(scorerModule);

module.exports = scorerModule;
