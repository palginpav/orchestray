'use strict';

/**
 * handoff-contract-text.js — single source of truth for the verbatim
 * Section 12.a Handoff Contract suffix (v2.2.2 Fix #7).
 *
 * Three sites used to hard-code this literal byte-identically:
 *   - bin/inject-output-shape.js          (appends to delegation prompts)
 *   - bin/validate-task-completion.js     (enforces required JSON sections
 *                                          listed inside the suffix)
 *   - bin/__tests__/v222-inject-output-shape.test.js
 *                                         (asserts the suffix lands on the
 *                                          updated prompt)
 *
 * Drift between any two of those would re-create D3 Finding #5 (agent
 * responses missing the contract section pass the agent-side write but fail
 * the hook-side enforcement). Centralising here means a future edit happens
 * in exactly one file.
 *
 * The suffix references the field list named in REQUIRED_SECTIONS — keep the
 * two in lockstep. The field list is exported separately so
 * validate-task-completion.js can derive its REQUIRED_SECTIONS array from
 * the same source.
 *
 * Cross-reference: agents/pm.md §"Handoff Contract and Rubric in Every
 * Delegation" item (a). The suffix wording was lifted verbatim from there
 * in v2.2.2 to migrate Section 12.a out of PM in-prompt prose and into the
 * PreToolUse:Agent hook (bin/inject-output-shape.js).
 */

/**
 * Required field names that MUST appear inside the agent's Structured
 * Result fenced JSON block. Used by:
 *   - this module (HANDOFF_CONTRACT_SUFFIX) — names listed inside the prose
 *   - bin/validate-task-completion.js (REQUIRED_SECTIONS)              — enforces
 *
 * Per v2.1.9 design-spec §5 I-12 item (c), `assumptions` is required even
 * when empty so downstream consumers can distinguish "no assumptions made"
 * from "assumptions omitted".
 */
const HANDOFF_REQUIRED_SECTIONS = [
  'status',
  'summary',
  'files_changed',
  'files_read',
  'issues',
  'assumptions',
];

/**
 * Verbatim Section 12.a contract suffix appended by inject-output-shape.js
 * to every Agent() spawn prompt with a non-`none` output-shape category.
 *
 * Mirrors agents/pm.md ~line 521. Byte-identical wording — DO NOT
 * paraphrase. If you change either side without changing the other, the
 * agent will pass the agent-side contract but fail the hook-side
 * enforcement (D3 Finding #5 returns).
 */
const HANDOFF_CONTRACT_SUFFIX =
  '\n\n## Output — Structured Result\n\n' +
  'Your output must end with a `## Structured Result` fenced JSON block ' +
  'conforming to `agents/pm-reference/handoff-contract.md`. Required fields: ' +
  '`status`, `summary`, `files_changed`, `files_read`, `issues`, `assumptions`.';

module.exports = {
  HANDOFF_CONTRACT_SUFFIX,
  HANDOFF_REQUIRED_SECTIONS,
};
