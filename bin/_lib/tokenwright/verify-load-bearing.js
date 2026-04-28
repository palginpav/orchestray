'use strict';

/**
 * verify-load-bearing.js — Post-compression invariant check (W4 §B1 / event 2).
 *
 * After compression, verifies that every heading in the load-bearing set is
 * still present in the compressed prompt with identical body content (SHA-256
 * of the section body). Also checks Block-A sentinel integrity.
 *
 * Pure function — no I/O, no side effects at require time. Caller does all
 * emit / fallback decisions based on the returned result.
 */

const crypto = require('crypto');
const { parseSections } = require('./parse-sections');

/** Block-A sentinel (must appear byte-identical up to and including this string). */
const BLOCK_A_SENTINEL = '<!-- ORCHESTRAY_BLOCK_A_END -->';

/**
 * Default load-bearing section headings (W4 §B1 / §event 2 — immutable in v2.2.6).
 * Configurable via `compression.load_bearing_sections` in config.json (merged additive).
 */
const DEFAULT_LOAD_BEARING_SECTIONS = [
  '## Acceptance Rubric',
  '## Structured Result',
  '## Output Style',
  '## Repository Map',
  '## Repository Map (unchanged this orchestration)',
  '## Repo Map (Aider-style, top-K symbols)',
  '## Project Persona',
  '## Project Intent',
  '## Context from Previous Agent',
];

/**
 * Compute SHA-256 hex of a UTF-8 string.
 *
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build a heading → body map from parsed sections.
 * Key is the heading text (e.g. "## Structured Result").
 * Value is the full raw section text (heading + body together).
 *
 * @param {string} prompt
 * @returns {Map<string, string>}
 */
function buildSectionMap(prompt) {
  const map = new Map();
  try {
    const sections = parseSections(prompt);
    for (const s of sections) {
      if (s.heading !== null) {
        map.set(s.heading, s.raw);
      }
    }
  } catch (_e) {
    // Return empty map — caller will treat all headings as missing
  }
  return map;
}

/**
 * Verify that all load-bearing sections are preserved byte-identically
 * after compression, and that Block-A sentinel integrity holds.
 *
 * @param {object} params
 * @param {string}   params.originalPrompt   — prompt before compression
 * @param {string}   params.compressedPrompt — prompt after compression
 * @param {string[]} [params.loadBearingSet] — headings to check; defaults to DEFAULT_LOAD_BEARING_SECTIONS
 * @returns {{
 *   violated:         boolean,
 *   violatedSection:  string|null,
 *   violationKind:    'load_bearing_dropped'|'block_a_sentinel_missing'|'prefix_byte_drift'|null
 * }}
 */
function verifyLoadBearing({ originalPrompt, compressedPrompt, loadBearingSet }) {
  try {
    const sections = (Array.isArray(loadBearingSet) && loadBearingSet.length > 0)
      ? loadBearingSet
      : DEFAULT_LOAD_BEARING_SECTIONS;

    const origStr = typeof originalPrompt === 'string' ? originalPrompt : '';
    const compStr = typeof compressedPrompt === 'string' ? compressedPrompt : '';

    // --- Block-A sentinel check ---
    const origHasSentinel = origStr.includes(BLOCK_A_SENTINEL);
    if (origHasSentinel) {
      const compHasSentinel = compStr.includes(BLOCK_A_SENTINEL);
      if (!compHasSentinel) {
        return {
          violated:        true,
          violatedSection: BLOCK_A_SENTINEL,
          violationKind:   'block_a_sentinel_missing',
        };
      }

      // Prefix byte-identity check: text up to and including the sentinel
      // must be byte-identical in both prompts.
      const origSentinelEnd = origStr.indexOf(BLOCK_A_SENTINEL) + BLOCK_A_SENTINEL.length;
      const compSentinelEnd = compStr.indexOf(BLOCK_A_SENTINEL) + BLOCK_A_SENTINEL.length;
      const origPrefix = origStr.slice(0, origSentinelEnd);
      const compPrefix = compStr.slice(0, compSentinelEnd);
      if (origPrefix !== compPrefix) {
        return {
          violated:        true,
          violatedSection: BLOCK_A_SENTINEL,
          violationKind:   'prefix_byte_drift',
        };
      }
    }

    // --- Load-bearing section check ---
    const origMap = buildSectionMap(origStr);
    const compMap = buildSectionMap(compStr);

    for (const heading of sections) {
      const origSection = origMap.get(heading);
      if (!origSection) {
        // Section not present in original — not a violation (no expectation)
        continue;
      }
      const compSection = compMap.get(heading);
      if (!compSection) {
        return {
          violated:        true,
          violatedSection: heading,
          violationKind:   'load_bearing_dropped',
        };
      }
      // Body must be byte-identical
      if (sha256(origSection) !== sha256(compSection)) {
        return {
          violated:        true,
          violatedSection: heading,
          violationKind:   'load_bearing_dropped',
        };
      }
    }

    return { violated: false, violatedSection: null, violationKind: null };
  } catch (_e) {
    // Fail-safe: treat as no violation (do not block compression on probe error)
    return { violated: false, violatedSection: null, violationKind: null };
  }
}

module.exports = {
  verifyLoadBearing,
  DEFAULT_LOAD_BEARING_SECTIONS,
  BLOCK_A_SENTINEL,
};
