'use strict';

/**
 * parse-sections.js — Tokenwright section parser.
 *
 * Splits a delegation prompt into sections at markdown H2 boundaries
 * (`## Heading`). Returns an ordered list of {heading, body, raw} where
 * `raw` is the byte-identical source slice (so the assembler can
 * round-trip when no compression occurs).
 *
 * The first slice (text BEFORE any `## ` heading) is returned with
 * heading: null. This typically holds the task summary and any
 * preamble emitted by upstream PreToolUse hooks (delegation-delta,
 * archetype-advisory, output-shape addendum reference).
 *
 * Pure function — no I/O, no globals, deterministic. Idempotent under
 * round-trip: parseSections(...).map(s => s.raw).join('') === input.
 */

/**
 * Parse a delegation prompt into a list of sections at H2 boundaries.
 *
 * @param {string} input  Raw delegation prompt text.
 * @returns {Array<{heading:(string|null), body:string, raw:string, byteOffset:number}>}
 */
function parseSections(input) {
  if (typeof input !== 'string') {
    throw new TypeError('parseSections expects a string input');
  }
  if (input.length === 0) return [];

  // Match at start-of-line; require exactly two leading hashes so we
  // do not accidentally split on H3 (### …) headings INSIDE a section
  // (those belong to the parent H2 and must travel with it).
  const headingRe = /^## .*$/gm;

  const matches = [];
  let m;
  while ((m = headingRe.exec(input)) !== null) {
    matches.push({ index: m.index, line: m[0] });
  }

  if (matches.length === 0) {
    // No H2 headings — single section.
    return [{
      heading: null,
      body: input,
      raw: input,
      byteOffset: 0,
    }];
  }

  const out = [];
  // Preamble (before first heading), if any.
  if (matches[0].index > 0) {
    const raw = input.slice(0, matches[0].index);
    out.push({
      heading: null,
      body: raw,
      raw,
      byteOffset: 0,
    });
  }
  // Each H2 section runs from its heading line to the next H2 (or EOF).
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : input.length;
    const raw = input.slice(start, end);
    out.push({
      heading: matches[i].line,
      body: raw,
      raw,
      byteOffset: start,
    });
  }
  return out;
}

/**
 * Reassemble a list of sections back into a single string. Order is
 * preserved; sections marked `dropped: true` are excluded.
 *
 * @param {Array<{raw:string, dropped?:boolean}>} sections
 * @returns {string}
 */
function reassembleSections(sections) {
  if (!Array.isArray(sections)) {
    throw new TypeError('reassembleSections expects an array');
  }
  return sections
    .filter(s => !s.dropped)
    .map(s => s.raw)
    .join('');
}

module.exports = { parseSections, reassembleSections };
