'use strict';

/**
 * `pattern_find` MCP tool.
 *
 * Retrieves the most relevant orchestration patterns for a task summary.
 * See CHANGELOG.md §2.0.11 (Stage 2 MCP tools & resources) for design context.
 *
 * Stateless per-call: reads every `.orchestray/patterns/*.md`, parses
 * frontmatter, and scores by keyword/role/file-glob overlap times
 * confidence.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { sanitizeExcerpt } = require('../lib/excerpt');
const { logStderr } = require('../lib/rpc');
const { AGENT_ROLES } = require('../lib/constants');
const { loadPatternDecayConfig, loadRetrievalConfig } = require('../../_lib/config-schema');
const { searchPatterns, UNAVAILABLE: FTS5_UNAVAILABLE } = require('../../_lib/pattern-index-sqlite');
const { _expandSynonyms } = require('./_synonyms');
const { getSharedPatternsDir } = require('../lib/paths');
const { writeAuditEvent, readOrchestrationId } = require('../lib/audit');
const { _projectHash } = require('../../_lib/shared-promote');
const { parseFields, projectArray } = require('../lib/field-projection');
const scorerVariants = require('../../_lib/scorer-variants');
const { getEventWindow } = require('../../_lib/scorer-telemetry');
const { maybeAnnounce: maybeAnnounceScorerVariants } = require('../announce-scorer-variants');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

// Session flag to emit the FTS5 fallback warning at most once per process.
let _fts5WarnedThisSession = false;

const { recordDegradation } = require('../../_lib/degraded-journal');

const CATEGORIES = [
  'decomposition',
  'routing',
  'specialization',
  'anti-pattern',
  'design-preference',
];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['task_summary'],
  properties: {
    task_summary: { type: 'string', minLength: 3, maxLength: 500 },
    agent_role: { type: 'string', enum: AGENT_ROLES },
    file_globs: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    categories: {
      type: 'array',
      items: { type: 'string', enum: CATEGORIES },
    },
    max_results: { type: 'integer', minimum: 1, maximum: 10 },
    min_confidence: { type: 'number', minimum: 0, maximum: 1 },
    include_deprecated: { type: 'boolean' },
    include_proposed: { type: 'boolean' },
    // fields: accepts a comma-separated string or string[] — validated by parseFields() at runtime.
    // Schema type intentionally omitted: the validator subset does not support oneOf/anyOf,
    // and parseFields() enforces the allowed shapes with clear error messages.
    fields: { description: 'Optional comma-separated string or array of top-level field names to project. Omit for full response (backward compat).' },
    // R-CAT (v2.1.14): mode controls response shape.
    //   "full"    (default) — existing behaviour: full match objects subject to `fields` projection.
    //   "catalog" — TOON-formatted headline list (one line per pattern). When mode=catalog,
    //               `fields` is ignored and the fixed catalog shape is returned.
    // Precedence: mode wins over fields when mode="catalog".
    mode: { type: 'string', enum: ['full', 'catalog'] },
  },
};

const definition = deepFreeze({
  name: 'pattern_find',
  description:
    'Retrieve the most relevant patterns for a task. Call before decomposition; ' +
    'inject any returned URIs as @orchestray:pattern://<slug> references in ' +
    'delegation prompts. ' +
    'mode="catalog" returns a TOON-formatted headline list (one line per pattern, ' +
    'no body text); use pattern_read(slug) to fetch a full pattern body on demand. ' +
    'mode="full" (default) returns full match objects.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Scorer variant selection
// ---------------------------------------------------------------------------

// Event windows used by the usage-aware variants (skip-down: 180d, local-success: 90d).
const SKIP_DOWN_WINDOW_MS    = 180 * 24 * 60 * 60 * 1000;
const LOCAL_SUCCESS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Select the active scoring function for this pattern_find call.
 *
 * Returns an object carrying:
 *   - variant:  the resolved variant name (one of baseline/skip-down/local-success/composite).
 *   - scoreFn:  (pattern, ctx) => number — the function to call per pattern.
 *
 * Unknown / invalid `retrieval.scorer_variant` values fall back to baseline.
 * loadRetrievalConfig already performs validation + coercion before returning,
 * so reaching here with an out-of-range value should be impossible; the
 * defensive fallback in scorerForVariant is belt-and-braces.
 *
 * @param {object} retrievalConfig — result of loadRetrievalConfig(projectRoot).
 * @returns {{ variant: string, scoreFn: Function }}
 */
function _selectScorer(retrievalConfig) {
  const variant = (retrievalConfig && typeof retrievalConfig.scorer_variant === 'string')
    ? retrievalConfig.scorer_variant
    : 'baseline';
  const scoreFn = scorerVariants.scorerForVariant(variant);
  return { variant, scoreFn };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('pattern_find', context);
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_find: ' + validation.errors.join('; '));
  }

  // Resolve patterns directory. Tool context may inject projectRoot for
  // tests — prefer it when present (matches fixture strategy in §13).
  let patternsDir;
  let projectRoot;
  try {
    if (context && context.projectRoot) {
      projectRoot = context.projectRoot;
      patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
    } else {
      patternsDir = paths.getPatternsDir();
      projectRoot = process.cwd();
    }
  } catch (err) {
    // No project root — no patterns. Return empty match set, not an error.
    return toolSuccess({ matches: [], considered: 0, filtered_out: 0 });
  }

  // Load decay config. Fail-open: defaults if config missing/malformed.
  let decayConfig;
  try {
    decayConfig = loadPatternDecayConfig(projectRoot);
  } catch (_) {
    decayConfig = { default_half_life_days: 90, category_overrides: {} };
  }

  // One-time stderr announcement of scorer variants (fires at most once per install).
  try {
    maybeAnnounceScorerVariants(projectRoot);
  } catch (_) { /* self-silencing */ }

  // Resolve active scorer from retrieval.scorer_variant (default: baseline).
  let retrievalConfig;
  try {
    retrievalConfig = loadRetrievalConfig(projectRoot);
  } catch (_) {
    retrievalConfig = { scorer_variant: 'baseline' };
  }
  const { variant: activeVariant, scoreFn: activeScoreFn } = _selectScorer(retrievalConfig);

  // Event-count maps for usage-aware variants. Only loaded when non-baseline
  // is active (default fast-path pays zero extra I/O).
  let skipCounts = null;
  let successCounts = null;
  if (activeVariant !== 'baseline') {
    const nowMsForEvents = Date.now();
    try {
      if (activeVariant === 'skip-down' || activeVariant === 'composite') {
        const skipEvents = getEventWindow(projectRoot, {
          types:   new Set(['pattern_skip_enriched']),
          sinceMs: nowMsForEvents - SKIP_DOWN_WINDOW_MS,
        });
        skipCounts = scorerVariants.buildSkipCounts(skipEvents);
      }
      if (activeVariant === 'local-success' || activeVariant === 'composite') {
        const successEvents = getEventWindow(projectRoot, {
          types:   new Set(['mcp_tool_call']),
          sinceMs: nowMsForEvents - LOCAL_SUCCESS_WINDOW_MS,
        });
        successCounts = scorerVariants.buildSuccessCounts(successEvents);
      }
    } catch (_) {
      // Fail-open: empty maps collapse scores to baseline.
      skipCounts    = skipCounts    || new Map();
      successCounts = successCounts || new Map();
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(patternsDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return toolSuccess({ matches: [], considered: 0, filtered_out: 0 });
    }
    return toolError('pattern_find: ' + (err && err.message ? err.message : String(err)));
  }

  // Sort before scoring for deterministic output on tied scores.
  const mdFiles = entries.filter((n) => n.endsWith('.md')).sort();

  // Build local index with _tier: 'local' on each entry.
  const localIndex = [];
  for (const name of mdFiles) {
    const filepath = path.join(patternsDir, name);
    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (err) {
      logStderr('pattern_find: read failed ' + filepath);
      continue;
    }
    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) {
      logStderr('pattern_find.parse_error: ' + name);
      continue;
    }
    const slug = name.slice(0, -3); // strip .md
    localIndex.push({
      slug,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      filepath,
      _tier: 'local',
    });
  }

  const taskSummary = input.task_summary;
  const agentRole = input.agent_role;
  const fileGlobs = Array.isArray(input.file_globs) ? input.file_globs : [];
  const categoryFilter = Array.isArray(input.categories) && input.categories.length > 0
    ? new Set(input.categories) : null;
  const minConfidence = typeof input.min_confidence === 'number' ? input.min_confidence : 0;
  const maxResults = typeof input.max_results === 'number' ? input.max_results : 5;
  const includeDeprecated = input.include_deprecated === true;
  // W4 (v2.1.6 F-05): proposed patterns are excluded by default.
  // Set include_proposed: true to include them (e.g. for /orchestray:learn list --proposed).
  const includeProposed = input.include_proposed === true;

  // When include_proposed is true, also scan proposed-patterns/. Filepath lets
  // the filter loop identify and tag these entries as proposed.
  if (includeProposed) {
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
    let proposedEntries;
    try {
      proposedEntries = fs.readdirSync(proposedDir);
    } catch (_) {
      proposedEntries = [];
    }
    for (const name of proposedEntries.filter((n) => n.endsWith('.md')).sort()) {
      const filepath = path.join(proposedDir, name);
      let content;
      try {
        content = fs.readFileSync(filepath, 'utf8');
      } catch (_) {
        continue;
      }
      const parsed = frontmatter.parse(content);
      if (!parsed.hasFrontmatter) continue;
      const slug = name.slice(0, -3);
      // Only include if not already in localIndex (no slug collision).
      if (!localIndex.some((e) => e.slug === slug)) {
        localIndex.push({
          slug,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          filepath,
          _tier: 'local',
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // FTS5 seam (bin/_lib/pattern-index-sqlite.js). On UNAVAILABLE fall back
  // to inline Jaccard scoring below.
  // ---------------------------------------------------------------------------

  /** @type {Map<string, number>|null} slug → normalized [0,1] relevance score */
  let fts5ScoreBySlug = null;
  let fts5Available = true;
  /** @type {Array|null} Raw results from searchPatterns (carries match_terms). */
  let fts5Results = null;

  try {
    fts5Results = searchPatterns(taskSummary, {
      projectRoot,
      limit: Math.max(localIndex.length, 50),
      includeDeprecated,
    });

    if (fts5Results === FTS5_UNAVAILABLE || !Array.isArray(fts5Results)) {
      fts5Available = false;
      fts5Results = null;
    } else {
      // BM25 scores are negative (more negative = better). Normalize to [0,1].
      const scores = fts5Results.map((r) => r.bm25_score);
      const minBm25 = scores.length > 0 ? Math.min(...scores) : 0;
      const maxBm25 = scores.length > 0 ? Math.max(...scores) : 0;
      const range = maxBm25 - minBm25; // negative range or 0

      fts5ScoreBySlug = new Map();
      for (const r of fts5Results) {
        // Normalize: best (most negative) → 1.0, worst → 0.0.
        // If all scores are the same (range === 0), assign 0.5.
        const normalized = range !== 0
          ? (maxBm25 - r.bm25_score) / Math.abs(range)
          : 0.5;
        fts5ScoreBySlug.set(r.slug, normalized);
      }
    }
  } catch (_) {
    fts5Available = false;
    fts5Results = null;
  }

  if (!fts5Available && !_fts5WarnedThisSession) {
    _fts5WarnedThisSession = true;
    logStderr(
      'pattern_find: FTS5 backend unavailable; falling back to Jaccard retrieval. ' +
      'Install native build tools or update to Node 22.5+ for FTS5.'
    );
    recordDegradation({
      kind: 'fts5_fallback',
      severity: 'warn',
      projectRoot,
      detail: {
        reason: 'FTS5 backend returned UNAVAILABLE',
        shared_tier: false,
        dedup_key: 'fts5_fallback',
      },
    });
    // Write a session flag as belt-and-braces for multi-process scenarios
    // (the in-process boolean above is the primary guard).
    try {
      const stateDir = path.join(projectRoot, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'fts5-warn-emitted.flag'),
        new Date().toISOString(),
        { flag: 'wx' } // 'wx' = fail silently if file already exists
      );
    } catch (_) { /* non-fatal */ }
  }

  // ---------------------------------------------------------------------------
  // Two-tier lookup: if federation is enabled, scan the shared patterns dir
  // and merge with the local index. Local wins on slug collision. The shared
  // tier always uses Jaccard (FTS5 index covers only the local projectRoot dir).
  // ---------------------------------------------------------------------------

  /** @type {Array<{slug, frontmatter, body, filepath, _tier}>} merged index */
  let index = localIndex;

  // Shared tier: only active when federation is enabled.
  const sharedPatternsDir = getSharedPatternsDir();

  if (sharedPatternsDir !== null) {
    // Build shared index from disk (Jaccard path — see note above).
    let sharedEntries;
    try {
      sharedEntries = fs.readdirSync(sharedPatternsDir);
    } catch (_err) {
      sharedEntries = null; // Shared dir absent or unreadable — skip silently.
    }

    if (sharedEntries !== null) {
      const sharedIndex = [];
      for (const name of sharedEntries.filter((n) => n.endsWith('.md')).sort()) {
        const filepath = path.join(sharedPatternsDir, name);
        let content;
        try {
          content = fs.readFileSync(filepath, 'utf8');
        } catch (_err) {
          logStderr('pattern_find(shared): read failed ' + filepath);
          continue;
        }
        const parsed = frontmatter.parse(content);
        if (!parsed.hasFrontmatter) {
          logStderr('pattern_find(shared).parse_error: ' + name);
          continue;
        }
        // R-FED-PRIVACY: local-only patterns must not surface on the shared-tier
        // read side. Absent `sharing` is treated as `federated` for back compat.
        if (parsed.frontmatter.sharing === 'local-only') {
          continue;
        }
        sharedIndex.push({
          slug: name.slice(0, -3),
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          filepath,
          _tier: 'shared',
        });
      }

      // Merge: local wins on slug collision. Build slug Set for O(1) lookup.
      const localSlugs = new Set(localIndex.map((e) => e.slug));
      const collidingSlugs = [];

      for (const sharedEntry of sharedIndex) {
        if (localSlugs.has(sharedEntry.slug)) {
          collidingSlugs.push(sharedEntry.slug);
        } else {
          index = index.concat([sharedEntry]);
        }
      }

      // Emit ONE collision summary event instead of one per slug.
      if (collidingSlugs.length > 0) {
        try {
          writeAuditEvent({
            timestamp: new Date().toISOString(),
            type: 'pattern_find_collisions_summary',
            orchestration_id: readOrchestrationId(),
            count: collidingSlugs.length,
            all_winning_tier: 'local',
            all_losing_tier: 'shared',
            slugs: collidingSlugs.slice(0, 20), // cap for audit-log hygiene
            context: 'pattern_find',
          });
        } catch (_err) { /* non-fatal */ }
      }
    }
  }

  const considered = index.length;
  const scored = [];
  let filteredOut = 0;

  const nowMs = Date.now();
  const taskTokens = _tokenize(taskSummary); // Pre-compute once for Jaccard path.

  // Synonym expansion for the Jaccard path (not applied to FTS5 local path).
  // Default ON; `retrieval.synonyms_enabled = false` disables it.
  let synonymsEnabled = true;
  try {
    const retrievalCfg = loadRetrievalConfig(projectRoot);
    if (retrievalCfg && retrievalCfg.synonyms_enabled === false) {
      synonymsEnabled = false;
    }
  } catch (_) { /* fail-open: default-on */ }
  const { tokens: expandedTaskTokens, expansions: synonymExpansions } =
    _expandSynonyms(taskTokens, { enabled: synonymsEnabled });

  // Build slug → match_terms lookup from fts5Results for O(1) access per entry.
  /** @type {Map<string, import('../../_lib/pattern-index-sqlite').TermHit[]>} */
  const fts5TermsBySlug = new Map();
  if (fts5Results !== null) {
    for (const r of fts5Results) {
      if (Array.isArray(r.match_terms)) {
        fts5TermsBySlug.set(r.slug, r.match_terms);
      }
    }
  }

  for (const entry of index) {
    const fm = entry.frontmatter;
    const confidence = _numericConfidence(fm.confidence);
    const category = (typeof fm.category === 'string' && fm.category) ||
                     (typeof fm.type === 'string' && fm.type) || 'unknown';
    const timesApplied = _numericInt(fm.times_applied, 0);
    const description = typeof fm.description === 'string' ? fm.description : '';

    // Skip deprecated patterns (include_deprecated opt-in overrides for curator reads).
    if ((fm.deprecated === true || fm.deprecated === 'true') && !includeDeprecated) {
      filteredOut++;
      continue;
    }

    // W4 (v2.1.6 F-05): exclude proposed patterns from default results.
    // Defense-in-depth: filter by both path and frontmatter flag so FTS5
    // accidentally indexing a proposed file is caught here too.
    const isProposed = fm.proposed === true ||
      entry.filepath.replace(/\\/g, '/').includes('/.orchestray/proposed-patterns/');
    if (isProposed && !includeProposed) {
      filteredOut++;
      continue;
    }

    // Category filter
    if (categoryFilter && !categoryFilter.has(category)) {
      filteredOut++;
      continue;
    }

    // min_confidence filter
    if (confidence < minConfidence) {
      filteredOut++;
      continue;
    }

    let overlapRatio;
    let overlapTokens;

    // Local entries use FTS5 when available; shared entries always use Jaccard
    // (FTS5 index covers only the local projectRoot patterns dir).
    // W4: proposed entries are NEVER indexed by FTS5 (F-05 design). Always
    // use Jaccard for proposed entries so they score on their body/description text.
    const entryTier = entry._tier || 'local';
    const usesFts5 = fts5Available && fts5ScoreBySlug !== null &&
                     entryTier === 'local' && !isProposed;
    if (usesFts5) {
      // FTS5 path: use normalized BM25 score as the relevance signal.
      overlapRatio = fts5ScoreBySlug.get(entry.slug) || 0;
      overlapTokens = new Set(); // no per-token breakdown available from FTS5
    } else {
      // Jaccard fallback (FTS5 unavailable, shared-tier, or proposed entry).
      const bodyHead = entry.body.slice(0, 200);
      const hay = (description + ' ' + bodyHead).toLowerCase();
      const hayTokens = _tokenize(hay);
      const result = _jaccard(expandedTaskTokens, hayTokens);
      overlapRatio = result.ratio;
      overlapTokens = result.overlap;
    }

    let roleBonus = 0;
    if (agentRole) {
      const roleNeedle = agentRole.toLowerCase();
      if (entry.slug.toLowerCase().includes(roleNeedle) ||
          entry.body.toLowerCase().includes(roleNeedle)) {
        roleBonus = 0.3;
      }
    }

    let fileBonus = 0;
    if (fileGlobs.length > 0) {
      const patternSegments = _segmentsOf(entry.body + ' ' + description);
      let overlapSeg = 0;
      for (const g of fileGlobs) {
        for (const seg of _segmentsOf(g)) {
          if (patternSegments.has(seg)) overlapSeg++;
        }
      }
      fileBonus = Math.min(0.4, 0.2 * overlapSeg);
    }

    // Delegate final scoring to the active variant function.
    const score = activeScoreFn({
      slug:         entry.slug,
      confidence,
      overlapRatio,
      roleBonus,
      fileBonus,
      timesApplied,
    }, {
      skipCounts,
      successCounts,
    });

    const matchReasons = [];
    if (usesFts5) {
      // Build per-term reasons from FTS5 highlight() data.
      // Group by term to emit "fts5:term=X (in context, approach)".
      const termHits = fts5TermsBySlug.get(entry.slug) || [];

      if (termHits.length > 0) {
        const termSections = new Map();
        for (const { term, section } of termHits) {
          if (!termSections.has(term)) termSections.set(term, []);
          const secs = termSections.get(term);
          if (!secs.includes(section)) secs.push(section);
        }
        for (const [term, sections] of termSections) {
          matchReasons.push('fts5:term=' + term + ' (in ' + sections.join(', ') + ')');
        }
      } else {
        // No highlight hits (old SQLite or uncovered section); emit generic signal.
        matchReasons.push('fts5');
      }
    }
    if (roleBonus > 0) matchReasons.push('role=' + agentRole);
    if (!usesFts5) {
      if (!fts5Available) {
        matchReasons.push('fallback: keyword');
      }
      for (const tok of Array.from(overlapTokens).slice(0, 3)) {
        matchReasons.push('keyword:' + tok);
      }
      // R-RET-EXPAND: surface synonym-expansion hits in the audit trail.
      // Only emit an entry for a token in overlapTokens that was added by
      // synonym expansion (i.e. was NOT in the original task tokens).
      // Deterministic order: iterate synonymExpansions (already sorted).
      if (synonymsEnabled && synonymExpansions.length > 0 && overlapTokens.size > 0) {
        const seenPairs = new Set();
        for (const { from, to } of synonymExpansions) {
          if (!overlapTokens.has(to)) continue;
          if (taskTokens.has(to)) continue; // was in the original query; not an expansion hit
          const key = from + '->' + to;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          matchReasons.push('synonym_expanded:' + key);
        }
      }
    }
    if (fileBonus > 0) matchReasons.push('file-overlap');

    // Sanitize one_line: cap at 80 chars, strip markdown.
    const oneLine = sanitizeExcerpt(_firstLine(description || entry.body));

    // Exponential decay: reference timestamp = last_applied or file mtime.
    const { decayedConfidence, ageDays } = _computeDecay(
      confidence, fm, entry.filepath, category, decayConfig, nowMs
    );

    // Populate provenance fields for shared-tier matches ([shared] vs [shared, own]).
    // context_hook is stored with underscore prefix so it's stripped from full-mode
    // responses (alongside _score).
    const _contextHook = (typeof fm.context_hook === 'string' && fm.context_hook.length >= 5)
      ? fm.context_hook
      : null;

    const matchEntry = {
      slug: entry.slug,
      uri: isProposed
        ? 'orchestray:proposed-pattern://' + entry.slug
        : 'orchestray:pattern://' + entry.slug,
      confidence,
      decayed_confidence: decayedConfidence,
      age_days: ageDays,
      times_applied: timesApplied,
      category,
      one_line: oneLine,
      match_reasons: matchReasons,
      source: entryTier,
      _score: score,
      _context_hook: _contextHook,
    };
    if (entryTier === 'shared') {
      const promotedFrom = typeof fm.promoted_from === 'string' ? fm.promoted_from : undefined;
      if (promotedFrom !== undefined) {
        matchEntry.promoted_from = promotedFrom;
        matchEntry.promoted_is_own = promotedFrom === _projectHash(projectRoot);
      }
    }
    if (isProposed) {
      matchEntry.proposed = true;
    }
    scored.push(matchEntry);
  }

  // Sort: score desc, tiebreak times_applied desc, confidence desc, slug asc.
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    if (b.times_applied !== a.times_applied) return b.times_applied - a.times_applied;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  const top = scored.slice(0, maxResults).map((m) => {
    const { _score, ...rest } = m;
    return rest;
  });

  // Shadow scorer seam: fire-and-forget; harness fails open. No-op at defaults.
  try {
    const { maybeRunShadowScorers } = require('../../_lib/scorer-shadow');
    maybeRunShadowScorers({
      query:          taskSummary,
      baselineScored: scored,
      candidates:     index,
      inputContext:   { projectRoot, agentRole, fileGlobs, nowMs },
      maxResults,
    });
  } catch (_e) { /* fail-open */ }

  // mode=catalog returns a TOON-formatted headline list (fields is ignored).
  // mode=full (default) returns full match objects with optional field projection.
  const mode = (typeof input.mode === 'string' && input.mode === 'catalog') ? 'catalog' : 'full';

  if (mode === 'catalog') {
    const catalogMatches = top.map((m) => ({
      slug: m.slug,
      confidence: m.confidence,
      one_line: m.one_line,
      _context_hook: m._context_hook,
    }));
    return toolSuccess({
      mode: 'catalog',
      catalog: _renderToon(catalogMatches),
      considered,
      filtered_out: filteredOut,
    });
  }

  // mode=full: strip internal fields and apply optional field projection.
  const topClean = top.map((m) => {
    // eslint-disable-next-line no-unused-vars
    const { _score: _s, _context_hook: _ch, ...rest } = m;
    return rest;
  });

  // The PreToolUse:mcp__orchestray__pattern_find checkpoint hook writes
  // fields_used: <bool> to .orchestray/state/mcp-checkpoint.jsonl based on
  // whether tool_input.fields was non-empty. The literal string fields_used
  // is asserted by tests/regression/v2114-r-pfx.test.js — load-bearing.
  const fieldNames = parseFields(input.fields);
  if (fieldNames !== null) {
    if (fieldNames && typeof fieldNames === 'object' && 'error' in fieldNames) {
      return toolError('pattern_find: ' + fieldNames.error);
    }
    return toolSuccess({
      matches: projectArray(topClean, fieldNames),
      considered,
      filtered_out: filteredOut,
    });
  }

  return toolSuccess({
    matches: topClean,
    considered,
    filtered_out: filteredOut,
  });
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Federation-context detector.
 *
 * Returns true when the entry was loaded from the shared tier. Local-only
 * patterns must never surface in federation contexts (shared tier is a
 * cross-install read; local tier is fully visible to the owning project).
 *
 * Accepts either a full index entry `{_tier}` or a bare tier string.
 */
function _isFederationContext(entryOrTier) {
  if (!entryOrTier) return false;
  if (typeof entryOrTier === 'string') return entryOrTier === 'shared';
  if (typeof entryOrTier === 'object' && entryOrTier._tier) {
    return entryOrTier._tier === 'shared';
  }
  return false;
}

function _tokenize(text) {
  if (typeof text !== 'string') return new Set();
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return { ratio: 0, overlap: new Set() };
  const overlap = new Set();
  for (const x of a) if (b.has(x)) overlap.add(x);
  const union = new Set([...a, ...b]);
  return { ratio: overlap.size / union.size, overlap };
}

function _segmentsOf(s) {
  if (typeof s !== 'string') return new Set();
  const out = new Set();
  for (const part of s.split(/[\s,()'"[\]{}]+/)) {
    for (const seg of part.split(/[/\\]/)) {
      if (seg.length > 0) out.add(seg);
    }
  }
  return out;
}

function _numericConfidence(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const map = { low: 0.3, medium: 0.6, high: 0.9 };
    if (v in map) return map[v];
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0.5;
}

function _numericInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function _firstLine(s) {
  if (typeof s !== 'string') return '';
  const idx = s.indexOf('\n');
  const line = idx === -1 ? s : s.slice(0, idx);
  return line.trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Decay helpers
// ---------------------------------------------------------------------------

/**
 * Compute decayed_confidence and age_days for a pattern.
 *
 * Formula: decayed_confidence = confidence * 0.5 ^ (age_days / half_life)
 *
 * Reference timestamp precedence:
 *   1. fm.last_applied — ISO 8601 string written when a pattern is applied.
 *   2. file mtime — cheapest fallback; no history scanning required.
 *
 * Half-life precedence (highest to lowest):
 *   1. fm.decay_half_life_days — per-pattern override in frontmatter.
 *   2. decayConfig.category_overrides[category] — per-category override.
 *   3. decayConfig.default_half_life_days — global default (90 days).
 *
 * @param {number} confidence - Raw pattern confidence (0..1).
 * @param {object} fm - Parsed frontmatter object.
 * @param {string} filepath - Absolute path to the pattern file (for mtime fallback).
 * @param {string} category - Resolved pattern category string.
 * @param {{ default_half_life_days: number, category_overrides: object }} decayConfig
 * @param {number} nowMs - Current timestamp in milliseconds (Date.now()).
 * @returns {{ decayedConfidence: number, ageDays: number }}
 */
function _computeDecay(confidence, fm, filepath, category, decayConfig, nowMs) {
  let refMs = null;

  if (fm.last_applied && typeof fm.last_applied === 'string' && fm.last_applied !== 'null') {
    const parsed = Date.parse(fm.last_applied);
    if (!isNaN(parsed)) refMs = parsed;
  }

  if (refMs === null) {
    try {
      const stat = fs.statSync(filepath);
      refMs = stat.mtimeMs;
    } catch (_) {
      refMs = nowMs; // mtime unavailable — treat as 0 days old (no decay)
    }
  }

  const ageDays = Math.max(0, Math.floor((nowMs - refMs) / 86400000));

  // Resolve half-life: default → category override → per-pattern frontmatter.
  let halfLife = decayConfig.default_half_life_days;
  if (
    decayConfig.category_overrides &&
    typeof decayConfig.category_overrides === 'object' &&
    category in decayConfig.category_overrides
  ) {
    const cv = decayConfig.category_overrides[category];
    if (Number.isInteger(cv) && cv >= 1) halfLife = cv;
  }
  const perPattern = fm.decay_half_life_days;
  if (Number.isInteger(perPattern) && perPattern >= 1) halfLife = perPattern;

  const decayedConfidence = Math.round(
    confidence * Math.pow(0.5, ageDays / halfLife) * 1000
  ) / 1000;

  return { decayedConfidence, ageDays };
}

// ---------------------------------------------------------------------------
// TOON renderer
//
// TOON = Tag-Oriented Object Notation — minimal column-oriented compact text.
// One line per pattern:  PATTERN slug=<slug> confidence=<0.00> one_line="<...>" hook="<...>"
// Values with spaces are double-quoted; embedded quotes escaped as \".
// confidence is fixed to 2 decimal places.
// ---------------------------------------------------------------------------

/**
 * Escape a string value for a TOON field.
 * If the value contains a space or a double-quote, wrap in double-quotes and
 * escape embedded double-quotes as \".
 *
 * @param {string} s
 * @returns {string}
 */
function _toonValue(s) {
  if (typeof s !== 'string') s = String(s);
  const needsQuotes = s.includes(' ') || s.includes('"');
  if (!needsQuotes) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Render an array of match objects as a TOON catalog string.
 * Each entry produces one line. The `context_hook` field (from frontmatter,
 * populated by bin/backfill-pattern-hooks.js) is used for the hook column;
 * falls back to `one_line` when absent.
 *
 * @param {Array<{slug, confidence, one_line, _context_hook}>} matches
 * @returns {string} Multi-line TOON block (no trailing newline).
 */
function _renderToon(matches) {
  return matches.map((m) => {
    const confStr = (typeof m.confidence === 'number')
      ? m.confidence.toFixed(2)
      : String(m.confidence || '0.00');
    const hook = (typeof m._context_hook === 'string' && m._context_hook.length >= 5)
      ? m._context_hook
      : (m.one_line || '');
    return (
      'PATTERN slug=' + _toonValue(m.slug) +
      ' confidence=' + confStr +
      ' one_line=' + _toonValue(m.one_line || '') +
      ' hook=' + _toonValue(hook)
    );
  }).join('\n');
}

module.exports = {
  definition,
  handle,
  _isFederationContext,
  _renderToon,
  _toonValue,
};
