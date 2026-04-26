'use strict';

/**
 * repo-map-render.js — token-budget binary search + markdown renderer.
 * Implements steps 4 + 5 of W4 §3.
 *
 *   countTokens(text)               -> number  (uses ./token-counter.js or fallback)
 *   renderTopK(rankedFiles, tagsByFile, K, totalFileCount, tokenCount?) -> string
 *   binarySearchK(rankedFiles, tagsByFile, totalFileCount, budget) -> {K, map, tokens}
 *
 * Per file we emit at most the top 8 def tags ordered by line number. Refs
 * are not rendered. The output is a self-contained markdown block prefixed
 * with `# Repo Map (top <K> of <N> files, ~<token_count> tokens)`.
 */

const path = require('path');

const MAX_DEFS_PER_FILE = 8;

let _tokenCounter = undefined; // null = unavailable, fn = available, undefined = unloaded

/**
 * Lazy-load `./token-counter.js` if it exists. On any failure (missing
 * module, throw on require, throw on invocation) we silently fall back to
 * `Math.ceil(text.length / 4)` per W4 §3 step 4.
 */
function countTokens(text) {
  if (_tokenCounter === undefined) {
    try {
      // eslint-disable-next-line global-require
      const m = require('./token-counter.js');
      // Accept either a default function export or { count }.
      if (typeof m === 'function') _tokenCounter = m;
      else if (m && typeof m.count === 'function') _tokenCounter = m.count.bind(m);
      else _tokenCounter = null;
    } catch (_e) {
      _tokenCounter = null;
    }
  }
  if (typeof _tokenCounter === 'function') {
    try {
      const n = _tokenCounter(text);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch (_e) { /* fall through */ }
  }
  return Math.ceil((text || '').length / 4);
}

function _resetTokenCounterForTests() {
  _tokenCounter = undefined;
}

/**
 * Render the top-K files. `rankedFiles` is an array of file paths in
 * descending pagerank order. Truncates to `K`. The header line shows
 * `top <K> of <totalFileCount>`.
 *
 * Pass `tokenCount` (e.g. computed by binarySearchK) to render the final
 * header. If omitted, the body is rendered with a placeholder header that
 * the caller can re-run after counting.
 */
function renderTopK(rankedFiles, tagsByFile, K, totalFileCount, tokenCount) {
  if (K <= 0 || rankedFiles.length === 0) return '';
  const slice = rankedFiles.slice(0, K);
  const body = slice.map((file) => {
    const tags = (tagsByFile.get(file) || []).filter((t) => t.kind === 'def');
    // Stable ordering — line ASC, then name ASC for determinism on ties.
    tags.sort((a, b) => (a.line - b.line) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const top = tags.slice(0, MAX_DEFS_PER_FILE);
    if (top.length === 0) {
      return '### ' + _normalizePath(file) + '\n- (no definitions captured)';
    }
    const lines = top.map((t) => '- L' + t.line + ': ' + t.kind + ' ' + t.name);
    return '### ' + _normalizePath(file) + '\n' + lines.join('\n');
  }).join('\n\n');

  const tokensStr = (tokenCount === undefined || tokenCount === null) ? '?' : String(tokenCount);
  const header = '# Repo Map (top ' + K + ' of ' + totalFileCount + ' files, ~' + tokensStr + ' tokens)';
  return header + '\n\n' + body + '\n';
}

function _normalizePath(p) {
  // Always emit forward slashes for portability.
  return String(p).split(path.sep).join('/');
}

/**
 * Binary-search the largest K such that `tokens(render(K)) <= budget`.
 * Returns { K, map, tokens }. K=0 => empty map.
 *
 * Per W4 §3.4: low=0, high=ranked.length, invariant render(low)<=budget,
 * render(high) potentially over. Step: mid; if over budget high=mid else
 * low=mid. Final K = low.
 */
function binarySearchK(rankedFiles, tagsByFile, totalFileCount, budget) {
  if (!Number.isFinite(budget) || budget <= 0 || rankedFiles.length === 0) {
    return { K: 0, map: '', tokens: 0 };
  }

  let low = 0;
  let high = rankedFiles.length;

  // Quick boundary: if rendering ALL files fits, return immediately.
  const fullMap = renderTopK(rankedFiles, tagsByFile, high, totalFileCount, 0);
  const fullTokens = countTokens(fullMap);
  if (fullTokens <= budget) {
    // Re-render with the actual token count in the header.
    const finalMap = renderTopK(rankedFiles, tagsByFile, high, totalFileCount, fullTokens);
    return { K: high, map: finalMap, tokens: countTokens(finalMap) };
  }

  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    const candidate = renderTopK(rankedFiles, tagsByFile, mid, totalFileCount, 0);
    const t = countTokens(candidate);
    if (t > budget) high = mid;
    else low = mid;
  }

  if (low === 0) return { K: 0, map: '', tokens: 0 };

  // Render with placeholder header, count, then re-render with the final
  // count so the header matches reality.
  const placeholder = renderTopK(rankedFiles, tagsByFile, low, totalFileCount, 0);
  const placeholderTokens = countTokens(placeholder);
  const finalMap = renderTopK(rankedFiles, tagsByFile, low, totalFileCount, placeholderTokens);
  return { K: low, map: finalMap, tokens: countTokens(finalMap) };
}

module.exports = {
  countTokens,
  renderTopK,
  binarySearchK,
  _resetTokenCounterForTests,
  MAX_DEFS_PER_FILE,
};
