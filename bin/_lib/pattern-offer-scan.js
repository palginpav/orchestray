'use strict';

/**
 * pattern-offer-scan.js — pure scanner for pattern-offer evidence
 * (design: pattern-application-evidence-design.md §4.1, §11).
 *
 * No I/O, no side effects. Called by bin/record-pattern-offers.js
 * (PreToolUse:Agent) with the spawn's prompt text.
 *
 * Detects three offer shapes, per §4.1:
 *   1. Curated citations: `@orchestray:pattern://<slug>` anywhere in the text
 *      (offer_kind: "curated"). Confidence is read from a trailing
 *      `conf 0.NN` token when the PM's citation label carries one; otherwise
 *      null. Sentiment-agnostic — a slug inside a rejection sentence or a
 *      code fence still counts as offered (offer is about presence in
 *      context, not endorsement). NOT provenance-agnostic, though: a match
 *      inside an open double-quoted span is dropped (see
 *      `isInsideQuotedSpan`) rather than classified curated. The PM routinely
 *      inlines a prior agent's free-text output into a later delegation
 *      prompt for context, and that quoted prose can itself contain a stray
 *      `@orchestray:pattern://` mention that was never a PM-authored
 *      citation — RV-2 Issue 3. This is a bounded heuristic (fixed-size
 *      backward scan), not a formal parse of the prompt's structure; it
 *      removes the common contamination shape, not every one.
 *   2. Ambient TOON catalog lines inside a <mcp-grounding> fence:
 *      `PATTERN slug=<slug> confidence=<n> ...` (offer_kind: "ambient").
 *      This is the shape pattern_find's mode:"catalog" renders
 *      (bin/mcp-server/tools/pattern_find.js `_renderToon`).
 *   3. Ambient legacy JSON `{matches|items|results|patterns: [{slug,
 *      confidence}, ...]}` inside the `## pattern_find results` section of
 *      the fence (offer_kind: "ambient"). This is the shape
 *      pattern_find's mode:"full" returns, and the one the pre-existing
 *      §0.2 bug in validate-pattern-ack.js's parser targeted exclusively.
 *      Both 2 and 3 must be supported — hard-coding one shape is exactly
 *      how §0.2 happened.
 *
 * A slug found by any shape that fails the injected `exists()` resolver is
 * dropped from `offers` and reported in `unresolved_slugs` (broken-ref
 * canary). Curated wins when the same slug appears via both a citation and
 * the ambient catalog — it is the stronger, PM-authored signal.
 */

// Slug shape matches the pattern corpus filename convention (lowercase
// alphanum + hyphen) and bin/_lib/cite-label-scanner.js's URL_RE.
const CURATED_URL_RE = /@orchestray:pattern:\/\/([a-z0-9][a-z0-9-]*)/g;
// PM citation label format: "@orchestray:pattern://slug [tier] conf 0.X, applied Nx".
const CONF_TAIL_RE = /conf\s+([0-9]*\.?[0-9]+)/;
const CONF_TAIL_WINDOW = 120;

// TOON line rendered by pattern_find's _renderToon: one per pattern, slug
// values are never quoted (the corpus slug charset has no spaces/quotes).
const TOON_LINE_RE = /PATTERN\s+slug=(\S+)\s+confidence=([0-9]*\.?[0-9]+)/g;

const GROUNDING_OPEN  = '<mcp-grounding';
const GROUNDING_CLOSE = '</mcp-grounding>';
const PATTERN_FIND_SECTION_RE =
  /##\s*pattern_find\s+results\s*\n([\s\S]*?)(?=\n##\s|\n<\/mcp-grounding>|$)/i;

// RV-2 Issue 3: bounded backward window (chars) for the quoted-span check —
// large enough to span a realistic attribution phrase ("Prior developer
// summary (for your context): \"...\""), small enough to keep the per-match
// cost O(1) even against an adversarial prompt with thousands of citations.
const QUOTE_SCAN_WINDOW = 400;

/**
 * Locate the <mcp-grounding>...</mcp-grounding> fence, if present.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractGroundingBlock(text) {
  if (typeof text !== 'string' || !text) return null;
  const start = text.indexOf(GROUNDING_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(GROUNDING_CLOSE, start);
  if (end === -1) return null;
  return text.slice(start, end + GROUNDING_CLOSE.length);
}

/**
 * True when `matchIndex` falls inside an open (unclosed) double-quoted span,
 * per a bounded backward scan — a heuristic for "this text was quoted from
 * somewhere else" (typically the PM inlining a prior agent's free-text
 * output), not a structural parse. Only looks back QUOTE_SCAN_WINDOW chars,
 * so a quote opened further back than that is invisible to this check (an
 * accepted false-negative, not a false-positive risk).
 *
 * @param {string} text
 * @param {number} matchIndex
 * @returns {boolean}
 */
function isInsideQuotedSpan(text, matchIndex) {
  const start = Math.max(0, matchIndex - QUOTE_SCAN_WINDOW);
  const window = text.slice(start, matchIndex);
  let quoteCount = 0;
  for (let i = 0; i < window.length; i++) {
    if (window[i] === '"' && window[i - 1] !== '\\') quoteCount++;
  }
  return quoteCount % 2 === 1;
}

/**
 * Scan for curated `@orchestray:pattern://<slug>` citations anywhere in the
 * text. Returns slug -> confidence|null, first non-quoted occurrence wins —
 * a match inside an open double-quoted span is skipped (RV-2 Issue 3), so a
 * later, unquoted occurrence of the same slug can still be recorded.
 *
 * @param {string} text
 * @returns {Map<string, number|null>}
 */
function scanCurated(text) {
  const found = new Map();
  const re = new RegExp(CURATED_URL_RE.source, CURATED_URL_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1];
    if (found.has(slug)) continue;
    if (isInsideQuotedSpan(text, m.index)) continue;
    const tail = text.slice(re.lastIndex, re.lastIndex + CONF_TAIL_WINDOW);
    const confMatch = tail.match(CONF_TAIL_RE);
    found.set(slug, confMatch ? Number(confMatch[1]) : null);
  }
  return found;
}

/**
 * Scan for TOON catalog lines anywhere in the grounding block. Returns
 * slug -> confidence, first occurrence wins.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
function scanToonCatalog(text) {
  const found = new Map();
  const re = new RegExp(TOON_LINE_RE.source, TOON_LINE_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1].replace(/^"|"$/g, '');
    if (!found.has(slug)) found.set(slug, Number(m[2]));
  }
  return found;
}

/**
 * Parse the `## pattern_find results` section body as JSON and extract a
 * legacy matches-shaped array (mode:"full" — {matches|items|results|patterns:
 * [{slug, confidence}]}). Returns null when the section is absent, not valid
 * JSON, or does not contain one of the known array keys (i.e. "not this
 * shape" — distinct from "this shape, zero entries").
 *
 * @param {string|null} groundingBlock
 * @returns {Map<string, number|null>|null}
 */
function scanJsonMatches(groundingBlock) {
  if (!groundingBlock) return null;
  const sectionMatch = groundingBlock.match(PATTERN_FIND_SECTION_RE);
  if (!sectionMatch) return null;
  const sectionBody = sectionMatch[1].trim();
  if (!sectionBody) return null;

  let parsed;
  try {
    parsed = JSON.parse(sectionBody);
  } catch (_e) {
    return null;
  }

  let arr = null;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object') {
    for (const key of ['matches', 'items', 'results', 'patterns']) {
      if (Array.isArray(parsed[key])) { arr = parsed[key]; break; }
    }
  }
  if (arr === null) return null;

  const found = new Map();
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const slug = typeof p.slug === 'string' ? p.slug.trim() : null;
    if (!slug || found.has(slug)) continue;
    found.set(slug, typeof p.confidence === 'number' ? p.confidence : null);
  }
  return found;
}

/**
 * Scan promptText for pattern-offer evidence.
 *
 * @param {string} promptText - tool_input.prompt (+ any additionalContext
 *   already merged into it by earlier PreToolUse:Agent hooks in the chain).
 * @param {(slug: string) => boolean} exists - slug-resolver injected by the
 *   caller (checks .orchestray/patterns/, team-patterns/, shared tier).
 * @returns {{
 *   offers: Array<{ slug: string, offer_kind: 'curated'|'ambient', confidence: number|null }>,
 *   shape_detected: 'toon_catalog'|'json_matches'|'uri_only'|'mixed'|'none',
 *   unresolved_slugs: string[]
 * }}
 */
function scanOffers(promptText, exists) {
  const resolves = typeof exists === 'function' ? exists : () => true;
  if (typeof promptText !== 'string' || !promptText) {
    return { offers: [], shape_detected: 'none', unresolved_slugs: [] };
  }

  const curated = scanCurated(promptText);

  const groundingBlock = extractGroundingBlock(promptText);
  const toon = groundingBlock ? scanToonCatalog(groundingBlock) : new Map();
  const jsonMatches = scanJsonMatches(groundingBlock);
  const ambient = new Map(toon);
  if (jsonMatches) {
    for (const [slug, conf] of jsonMatches) {
      if (!ambient.has(slug)) ambient.set(slug, conf);
    }
  }

  const ambientToonFound = toon.size > 0;
  const ambientJsonFound = jsonMatches !== null && jsonMatches.size > 0;
  let shape_detected;
  if (ambientToonFound && ambientJsonFound) shape_detected = 'mixed';
  else if (ambientToonFound) shape_detected = 'toon_catalog';
  else if (ambientJsonFound) shape_detected = 'json_matches';
  else if (curated.size > 0) shape_detected = 'uri_only';
  else shape_detected = 'none';

  // Merge: curated wins over ambient for the same slug (stronger signal).
  const merged = new Map(); // slug -> { offer_kind, confidence }
  for (const [slug, confidence] of ambient) merged.set(slug, { offer_kind: 'ambient', confidence });
  for (const [slug, confidence] of curated) merged.set(slug, { offer_kind: 'curated', confidence });

  const offers = [];
  const unresolved_slugs = [];
  const resolveCache = new Map();
  for (const [slug, { offer_kind, confidence }] of merged) {
    let ok = resolveCache.get(slug);
    if (ok === undefined) {
      try { ok = !!resolves(slug); } catch (_e) { ok = false; }
      resolveCache.set(slug, ok);
    }
    if (ok) {
      offers.push({ slug, offer_kind, confidence });
    } else {
      unresolved_slugs.push(slug);
    }
  }

  return { offers, shape_detected, unresolved_slugs };
}

// ---------------------------------------------------------------------------
// Ack-side slug resolution
// ---------------------------------------------------------------------------

// Corpus slugs are `<category>-<name>`. Mirrors schemas/pattern.schema.js
// CATEGORIES — copied rather than imported because that module pulls zod onto
// a SubagentStop hot path (caller-identity.js header: ~87 modules, ~45 ms).
// Parity guard: bin/__tests__/v2211-w2-6-pattern-ack.test.js.
const CATEGORY_PREFIXES = [
  'decomposition',
  'routing',
  'specialization',
  'anti-pattern',
  'design-preference',
  'user-correction',
  'roi',
];

/**
 * Map a slug an agent acknowledged onto one of the slugs it was offered.
 *
 * Agents drop the category prefix in practice — a live payload named
 * `verification-shares-blind-spot` for the offered
 * `anti-pattern-verification-shares-blind-spot`. Exact match wins; otherwise a
 * bare name resolves only when exactly one offered slug is that name behind a
 * known category prefix. Two candidates (e.g. `routing-x` and `roi-x` both
 * offered) is a genuine ambiguity: the raw name is returned unchanged so it
 * fails the offered-set intersection and is treated as unacknowledged, rather
 * than crediting a pattern the agent never named.
 *
 * @param {*} raw
 * @param {string[]} offeredSlugs
 * @returns {string} the canonical offered slug, or the trimmed input unchanged
 */
function resolveOfferedSlug(raw, offeredSlugs) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return name;
  const offered = Array.isArray(offeredSlugs) ? offeredSlugs : [];
  const lower = name.toLowerCase();

  for (const s of offered) {
    if (typeof s === 'string' && s.toLowerCase() === lower) return s;
  }

  const candidates = [];
  for (const s of offered) {
    if (typeof s !== 'string') continue;
    const sl = s.toLowerCase();
    if (CATEGORY_PREFIXES.some((p) => sl === p + '-' + lower)) candidates.push(s);
  }
  return candidates.length === 1 ? candidates[0] : name;
}

module.exports = {
  scanOffers,
  resolveOfferedSlug,
  CATEGORY_PREFIXES,
  // Internals exported for unit tests — not a stable contract.
  _internal: { extractGroundingBlock, scanCurated, scanToonCatalog, scanJsonMatches, isInsideQuotedSpan },
};
