'use strict';

/**
 * kb-slug-detector.js — Pure bare-slug reference detector (K4 two-signal rule).
 *
 * Exports detectBareSlug(line, prevLine, listContextFlag, ignoreList) → { hit, slug?, reason? }.
 * Exports detectAllBareSlugs(line, prevLine, listContextFlag, ignoreList) → Array<{ slug }>.
 *
 * K4 rule: a bare-slug reference is flagged ONLY when BOTH signals fire:
 *
 *   Signal 1 (prefix-or-link-context) — one of:
 *     A. The prefix phrase appears WITHIN 50 CHARS of the slug on the current line
 *        (proximity requirement eliminates false positives in long table rows/list items
 *        where "linked" or "refer to" appears in unrelated prose within the same row).
 *     B. The slug appears inside a markdown link target/title (the link itself is the signal).
 *     C. The previous line is a short "See also:" header (≤ 60 chars, ends with the prefix
 *        or a colon after it) — for the two-line "See also:\n- slug" pattern.
 *
 *   Signal 2 (structural context) — one of:
 *     A. List item: line starts with `- `, `* `, `+ `, or `<digits>.` after optional whitespace.
 *     B. Table cell: line contains `|` characters (line-level check).
 *     C. Link target/title: the slug is inside `[...](...)` or `[...][...]` syntax.
 *
 * Slug shape: /^[a-z][a-z0-9-]{3,40}$/ AND must contain at least one hyphen (kebab-like).
 *
 * Ignore-list check runs last.
 *
 * No fs, no config, no network — pure string/regex logic. All inputs are injected.
 *
 * v2.1.7 — Bundle B (bare-slug refinement).
 */

// ---------------------------------------------------------------------------
// Slug shape
// ---------------------------------------------------------------------------

/**
 * Slug pattern (used inline inside _collectCandidates — NOT module-scoped with /g).
 * SEC-06: a module-scoped /g regex carries mutable .lastIndex state across calls,
 * which causes non-deterministic results when the function is called more than once
 * in the same process. The regex is created fresh per call in _collectCandidates
 * so each invocation starts with lastIndex = 0.
 *
 * Pattern: starts with lowercase letter, 4–41 chars total, kebab-case.
 * /^[a-z][a-z0-9-]{3,40}$/ → 1 + 3..40 = 4..41 chars.
 * Must also contain at least one hyphen (_isKebabLike check below).
 *
 * This constant is kept for documentation/test reference but is NOT used directly
 * with .exec() in production code.
 */
const SLUG_SHAPE_RE_SOURCE = '[a-z][a-z0-9-]{3,40}';

/** Slug must contain at least one hyphen to be considered "kebab-like". */
function _isKebabLike(s) {
  return s.includes('-');
}

// ---------------------------------------------------------------------------
// Signal 1 — prefix-or-link-context
// ---------------------------------------------------------------------------

/**
 * Prefix phrase regex. Uses negative lookbehind for `-` to avoid matching
 * `ref` in compound words like `cross-ref`, `self-ref`, `back-ref`.
 * Does NOT have the 'g' flag — safe to call .test() repeatedly.
 *
 * Note: "compare" was in the original spec but omitted here because it triggers
 * too many false positives in technical prose ("compare against baseline", etc.).
 * The prefix must be followed by `:` to be a valid signal (see _prefixNearSlug).
 */
const PREFIX_RE = /(?<!-)\b(see also|ref(?!-)|refers? to|linked|cf\.?)\b/i;

/**
 * Proximity check: returns true if the prefix phrase appears near the slug
 * on the current line AND is followed by `:` (indicating it is a label/header
 * phrase, not embedded prose).
 *
 * The colon requirement eliminates false positives from sentences like
 * "all refer to runtime-created" where the prefix is mid-sentence prose.
 *
 * The colon may be preceded/followed by optional whitespace and/or `*` markers
 * (e.g. "**See also:**") or pipe characters (table cells like "| Ref |").
 *
 * @param {string} line
 * @param {number} slugStart - Start index of the slug in the line.
 * @param {number} slugEnd   - End index (exclusive) of the slug.
 * @param {number} window    - Max character distance between prefix end and slug start.
 * @returns {boolean}
 */
function _prefixNearSlug(line, slugStart, slugEnd, window) {
  // Match prefix phrase optionally followed by optional markdown bold markers and a colon.
  // Also match the table-cell pattern: | Ref | or | ref: | where the cell content IS the prefix.
  const re = /(?<!-)\b(see also|ref(?!-)|refers? to|linked|cf\.?)\b[\s*]*:?/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    const prefixEnd = m.index + m[0].length;
    const rawMatch = m[0];

    // Only fire if:
    //   (a) The match ends with ':' (explicit label form like "See also:" or "Ref:"), OR
    //   (b) The prefix appears in a table-cell boundary context (immediately after or before '|').
    // cf. and cf already end with a dot/period — treat the trailing dot as a terminator.
    const hasColon = rawMatch.trim().endsWith(':') || /:\s*$/.test(rawMatch) ||
                     /\bcf\.?\s*$/.test(rawMatch.trim());
    const nearPipe = (m.index > 0 && line[m.index - 1] === '|') ||
                     (prefixEnd < line.length && line[prefixEnd] === '|') ||
                     (m.index > 0 && line.slice(Math.max(0, m.index - 2), m.index).includes('|')) ||
                     (prefixEnd < line.length && line.slice(prefixEnd, Math.min(line.length, prefixEnd + 2)).includes('|'));

    if (!hasColon && !nearPipe) continue;

    // Prefix before slug: gap between prefixEnd and slugStart.
    if (prefixEnd <= slugStart && (slugStart - prefixEnd) <= window) return true;
  }
  return false;
}

/**
 * Returns true if the previous line is a "See also:" style header — short,
 * dominated by a prefix phrase, and indicates a continuation slug list follows.
 *
 * Criteria:
 *   - Line length ≤ 60 chars (after trim).
 *   - Contains a prefix phrase.
 *
 * @param {string} prevLine
 * @returns {boolean}
 */
function _prevLineIsHeader(prevLine) {
  if (!prevLine) return false;
  const trimmed = prevLine.trim();
  if (trimmed.length > 40) return false;
  return PREFIX_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// Signal 2 — structural context detectors
// ---------------------------------------------------------------------------

/**
 * List item: starts with optional whitespace then `- `, `* `, `+ `, or `<digits>. `.
 */
const LIST_ITEM_RE = /^\s*([-*+]|\d+\.)\s/;

/**
 * Table cell: line contains pipe characters.
 */
function _isTableLine(line) {
  return line.includes('|');
}

/**
 * Link target/title: find all kebab-like slug-shaped words that appear inside
 * `[...](...)` or `[...][...]` link syntax (in the target/ref part, not the text part).
 * Returns a Set of { slug, start, end } for proximity/context checks.
 */
function _linkContextSlugs(line) {
  const results = [];
  // Inline links: [text](target "title") — extract from the (...) part.
  const inlineRe = /\[[^\]]*\]\(([^)]*)\)/g;
  let m;
  while ((m = inlineRe.exec(line)) !== null) {
    const innerStart = m.index + m[0].indexOf('(') + 1;
    const inner = m[1];
    const slugRe = /\b([a-z][a-z0-9-]{3,40})\b/g;
    let sm;
    while ((sm = slugRe.exec(inner)) !== null) {
      if (_isKebabLike(sm[1])) {
        results.push({ slug: sm[1], start: innerStart + sm.index, end: innerStart + sm.index + sm[1].length });
      }
    }
  }
  // Reference-style links: [text][ref] — extract from the second [ref] part.
  const refRe = /\[[^\]]*\]\[([^\]]+)\]/g;
  while ((m = refRe.exec(line)) !== null) {
    const innerStart = m.index + m[0].lastIndexOf('[') + 1;
    const inner = m[1];
    const slugRe = /\b([a-z][a-z0-9-]{3,40})\b/g;
    let sm;
    while ((sm = slugRe.exec(inner)) !== null) {
      if (_isKebabLike(sm[1])) {
        results.push({ slug: sm[1], start: innerStart + sm.index, end: innerStart + sm.index + sm[1].length });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

/**
 * Collect all slug-shaped candidates from a line with their positions.
 * Only kebab-like slugs (containing at least one hyphen) are included.
 *
 * @param {string} line
 * @returns {Array<{ slug: string, start: number, end: number }>}
 */
function _collectCandidates(line) {
  const seen = new Set();
  const result = [];
  // SEC-06: create the /g regex fresh per call so .lastIndex is always 0.
  // A module-scoped /g regex would carry state across calls and produce
  // non-deterministic results on repeated invocations with the same input.
  const re = new RegExp('\\b(' + SLUG_SHAPE_RE_SOURCE + ')\\b', 'g');
  let m;
  while ((m = re.exec(line)) !== null) {
    const candidate = m[1];
    if (_isKebabLike(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push({ slug: candidate, start: m.index, end: m.index + candidate.length });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

/**
 * Test a single candidate slug against the K4 two-signal rule.
 *
 * @param {{ slug: string, start: number, end: number }} candidate
 * @param {string} line
 * @param {string} prevLine
 * @param {boolean} isList
 * @param {boolean} isTable
 * @param {Array<{ slug: string, start: number, end: number }>} linkCtx
 * @param {string[]} ignoreList
 * @returns {{ hit: boolean, reason?: string }}
 */
function _testCandidate(candidate, line, prevLine, isList, isTable, linkCtx, ignoreList) {
  const { slug, start, end } = candidate;

  // --- Signal 1 ---
  // A: Prefix phrase within 50 chars of the slug on the CURRENT line.
  const PROXIMITY = 50;
  const signal1A = _prefixNearSlug(line, start, end, PROXIMITY);

  // B: Slug is in a link target/title context.
  const inLinkCtx = linkCtx.some((lc) => lc.slug === slug);

  // C: Previous line is a short prefix-phrase header ("See also:" etc.).
  const signal1C = _prevLineIsHeader(prevLine);

  const signal1 = signal1A || inLinkCtx || signal1C;
  if (!signal1) return { hit: false };

  // --- Signal 2 ---
  const signal2 = isList || isTable || inLinkCtx;
  if (!signal2) return { hit: false };

  // Both signals fired — check ignore list.
  if (Array.isArray(ignoreList) && ignoreList.includes(slug)) {
    return { hit: false, reason: 'ignored' };
  }

  return { hit: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect a bare-slug reference on a single line using the K4 two-signal rule.
 *
 * Returns the FIRST hit found (deterministic: left-to-right candidate order).
 *
 * @param {string} line
 * @param {string} prevLine
 * @param {boolean} listContextFlag  - Caller-provided list context hint (merged with line check).
 * @param {string[]} ignoreList
 * @returns {{ hit: boolean, slug?: string, reason?: string }}
 */
function detectBareSlug(line, prevLine, listContextFlag, ignoreList) {
  const candidates = _collectCandidates(line);
  if (candidates.length === 0) return { hit: false };

  const isList = listContextFlag || LIST_ITEM_RE.test(line);
  const isTable = _isTableLine(line);
  const linkCtx = _linkContextSlugs(line);

  for (const candidate of candidates) {
    const result = _testCandidate(candidate, line, prevLine, isList, isTable, linkCtx, ignoreList);
    if (result.hit) return { hit: true, slug: candidate.slug };
    if (result.reason === 'ignored') return { hit: false, reason: 'ignored' };
  }

  return { hit: false };
}

/**
 * Detect ALL bare-slug references on a single line.
 * Returns an array of { slug } for each flagged slug.
 *
 * @param {string} line
 * @param {string} prevLine
 * @param {boolean} listContextFlag
 * @param {string[]} ignoreList
 * @returns {Array<{ slug: string }>}
 */
function detectAllBareSlugs(line, prevLine, listContextFlag, ignoreList) {
  const candidates = _collectCandidates(line);
  if (candidates.length === 0) return [];

  const isList = listContextFlag || LIST_ITEM_RE.test(line);
  const isTable = _isTableLine(line);
  const linkCtx = _linkContextSlugs(line);

  const hits = [];
  for (const candidate of candidates) {
    const result = _testCandidate(candidate, line, prevLine, isList, isTable, linkCtx, ignoreList);
    if (result.hit) hits.push({ slug: candidate.slug });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { detectBareSlug, detectAllBareSlugs };
