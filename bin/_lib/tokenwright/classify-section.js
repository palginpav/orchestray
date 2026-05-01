'use strict';

/**
 * classify-section.js — Tokenwright section classifier.
 *
 * Maps each parsed section to one of:
 *   - 'preserve'        : NEVER touched (handoff contract, repo map,
 *                         output-shape addendum, structured-result block,
 *                         project-intent, Block-A sentinel range, etc.)
 *   - 'dedup-eligible'  : may be dedup'd (KB attachments, prior findings,
 *                         repeated context blocks)
 *   - 'score-eligible'  : Layer 2 only (prose body of task description,
 *                         human context paragraph, prior agent summaries)
 *
 * Default-safe: when a section's heading is unknown, classify as
 * 'preserve'. Tokenwright never compresses something it does not
 * recognize.
 *
 * Block-A sentinel detection: if a section's body contains the literal
 * `<!-- ORCHESTRAY_BLOCK_A_END -->`, the section is force-classified as
 * 'preserve' regardless of its heading. The slot before the sentinel is
 * cache-anchored and any mutation invalidates the prefix.
 *
 * Pure function — no I/O, deterministic.
 */

const BLOCK_A_SENTINEL = '<!-- ORCHESTRAY_BLOCK_A_END -->';

// Default PRESERVE list. Project rule: a section heading must appear here
// EXACTLY (case-sensitive, leading "## " included) to be guaranteed
// preservation. Anything not on this list AND not on the dedup/score lists
// below falls back to 'preserve' (default-safe).
const DEFAULT_PRESERVE_HEADINGS = Object.freeze([
  '## Acceptance Rubric',
  '## Structured Result',
  '## Output Style',
  '## Repository Map',
  '## Repository Map (unchanged this orchestration)',
  '## Repo Map (Aider-style, top-K symbols)',
  '## Project Persona',
  '## Project Intent',
  '## Context from Previous Agent',
]);

// Inert placeholder — schema-level reservation, intentionally produces 0 dedup matches
// in production. v2.2.20 audit (n=477) found 0/477 prompts matched any of these headings.
// DO NOT remove: Layer-2 Haiku scoring may reuse the constant; removing triggers a five-test
// rewrite for zero behavioural benefit. See .orchestray/kb/artifacts/v2220-l1-revival-design.md §3.
const DEDUP_ELIGIBLE_HEADINGS = Object.freeze([
  '## Prior Reviewer Findings',
  '## Prior Findings',
  '## Audit Round Findings',
  '## Knowledge Base References',
  '## KB References',
]);

// Inert placeholder — schema-level reservation, intentionally produces 0 score matches
// in production. v2.2.20 audit confirmed 0/477 prompts matched any of these headings.
// DO NOT remove: reserved for Layer-2 Haiku block-scoring rollout.
// See .orchestray/kb/artifacts/v2220-l1-revival-design.md §3.
const SCORE_ELIGIBLE_HEADINGS = Object.freeze([
  '## Task Description',
  '## Context Paragraph',
  '## Prior Agent Summary',
]);

/**
 * @param {{heading:(string|null), body:string, raw:string}} section
 * @param {{ preserveExtra?: string[] }} [opts]
 * @returns {{kind:string, heading:(string|null)}}
 */
function classifySection(section, opts) {
  if (!section || typeof section.body !== 'string') {
    throw new TypeError('classifySection expects {heading, body, raw}');
  }

  // Block-A guard — wins over heading.
  if (section.body.indexOf(BLOCK_A_SENTINEL) !== -1) {
    return { kind: 'preserve', heading: section.heading };
  }

  // Sections with no heading (preamble) are PRESERVE — they hold the
  // task summary and upstream-injected addenda we never want to touch.
  if (section.heading === null) {
    return { kind: 'preserve', heading: null };
  }

  const extra = (opts && Array.isArray(opts.preserveExtra)) ? opts.preserveExtra : [];
  const preserveSet = new Set([...DEFAULT_PRESERVE_HEADINGS, ...extra]);

  if (preserveSet.has(section.heading)) {
    return { kind: 'preserve', heading: section.heading };
  }
  if (DEDUP_ELIGIBLE_HEADINGS.includes(section.heading)) {
    return { kind: 'dedup-eligible', heading: section.heading };
  }
  if (SCORE_ELIGIBLE_HEADINGS.includes(section.heading)) {
    return { kind: 'score-eligible', heading: section.heading };
  }
  // Default-safe: unknown headings are preserved.
  return { kind: 'preserve', heading: section.heading };
}

module.exports = {
  classifySection,
  BLOCK_A_SENTINEL,
  DEFAULT_PRESERVE_HEADINGS,
  DEDUP_ELIGIBLE_HEADINGS,
  SCORE_ELIGIBLE_HEADINGS,
};
