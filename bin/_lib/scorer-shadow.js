'use strict';

/**
 * scorer-shadow.js — Shadow scorer harness.
 *
 * Called fire-and-forget from pattern_find.js after the baseline ranking is
 * already finalised. The harness:
 *   1. Short-circuits immediately when no shadow scorers are configured.
 *   2. Defers real work via setImmediate so pattern_find latency is unaffected.
 *   3. Passes a frozen snapshot of candidates to registered scorers to prevent
 *      accidental mutation of live index state.
 *   4. Computes rank-agreement statistics (Kendall tau, top-K overlap,
 *      displacement) and writes one JSONL row per (call × scorer).
 *   5. Swallows all errors — a shadow scorer crash must never surface in the
 *      MCP response.
 *
 * Bundle RS (v2.1.3): H1 pluggability seam + telemetry harness.
 *
 * @module scorer-shadow
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { appendJsonlWithRotation } = require('./jsonl-rotate');
const { recordDegradation }       = require('./degraded-journal');
// Note: imported as module object (not destructured) so tests can patch
// loadRetrievalConfig via cs.loadRetrievalConfig = ... without a stale closure.
const _configSchema = require('./config-schema');

// Schema version — bump on any breaking change to the JSONL row shape.
const SHADOW_SCHEMA_VERSION = 1;

// Per-line size cap for shadow JSONL rows (2 KB per architect design).
const MAX_LINE_BYTES = 2 * 1024;

// Scorer name → module path (lazy-loaded inside deferred closure).
const SCORER_PATHS = {
  'skip-down':     './scorer-skip-down',
  'local-success': './scorer-local-success',
};

// In-process scorer registry: name → { name, version, score }.
// Populated by registerScorer() when scorer modules self-register on require().
const _registry = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a scorer in the in-process registry.
 * Called at bottom of each scorer module (scorer-skip-down.js, etc.).
 *
 * @param {{ name: string, version: number, score: Function }} mod
 */
function registerScorer(mod) {
  if (!mod || typeof mod.name !== 'string' || typeof mod.score !== 'function') return;
  _registry.set(mod.name, mod);
}

/**
 * Entry point called by pattern_find.js immediately after `top` is finalised.
 *
 * Contract:
 *   - No return value — caller ignores it.
 *   - Never throws (wraps everything in try/catch).
 *   - At default config (shadow_scorers: []), returns synchronously after a
 *     single config read (~1 ms cached).
 *
 * @param {{
 *   query: string,
 *   baselineScored: object[],
 *   candidates: object[],
 *   inputContext: { projectRoot: string, agentRole?: string, fileGlobs?: string[], nowMs: number },
 *   maxResults: number,
 * }} args
 */
function maybeRunShadowScorers(args) {
  try {
    const projectRoot = args.inputContext && args.inputContext.projectRoot;
    const cfg = _configSchema.loadRetrievalConfig(projectRoot || process.cwd());

    if (cfg.global_kill_switch) return;
    if (!cfg.shadow_scorers || cfg.shadow_scorers.length === 0) return;

    // Build snapshot before setImmediate so the caller's arrays can be GC-ed.
    const snapshot = _snapshotForShadow(args, cfg);

    setImmediate(() => {
      try {
        _runShadowDeferred(snapshot, cfg);
      } catch (_e) {
        // Belt-and-braces: errors inside the deferred closure are caught here.
        try {
          process.stderr.write('[orchestray] scorer-shadow: unhandled error in deferred: ' +
            (_e && _e.message ? _e.message : String(_e)) + '\n');
        } catch (_) { /* swallow */ }
      }
    });
  } catch (_e) {
    // Nothing: shadow must never bubble up.
  }
}

// ---------------------------------------------------------------------------
// Internal: snapshot builder
// ---------------------------------------------------------------------------

/**
 * Build a self-contained snapshot of everything the deferred closure needs.
 * Freezes each candidate so scorers cannot mutate the live index objects.
 *
 * Note on frozen-object semantics: `Object.freeze` is shallow. Nested objects
 * (e.g., candidate.frontmatter.*) are not deeply frozen. However, scorers
 * are only expected to read top-level and one-level-deep properties. The freeze
 * prevents direct property assignment on the candidate object itself (the most
 * likely accidental mutation vector) and will throw in strict mode. For defence
 * in depth, candidates are cloned shallowly first so even a successful prototype
 * mutation on the original cannot propagate to the snapshot.
 *
 * @param {object} args
 * @param {object} cfg
 * @returns {object}
 */
function _snapshotForShadow(args, cfg) {
  const { query, baselineScored, candidates, inputContext, maxResults } = args;

  // Clone and freeze each candidate. Shallow clone + freeze prevents direct
  // property assignment. The frontmatter sub-object is also frozen for extra
  // protection against the most common mutation pattern (scorer sets
  // candidate.frontmatter.foo = 'x').
  const frozenCandidates = (candidates || []).map((c) => {
    const clone = Object.assign({}, c);
    // Also freeze the frontmatter sub-object if present.
    if (clone.frontmatter && typeof clone.frontmatter === 'object') {
      clone.frontmatter = Object.freeze(Object.assign({}, clone.frontmatter));
    }
    return Object.freeze(clone);
  });

  // Build baseline rank map: slug → 0-based rank index.
  const baselineRank = new Map();
  (baselineScored || []).forEach((m, i) => baselineRank.set(m.slug, i));

  // Baseline top-K slug list (using cfg.top_k, clamped [1,50]).
  const K = Math.max(1, Math.min(50, typeof cfg.top_k === 'number' ? cfg.top_k : 10));
  const baselineTopK = (baselineScored || []).slice(0, K).map((m) => m.slug);

  // Enrich each frozen candidate with baseline_score so scorers can apply
  // multiplicative adjustments on top of the baseline.
  // We build a lookup from the original baselineScored array which still has _score.
  const baselineScoreBySlug = new Map();
  (baselineScored || []).forEach((m) => baselineScoreBySlug.set(m.slug, m._score || 0));

  // Re-freeze after adding baseline_score (we need a mutable intermediate copy
  // per candidate to add the field before freezing). Also hoist times_applied
  // out of frontmatter so scorers see it at the canonical top-level slot — in
  // production candidates come from the pattern index with times_applied under
  // `frontmatter`, whereas scorers read the field directly from the candidate.
  const enrichedCandidates = frozenCandidates.map((c) => {
    const timesAppliedFromFm =
      (c.frontmatter && typeof c.frontmatter.times_applied === 'number')
        ? c.frontmatter.times_applied
        : (typeof c.times_applied === 'number' ? c.times_applied : 0);
    const enriched = Object.assign({}, c, {
      baseline_score: baselineScoreBySlug.get(c.slug) || 0,
      times_applied: timesAppliedFromFm,
    });
    // Re-freeze frontmatter if we thawed it above.
    if (enriched.frontmatter && typeof enriched.frontmatter === 'object' &&
        !Object.isFrozen(enriched.frontmatter)) {
      enriched.frontmatter = Object.freeze(Object.assign({}, enriched.frontmatter));
    }
    return Object.freeze(enriched);
  });

  const nowMs = (inputContext && typeof inputContext.nowMs === 'number')
    ? inputContext.nowMs
    : Date.now();

  return {
    query:            typeof query === 'string' ? query : '',
    baselineRank,
    baselineTopK,
    enrichedCandidates,
    projectRoot:      (inputContext && inputContext.projectRoot) || process.cwd(),
    agentRole:        (inputContext && inputContext.agentRole) || null,
    fileGlobs:        (inputContext && Array.isArray(inputContext.fileGlobs)) ? inputContext.fileGlobs : [],
    maxResults:       typeof maxResults === 'number' ? maxResults : 5,
    nowMs,
    K,
  };
}

// ---------------------------------------------------------------------------
// Internal: deferred execution
// ---------------------------------------------------------------------------

/**
 * Run all configured shadow scorers, compute stats, write JSONL rows.
 * Runs on the next tick (setImmediate), so pattern_find has already returned.
 *
 * @param {object} snapshot  - Built by _snapshotForShadow.
 * @param {object} cfg       - Validated retrieval config.
 */
function _runShadowDeferred(snapshot, cfg) {
  const {
    query,
    baselineRank,
    baselineTopK,
    enrichedCandidates,
    projectRoot,
    agentRole,
    fileGlobs,
    nowMs,
    K,
  } = snapshot;

  // Short unique run_id: 12 hex chars from crypto.randomBytes.
  let runId;
  try {
    runId = crypto.randomBytes(6).toString('hex');
  } catch (_) {
    runId = Math.random().toString(16).slice(2, 14);
  }

  // Resolve orchestration_id via the same mechanism as degraded-journal.
  const orchId = _resolveOrchId(projectRoot);

  // Query hash: SHA-256 of raw task summary, first 16 hex chars.
  const queryHash = _hashQuery(query);

  // Context passed to each scorer.
  const context = Object.freeze({
    projectRoot,
    agentRole,
    fileGlobs,
    config:  cfg,
    nowMs,
    runId,
  });

  const validatedScorers = _resolveScorers(cfg.shadow_scorers, projectRoot);

  for (const { name, scorer } of validatedScorers) {
    try {
      _runOneScorerAndWrite({
        name,
        scorer,
        query,
        candidates: enrichedCandidates,
        context,
        baselineRank,
        baselineTopK,
        K,
        runId,
        orchId,
        queryHash,
        projectRoot,
        cfg,
      });
    } catch (err) {
      // Capture scorer failure in degraded journal; continue with remaining scorers.
      try {
        recordDegradation({
          kind: 'shadow_scorer_failed',
          severity: 'warn',
          projectRoot,
          detail: {
            scorer_name:  name,
            error:        err && err.message ? err.message.slice(0, 200) : String(err).slice(0, 200),
            dedup_key:    'shadow_scorer_failed_' + name,
          },
        });
      } catch (_) { /* swallow */ }
    }
  }
}

/**
 * Resolve scorer names to scorer objects. Unknown names are dropped after
 * writing a degraded-journal entry.
 *
 * Scorers are loaded via require() here (inside the deferred closure) so they
 * are never loaded on the hot path when shadow scoring is disabled.
 *
 * @param {string[]} names
 * @param {string} projectRoot
 * @returns {{ name: string, scorer: object }[]}
 */
function _resolveScorers(names, projectRoot) {
  const result = [];
  for (const name of names) {
    // Check registry first (scorer may already be loaded from a prior call).
    if (_registry.has(name)) {
      result.push({ name, scorer: _registry.get(name) });
      continue;
    }
    // Try to load from known paths.
    const modulePath = SCORER_PATHS[name];
    if (!modulePath) {
      try {
        recordDegradation({
          kind:        'shadow_scorer_failed',
          severity:    'warn',
          projectRoot,
          detail: {
            scorer_name: name,
            error:       'unknown scorer name — not in SCORER_PATHS registry',
            dedup_key:   'shadow_scorer_failed_' + name,
          },
        });
      } catch (_) { /* swallow */ }
      continue;
    }
    try {
      // require() is cached by Node; re-loading the same module is cheap.
      require(modulePath);
      // The scorer self-registers via registerScorer() at bottom of its module.
      if (_registry.has(name)) {
        result.push({ name, scorer: _registry.get(name) });
      }
    } catch (loadErr) {
      try {
        recordDegradation({
          kind:        'shadow_scorer_failed',
          severity:    'warn',
          projectRoot,
          detail: {
            scorer_name: name,
            error:       loadErr && loadErr.message
              ? loadErr.message.slice(0, 200)
              : String(loadErr).slice(0, 200),
            dedup_key:   'shadow_scorer_failed_' + name,
          },
        });
      } catch (_) { /* swallow */ }
    }
  }
  return result;
}

/**
 * Run one scorer, compute stats, and write one JSONL row.
 *
 * @param {object} opts
 */
function _runOneScorerAndWrite(opts) {
  const {
    name, scorer, query, candidates, context,
    baselineRank, baselineTopK, K,
    runId, orchId, queryHash, projectRoot, cfg,
  } = opts;

  // Call scorer synchronously (scorers use cached telemetry — no async needed).
  const shadowResults = scorer.score(query, candidates, context);

  // Build shadow rank map (slug → 0-based index from shadow results).
  const shadowRankMap = new Map();
  (shadowResults || []).forEach((r, i) => shadowRankMap.set(r.slug, i));

  // Shadow top-K slug list.
  const shadowTopK = (shadowResults || []).slice(0, K).map((r) => r.slug);

  // Collect per-slug reasons from shadow scorer.
  const reasonsBySlug = {};
  for (const r of (shadowResults || [])) {
    if (Array.isArray(r.reasons) && r.reasons.length > 0) {
      reasonsBySlug[r.slug] = r.reasons;
    }
  }

  // Rank agreement statistics.
  const topKOverlap  = _computeTopKOverlap(baselineTopK, shadowTopK);
  const kendallTau   = _computeKendallTau(baselineTopK, shadowTopK);
  const displacement = _computeDisplacement(baselineTopK, shadowTopK, baselineRank, shadowRankMap);

  // Build JSONL row.
  const row = {
    schema:                  SHADOW_SCHEMA_VERSION,
    ts:                      new Date(context.nowMs).toISOString(),
    run_id:                  runId,
    pid:                     process.pid,
    orchestration_id:        orchId,
    scorer_name:             name,
    scorer_version:          scorer.version || 1,
    query_hash:              queryHash,
    query_length:            query.length,
    candidate_count:         candidates.length,
    k:                       K,
    baseline_top_k:          baselineTopK,
    shadow_top_k:            shadowTopK,
    top_k_overlap:           topKOverlap,
    kendall_tau:             kendallTau,
    displacement,
    shadow_reasons_by_slug:  reasonsBySlug,
    notes:                   ['kendall_tau: tau-b, tied-x/tied-y normalized'],
  };

  _writeShadowRow(row, projectRoot, cfg);
}

// ---------------------------------------------------------------------------
// Internal: statistics helpers
// ---------------------------------------------------------------------------

/**
 * Compute Kendall tau-b over the intersection of two slug arrays.
 *
 * Both arrays are ranked lists (index = rank). Tau is computed over the slugs
 * present in both lists. Returns null if intersection has fewer than 2 elements.
 *
 * @param {string[]} baselineOrder - Baseline top-K slugs, rank 0 = best.
 * @param {string[]} shadowOrder   - Shadow top-K slugs, rank 0 = best.
 * @returns {number|null}
 */
function _computeKendallTau(baselineOrder, shadowOrder) {
  if (!Array.isArray(baselineOrder) || !Array.isArray(shadowOrder)) return null;

  // Build rank maps (0-based).
  const baseRank = new Map(baselineOrder.map((s, i) => [s, i]));
  const shadRank = new Map(shadowOrder.map((s, i) => [s, i]));

  // Intersection: slugs present in both lists.
  const common = baselineOrder.filter((s) => shadRank.has(s));
  if (common.length < 2) return null;

  // Build paired rank arrays for tau-b computation.
  const bRanks = common.map((s) => baseRank.get(s));
  const sRanks = common.map((s) => shadRank.get(s));

  const n = common.length;
  let concordant  = 0;
  let discordant  = 0;
  let tiedBase    = 0;
  let tiedShadow  = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const db = bRanks[i] - bRanks[j];
      const ds = sRanks[i] - sRanks[j];
      const sign = db * ds;

      if (sign > 0) {
        concordant++;
      } else if (sign < 0) {
        discordant++;
      } else {
        // Tie in one or both rankings.
        if (db === 0) tiedBase++;
        if (ds === 0) tiedShadow++;
      }
    }
  }

  // Tau-b: normalise by geometric mean of non-tied pairs.
  const n0     = n * (n - 1) / 2;
  const normB  = Math.sqrt((n0 - tiedBase) * (n0 - tiedShadow));
  if (normB === 0) return null; // All ties — undefined.

  const tau = (concordant - discordant) / normB;
  // Clamp to [-1, 1] to avoid floating-point overshoot.
  return Math.max(-1, Math.min(1, Math.round(tau * 1000) / 1000));
}

/**
 * Compute the count of slugs in the intersection of two top-K lists.
 *
 * @param {string[]} baselineTopK
 * @param {string[]} shadowTopK
 * @returns {number}
 */
function _computeTopKOverlap(baselineTopK, shadowTopK) {
  if (!Array.isArray(baselineTopK) || !Array.isArray(shadowTopK)) return 0;
  const shadowSet = new Set(shadowTopK);
  let count = 0;
  for (const slug of baselineTopK) {
    if (shadowSet.has(slug)) count++;
  }
  return count;
}

/**
 * Compute displacement stats for slugs in the intersection of baseline and
 * shadow top-K lists.
 *
 * Returns { median, p95, max, count } or null if intersection is empty.
 *
 * @param {string[]} baselineTopK
 * @param {string[]} shadowTopK
 * @param {Map<string, number>} baselineRankMap  - Full (pre-top-K) rank map.
 * @param {Map<string, number>} shadowRankMap    - Full shadow rank map.
 * @returns {{ median: number, p95: number, max: number, count: number }|null}
 */
function _computeDisplacement(baselineTopK, shadowTopK, baselineRankMap, shadowRankMap) {
  if (!Array.isArray(baselineTopK) || !Array.isArray(shadowTopK)) return null;

  const shadowSet = new Set(shadowTopK);
  const deltas = [];

  for (const slug of baselineTopK) {
    if (!shadowSet.has(slug)) continue;
    const bRank = baselineRankMap.has(slug)
      ? baselineRankMap.get(slug)
      : baselineTopK.indexOf(slug);
    const sRank = shadowRankMap.has(slug)
      ? shadowRankMap.get(slug)
      : shadowTopK.indexOf(slug);
    deltas.push(Math.abs(bRank - sRank));
  }

  if (deltas.length === 0) return null;

  deltas.sort((a, b) => a - b);
  const count = deltas.length;
  const median = _percentile(deltas, 0.5);
  const p95    = _percentile(deltas, 0.95);
  const max    = deltas[count - 1];

  return { median, p95, max, count };
}

/**
 * Compute percentile from a sorted array of numbers.
 * @param {number[]} sorted
 * @param {number} p  - 0..1
 * @returns {number}
 */
function _percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// Internal: JSONL writer
// ---------------------------------------------------------------------------

/**
 * Write a shadow telemetry row to `.orchestray/state/scorer-shadow.jsonl`.
 * Never throws; all errors are silently swallowed (telemetry is optional).
 *
 * @param {object} row
 * @param {string} projectRoot
 * @param {object} cfg  - Validated retrieval config (provides rotation settings).
 */
function _writeShadowRow(row, projectRoot, cfg) {
  try {
    // Enforce per-line cap (2 KB). If the row is over cap, truncate the
    // slug arrays and reasons map (the most likely source of size growth).
    const serialized = _capRow(row, MAX_LINE_BYTES);
    if (serialized === null) return; // Could not fit — skip silently.

    const stateDir  = path.join(projectRoot, '.orchestray', 'state');
    const jsonlPath = path.join(stateDir, 'scorer-shadow.jsonl');

    const maxSizeBytes   = typeof cfg.jsonl_max_bytes === 'number'
      ? cfg.jsonl_max_bytes
      : 1 * 1024 * 1024;
    const maxGenerations = typeof cfg.jsonl_max_generations === 'number'
      ? cfg.jsonl_max_generations
      : 3;

    // appendJsonlWithRotation creates the directory and handles rotation.
    appendJsonlWithRotation(jsonlPath, JSON.parse(serialized), {
      maxSizeBytes,
      maxGenerations,
    });
  } catch (_e) {
    // Telemetry writes must never throw into caller.
    try {
      process.stderr.write('[orchestray] scorer-shadow: JSONL write failed: ' +
        (_e && _e.message ? _e.message : String(_e)) + '\n');
    } catch (_) { /* swallow */ }
  }
}

/**
 * Attempt to serialise `row` within `maxBytes`. Truncates top_k arrays and
 * reasons maps progressively if needed. Returns the JSON string, or null if
 * it cannot be made to fit.
 *
 * @param {object} row
 * @param {number} maxBytes
 * @returns {string|null}
 */
function _capRow(row, maxBytes) {
  let s = JSON.stringify(row);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;

  // Strategy: progressively truncate top-K arrays and reasons map.
  const copy = Object.assign({}, row);
  copy.shadow_reasons_by_slug = {};
  s = JSON.stringify(copy);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;

  // Truncate baseline_top_k and shadow_top_k by half.
  copy.baseline_top_k = (row.baseline_top_k || []).slice(0, 5);
  copy.shadow_top_k   = (row.shadow_top_k   || []).slice(0, 5);
  s = JSON.stringify(copy);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;

  // Give up — row cannot be made to fit.
  return null;
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 of query, first 16 hex chars. Avoids storing raw query prose.
 * @param {string} query
 * @returns {string}
 */
function _hashQuery(query) {
  try {
    return 'sha256:' + crypto.createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16);
  } catch (_) {
    return 'sha256:0000000000000000';
  }
}

/**
 * Resolve orchestration ID from the state file.
 * Mirrors degraded-journal._resolveOrchId but kept local to avoid coupling.
 * @param {string} projectRoot
 * @returns {string|null}
 */
function _resolveOrchId(projectRoot) {
  try {
    const statePath = path.join(projectRoot, '.orchestray', 'state', 'orchestration.md');
    const content   = fs.readFileSync(statePath, 'utf8');
    const match     = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const idLine = match[1].split(/\r?\n/).find((l) => l.startsWith('id:'));
      if (idLine) return idLine.replace(/^id:\s*/, '').trim() || null;
    }
  } catch (_) { /* best-effort */ }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  maybeRunShadowScorers,
  registerScorer,
  SHADOW_SCHEMA_VERSION,
  // Exported for tests only:
  _computeKendallTau,
  _computeTopKOverlap,
  _computeDisplacement,
  _writeShadowRow,
  _snapshotForShadow,
  _registry,
};
