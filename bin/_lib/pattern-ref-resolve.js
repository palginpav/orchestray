'use strict';

/**
 * pattern-ref-resolve.js — resolve a user-supplied pattern reference (the
 * `[pattern-name]` argument to `/orchestray:patterns`) against a loaded
 * pattern set, by slug OR `name:` frontmatter.
 *
 * A pattern has two identifiers (see
 * .orchestray/kb/decisions/pattern-ack-slug-fidelity-limit.md): the slug
 * (filename stem — what pattern_find, the offer ledger, and credit key on)
 * and the frontmatter `name:` (what the document calls itself, and the only
 * identity visible to a human or agent reading the file body). Both are
 * valid ways to refer to a pattern from the CLI. This resolver is NOT
 * bounded to an "offered" set like the ack-side resolveOfferedSlug
 * (bin/_lib/pattern-offer-scan.js) — it searches the whole loaded corpus —
 * and it reports ambiguity instead of silently picking a winner, because two
 * patterns in different categories can legitimately share a bare name (e.g.
 * `routing-shadow-ship` and `roi-shadow-ship` both named `shadow-ship`).
 */

/**
 * A pattern's bare name: the explicit `name` field if present, else derived
 * from `slug` + `category` per the corpus parity invariant (slug === category
 * + '-' + name — see tests/schemas/pattern-slug-name-parity.test.js). The
 * derivation means callers passing pattern_find's match shape (`slug` +
 * `category`, no `name`) don't need an extra frontmatter read.
 *
 * @param {object} p
 * @returns {string|null}
 */
function bareName(p) {
  if (typeof p.name === 'string' && p.name) return p.name;
  if (typeof p.slug === 'string' && typeof p.category === 'string' && p.slug.startsWith(p.category + '-')) {
    return p.slug.slice(p.category.length + 1);
  }
  return null;
}

/**
 * @param {*} ref - user-supplied reference (slug or name), any case
 * @param {Array<{slug: string, name?: string, category?: string}>} patterns - loaded pattern set
 * @returns {
 *   { status: 'found', pattern: object } |
 *   { status: 'not_found' } |
 *   { status: 'ambiguous', matches: object[] }
 * }
 */
function resolvePatternRef(ref, patterns) {
  const needle = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
  if (!needle || !Array.isArray(patterns)) return { status: 'not_found' };

  // Exact slug match wins outright — slug is the canonical, collision-free key.
  const slugHit = patterns.find((p) => p && typeof p.slug === 'string' && p.slug.toLowerCase() === needle);
  if (slugHit) return { status: 'found', pattern: slugHit };

  // Otherwise resolve by bare name. Two+ patterns sharing a name (across
  // categories) is a genuine ambiguity — report it rather than guess.
  const nameHits = patterns.filter((p) => {
    if (!p) return false;
    const n = bareName(p);
    return n !== null && n.toLowerCase() === needle;
  });
  if (nameHits.length === 1) return { status: 'found', pattern: nameHits[0] };
  if (nameHits.length > 1) return { status: 'ambiguous', matches: nameHits };
  return { status: 'not_found' };
}

module.exports = { resolvePatternRef };
