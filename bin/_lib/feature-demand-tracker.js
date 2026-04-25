'use strict';

/**
 * feature-demand-tracker.js — R-GATE demand measurement library (v2.1.14).
 *
 * Reads .orchestray/audit/events.jsonl for `feature_gate_eval` and
 * `tier2_invoked` events, and computes per-gate demand metrics over the last
 * 30 days.
 *
 * BUILD-TIME EMITTER AUDIT — accuracy guardrail:
 *   Only protocols with a wired `tier2_invoked` emitter are eligible for
 *   quarantine. As of v2.1.14, the wired protocols are:
 *     - pattern_extraction  (wired in inject-archetype-advisory.js / pattern extraction hook)
 *     - archetype_cache     (wired in inject-archetype-advisory.js)
 *
 *   The 6 unwired protocols are NOT eligible until R-TGATE-PM ships in v2.1.15:
 *     - drift_sentinel, consequence_forecast, replay_analysis,
 *       auto_documenter, disagreement_protocol, cognitive_backpressure
 *
 * Gate slugs map to config keys via the GATE_TO_CONFIG_KEY table below.
 * Gate slugs map to protocol slugs via the GATE_TO_PROTOCOL table below.
 *
 * Fail-open: any I/O error returns empty results. Never throws.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Build-time emitter allowlist — only these protocol slugs are quarantine-eligible.
// Update this list when R-TGATE-PM wires the remaining 6 protocols (v2.1.15).
// ---------------------------------------------------------------------------

const WIRED_EMITTER_PROTOCOLS = [
  'pattern_extraction',
  'archetype_cache',
];

// Map from gate slug (human-facing identity used in quarantine_candidates) to
// the protocol slug emitted in tier2_invoked events.
const GATE_SLUG_TO_PROTOCOL = {
  pattern_extraction: 'pattern_extraction',
  archetype_cache:    'archetype_cache',
};

// Map from gate slug to the config key in config.json.
const GATE_SLUG_TO_CONFIG_KEY = {
  pattern_extraction: 'enable_pattern_extraction',
  archetype_cache:    'enable_archetype_cache',
};

// Reverse map: config key → gate slug.
const CONFIG_KEY_TO_GATE_SLUG = {};
for (const [slug, key] of Object.entries(GATE_SLUG_TO_CONFIG_KEY)) {
  CONFIG_KEY_TO_GATE_SLUG[key] = slug;
}

// Reverse map: protocol → gate slug.
const PROTOCOL_TO_GATE_SLUG = {};
for (const [slug, protocol] of Object.entries(GATE_SLUG_TO_PROTOCOL)) {
  PROTOCOL_TO_GATE_SLUG[protocol] = slug;
}

// Window constants
const WINDOW_DAYS_30   = 30;
const WINDOW_MS_30     = WINDOW_DAYS_30 * 24 * 60 * 60 * 1000;
const ELIGIBLE_DAYS_14 = 14;
const ELIGIBLE_MS_14   = ELIGIBLE_DAYS_14 * 24 * 60 * 60 * 1000;
const MIN_EVAL_COUNT   = 5;

/**
 * Parse a JSONL file and return an array of parsed line objects (skips malformed).
 * Returns [] if the file does not exist.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try { return JSON.parse(l); } catch (_e) { return null; }
      })
      .filter(Boolean);
  } catch (_e) {
    return [];
  }
}

/**
 * Compute per-gate demand metrics from events.jsonl.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {object} Report keyed by gate slug, or {} on any error.
 *
 * Report shape per gate:
 * {
 *   gate_slug: string,
 *   config_key: string,
 *   protocol: string,
 *   gate_eval_true_count: number,       // times gate appeared in gates_true in last 30d
 *   tier2_invoked_count: number,        // times tier2_invoked was emitted for this protocol in last 30d
 *   demand_ratio: number,               // invoked / eval_true_count (0.0 if eval_true_count === 0)
 *   first_eval_at: string|null,         // ISO timestamp of first gate_eval_true in last 30d window
 *   quarantine_eligible: boolean,       // true iff all three conditions hold (see below)
 *   ineligible_reason: string|null,     // human-readable reason if not eligible
 * }
 *
 * quarantine_eligible === true iff ALL of:
 *   1. gate_eval_true_count >= 5 (enough observation)
 *   2. tier2_invoked_count === 0 (never actually fired)
 *   3. (now - first_eval_at) >= 14 days (observation window has elapsed)
 */
function computeDemandReport(cwd) {
  try {
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    const events = readJsonl(eventsPath);
    const now = Date.now();
    const windowStart30 = now - WINDOW_MS_30;

    // Filter to last-30-days events only.
    const recent = events.filter(ev => {
      if (!ev || !ev.timestamp) return false;
      const ts = Date.parse(ev.timestamp);
      return !isNaN(ts) && ts >= windowStart30;
    });

    // Per gate slug: count gate_eval_true occurrences and track first_eval_at.
    const evalTrueCounts = {};   // slug → count
    const firstEvalAt    = {};   // slug → earliest ISO timestamp (as ms)

    for (const ev of recent) {
      if (ev.type !== 'feature_gate_eval') continue;
      const gatesTrue = Array.isArray(ev.gates_true) ? ev.gates_true : [];
      for (const configKey of gatesTrue) {
        const slug = CONFIG_KEY_TO_GATE_SLUG[configKey];
        if (!slug) continue; // Not a tracked gate slug
        evalTrueCounts[slug] = (evalTrueCounts[slug] || 0) + 1;
        const ts = Date.parse(ev.timestamp);
        if (!isNaN(ts)) {
          if (!firstEvalAt[slug] || ts < firstEvalAt[slug]) {
            firstEvalAt[slug] = ts;
          }
        }
      }
    }

    // Per gate slug: count tier2_invoked occurrences.
    const invokedCounts = {};   // slug → count

    for (const ev of recent) {
      if (ev.type !== 'tier2_invoked') continue;
      const slug = PROTOCOL_TO_GATE_SLUG[ev.protocol];
      if (!slug) continue;
      invokedCounts[slug] = (invokedCounts[slug] || 0) + 1;
    }

    // Build report for each wired-emitter gate slug.
    const report = {};
    for (const gateSlug of WIRED_EMITTER_PROTOCOLS) {
      const configKey    = GATE_SLUG_TO_CONFIG_KEY[gateSlug];
      const protocol     = GATE_SLUG_TO_PROTOCOL[gateSlug];
      const evalCount    = evalTrueCounts[gateSlug] || 0;
      const invokedCount = invokedCounts[gateSlug] || 0;
      const demandRatio  = evalCount === 0 ? 0.0 : invokedCount / evalCount;
      const firstMs      = firstEvalAt[gateSlug] || null;
      const firstIso     = firstMs ? new Date(firstMs).toISOString() : null;

      // Eligibility checks.
      let quarantineEligible = false;
      let ineligibleReason   = null;

      if (evalCount < MIN_EVAL_COUNT) {
        ineligibleReason = `eval_true_count (${evalCount}) < ${MIN_EVAL_COUNT} — not enough observation`;
      } else if (invokedCount !== 0) {
        ineligibleReason = `tier2_invoked_count (${invokedCount}) > 0 — protocol has fired`;
      } else if (!firstMs || (now - firstMs) < ELIGIBLE_MS_14) {
        const elapsed = firstMs ? Math.floor((now - firstMs) / (24 * 60 * 60 * 1000)) : 0;
        ineligibleReason = `observation window not elapsed (${elapsed}d < ${ELIGIBLE_DAYS_14}d)`;
      } else {
        quarantineEligible = true;
      }

      report[gateSlug] = {
        gate_slug:            gateSlug,
        config_key:           configKey,
        protocol,
        gate_eval_true_count: evalCount,
        tier2_invoked_count:  invokedCount,
        demand_ratio:         demandRatio,
        first_eval_at:        firstIso,
        quarantine_eligible:  quarantineEligible,
        ineligible_reason:    ineligibleReason,
      };
    }

    return report;
  } catch (_e) {
    return {};
  }
}

/**
 * Returns the set of gate slugs that are currently quarantine-eligible.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {string[]} Array of eligible gate slugs.
 */
function getEligibleGateSlugs(cwd) {
  try {
    const report = computeDemandReport(cwd);
    return Object.keys(report).filter(slug => report[slug].quarantine_eligible);
  } catch (_e) {
    return [];
  }
}

module.exports = {
  computeDemandReport,
  getEligibleGateSlugs,
  WIRED_EMITTER_PROTOCOLS,
  GATE_SLUG_TO_PROTOCOL,
  GATE_SLUG_TO_CONFIG_KEY,
  CONFIG_KEY_TO_GATE_SLUG,
  PROTOCOL_TO_GATE_SLUG,
  WINDOW_DAYS_30,
  ELIGIBLE_DAYS_14,
  MIN_EVAL_COUNT,
};
