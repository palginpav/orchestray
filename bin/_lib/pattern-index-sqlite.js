'use strict';

/**
 * FTS5 index backend for `pattern_find`.
 *
 * Runtime branch:
 *   prefers node:sqlite (Node 22.5+) → falls back to better-sqlite3 →
 *   falls back to UNAVAILABLE sentinel for Jaccard fallback in pattern_find.js.
 *
 * Index location: <projectRoot>/.orchestray/patterns.db (gitignored).
 *
 * Change detection: compares max mtime of .orchestray/patterns/*.md against
 * patterns.db mtime. Rebuilds automatically if any pattern file is newer.
 *
 * Scoring: BM25 from FTS5 (lower = better match), then multiplied by existing
 * confidence × decayed_confidence factors preserved from pattern_find.js.
 *
 * No IndexBackend abstraction — see adversarial review W6 F08. Future backends
 * can plug in here with a one-file swap; no interface layer is warranted at
 * current scale.
 */

const fs = require('node:fs');
const path = require('node:path');

const frontmatter = require('../mcp-server/lib/frontmatter');
const migration001 = require('./migrations/001-fts5-initial');
const { recordDegradation } = require('./degraded-journal');

// ---------------------------------------------------------------------------
// SQLite backend detection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DbBackend
 * @property {function(string): object} prepare - Prepare a statement.
 * @property {function(string): void}   exec    - Execute raw SQL.
 * @property {function(): void}        [close]  - Optional close method.
 */

/**
 * UNAVAILABLE sentinel. Exported so pattern_find.js can detect a failed load
 * and fall back to Jaccard scoring.
 *
 * @type {symbol}
 */
const UNAVAILABLE = Symbol('FTS5_BACKEND_UNAVAILABLE');

/**
 * Try to open a SQLite database at the given path using whichever runtime is
 * available. Returns a db handle or throws if neither runtime loads.
 *
 * @param {string} dbPath
 * @returns {object} db handle
 */
function _openDb(dbPath) {
  // Prefer node:sqlite (Node 22.5+, zero additional deps).
  try {
    const { DatabaseSync } = require('node:sqlite');
    // node:sqlite opens in WAL mode by default in newer Node versions; fine
    // for single-writer single-reader usage here.
    return new DatabaseSync(dbPath);
  } catch (_) {
    // Not available (Node < 22.5 or experimental flag not set).
  }

  // Fall back to better-sqlite3 (native addon, requires build tools).
  try {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(dbPath);
  } catch (_) {
    // Native build failed or package not installed.
  }

  recordDegradation({
    kind: 'fts5_backend_unavailable',
    severity: 'warn',
    detail: {
      reason: 'neither node:sqlite nor better-sqlite3 loaded',
      node_version: process.versions.node,
      dedup_key: 'fts5_backend_unavailable',
    },
  });
  throw new Error('No SQLite runtime available');
}

// ---------------------------------------------------------------------------
// Section extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of a named `## Section` from a Markdown body.
 * Returns empty string if the section is absent.
 *
 * @param {string} body  - Raw body text (post-frontmatter).
 * @param {string} name  - Section name to look for (case-insensitive).
 * @returns {string}
 */
function _extractSection(body, name) {
  if (typeof body !== 'string') return '';
  // Use multiline mode so ^ anchors match line starts.
  // Lookahead (?=^## |\Z) terminates at H2-or-above headers only (not H3+).
  // Without the ^ anchor, `(?=##)` matched `##` inside `### Subsection`,
  // silently dropping all content below any H3 (F05).
  const re = new RegExp(
    '^##\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)',
    'im'
  );
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------------------
// Index state — one open db handle per (projectRoot, process lifetime).
// Keyed by dbPath so tests with different tmp dirs don't share state.
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const _dbCache = new Map();

/**
 * Get or open the db for dbPath. Returns a db handle.
 * Throws if neither SQLite runtime is available.
 */
function _getDb(dbPath) {
  if (_dbCache.has(dbPath)) return _dbCache.get(dbPath);
  const db = _openDb(dbPath);
  migration001.run(db);
  _dbCache.set(dbPath, db);
  return db;
}

// ---------------------------------------------------------------------------
// Build / rebuild index
// ---------------------------------------------------------------------------

/**
 * Resolve the maximum mtime (ms) across all .md files in patternsDir.
 * Returns 0 if the directory is empty or absent.
 *
 * @param {string} patternsDir
 * @returns {number}
 */
function _maxPatternMtime(patternsDir) {
  let maxMs = 0;
  let entries;
  try {
    entries = fs.readdirSync(patternsDir);
  } catch (_) {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    try {
      const stat = fs.statSync(path.join(patternsDir, name));
      if (stat.mtimeMs > maxMs) maxMs = stat.mtimeMs;
    } catch (_) {
      // Skip unreadable files.
    }
  }
  return maxMs;
}

/**
 * Return the mtime (ms) of the db file, or 0 if it does not exist.
 *
 * @param {string} dbPath
 * @returns {number}
 */
function _dbMtime(dbPath) {
  try {
    return fs.statSync(dbPath).mtimeMs;
  } catch (_) {
    return 0;
  }
}

/**
 * Count the number of .md files in patternsDir.
 * Returns 0 if the directory is absent or empty.
 *
 * @param {string} patternsDir
 * @returns {number}
 */
function _patternFileCount(patternsDir) {
  try {
    const entries = fs.readdirSync(patternsDir);
    return entries.filter((n) => n.endsWith('.md')).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Count the number of distinct slugs currently in the FTS5 index.
 * Returns 0 if the table does not exist or is empty.
 *
 * @param {object} db
 * @returns {number}
 */
function _indexedSlugCount(db) {
  try {
    const rows = db.prepare('SELECT COUNT(DISTINCT slug) AS n FROM patterns_fts').all();
    return (rows && rows[0] && typeof rows[0].n === 'number') ? rows[0].n : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Populate (or repopulate) the FTS5 index from the pattern files in
 * patternsDir. Clears all existing rows first (DELETE FROM patterns_fts) so
 * the rebuild is idempotent.
 *
 * @param {object} db          - Open db handle.
 * @param {string} patternsDir - Absolute path to .orchestray/patterns/.
 */
function _buildIndex(db, patternsDir) {
  // Clear existing rows.
  db.exec('DELETE FROM patterns_fts');

  let entries;
  try {
    entries = fs.readdirSync(patternsDir);
  } catch (_) {
    return; // No patterns dir — leave index empty.
  }

  // Prepare insert once; reuse for every pattern.
  const insert = db.prepare(
    'INSERT INTO patterns_fts(slug, category, context, approach, evidence) ' +
    'VALUES (?, ?, ?, ?, ?)'
  );

  for (const name of entries.filter((n) => n.endsWith('.md')).sort()) {
    const filepath = path.join(patternsDir, name);

    // W4 (v2.1.6 F-05): guard — never index files under proposed-patterns/.
    // _buildIndex is called with the active patterns dir, but belt-and-suspenders:
    // reject any filepath that contains the proposed-patterns segment.
    if (filepath.replace(/\\/g, '/').includes('/.orchestray/proposed-patterns/')) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (_) {
      continue;
    }
    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) continue;

    // Secondary guard: skip files with proposed: true (defense-in-depth).
    if (parsed.frontmatter.proposed === true) continue;

    const slug = name.slice(0, -3);
    const fm = parsed.frontmatter;
    const category = (typeof fm.category === 'string' && fm.category) ||
                     (typeof fm.type === 'string' && fm.type) || '';
    const body = parsed.body || '';

    // Index description + first 200 chars as the "context" column when no
    // explicit ## Context section exists.
    const description = typeof fm.description === 'string' ? fm.description : '';
    const contextText = _extractSection(body, 'Context') || (description + ' ' + body.slice(0, 200));
    const approachText = _extractSection(body, 'Approach');
    const evidenceText = _extractSection(body, 'Evidence');

    insert.run(slug, category, contextText, approachText, evidenceText);
  }
}

// ---------------------------------------------------------------------------
// Per-term match extraction (Idea 4 — v2.1.2)
// ---------------------------------------------------------------------------

/**
 * Unique sentinel strings used as highlight markers. Chosen to be highly
 * unlikely to appear in real pattern text, and safe for string splitting.
 */
const _HL_START = '\x02MATCH\x02';
const _HL_END   = '\x03MATCH\x03';

/**
 * Extract per-term, per-section hit information for a set of matched slugs
 * using FTS5's `highlight()` function.
 *
 * Returns a Map<slug, TermHit[]>. Each TermHit describes one (term, section)
 * pair where the query matched. Duplicate (term, section) pairs are de-duped.
 *
 * Falls back to an empty Map on any error so callers can always proceed.
 *
 * Design notes:
 *   - We run a single SELECT that returns highlight() for the three content
 *     columns (context=col 2, approach=col 3, evidence=col 4) for all matched
 *     slugs at once (filtered by `slug IN (...)` inside a MATCH query).
 *   - The highlighted text has matched tokens wrapped in _HL_START / _HL_END.
 *     We split on those markers to collect the matched tokens per column.
 *   - Column indices for highlight() are 0-based over ALL columns including
 *     UNINDEXED ones: slug=0, category=1, context=2, approach=3, evidence=4.
 *     UNINDEXED columns are passed through unchanged (highlight is a no-op).
 *
 * @param {object}   db        - Open database handle.
 * @param {string}   safeQuery - Already-sanitized FTS5 query string.
 * @param {string[]} slugs     - Slugs to retrieve hit data for.
 * @returns {Map<string, TermHit[]>}
 */
function _extractMatchTerms(db, safeQuery, slugs) {
  const result = new Map();
  if (!slugs || slugs.length === 0) return result;

  try {
    // Build a query that returns highlight() for each content column.
    // We filter to only the slugs we care about by re-issuing the same MATCH
    // (FTS5 can't filter on UNINDEXED slug directly in a WHERE clause without
    // a rowid scan; using a subquery would also work but this is simpler and
    // the result set is already small).
    const stmt = db.prepare(
      'SELECT slug, ' +
      'highlight(patterns_fts, 2, ?, ?) AS hl_context, ' +
      'highlight(patterns_fts, 3, ?, ?) AS hl_approach, ' +
      'highlight(patterns_fts, 4, ?, ?) AS hl_evidence ' +
      'FROM patterns_fts WHERE patterns_fts MATCH ?'
    );

    const rows = stmt.all(
      _HL_START, _HL_END,
      _HL_START, _HL_END,
      _HL_START, _HL_END,
      safeQuery
    );

    const slugSet = new Set(slugs);
    for (const row of rows) {
      if (!slugSet.has(row.slug)) continue;

      const hits = [];
      const seenKey = new Set(); // de-dupe (term, section) pairs

      for (const [colText, section] of [
        [row.hl_context,  'context'],
        [row.hl_approach, 'approach'],
        [row.hl_evidence, 'evidence'],
      ]) {
        if (typeof colText !== 'string') continue;
        // Split on markers; every odd segment (1, 3, 5, …) is a highlighted token.
        const parts = colText.split(_HL_START);
        for (let i = 1; i < parts.length; i++) {
          const endIdx = parts[i].indexOf(_HL_END);
          if (endIdx === -1) continue;
          const token = parts[i].slice(0, endIdx).toLowerCase().trim();
          if (!token) continue;
          const key = token + '|' + section;
          if (!seenKey.has(key)) {
            seenKey.add(key);
            hits.push({ term: token, section });
          }
        }
      }

      result.set(row.slug, hits);
    }
  } catch (_) {
    // highlight() may behave differently on very old SQLite builds.
    // Fail-open: return empty map; callers fall back gracefully.
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A per-term, per-section hit produced by _extractMatchTerms.
 *
 * @typedef {object} TermHit
 * @property {string} term    - The matched query term (lowercased).
 * @property {string} section - Section where the term matched: 'context', 'approach', or 'evidence'.
 */

/**
 * Result shape returned by searchPatterns.
 *
 * @typedef {object} PatternMatch
 * @property {string}    slug        - Pattern slug (filename without .md).
 * @property {string}    category    - Pattern category from frontmatter.
 * @property {number}    bm25_score  - Raw BM25 score (lower = better match).
 * @property {object}    frontmatter - Parsed frontmatter fields.
 * @property {string}    body        - Pattern body text.
 * @property {string}    filepath    - Absolute path to the .md file.
 * @property {TermHit[]} match_terms - Per-term/per-section hit details (may be empty on error).
 */

/**
 * Search patterns using FTS5 BM25 scoring.
 *
 * Returns an array of PatternMatch objects sorted by BM25 score ascending
 * (best match first). If the index is stale it is rebuilt before querying.
 *
 * @param {string} query          - Free-form query string.
 * @param {object} [opts]
 * @param {string} opts.projectRoot      - Project root directory (required).
 * @param {number} [opts.limit]          - Max results (default: 20).
 * @param {boolean} [opts.includeDeprecated] - Include deprecated patterns (default: false).
 * @returns {PatternMatch[]}
 */
function searchPatterns(query, opts) {
  const projectRoot = (opts && opts.projectRoot) || process.cwd();
  const limit = (opts && typeof opts.limit === 'number' && opts.limit > 0) ? opts.limit : 20;
  const includeDeprecated = !!(opts && opts.includeDeprecated);

  const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
  const dbPath = path.join(projectRoot, '.orchestray', 'patterns.db');

  // Check mtime BEFORE opening/creating the db file.
  // If we check after _getDb, the new empty db file has a fresh mtime that
  // appears newer than the pattern files, causing the rebuild to be skipped.
  const patternMtime = _maxPatternMtime(patternsDir);
  const dbExistedBefore = fs.existsSync(dbPath);
  const dbMtimeBefore = dbExistedBefore ? _dbMtime(dbPath) : 0;

  const db = _getDb(dbPath);

  // Rebuild if:
  //  (a) db did not exist before this call (fresh install), OR
  //  (b) any pattern file is newer than the pre-existing db, OR
  //  (c) file count < indexed slug count (a pattern was deleted — F06).
  //      Max-mtime does not change on deletion, so mtime alone misses this.
  const fileCount = _patternFileCount(patternsDir);
  const indexedCount = dbExistedBefore ? _indexedSlugCount(db) : 0;
  const needsRebuild = !dbExistedBefore || patternMtime > dbMtimeBefore || fileCount < indexedCount;
  if (needsRebuild) {
    _buildIndex(db, patternsDir);
  } else {
    // Verify the index is non-empty as a sanity check for corruption recovery.
    try {
      const row = db.prepare('SELECT count(*) AS n FROM patterns_fts').all();
      const count = (row && row[0] && typeof row[0].n === 'number') ? row[0].n : 0;
      if (count === 0) {
        _buildIndex(db, patternsDir);
      }
    } catch (_) {
      // Table may not exist (extremely unlikely after migration); rebuild.
      _buildIndex(db, patternsDir);
    }
  }

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return [];
  }

  // FTS5 query: sanitize to prevent injection and reserved-word false zeros.
  //
  // Step 1: Strip characters that cannot appear inside a double-quoted FTS5 token.
  //   - Null bytes and double-quotes need special handling; everything else is safe.
  // Step 2: Split on whitespace and double-quote each token.
  //   Rationale: FTS5 treats AND/OR/NOT/NEAR as reserved operators when unquoted.
  //   A task summary like "parallel AND disjoint" or "find NEAR match" would either
  //   silently change query semantics (AND/OR/NOT) or trigger a syntax error
  //   (bareword NEAR), causing the catch-block to return [] and zeroing all local
  //   FTS5 scores (F03). Wrapping each token in double-quotes forces FTS5 to treat
  //   them as literal strings. Embedded double-quotes are escaped by doubling ("").
  const rawTokens = query.replace(/\x00/g, ' ').split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return [];
  const safeQuery = rawTokens
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
    .join(' ');
  if (!safeQuery) return [];

  // BM25(patterns_fts) returns negative scores; more negative = better match.
  // We order ASC (most negative first = best match).
  // Note: LIMIT is inlined (not a bound param) because node:sqlite and
  // better-sqlite3 handle extra positional params for LIMIT differently;
  // inlining avoids the discrepancy.
  const limitSafe = Math.trunc(Math.max(1, Math.min(limit, 200)));
  const stmt = db.prepare(
    'SELECT slug, category, bm25(patterns_fts) AS bm25_score ' +
    'FROM patterns_fts ' +
    'WHERE patterns_fts MATCH ? ' +
    'ORDER BY bm25(patterns_fts) ASC ' +
    'LIMIT ' + limitSafe
  );

  let rows;
  try {
    rows = stmt.all(safeQuery);
  } catch (_) {
    // Query syntax error (e.g., empty after sanitization) — return empty.
    return [];
  }

  // Extract per-term, per-section match information using highlight().
  // Do this before hydrating from disk so we have a single extra round-trip
  // against the FTS index (already in memory) rather than per-file I/O.
  const slugList = rows.map((r) => r.slug);
  const matchTermsBySlug = _extractMatchTerms(db, safeQuery, slugList);

  // Hydrate each row with frontmatter + body from disk.
  const results = [];
  for (const row of rows) {
    const filepath = path.join(patternsDir, row.slug + '.md');
    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (_) {
      continue;
    }
    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) continue;

    const fm = parsed.frontmatter;

    // Apply deprecated filter (mirrors pattern_find.js D1 logic).
    if (!includeDeprecated && (fm.deprecated === true || fm.deprecated === 'true')) {
      continue;
    }

    results.push({
      slug: row.slug,
      category: row.category || '',
      bm25_score: row.bm25_score,
      frontmatter: fm,
      body: parsed.body || '',
      filepath,
      match_terms: matchTermsBySlug.get(row.slug) || [],
    });
  }

  return results;
}

module.exports = { searchPatterns, UNAVAILABLE };

// ---------------------------------------------------------------------------
// Smoke test (run directly: node bin/_lib/pattern-index-sqlite.js)
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..', '..');

  console.log('Building FTS5 index from', path.join(projectRoot, '.orchestray', 'patterns'));

  // Force rebuild by removing cached db handle if any.
  const dbPath = path.join(projectRoot, '.orchestray', 'patterns.db');
  _dbCache.delete(dbPath);
  // Force rebuild by making patternMtime > 0, dbMtime = 0 via cache flush.

  function runQuery(label, queryStr, expectedTopSlug) {
    const results = searchPatterns(queryStr, { projectRoot, limit: 5 });
    console.log('\nQuery:', label, '->', JSON.stringify(queryStr));
    if (results.length === 0) {
      console.log('  (no results)');
      return;
    }
    results.forEach((r, i) => {
      const marker = r.slug === expectedTopSlug ? ' <-- EXPECTED' : '';
      console.log(`  ${i + 1}. ${r.slug} (bm25=${r.bm25_score.toFixed(3)})${marker}`);
    });
    const topSlug = results[0] && results[0].slug;
    const inTop3 = results.slice(0, 3).some((r) => r.slug === expectedTopSlug);
    if (expectedTopSlug && inTop3) {
      console.log('  PASS: "' + expectedTopSlug + '" in top 3');
    } else if (expectedTopSlug) {
      console.log('  WARN: "' + expectedTopSlug + '" not in top 3 (top=' + topSlug + ')');
    }
  }

  runQuery(
    'audit fix verify',
    'audit fix verify',
    'decomposition-audit-fix-verify-triad-disjoint-scopes' // expected in top 3
  );

  runQuery(
    'parallel reviewer scope',
    'parallel reviewer scope',
    'decomposition-readonly-writer-parallel-slotting' // expect top result
  );

  runQuery(
    'decomposition parallel agents',
    'decomposition parallel agents tasks',
    null // show top 5; any decomposition pattern is expected
  );

  console.log('\nSmoke test complete.');
}
