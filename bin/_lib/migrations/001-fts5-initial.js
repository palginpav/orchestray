'use strict';

/**
 * Migration 001 — Create FTS5 virtual table for pattern search.
 *
 * Idempotent: uses CREATE VIRTUAL TABLE IF NOT EXISTS, safe to call on every
 * process start.
 *
 * Schema:
 *   patterns_fts(
 *     slug       UNINDEXED,  -- kebab-case pattern filename without .md
 *     category   UNINDEXED,  -- frontmatter category field
 *     context,               -- ## Context section body (tokenized)
 *     approach,              -- ## Approach section body (tokenized)
 *     evidence               -- ## Evidence section body (tokenized)
 *   )
 *   tokenize='porter'        -- Porter stemmer: "auditing" matches "audit"
 *
 * UNINDEXED columns are stored and returned but NOT tokenized into the FTS
 * index — metadata retrieval without search noise.
 *
 * Future migrations should be numbered 002, 003, etc. and appended in a new
 * file. Do not modify this file after the initial release.
 */

/**
 * Run migration 001 against an open database handle.
 *
 * @param {object} db - Open database handle (node:sqlite DatabaseSync or
 *   better-sqlite3 Database). Must support `.exec(sql)` synchronously.
 */
function run(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts
    USING fts5(
      slug       UNINDEXED,
      category   UNINDEXED,
      context,
      approach,
      evidence,
      tokenize='porter'
    )
  `);
}

module.exports = { run };
