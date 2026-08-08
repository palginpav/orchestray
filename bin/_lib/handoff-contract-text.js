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
 *
 * `patterns_used` / `patterns_rejected` (pattern-application-evidence-design
 * §4.2, v2.3.19 Phase 2): same required-even-when-empty rationale as
 * `assumptions`. Each entry is `{ slug, how }` (used) or `{ slug, why }`
 * (rejected), prose 10..300 chars. Field PRESENCE is graced at the
 * validate-task-completion.js call site (PATTERN_ACK_FIELDS_ENFORCED,
 * default off) so agents/tests that predate this change are not blocked;
 * ENTRY SHAPE, when the fields are present, is always validated.
 *
 * The per-entry prose KEY name (`how` vs `why`) is advisory, not load-bearing
 * — array membership in `patterns_used` vs `patterns_rejected` already
 * encodes the used/rejected semantics. `resolvePatternAckProse` below is the
 * one place that resolves prose across the accepted synonyms
 * (`how`/`why`/`reason`/`rationale`); both bin/validate-pattern-ack.js
 * (advisory ledger) and bin/validate-task-completion.js (blocking T15 gate)
 * call it so an agent writing `how` inside `patterns_rejected` (or vice
 * versa) is not silently treated as prose-less by one and prose-ful by the
 * other.
 */
const HANDOFF_REQUIRED_SECTIONS = [
  'status',
  'summary',
  'files_changed',
  'files_read',
  'issues',
  'assumptions',
  'patterns_used',
  'patterns_rejected',
];

/**
 * Resolve the prose string for one patterns_used/patterns_rejected entry.
 * Array membership already encodes used-vs-rejected semantics, so demanding
 * the exact prose key name buys nothing and discards real reasoning when an
 * agent writes `how` under `patterns_rejected` (or `why` under
 * `patterns_used`) — the same shape as the pre-existing `slug`/`name`
 * tolerance in bin/validate-pattern-ack.js#normalizeAckEntries. Checks the
 * preferred key first, then the paired opposite, then two synonyms observed
 * in the wild.
 *
 * @param {*} entry
 * @param {string} proseKey - 'how' (patterns_used) or 'why' (patterns_rejected)
 * @returns {string} trimmed prose, or '' if none found under any accepted key
 */
function resolvePatternAckProse(entry, proseKey) {
  if (!entry || typeof entry !== 'object') return '';
  const candidates = [entry[proseKey], entry.how, entry.why, entry.reason, entry.rationale];
  const found = candidates.find((v) => typeof v === 'string' && v.trim().length > 0);
  return found ? found.trim() : '';
}

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
  '`status`, `summary`, `files_changed`, `files_read`, `issues`, `assumptions`, ' +
  '`patterns_used`, `patterns_rejected`. For every pattern offered to this spawn, ' +
  'add one entry to exactly one of the two: `patterns_used: [{ "slug", "how" }]` ' +
  '(how the pattern changed the work, 10-300 chars) or `patterns_rejected: ' +
  '[{ "slug", "why" }]` (why it did not apply, 10-300 chars). The prose key name ' +
  'is flexible (`how`/`why`/`reason`/`rationale` all accepted) but 10-300 chars of ' +
  'real prose is still required. No patterns offered: both may be `[]`.';

module.exports = {
  HANDOFF_CONTRACT_SUFFIX,
  HANDOFF_REQUIRED_SECTIONS,
  resolvePatternAckProse,
};
