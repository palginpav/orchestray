'use strict';

/**
 * config-defaults.js — Single-source-of-truth for tokenwright config defaults.
 *
 * Centralises all kill-switch defaults so `/orchestray:config` and runtime
 * inspection can surface them without reading inject-tokenwright.js source.
 *
 * v2.2.20 audit verdict: l1_compression_enabled stays false.
 * See .orchestray/kb/artifacts/v2220-l1-revival-design.md §Executive Verdict
 * (0/477 production prompts matched the dedup-eligible heading list; do not revive).
 */

const defaults = Object.freeze({
  tokenwright: Object.freeze({
    // Kill-switch: L1 MinHash intra-prompt dedup. Default: false (do NOT flip).
    // Audit v2.2.20 found 0/477 production prompts matched any dedup-eligible heading.
    // See .orchestray/kb/artifacts/v2220-l1-revival-design.md §Executive Verdict.
    l1_compression_enabled: false,
  }),
});

module.exports = { defaults };
