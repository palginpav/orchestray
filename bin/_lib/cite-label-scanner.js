'use strict';

/**
 * cite-label-scanner.js — detect unlabelled @orchestray:pattern:// citations.
 *
 * v2.2.9 B-7.5 (W1 F-PM-27 mechanisation). The federation pattern-citation
 * format is currently prose-only:
 *
 *   "Source transparency. When citing a retrieved pattern in a decomposition
 *    plan or orchestration summary, you MUST include its source tier in
 *    brackets. Format: @orchestray:pattern://slug [local|shared|team] conf 0.X,
 *    applied Nx ... Omitting the bracket label is a protocol violation."
 *
 * This scanner reads a text blob and returns an array of `{pattern_url,
 * surrounding_text}` matches for any `@orchestray:pattern://<slug>` that is
 * NOT immediately followed by a `[label]` token. Used by a Stop hook to emit
 * `cite_unlabelled_detected` (warn-tier).
 *
 * Public API:
 *   scan(text) -> Array<{pattern_url: string, surrounding_text: string}>
 */

// Slug shape: lowercase alphanum + hyphen.
// After the slug, allow whitespace and other punctuation — except a `[`
// (which marks a label) immediately or after a single space.
const URL_RE = /@orchestray:pattern:\/\/([a-z0-9][a-z0-9-]*)/g;
const SURROUNDING_RADIUS = 80;

function scan(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const out = [];
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const matchStart = m.index;
    const matchEnd   = matchStart + m[0].length;

    // Look ahead for an immediate `[label]` token. Allow:
    //   - direct attachment: @orchestray:pattern://slug[label]
    //   - one trailing space: @orchestray:pattern://slug [label]
    // Reject: any other delimiter (period, newline, comma, etc.) before `[`.
    const tail = text.slice(matchEnd, matchEnd + 80);
    const labelled = /^( ?)\[[^\]]+\]/.test(tail);
    if (labelled) continue;

    const ctxStart = Math.max(0, matchStart - SURROUNDING_RADIUS);
    const ctxEnd   = Math.min(text.length, matchEnd + SURROUNDING_RADIUS);
    out.push({
      pattern_url: m[0],
      surrounding_text: text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

module.exports = { scan, URL_RE };
