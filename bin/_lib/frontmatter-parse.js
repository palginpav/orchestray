'use strict';

/**
 * bin/_lib/frontmatter-parse.js — shared frontmatter parser for Orchestray
 * hook/CLI scripts.
 *
 * Thin re-export of the canonical parser in
 * `bin/mcp-server/lib/frontmatter.js`. All parsing semantics live there;
 * this module exists so scripts under `bin/` have a stable, short require
 * path and a null-returning API that matches the convention used by the
 * original hand-rolled parsers it replaced.
 *
 * Exported API
 * ------------
 *   parseFrontmatter(content)
 *     @param  {string} content - Raw file contents.
 *     @returns {{ frontmatter: object, body: string } | null}
 *       Returns null when content contains no valid frontmatter block
 *       (opening --- with no closing delimiter, or no --- at all).
 *       Returns { frontmatter: {}, body: content } is NOT returned for
 *       missing frontmatter — callers that need a defined result must handle
 *       the null return.
 *
 * Supported value types (delegated to mcp-server/lib/frontmatter.js):
 *   - Bare scalars: key: value
 *   - Quoted values: key: "value with: colons"
 *   - Booleans: key: true / key: false → typed boolean
 *   - Numbers: key: 42 / key: 3.14 → typed number
 *   - Null: key: null / key: ~  → null
 *   - Inline arrays: key: [a, b, c]
 *   - Comments: not applicable (flat YAML, no # comments in Orchestray files)
 *
 * NOT supported: nested objects, multi-line scalars, block sequences, anchors.
 *
 * v2.2.18 S-2 consolidation. Replaces 4 hand-rolled parsers across bin/.
 */

const { parse: _parse } = require('../mcp-server/lib/frontmatter');

/**
 * Parse YAML frontmatter from a markdown/text file's content string.
 *
 * @param {string} content - Raw file contents.
 * @returns {{ frontmatter: object, body: string } | null}
 */
function parseFrontmatter(content) {
  const result = _parse(content);
  if (!result.hasFrontmatter) return null;
  return { frontmatter: result.frontmatter, body: result.body };
}

module.exports = { parseFrontmatter };
