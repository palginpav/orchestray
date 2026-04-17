'use strict';

/**
 * `kb_search` MCP tool.
 *
 * Scans `.orchestray/kb/{facts,decisions,artifacts}/*.md` and keyword-scores
 * each file by title + first H1-section body. Bypasses `kb/index.json`
 * entirely — reads the filesystem directly so stale index entries don't
 * leak into results.
 *
 * See CHANGELOG.md §2.0.11 (Stage 2 MCP tools & resources) for design context.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { sanitizeExcerpt } = require('../lib/excerpt');
const { getSharedKbDir } = require('../lib/paths');
const { writeAuditEvent, readOrchestrationId } = require('../lib/audit');

const SECTIONS = ['artifacts', 'facts', 'decisions'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 2, maxLength: 500 },
    kb_sections: {
      type: 'array',
      items: { type: 'string', enum: SECTIONS },
    },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  },
};

const definition = deepFreeze({
  name: 'kb_search',
  description:
    'Search the knowledge base (kb/artifacts/, kb/facts/, kb/decisions/) by ' +
    'topic. Returns URIs readable via @orchestray:kb://<section>/<slug>.',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('kb_search: ' + validation.errors.join('; '));
  }

  const limit = typeof input.limit === 'number' ? input.limit : 10;
  const sectionFilter = Array.isArray(input.kb_sections) && input.kb_sections.length > 0
    ? new Set(input.kb_sections)
    : null;

  let kbDir;
  try {
    if (context && context.projectRoot) {
      kbDir = path.join(context.projectRoot, '.orchestray', 'kb');
    } else {
      kbDir = paths.getKbDir();
    }
  } catch (err) {
    return toolSuccess({ matches: [] });
  }

  if (!fs.existsSync(kbDir)) {
    return toolSuccess({ matches: [] });
  }

  const queryTokens = _tokenize(input.query);
  const sectionsToScan = sectionFilter
    ? SECTIONS.filter((s) => sectionFilter.has(s))
    : SECTIONS;

  // T3 P2: readdirSync + readFileSync per file in a tight loop. Acceptable
  // for current scale (tens to low hundreds of files). If KB grows above
  // ~500 files, add mtime-keyed in-process caching to avoid redundant I/O.

  /**
   * Scan a KB directory root and collect scored candidates.
   * Each candidate has: { slug, section, uri, excerpt, score, source }.
   *
   * @param {string} kbRoot - Absolute path to the kb root (contains facts/, decisions/, artifacts/).
   * @param {string} tier - 'local' | 'shared' — used for the source field.
   * @returns {Array}
   */
  function _scanKbDir(kbRoot, tier) {
    const results = [];
    for (const section of sectionsToScan) {
      const sectionDir = path.join(kbRoot, section);
      if (!fs.existsSync(sectionDir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(sectionDir).filter((n) => n.endsWith('.md'));
      } catch (_err) {
        continue;
      }
      for (const name of entries) {
        const slug = name.slice(0, -3);
        const filepath = path.join(sectionDir, name);
        let content;
        try {
          content = fs.readFileSync(filepath, 'utf8');
        } catch (_err) {
          continue;
        }
        const title = _extractH1(content) || slug;
        const bodyExcerpt = _firstSectionBody(content);
        const haystack = (title + ' ' + bodyExcerpt).toLowerCase();
        const hayTokens = _tokenize(haystack);
        const score = _score(queryTokens, hayTokens, title, input.query);
        if (score <= 0) continue;
        // T3 S1: sanitize excerpt — strip markdown special sequences and cap at
        // 80 chars to limit prompt-injection attack surface in tool output.
        const excerpt = sanitizeExcerpt(bodyExcerpt);
        results.push({
          slug,
          section,
          uri: 'orchestray:kb://' + section + '/' + slug,
          excerpt,
          score,
          source: tier,
        });
      }
    }
    return results;
  }

  // Local tier scan.
  const localCandidates = _scanKbDir(kbDir, 'local');

  // ---------------------------------------------------------------------------
  // Two-tier lookup (B5)
  //
  // If federation is enabled (getSharedKbDir() returns non-null), scan the
  // shared KB directory and merge with local results. Local wins on collision.
  // Collision key: section + '/' + slug (matches the KB doc identifier used by
  // the existing tool — same as the uri path segment after orchestray:kb://).
  // ---------------------------------------------------------------------------

  let candidates = localCandidates;
  const sharedKbDir = getSharedKbDir();

  if (sharedKbDir !== null && fs.existsSync(sharedKbDir)) {
    const sharedCandidates = _scanKbDir(sharedKbDir, 'shared');

    // Build a Set of local collision keys for O(1) lookup.
    const localKeys = new Set(localCandidates.map((c) => c.section + '/' + c.slug));
    const collidingKeys = [];

    for (const sharedItem of sharedCandidates) {
      const key = sharedItem.section + '/' + sharedItem.slug;
      if (localKeys.has(key)) {
        collidingKeys.push(sharedItem.slug);
        // Local entry already present — discard shared copy.
      } else {
        candidates = candidates.concat([sharedItem]);
      }
    }

    // Emit one pattern_collision_resolved event per colliding entry.
    // Fail-open: audit failures must never block the lookup result.
    for (const slug of collidingKeys) {
      try {
        writeAuditEvent({
          timestamp: new Date().toISOString(),
          type: 'pattern_collision_resolved',
          orchestration_id: readOrchestrationId(),
          slug,
          winning_tier: 'local',
          losing_tier: 'shared',
          context: 'kb_search',
        });
      } catch (_err) {
        // Non-fatal.
      }
    }
  }
  // End Two-tier lookup (B5)

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.section < b.section) return -1;
    if (a.section > b.section) return 1;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  return toolSuccess({ matches: candidates.slice(0, limit) });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _extractH1(content) {
  if (typeof content !== 'string') return null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

function _firstSectionBody(content) {
  if (typeof content !== 'string') return '';
  const lines = content.split(/\r?\n/);
  let inFirst = false;
  const body = [];
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      if (inFirst) break;
      inFirst = true;
      continue;
    }
    if (inFirst) body.push(line);
  }
  return body.join('\n');
}

function _tokenize(text) {
  if (typeof text !== 'string') return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
  );
}

function _score(queryTokens, hayTokens, title, rawQuery) {
  let overlap = 0;
  for (const tok of queryTokens) {
    if (hayTokens.has(tok)) overlap++;
  }
  if (overlap === 0 && queryTokens.size === 0) return 0;
  if (overlap === 0) return 0;
  // Base score: fraction of query tokens that matched.
  let score = overlap / Math.max(1, queryTokens.size);
  // Title bonus: per-token match frequency in the title string (case-fold).
  const titleLower = (title || '').toLowerCase();
  const qLower = (rawQuery || '').toLowerCase();
  if (qLower.length > 0 && titleLower.includes(qLower)) score += 0.5;
  // Keyword frequency bonus: count total matches in the title to reward
  // repetition-heavy titles (matches the "high-hit" vs "low-hit" test).
  let titleMatches = 0;
  for (const tok of queryTokens) {
    // The boundary classes `(^|[^a-z0-9])` and `([^a-z0-9]|$)` use alternation
    // with anchors, which can backtrack on certain inputs. This is safe for the
    // current use-case because (a) query tokens are bounded by the 500-char
    // _validate query cap, and (b) titles are bounded by ~200 chars. If either
    // bound is ever relaxed, rewrite this as a word-boundary split instead of
    // a per-token regex to eliminate ReDoS backtracking risk. Advisory per
    // T14 audit.
    const re = new RegExp('(^|[^a-z0-9])' + _escapeRegex(tok) + '([^a-z0-9]|$)', 'g');
    const ms = titleLower.match(re);
    if (ms) titleMatches += ms.length;
  }
  score += 0.1 * titleMatches;
  return score;
}

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}



module.exports = {
  definition,
  handle,
};
