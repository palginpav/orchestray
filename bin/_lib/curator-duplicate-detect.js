'use strict';

/**
 * curator-duplicate-detect.js — MinHash + Jaccard duplicate pre-filter for the
 * pattern curator. Replaces O(N²) LLM-over-full-corpus attention with an O(N+k)
 * shortlist of candidate pairs whose Jaccard similarity ≥ threshold.
 *
 * Design: v2.1.3 Bundle CI (H3), see
 *   .orchestray/kb/decisions/v213-bundle-CI-design.md §1
 *
 * Algorithm:
 *   1. Read pattern files from `.orchestray/patterns/*.md`.
 *   2. Parse frontmatter (discard it) — hash the BODY only.
 *   3. Lowercase + collapse whitespace, extract k=5-char sliding-window shingles.
 *   4. Skip patterns with < min_shingle_count (8) distinct shingles.
 *   5. Build MinHash signatures: m=128 permutations, FNV-1a 32-bit shingle hashes,
 *      deterministic hash family h_i(x) = ((a_i*x + b_i) mod P) mod 2^32.
 *   6. Pairwise Jaccard estimation: emit pairs with jaccard_hat >= 0.6.
 *   7. Write output JSON atomically, return shortlist.
 *
 * Parameters (hardcoded per design):
 *   k   = 5      (character shingle size)
 *   m   = 128    (MinHash permutation count)
 *   J   = 0.6    (Jaccard threshold, inclusive)
 *   min_shingle_count = 8
 *
 * Output file shape: see §1.6 of the design doc.
 *
 * No new npm dependencies — stdlib only.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Constants (must match the curator.md §4.2 and §1 design spec)
// ---------------------------------------------------------------------------

const K                = 5;     // shingle character length
const M                = 128;   // MinHash permutation count
// NOTE: MinHash stdev ≈ 1/√M = 1/√128 ≈ 8.8%. Pairs near threshold may be
// missed; LLM adversarial re-read (curator §4.2 step 2b) backstops. See
// design doc v213-bundle-CI-design.md §1.1.
const JACCARD_THRESHOLD = 0.6;  // inclusive lower bound for shortlist inclusion
const MIN_SHINGLE_COUNT = 8;    // minimum distinct shingles to be included

// Mersenne prime used in the multiplicative hash family.
const MERSENNE_PRIME = 2147483647; // 2^31 - 1

// ---------------------------------------------------------------------------
// Deterministic hash family seed (fixed salt for reproducibility)
//
// The (a_i, b_i) pairs are derived from a fixed seed via a simple LCG so that
// the same corpus always produces the same shortlist across runs.
// Salt value is arbitrary but MUST NOT change between versions.
// ---------------------------------------------------------------------------

const HASH_SALT = 0xdeadbeef; // fixed salt — do not change

/**
 * Generate m (a, b) pairs for the MinHash hash family.
 * Uses a simple seeded LCG to derive deterministic values.
 * All values are non-zero to avoid degenerate hash functions.
 *
 * @param {number} m - Number of permutations.
 * @returns {{ a: number, b: number }[]}
 */
function generateHashFamily(m) {
  const pairs = new Array(m);
  // LCG parameters (Numerical Recipes): multiplier 1664525, increment 1013904223.
  let state = HASH_SALT >>> 0;
  for (let i = 0; i < m; i++) {
    // Advance LCG twice per pair to ensure a and b are independent.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const a = (state | 1) >>> 0; // ensure odd (non-zero)
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const b = state >>> 0;
    pairs[i] = { a, b };
  }
  return pairs;
}

// Pre-compute the hash family once at module load (deterministic, same every run).
const HASH_FAMILY = generateHashFamily(M);

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME        = 0x01000193;

/**
 * Compute the FNV-1a 32-bit hash of a string.
 *
 * @param {string} s
 * @returns {number} Unsigned 32-bit integer.
 */
function fnv1a32(s) {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    // FNV-1a: XOR then multiply.
    h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// MinHash permutation: h_i(x) = ((a_i * x + b_i) mod P) mod 2^32
// ---------------------------------------------------------------------------

/**
 * Apply the i-th hash permutation to a 32-bit hash value x.
 *
 * Formula: ((a_i * x + b_i) mod MERSENNE_PRIME) mod 2^32
 * JavaScript's integer arithmetic requires BigInt for the multiplication to
 * avoid 32-bit overflow, BUT we keep it in 32-bit to match the design spec
 * that specifies "mod 2^32". We use 64-bit multiply via Math.imul-based
 * approach.
 *
 * Actually the design says: h_i(x) = ((a_i * x + b_i) mod P) mod 2^32
 * where P = 2^31 - 1. We implement this correctly with BigInt for safety.
 *
 * @param {number} i - Hash index (0-based).
 * @param {number} x - 32-bit input hash.
 * @returns {number} Unsigned 32-bit result.
 */
function hashPermutation(i, x) {
  const { a, b } = HASH_FAMILY[i];
  // Use BigInt for the intermediate multiplication to avoid overflow.
  const ax = BigInt(a) * BigInt(x >>> 0);
  const sum = ax + BigInt(b >>> 0);
  const modP = sum % BigInt(MERSENNE_PRIME);
  return Number(modP % BigInt(0x100000000)) >>> 0;
}

// ---------------------------------------------------------------------------
// Corpus preparation
// ---------------------------------------------------------------------------

/**
 * Normalise a pattern body for shingling.
 * Lowercase, collapse whitespace runs to single space, trim.
 *
 * @param {string} body
 * @returns {string}
 */
function normaliseBody(body) {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract the set of distinct k-character shingles from a text.
 *
 * @param {string} text - Already-normalised body.
 * @param {number} k    - Shingle length.
 * @returns {Set<string>}
 */
function shinglise(text, k) {
  const shingles = new Set();
  const limit = text.length - k + 1;
  for (let i = 0; i < limit; i++) {
    shingles.add(text.slice(i, i + k));
  }
  return shingles;
}

// ---------------------------------------------------------------------------
// MinHash signature
// ---------------------------------------------------------------------------

/**
 * Build a MinHash signature for a shingle set.
 *
 * @param {Set<string>} shingles
 * @returns {Uint32Array} Signature of length M.
 */
function buildSignature(shingles) {
  const sig = new Uint32Array(M);
  sig.fill(0xffffffff); // initialise to MAX_UINT32 (infinity for min)

  for (const shingle of shingles) {
    const x = fnv1a32(shingle);
    for (let i = 0; i < M; i++) {
      const h = hashPermutation(i, x);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Pairwise Jaccard estimation
// ---------------------------------------------------------------------------

/**
 * Estimate Jaccard similarity between two MinHash signatures.
 *
 * @param {Uint32Array} sigA
 * @param {Uint32Array} sigB
 * @returns {number} Estimated Jaccard in [0, 1].
 */
function estimateJaccard(sigA, sigB) {
  let matches = 0;
  for (let i = 0; i < M; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / M;
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

/**
 * Build the similarity shortlist for the local pattern corpus.
 *
 * Reads all `.md` files from `patternsDir`, computes MinHash signatures over
 * their bodies (frontmatter discarded), and emits pairs with Jaccard ≥ threshold.
 *
 * @param {{
 *   patternsDir: string,   // absolute path to .orchestray/patterns/
 *   outputPath:  string,   // absolute path to write the similarity JSON
 *   runId:       string,   // curator run ID (for the generated_at / filename)
 * }} opts
 * @returns {{
 *   shortlist: Array<{ a: string, b: string, jaccard: number }>,
 *   excluded:  Array<{ slug: string, reason: string }>,
 *   corpus_size: number,
 * }}
 */
function buildShortlist(opts) {
  const { patternsDir, outputPath, runId } = opts;

  // Lazy require to avoid circular deps at module load.
  const { parse: parseFrontmatter } = require('../mcp-server/lib/frontmatter.js');

  // ------------------------------------------------------------------
  // 1. Discover pattern files
  // ------------------------------------------------------------------
  let files = [];
  try {
    files = fs.readdirSync(patternsDir)
      .filter(f => f.endsWith('.md'))
      .sort(); // deterministic ordering
  } catch (err) {
    // patternsDir absent or unreadable — return empty shortlist.
    process.stderr.write(
      '[orchestray] curator-duplicate-detect: cannot read patternsDir ' +
      patternsDir + ': ' + (err && err.message) + '\n'
    );
    return { shortlist: [], excluded: [], corpus_size: 0 };
  }

  // ------------------------------------------------------------------
  // 2. Parse, normalise, shingle each pattern
  // ------------------------------------------------------------------
  const corpus = []; // { slug, sig }
  const excluded = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const filePath = path.join(patternsDir, file);

    let rawContent;
    try {
      rawContent = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(
        '[orchestray] curator-duplicate-detect: skipping unreadable file ' +
        filePath + ': ' + (err && err.message) + '\n'
      );
      continue; // exclude unreadable files — do not abort
    }

    // Discard frontmatter; hash body only.
    let body;
    try {
      const parsed = parseFrontmatter(rawContent);
      body = parsed.body || '';
    } catch (_) {
      body = rawContent; // fallback: hash the whole thing
    }

    const normalised = normaliseBody(body);
    const shingles   = shinglise(normalised, K);

    if (shingles.size < MIN_SHINGLE_COUNT) {
      excluded.push({ slug, reason: 'body_too_short' });
      continue;
    }

    const sig = buildSignature(shingles);
    corpus.push({ slug, sig });
  }

  // ------------------------------------------------------------------
  // 3. Pairwise Jaccard estimation
  // ------------------------------------------------------------------
  const shortlist = [];
  const n = corpus.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const jaccard = estimateJaccard(corpus[i].sig, corpus[j].sig);
      if (jaccard >= JACCARD_THRESHOLD) {
        shortlist.push({
          a:       corpus[i].slug,
          b:       corpus[j].slug,
          jaccard: Math.round(jaccard * 10000) / 10000, // 4 decimal places
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. Advisory for large corpora
  // ------------------------------------------------------------------
  if (n > 500) {
    process.stderr.write(
      '[orchestray] curator-duplicate-detect: corpus size ' + n +
      ' > 500 — pre-filter ran successfully but may be slow on very large sets.\n'
    );
  }

  // ------------------------------------------------------------------
  // 5. Write output JSON atomically
  // ------------------------------------------------------------------
  if (outputPath) {
    const output = {
      version:      1,
      method:       'minhash',
      k:            K,
      m:            M,
      threshold:    JACCARD_THRESHOLD,
      generated_at: new Date().toISOString(),
      corpus_size:  files.length, // total files discovered (including unreadable)
      excluded,
      shortlist,
    };

    const dir = path.dirname(outputPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}

    const tmp = outputPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(output, null, 2), 'utf8');
      fs.renameSync(tmp, outputPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      process.stderr.write(
        '[orchestray] curator-duplicate-detect: failed to write output ' +
        outputPath + ': ' + (err && err.message) + '\n'
      );
      // Non-fatal: return shortlist without writing.
    }
  }

  return { shortlist, excluded, corpus_size: files.length };
}

/**
 * Thin wrapper around buildShortlist for use by the SKILL dispatcher.
 * Propagates exceptions to the caller — wrap in try/catch and call
 * writeFallbackShortlist() on error (see SKILL.md step 3b).
 *
 * @param {object} opts - Same as buildShortlist opts.
 * @returns Same as buildShortlist.
 */
function buildShortlistForDispatch(opts) {
  return buildShortlist(opts);
}

/**
 * Write a fallback-all-pairs shortlist file.
 * Called by SKILL dispatcher when buildShortlist throws.
 *
 * @param {string} outputPath
 * @param {string} [runId]
 */
function writeFallbackShortlist(outputPath, runId) {
  const output = {
    version:      1,
    method:       'fallback-all-pairs',
    k:            K,
    m:            M,
    threshold:    JACCARD_THRESHOLD,
    generated_at: new Date().toISOString(),
    corpus_size:  0,
    excluded:     [],
    shortlist:    [],
  };

  const dir = path.dirname(outputPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  const tmp = outputPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(output, null, 2), 'utf8');
    fs.renameSync(tmp, outputPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = {
  buildShortlist,
  buildShortlistForDispatch,
  writeFallbackShortlist,
  // Exported for tests.
  _internal: {
    fnv1a32,
    hashPermutation,
    shinglise,
    normaliseBody,
    buildSignature,
    estimateJaccard,
    generateHashFamily,
    K,
    M,
    JACCARD_THRESHOLD,
    MIN_SHINGLE_COUNT,
    MERSENNE_PRIME,
  },
};
