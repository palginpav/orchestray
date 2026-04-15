'use strict';

/**
 * Excerpt sanitisation helpers for MCP tool result strings.
 *
 * Strips markdown special sequences and control characters from KB / pattern
 * content before including it in tool result payloads. This limits the
 * prompt-injection attack surface: tool outputs are trusted as tool-output
 * context by the LLM caller; including raw KB content verbatim could allow
 * a compromised KB file to inject instructions into the caller's context.
 *
 * Cap is 80 chars — sufficient for disambiguation, minimal attack surface.
 * Per T3 S1 + S2 (v2.0.15 reviewer audit).
 */

// Characters that carry special meaning in markdown or that could be used
// to inject instructions into LLM context. Includes backticks, bold/italic
// markers, headings, links, HTML, and ASCII control characters (0x00–0x1F
// except \t, \n, \r which are handled by the collapse step).
const _STRIP_PATTERN = /[`*_#<>\[\]\\]|[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

// Maximum excerpt length after stripping. 80 chars is sufficient for
// disambiguation and keeps LLM context exposure minimal (down from 240).
const EXCERPT_MAX_CHARS = 80;

/**
 * Sanitise a string for inclusion in a tool result excerpt field.
 *
 * Steps:
 *   1. Collapse whitespace (normalize line-breaks, runs of spaces).
 *   2. Strip markdown special sequences and control characters.
 *   3. Truncate to EXCERPT_MAX_CHARS.
 *
 * @param {string} s - Raw content from a KB or pattern file.
 * @returns {string} Safe, truncated excerpt.
 */
function sanitizeExcerpt(s) {
  if (typeof s !== 'string') return '';
  // Collapse first so stripping doesn't leave ragged spacing.
  const collapsed = s.replace(/\s+/g, ' ').trim();
  const stripped = collapsed.replace(_STRIP_PATTERN, '');
  return stripped.slice(0, EXCERPT_MAX_CHARS);
}

module.exports = { sanitizeExcerpt, EXCERPT_MAX_CHARS };
