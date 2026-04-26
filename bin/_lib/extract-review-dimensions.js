'use strict';

/**
 * extract-review-dimensions.js — R-RV-DIMS-CAPTURE prompt parser (v2.1.17).
 *
 * Pure function that parses the `## Dimensions to Apply` block from a reviewer
 * delegation prompt and returns a normalized `review_dimensions` value:
 *
 *   - `"all"`        — block present and value is the literal string "all" or
 *                      the placeholder text indicates all-dimension fallback
 *   - string[]       — sorted, deduped, allowed-enum-only subset
 *   - `null`         — no block found, or block is empty / unparseable
 *
 * Spec source: `agents/pm-reference/delegation-templates.md` §Reviewer Delegation:
 * Dimension Scoping. Block format (per the v2.1.16 R-RV-DIMS shipping template):
 *
 *     ## Dimensions to Apply
 *     {review_dimensions: "all" | bulleted list}
 *
 *     For each item in the bulleted list, Read the matching fragment file ...
 *     - code-quality   → agents/reviewer-dimensions/code-quality.md
 *     - performance    → agents/reviewer-dimensions/performance.md
 *     ...
 *
 * The static enum-list bullets that appear in the documentation block at the
 * BOTTOM of the section are NOT the chosen dimensions — they're a legend of
 * fragment-file paths. The chosen value is the line(s) immediately following
 * the heading: either the literal `all` keyword (case-insensitive), or one or
 * more bullet lines that name dimensions before the legend block begins.
 *
 * Heuristic (deterministic, no model needed):
 *
 *   1. Locate the `## Dimensions to Apply` heading.
 *   2. Read content from heading to the next `##` heading (or EOF).
 *   3. If the immediately-following non-blank line contains the bare word
 *      `all` (case-insensitive, allowing surrounding quotes / whitespace /
 *      placeholder braces), return `"all"`.
 *   4. Otherwise scan bullet lines (`- {name}` or `* {name}`) before the first
 *      arrow `→` or `->` mapping a dimension to a fragment-file path (those
 *      are the legend lines, not the chosen set). Collect the dimension names
 *      that appear in the allowed enum
 *      `["code-quality","performance","documentation","operability","api-compat"]`.
 *   5. If the collected list is non-empty, return it sorted+deduped.
 *   6. Otherwise return `null` (block was the legend-only template stamp, e.g.
 *      a kill-switch fallback that lists all five fragment paths).
 *
 * Return contract:
 *   - The output is always one of: `"all"`, `string[]` (length ≥ 1), or `null`.
 *   - String literals `"correctness"` and `"security"` are filtered out
 *     defensively (they live in core, never in the optional set).
 *
 * Safety: never throws on malformed input. Caps prompt scan at first 16 KB so
 * a giant prompt body cannot stall the SubagentStart hook (≤ 5 s budget).
 */

const ALLOWED = new Set([
  'code-quality',
  'performance',
  'documentation',
  'operability',
  'api-compat',
]);

const MAX_SCAN_BYTES = 16 * 1024; // 16 KB — well above any realistic block.

/**
 * Extract `review_dimensions` from a reviewer delegation prompt body.
 *
 * @param {string|null|undefined} prompt - The full delegation prompt text
 *   (the `prompt` field passed to `Agent()` for a reviewer spawn).
 * @returns {"all" | string[] | null}
 */
function extractReviewDimensions(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return null;
  const scan = prompt.length > MAX_SCAN_BYTES
    ? prompt.slice(0, MAX_SCAN_BYTES)
    : prompt;

  // 1. Locate the heading.
  const headingRe = /^##\s+Dimensions to Apply\s*$/m;
  const headingMatch = headingRe.exec(scan);
  if (!headingMatch) return null;

  // 2. Slice from heading to next `## ` heading or EOF.
  const blockStart = headingMatch.index + headingMatch[0].length;
  const tail       = scan.slice(blockStart);
  const nextHeadingRe = /^##\s/m;
  const nextMatch     = nextHeadingRe.exec(tail);
  const blockBody     = nextMatch ? tail.slice(0, nextMatch.index) : tail;

  // Split into lines for two-pass scanning.
  const lines = blockBody.split(/\r?\n/);

  // 3. "all" sentinel: the first non-blank, non-bullet line that mentions a
  //    bare `all` (after stripping placeholder braces / quotes / template
  //    field-name prefix). Stop scanning at the first bullet line — bullets
  //    indicate explicit subset.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    // A bullet line ends the "all"-sentinel scan.
    if (/^[-*]\s+/.test(line)) break;
    // Heuristic: strip placeholder/template noise then test for bare `all`.
    // Accepts lines like:
    //   {review_dimensions: "all" | bulleted list}   <- template stamp itself
    //   "all"
    //   review_dimensions: all
    //   all
    const stripped = line
      .replace(/^\{review_dimensions:\s*/i, '')   // template field prefix
      .replace(/^"?review_dimensions"?\s*:?\s*/i, '')
      .replace(/[}{"'`]/g, '')                    // braces, quotes, backticks
      .replace(/\|.*$/, '')                       // template OR-separator tail
      .trim();
    if (/^all$/i.test(stripped)) return 'all';
    // Non-bullet, non-"all" prose — keep scanning.
  }

  // 4. Bullet scan. Stop collecting at the first line whose bullet maps a
  //    dimension to a fragment-file path via `→` or `->` — that's the legend.
  const collected = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bulletMatch = /^[-*]\s+(.+)$/.exec(line.trim());
    if (!bulletMatch) continue;
    const inner = bulletMatch[1];
    // Legend line: contains an arrow mapping. Stop.
    if (/[→]|->/.test(inner)) break;
    // Strip surrounding backticks / quotes and pick first whitespace-delimited
    // token (the dimension name).
    const cleaned = inner.replace(/[`"']/g, '').trim().split(/\s+/)[0];
    if (!cleaned) continue;
    if (cleaned === 'correctness' || cleaned === 'security') continue;
    if (ALLOWED.has(cleaned)) collected.add(cleaned);
  }

  if (collected.size === 0) return null;

  // Stable, sorted output (same shape the classifier emits).
  return Array.from(collected).sort();
}

module.exports = { extractReviewDimensions, ALLOWED };
