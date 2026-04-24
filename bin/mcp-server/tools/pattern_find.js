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
  },
};

const definition = deepFreeze({
  name: 'pattern_find',
  description:
    'Retrieve the most relevant patterns for a task. Call before decomposition; ' +
    'inject any returned URIs as @orchestray:pattern://<slug> references in ' +
    'delegation prompts.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Scorer variant selection (W8 v2.1.13 R-RET-PROMOTE)
// ---------------------------------------------------------------------------

// Event windows used by the usage-aware variants — mirror the shadow scorers
// shipped in v2.1.3 (skip-down: 180d, local-success: 90d) so the promoted
// behaviour matches the telemetry operators have been observing.
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

  // W8 (v2.1.13 R-RET-PROMOTE): one-time stderr announcement of the newly
  // selectable scorer variants. Fires at most once per install (sentinel
  // lives at .orchestray/state/.scorer-variants-announced-2113).
  try {
    maybeAnnounceScorerVariants(projectRoot);
  } catch (_) {
    // Announcer is self-silencing; belt-and-braces.
  }

  // W8: resolve active scorer from retrieval.scorer_variant. Default stays
  // `baseline` — this release promotes the other variants from shadow-only to
  // selectable, but does NOT flip the default.
  let retrievalConfig;
  try {
    retrievalConfig = loadRetrievalConfig(projectRoot);
  } catch (_) {
    retrievalConfig = { scorer_variant: 'baseline' };
  }
  const { variant: activeVariant, scoreFn: activeScoreFn } = _selectScorer(retrievalConfig);

  // Event-count maps for the usage-aware variants. Only loaded when a non-
  // baseline variant is active, so the default fast-path pays zero extra I/O.
  // When loaded, the maps are reused for every pattern in the scoring loop.
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
      // Event-window read failure → variants fall back to empty maps, which
      // makes scores collapse to baseline. Fail-open, do not surface.
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

  // T3 C2: sort before the scoring loop so tied scores yield deterministic
  // output regardless of filesystem readdir ordering.
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

  // W4: when include_proposed is true, also scan .orchestray/proposed-patterns/.
  // These entries get _tier: 'local' so scoring works, but their filepath lets
  // the filter loop identify and tag them as proposed.
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
  // FTS5 seam: adapter lives in bin/_lib/pattern-index-sqlite.js.
  // No IndexBackend abstraction — see adversarial review W6 F08.
  //
  // Try FTS5 first. On UNAVAILABLE fall back to inline Jaccard scoring below.
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
      // BM25 scores are negative (more negative = better). Normalize to [0,1]:
      // find the most-negative score (best match) and map to 1.0.
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
    // Write a session flag to .orchestray/state/ to prevent warning spam across
    // tool calls within the same MCP server process (the in-process boolean
    // above already guards that; this file is belt-and-suspenders for
    // multi-process scenarios such as running two MCP servers simultaneously).
    try {
      const stateDir = path.join(projectRoot, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'fts5-warn-emitted.flag'),
        new Date().toISOString(),
        { flag: 'wx' } // 'wx' = fail silently if file already exists
      );
    } catch (_) {
      // Non-fatal — the in-process boolean is the real guard.
    }
  }

  // ---------------------------------------------------------------------------
  // Two-tier lookup (B5)
  //
  // If federation is enabled (getSharedPatternsDir() returns non-null), scan
  // the shared patterns directory and merge with the local index.
  // Local wins on slug collision. Collision events are emitted per-collision.
  //
  // The shared tier uses Jaccard scoring (not FTS5). The shared dir layout is
  // <sharedBase>/patterns — not <root>/.orchestray/patterns — so the FTS5
  // backend's projectRoot convention does not apply. Jaccard is the correct
  // fallback here; it is consistent with the existing fts5Available=false path.
  // Local FTS5-scored entries and shared Jaccard-scored entries are merged
  // before ranking — they all flow through the same final sort.
  //
  // B9 note: B9 adds curator-specific reads to pattern_find.js in Wave 3.
  // B9's seam is the `include_deprecated` flag + the scoring/filter loop below.
  // B9 should NOT modify the two-tier merge block (lines bounded by
  // "Two-tier lookup (B5)" comments). The final `index` array handed to the
  // scoring loop is the correct integration point for any per-entry B9 changes.
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
        // R-FED-PRIVACY (v2.1.13 W6): sharing: local-only patterns must never
        // surface on the federation READ side. The shared-tier scan is by
        // definition a federation read context — any entry flagged local-only
        // (e.g. a pattern that slipped into the shared dir but is tagged not
        // to leave this machine) is skipped here. Absent `sharing` key is
        // treated as `federated` (backward compat with pre-v2.1.13 patterns).
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

      // Merge: local wins on slug collision.
      // Build a slug Set from local to detect collisions in O(1).
      const localSlugs = new Set(localIndex.map((e) => e.slug));
      const collidingSlugs = [];

      for (const sharedEntry of sharedIndex) {
        if (localSlugs.has(sharedEntry.slug)) {
          collidingSlugs.push(sharedEntry.slug);
          // Local entry is already in localIndex — discard shared copy.
        } else {
          // No local counterpart — include shared entry.
          index = index.concat([sharedEntry]);
        }
      }

      // Emit one pattern_collision_resolved event per colliding slug.
      // Fail-open: event emission must never block the lookup.
      for (const slug of collidingSlugs) {
        try {
          writeAuditEvent({
            timestamp: new Date().toISOString(),
            type: 'pattern_collision_resolved',
            orchestration_id: readOrchestrationId(),
            slug,
            winning_tier: 'local',
            losing_tier: 'shared',
            context: 'pattern_find',
          });
        } catch (_err) {
          // Non-fatal — audit failure must not block results.
        }
      }
    }
  }
  // End Two-tier lookup (B5)

  const considered = index.length;
  const scored = [];
  let filteredOut = 0;

  const nowMs = Date.now();
  const taskTokens = _tokenize(taskSummary); // Pre-compute once for Jaccard path.

  // R-RET-EXPAND (v2.1.13): synonym expansion for the Jaccard path.
  // Default ON; `retrieval.synonyms_enabled = false` disables expansion entirely.
  // loadRetrievalConfig is fail-open — on any parse error it returns defaults,
  // and the synonyms_enabled key is treated as default-true when undefined.
  //
  // Scope note: expansion is applied ONLY to the Jaccard path (shared tier,
  // proposed entries, and FTS5-fallback). The FTS5 primary path is left
  // untouched to guarantee zero regression on the FTS5-indexed local corpus.
  // This is the XS-scope trade-off for v2.1.13 — FTS5 expansion can come later
  // once shadow-telemetry proves recall gains outweigh precision loss.
  let synonymsEnabled = true;
  try {
    const retrievalCfg = loadRetrievalConfig(projectRoot);
    if (retrievalCfg && retrievalCfg.synonyms_enabled === false) {
      synonymsEnabled = false;
    }
  } catch (_) {
    // Fail-open: default-on.
  }
  const { tokens: expandedTaskTokens, expansions: synonymExpansions } =
    _expandSynonyms(taskTokens, { enabled: synonymsEnabled });

  // Build a slug → match_terms lookup from fts5Results for O(1) access in the
  // scoring loop (avoids O(N*M) Array.find per entry).
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

    // D1 (v2.0.16): skip deprecated patterns so they never surface in search results.
    // include_deprecated opt-in override (B4 — for curator reads and debug).
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
      // Jaccard fallback path (FTS5 unavailable, shared-tier entry, or proposed entry).
      // R-RET-EXPAND: use synonym-expanded task tokens (may equal taskTokens if
      // kill switch is off or query has no known synonyms).
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

    // W8 (v2.1.13 R-RET-PROMOTE): delegate final scoring to the selected
    // variant. At default (baseline) this is identical to the legacy inline
    // `confidence * (overlapRatio + roleBonus + fileBonus)` formula. Non-
    // baseline variants layer a Laplace-smoothed penalty or boost on top.
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
      // Build per-term reasons from the FTS5 highlight() data attached by
      // searchPatterns() (Idea 4 — v2.1.2). Each TermHit carries {term, section}.
      // Group by term so we can emit "fts5:term=X (in context, approach)" when
      // the same term hit multiple sections.
      const termHits = fts5TermsBySlug.get(entry.slug) || [];

      if (termHits.length > 0) {
        // Group hits by term, collect unique sections.
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
        // highlight() returned no hits (e.g., very old SQLite without highlight
        // support, or the match was on a section not covered by highlight).
        // Fall back to a generic fts5 reason so the caller still knows FTS5 ran.
        matchReasons.push('fts5');
      }
    }
    if (roleBonus > 0) matchReasons.push('role=' + agentRole);
    if (!usesFts5) {
      // Jaccard / fallback path: emit "fallback: keyword" to signal that FTS5
      // was unavailable or this is a shared-tier entry, plus the top overlap tokens.
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

    // T3 S2: sanitize one_line to limit prompt-injection exposure.
    // cap at 80 chars and strip markdown special sequences.
    const oneLine = sanitizeExcerpt(_firstLine(description || entry.body));

    // W9 (v2.0.18): compute decayed_confidence using exponential decay.
    // Reference timestamp: last_applied if set and parseable; otherwise file
    // mtime. File mtime is the cheapest fallback — no history scanning needed,
    // and it's a reasonable lower bound on "last touched" for new patterns.
    const { decayedConfidence, ageDays } = _computeDecay(
      confidence, fm, entry.filepath, category, decayConfig, nowMs
    );

    // Populate provenance fields for shared-tier matches so the PM can render
    // [shared] vs [shared, own] bracket labels without LLM string comparisons.
    // promoted_from is copied verbatim from frontmatter (8-hex, already present
    // on shared patterns promoted by shared-promote.js).
    // promoted_is_own is true iff this project promoted the pattern.
    //
    // W4 (v2.1.6): proposed entries are marked with proposed: true in the result
    // and their uri uses the proposed-pattern namespace so callers can distinguish
    // them from active patterns.
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
    };
    if (entryTier === 'shared') {
      const promotedFrom = typeof fm.promoted_from === 'string' ? fm.promoted_from : undefined;
      if (promotedFrom !== undefined) {
        matchEntry.promoted_from = promotedFrom;
        matchEntry.promoted_is_own = promotedFrom === _projectHash(projectRoot);
      }
    }
    // W4: tag proposed entries when include_proposed is true so callers know.
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

  // === RS v2.1.3: shadow scorer seam ===
  // Fire-and-forget. No await. Any throw inside is caught by the harness.
  // `top` is fully materialised before this call; the harness receives `scored`
  // (pre-slice, includes _score) read-only. Baseline wins architecturally:
  // the shadow call has no return value and cannot affect `top`.
  // At config defaults (shadow_scorers: []) this is a no-op after one config read.
  try {
    const { maybeRunShadowScorers } = require('../../_lib/scorer-shadow');
    maybeRunShadowScorers({
      query:        taskSummary,
      baselineScored: scored,        // Full scored[] (not sliced). Harness reads slugs + _score.
      candidates:   index,           // Same array baseline looped over.
      inputContext: {
        projectRoot,
        agentRole,
        fileGlobs,
        nowMs,
      },
      maxResults,                    // For top-K window clamping.
    });
  } catch (_e) {
    // Belt-and-braces: the harness itself fails open. This catch handles the
    // (extremely unlikely) case of the module failing to load.
  }
  // === END shadow scorer seam ===

  // R5 field projection (v2.1.11): apply `fields` parameter if provided.
  // Backward compat: omitting `fields` returns the full legacy response unchanged.
  const fieldNames = parseFields(input.fields);
  if (fieldNames !== null) {
    if (fieldNames && typeof fieldNames === 'object' && 'error' in fieldNames) {
      return toolError('pattern_find: ' + fieldNames.error);
    }
    return toolSuccess({
      matches: projectArray(top, fieldNames),
      considered,
      filtered_out: filteredOut,
    });
  }

  return toolSuccess({
    matches: top,
    considered,
    filtered_out: filteredOut,
  });
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * R-FED-PRIVACY (v2.1.13 W6): Federation-context detector.
 *
 * Returns true when the supplied index-entry (or tier string) represents a
 * cross-install federation read — i.e. a pattern loaded from the shared tier
 * directory (`~/.orchestray/shared/patterns/`) rather than the local project
 * directory. Patterns with `sharing: local-only` in frontmatter must be
 * excluded from federation-context reads regardless of any future consumer
 * that bypasses the in-scan filter.
 *
 * Local reads (tier === 'local') are not federation contexts — local-only
 * patterns are fully visible to the project that owns them.
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
// Decay helpers (W9 v2.0.18)
// ---------------------------------------------------------------------------

/**
 * Compute decayed_confidence and age_days for a pattern.
 *
 * Formula: decayed_confidence = confidence * 0.5 ^ (age_days / half_life)
 *
 * Reference timestamp precedence:
 *   1. fm.last_applied — ISO 8601 string written by §22c when a pattern is applied.
 *   2. file mtime — cheapest fallback; no history scanning required.
 *      (created_from contains an orch-id string like "orch-1744122000" whose
 *      embedded Unix timestamp could be parsed, but mtime is authoritative for
 *      file age and avoids parsing the orch-id format.)
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
  // Resolve reference timestamp (ms since epoch).
  let refMs = null;

  // Prefer last_applied ISO 8601 string from frontmatter.
  if (fm.last_applied && typeof fm.last_applied === 'string' && fm.last_applied !== 'null') {
    const parsed = Date.parse(fm.last_applied);
    if (!isNaN(parsed)) refMs = parsed;
  }

  // Fall back to file mtime.
  if (refMs === null) {
    try {
      const stat = fs.statSync(filepath);
      refMs = stat.mtimeMs;
    } catch (_) {
      // mtime unavailable — use nowMs (0 days old → no decay)
      refMs = nowMs;
    }
  }

  const ageDays = Math.max(0, Math.floor((nowMs - refMs) / 86400000));

  // Resolve half-life using fallback chain.
  let halfLife = decayConfig.default_half_life_days;
  if (
    decayConfig.category_overrides &&
    typeof decayConfig.category_overrides === 'object' &&
    category in decayConfig.category_overrides
  ) {
    const cv = decayConfig.category_overrides[category];
    if (Number.isInteger(cv) && cv >= 1) halfLife = cv;
  }
  // Per-pattern frontmatter override (highest priority).
  const perPattern = fm.decay_half_life_days;
  if (Number.isInteger(perPattern) && perPattern >= 1) halfLife = perPattern;

  const decayedConfidence = Math.round(
    confidence * Math.pow(0.5, ageDays / halfLife) * 1000
  ) / 1000;

  return { decayedConfidence, ageDays };
}

module.exports = {
  definition,
  handle,
  _isFederationContext,
};
