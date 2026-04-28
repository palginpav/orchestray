'use strict';

/**
 * tokenwright/index.js — public API surface for the tokenwright library.
 *
 * Re-exports all sub-modules as a single namespace so callers in bin/
 * can grab the whole API in one statement, then call parseSections,
 * applyMinHashDedup, emitPromptCompression, etc. as namespace methods.
 *
 * Alternatively, import individual helpers directly for smaller require() graphs
 * (inject-tokenwright.js does this to keep the hook's require() calls explicit).
 */

const { parseSections, reassembleSections } = require('./parse-sections');
const { classifySection,
        BLOCK_A_SENTINEL,
        DEFAULT_PRESERVE_HEADINGS,
        DEDUP_ELIGIBLE_HEADINGS,
        SCORE_ELIGIBLE_HEADINGS }            = require('./classify-section');
const { applyMinHashDedup,
        signature, jaccard, shingles,
        SIGNATURE_ROWS,
        DEFAULT_THRESHOLD,
        DEFAULT_K }                          = require('./dedup-minhash');
const { emitPromptCompression,
        emitTokenwrightRealizedSavings }     = require('./emit');

module.exports = {
  // parse-sections
  parseSections,
  reassembleSections,
  // classify-section
  classifySection,
  BLOCK_A_SENTINEL,
  DEFAULT_PRESERVE_HEADINGS,
  DEDUP_ELIGIBLE_HEADINGS,
  SCORE_ELIGIBLE_HEADINGS,
  // dedup-minhash
  applyMinHashDedup,
  signature,
  jaccard,
  shingles,
  SIGNATURE_ROWS,
  DEFAULT_THRESHOLD,
  DEFAULT_K,
  // emit
  emitPromptCompression,
  emitTokenwrightRealizedSavings,
};
