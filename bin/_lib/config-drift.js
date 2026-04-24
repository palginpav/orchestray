'use strict';

/**
 * bin/_lib/config-drift.js — unknown-key / renamed-key detector for
 * `.orchestray/config.json`.
 *
 * v2.1.13 R-CONFIG-DRIFT (W9). Runs AFTER the authoritative zod-like
 * validation in `bin/validate-config.js` (R-ZOD). The top-level config
 * schema uses `.passthrough()` so unknown keys don't fail validation;
 * this module is what turns those unknown keys into a loud, actionable
 * boot warning.
 *
 * AC (from the v2.1.13 plan):
 *   - Seeded typo produces a suggestion ("did you mean …?") when the
 *     closest known key is within Levenshtein distance 2.
 *   - Renamed-key entries from config-rename-map.js surface the new name.
 *   - Each unknown key warns at most once per boot (caller dedups).
 *   - `config.config_drift_silence: [...]` suppresses named keys.
 *   - Warnings are WARNINGS — the caller exits 0 on drift.
 *
 * Scope: TOP-LEVEL keys only. Nested-section drift (e.g.,
 * `mcp_enforcement.mistyped_flag`) is intentionally deferred — the zod
 * schemas already use `.passthrough()` on sub-sections for back-compat,
 * and building a full schema walker is out of the W9 scope.
 *
 * Public API:
 *   detectDrift(config, opts?) -> {
 *     unknown:     Array<string>,          // unknown keys (not in rename map)
 *     renamed:     Array<{ key, to, since?, note? }>,
 *     suggestions: Record<string, string>, // unknown key -> nearest known key (lev ≤ 2)
 *   }
 *
 *   opts.knownKeys?: string[]              // defaults to KNOWN_TOP_LEVEL_KEYS
 *   opts.renameMap?: Record<string, {to,...}> // defaults to RENAME_MAP
 *   opts.silence?: string[]                // keys to drop from all three arrays
 *
 * This module has no I/O and no side effects: it's a pure function of the
 * parsed config object. The caller (boot-validate-config.js) is responsible
 * for printing warnings and deduplicating across calls.
 */

const { RENAME_MAP } = require('./config-rename-map.js');

/**
 * Canonical list of TOP-LEVEL keys accepted by `schemas/config.schema.js`.
 *
 * MAINTENANCE CONTRACT: whenever a key is added, removed, or renamed in
 * `schemas/config.schema.js`'s top-level `z.object({...})`, mirror the
 * change here. The cross-ref test in `tests/unit/config-drift.test.js`
 * scans the schema source and fails if the two lists diverge, so drift
 * is caught at CI time.
 */
const KNOWN_TOP_LEVEL_KEYS = Object.freeze([
  // Core scalars
  'auto_review',
  'max_retries',
  'default_delegation',
  'verbose',
  'complexity_threshold',
  'force_orchestrate',
  'force_solo',
  'replan_budget',
  'verify_fix_max_rounds',

  // Model routing
  'model_floor',
  'force_model',
  'haiku_max_score',
  'opus_min_score',
  'default_effort',
  'force_effort',
  'effort_routing',
  'enable_agent_teams',

  // Cost
  'max_cost_usd',
  'daily_cost_limit_usd',
  'weekly_cost_limit_usd',

  // Reviewer / tester / docs / misc
  'security_review',
  'tdd_mode',
  'enable_prescan',
  'test_timeout',
  'confirm_before_execute',
  'enable_checkpoints',
  'ci_command',
  'ci_max_retries',
  'post_to_issue',
  'auto_document',
  'adversarial_review',
  'contract_strictness',
  'enable_consequence_forecast',
  'enable_repo_map',
  'post_pr_comments',
  'enable_introspection',
  'enable_backpressure',
  'surface_disagreements',
  'enable_drift_sentinel',
  'enable_visual_review',
  'enable_threads',
  'enable_outcome_tracking',
  'enable_personas',
  'enable_replay_analysis',
  'max_turns_overrides',

  // Nested sections
  'mcp_server',
  'mcp_enforcement',
  'cost_budget_enforcement',
  'routing_gate',
  'v2017_experiments',
  'cache_choreography',
  'adaptive_verbosity',
  'pattern_decay',
  'anti_pattern_gate',
  'state_sentinel',
  'redo_flow',
  'context_statusbar',
  'federation',
  'retrieval',
  'auto_learning',
  'context_compression_v218',
  'resilience',
  'curator',
  'audit',
  'shield',

  // Meta
  'config_drift_silence',
]);

/**
 * Compute Levenshtein edit distance between two strings. Classic DP, O(m*n).
 * Short-circuits when either string is empty. No external dep — ~20 LoC.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // dp[i][j] = distance between a[0..i) and b[0..j)
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1);
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      const sub = dp[i - 1][j - 1] + cost;
      dp[i][j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
  }
  return dp[m][n];
}

/**
 * Find the closest candidate in `knownKeys` for `unknownKey`. Returns the
 * closest key when its Levenshtein distance is ≤ maxDistance, else null.
 * Ties broken by first-encountered (stable w.r.t. the knownKeys array order).
 *
 * @param {string} unknownKey
 * @param {readonly string[]} knownKeys
 * @param {number} [maxDistance=2]
 * @returns {string|null}
 */
function nearestKey(unknownKey, knownKeys, maxDistance) {
  const limit = typeof maxDistance === 'number' ? maxDistance : 2;
  let bestKey = null;
  let bestDist = Infinity;
  for (const k of knownKeys) {
    // Fast-path: if length difference already exceeds the limit, skip.
    if (Math.abs(k.length - unknownKey.length) > limit) continue;
    const d = lev(unknownKey, k);
    if (d < bestDist && d <= limit) {
      bestDist = d;
      bestKey = k;
      if (d === 0) break; // perfect match — shouldn't happen (key was unknown)
    }
  }
  return bestKey;
}

/**
 * Detect drift in a parsed config object.
 *
 * @param {object|null|undefined} config
 * @param {{
 *   knownKeys?: readonly string[],
 *   renameMap?: Record<string, {to: string, since?: string, note?: string, example?: boolean}>,
 *   silence?: readonly string[],
 * }} [opts]
 * @returns {{
 *   unknown: string[],
 *   renamed: Array<{key: string, to: string, since?: string, note?: string}>,
 *   suggestions: Record<string, string>,
 * }}
 */
function detectDrift(config, opts) {
  const empty = { unknown: [], renamed: [], suggestions: {} };
  if (!config || typeof config !== 'object' || Array.isArray(config)) return empty;

  const knownKeys = (opts && opts.knownKeys) || KNOWN_TOP_LEVEL_KEYS;
  const renameMap = (opts && opts.renameMap) || RENAME_MAP;
  const silenceList = (opts && opts.silence) || [];
  const silence = new Set(
    Array.isArray(silenceList) ? silenceList.filter((s) => typeof s === 'string') : []
  );
  const knownSet = new Set(knownKeys);

  const unknown = [];
  const renamed = [];
  const suggestions = {};

  // Config keys (unique — an object cannot have duplicate own keys anyway,
  // but we defensively filter to own enumerable strings).
  const cfgKeys = Object.keys(config);

  for (const key of cfgKeys) {
    if (silence.has(key)) continue;

    // Known — nothing to warn about.
    if (knownSet.has(key)) continue;

    // Renamed? The entry must exist, not be an "example", and its target
    // must not already be present in the config (the user could have BOTH
    // old and new names — in that case we still flag the rename so the user
    // knows the old one is dead).
    const rename = Object.prototype.hasOwnProperty.call(renameMap, key)
      ? renameMap[key]
      : null;
    if (rename && !rename.example && rename.to) {
      const r = { key, to: rename.to };
      if (rename.since) r.since = rename.since;
      if (rename.note) r.note = rename.note;
      renamed.push(r);
      continue;
    }

    // Plain unknown — maybe suggest a close match.
    unknown.push(key);
    const suggested = nearestKey(key, knownKeys, 2);
    if (suggested) suggestions[key] = suggested;
  }

  return { unknown, renamed, suggestions };
}

module.exports = {
  detectDrift,
  nearestKey,
  lev,
  KNOWN_TOP_LEVEL_KEYS,
};
