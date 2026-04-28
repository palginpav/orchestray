'use strict';

/**
 * dedup-minhash.js — Tokenwright Layer-1 MinHash dedup.
 *
 * Detects near-duplicate blocks WITHIN a single delegation prompt and
 * marks the second occurrence onward as `dropped`. First occurrence
 * stays. Threshold is Jaccard similarity over k-shingled tokens.
 *
 * Pure-Node, zero dependencies. Uses a custom 32-bit hash and a 64-row
 * MinHash signature; sufficient for distinguishing 1–2 KB text blocks
 * with low false-positive rate at the typical similarity threshold of
 * 0.85. Smaller signatures than 64 are too noisy for prose; larger
 * cost more CPU without changing decisions for prompts of this size.
 *
 * Algorithm:
 *   1. Tokenize each block's body into lowercase word k-shingles
 *      (k=3 by default — captures phrase repetition without being
 *      brittle to rephrasings).
 *   2. Compute 64 hash permutations of each shingle; the per-row
 *      minimum across all shingles is the signature row.
 *   3. Estimate Jaccard similarity between two signatures as the
 *      fraction of identical rows.
 *   4. If similarity >= threshold, mark the later block dropped.
 *
 * NEVER touches sections classified `preserve`. The hooked-up caller
 * (inject-tokenwright.js) feeds only `dedup-eligible` sections in.
 */

const SIGNATURE_ROWS = 64;
const DEFAULT_K = 3;
const DEFAULT_THRESHOLD = 0.85;

// 64 fixed hash seeds (precomputed pseudorandomly). Determinism:
// embedding them inline means the same input → same signature
// regardless of process state, which is what we want for testability.
const HASH_SEEDS = [
  0x9e3779b1, 0xa3b07142, 0xc2b2ae35, 0x85ebca77, 0xb692ee14, 0x27d4eb2f,
  0xd8b8a18b, 0xf6dd6f7d, 0x1f83d9ab, 0x57c61c45, 0xf4a8d10e, 0x2b3aae6e,
  0xfa9e3779, 0x6c8e9cf5, 0x71374491, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
  0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
];

if (HASH_SEEDS.length !== SIGNATURE_ROWS) {
  throw new Error('dedup-minhash internal: HASH_SEEDS must have ' + SIGNATURE_ROWS + ' entries');
}

/**
 * 32-bit non-cryptographic hash combining a seed with a string. Mirrors
 * the FNV-1a kernel with the seed mixed into the offset basis. Produces
 * a uint32. Fast enough to hash thousands of shingles without showing
 * up in latency tests.
 */
function fnv1aSeeded(seed, s) {
  let hash = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // 32-bit FNV prime: 16777619.
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Tokenize text into word k-shingles. Lowercased; collapses whitespace.
 */
function shingles(text, k) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < k) {
    // Fall back to the whole word stream as a single shingle so very
    // short blocks still produce a non-empty signature.
    return words.length === 0 ? [] : [words.join(' ')];
  }
  const out = [];
  for (let i = 0; i + k <= words.length; i++) {
    out.push(words.slice(i, i + k).join(' '));
  }
  return out;
}

/**
 * Compute the MinHash signature of a text block.
 * @returns {Uint32Array} of length SIGNATURE_ROWS; each cell is the
 *                       minimum hash for that seed across all shingles.
 *                       Empty input → all-MAX (signals "no content").
 */
function signature(text, k) {
  const sig = new Uint32Array(SIGNATURE_ROWS);
  for (let r = 0; r < SIGNATURE_ROWS; r++) sig[r] = 0xffffffff;
  const shins = shingles(text, k || DEFAULT_K);
  if (shins.length === 0) return sig;
  for (const shin of shins) {
    for (let r = 0; r < SIGNATURE_ROWS; r++) {
      const h = fnv1aSeeded(HASH_SEEDS[r], shin);
      if (h < sig[r]) sig[r] = h;
    }
  }
  return sig;
}

/**
 * Jaccard estimate from two MinHash signatures.
 * @returns {number} in [0, 1]
 */
function jaccard(sigA, sigB) {
  if (sigA.length !== sigB.length) {
    throw new Error('dedup-minhash: signature length mismatch');
  }
  let same = 0;
  // If both signatures are all-MAX (empty inputs), Jaccard is undefined;
  // return 0 (treat as "not similar" → both kept).
  let bothEmpty = true;
  for (let r = 0; r < sigA.length; r++) {
    if (sigA[r] !== 0xffffffff || sigB[r] !== 0xffffffff) bothEmpty = false;
    if (sigA[r] === sigB[r]) same++;
  }
  if (bothEmpty) return 0;
  return same / sigA.length;
}

/**
 * Mark near-duplicate sections as dropped. Operates IN-PLACE on the
 * `sections` array: each section may gain `dropped: true` and a
 * `dropped_reason` string. Original ordering is preserved.
 *
 * Only sections classified `dedup-eligible` are eligible for dropping;
 * the function takes the full classified-sections list so it can
 * compare candidates against earlier preserved sections too (a candidate
 * that duplicates a preserved section is also dropped).
 *
 * @param {Array<{kind:string, body:string, heading:(string|null), dropped?:boolean}>} sections
 * @param {{ threshold?: number, k?: number }} [opts]
 * @returns {{ dropped: number }}
 */
function applyMinHashDedup(sections, opts) {
  if (!Array.isArray(sections)) {
    throw new TypeError('applyMinHashDedup expects an array');
  }
  const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : DEFAULT_THRESHOLD;
  const k = (opts && typeof opts.k === 'number') ? opts.k : DEFAULT_K;

  // Compute signatures lazily — only for sections we may compare.
  const sigs = new Array(sections.length).fill(null);
  function sigAt(i) {
    if (sigs[i] === null) sigs[i] = signature(sections[i].body, k);
    return sigs[i];
  }

  let dropped = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.dropped) continue;
    if (s.kind !== 'dedup-eligible') continue;
    // Compare against every earlier non-dropped section.
    for (let j = 0; j < i; j++) {
      const earlier = sections[j];
      if (earlier.dropped) continue;
      const sim = jaccard(sigAt(j), sigAt(i));
      if (sim >= threshold) {
        s.dropped = true;
        s.dropped_reason = 'minhash-jaccard-' + sim.toFixed(2);
        dropped++;
        break;
      }
    }
  }
  return { dropped };
}

module.exports = {
  applyMinHashDedup,
  // exported for tests:
  signature,
  jaccard,
  shingles,
  SIGNATURE_ROWS,
  DEFAULT_THRESHOLD,
  DEFAULT_K,
};
