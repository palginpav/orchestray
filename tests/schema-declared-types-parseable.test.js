#!/usr/bin/env node
'use strict';

/**
 * schema-declared-types-parseable.test.js — W5 (v2.3.33)
 *
 * Regression guard for the H2-heading bug class: event-schemas.md declares an
 * event type via a `"type": "<slug>"` literal inside a fenced ```json block,
 * but the section's heading is not a `### ` (level-3) heading matching
 * event-schemas-parser.js's SECTION_RE — so the parser never anchors the
 * section and the type is silently invisible to the shadow, the tier2-index,
 * and schema-emit-validator. 27 event types were found in this state in
 * v2.3.33 (W3 had already fixed one instance of the same bug class,
 * `kill_switch_deactivated`, in v2.3.31 — this test exists so the next
 * mis-headed section is caught immediately instead of drifting for another
 * release).
 *
 * Method: scan the raw file for every `"type": "<slug>"` string literal
 * (the same signal a human or a hasty new section would introduce), then
 * confirm the parser's slug set is a superset of that literal set, modulo a
 * documented exclusion list of strings that are not real event-type
 * declarations.
 *
 * Exclusions (confirmed by direct inspection, not assumed):
 *   - `developer`, `reviewer` — inside the `disagreement_surfaced` event's
 *     sample payload, `agent_a.type` and `agent_b.type` hold the role name of
 *     each side of the disagreement (`"type": "reviewer"` / `"type":
 *     "developer"`). These are nested-object `type` keys describing an
 *     *agent role*, not the top-level event-type discriminator — the scan
 *     regex cannot distinguish nesting depth, so it picks them up as if they
 *     were declared event types.
 *   - `install_hook_args_updated`, `install_stale_hook_pruned` — explicitly
 *     retired event-type declarations. Both sections carry an E3 (v2.3.19)
 *     re-classification notice stating the event moved to `degraded.jsonl`
 *     `kind` (not `events.jsonl` `type`) and that "Schema-shadow validators
 *     must NOT count this slug toward declared-but-unobserved telemetry."
 *     The `"type": "..."` string these two slugs match on is prose *inside*
 *     that retirement notice (a blockquote describing the old, now-dead,
 *     heading+fence pair), not a live fenced JSON block.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseEventSchemas } = require('../bin/_lib/event-schemas-parser');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

// Documented, reasoned exclusion list — see file header comment above for
// why each entry is not a real declared event type.
const NON_EVENT_TYPE_LITERALS = new Set([
  'developer',
  'reviewer',
  'install_hook_args_updated',
  'install_stale_hook_pruned',
]);

describe('W5 — every declared event type must be parseable', () => {

  test('every "type": "<slug>" literal in event-schemas.md is either parsed or on the documented exclusion list', () => {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf8');

    const declared = new Set(
      [...content.matchAll(/"type"\s*:\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1])
    );
    assert.ok(declared.size > 100, 'sanity: expected well over 100 "type": literals in event-schemas.md');

    const parsed = new Set(parseEventSchemas(content).map((e) => e.slug));

    const unparsed = [...declared].filter((slug) => !parsed.has(slug));
    const unexpectedUnparsed = unparsed.filter((slug) => !NON_EVENT_TYPE_LITERALS.has(slug));

    assert.equal(
      unexpectedUnparsed.length,
      0,
      'The following "type": literals appear in event-schemas.md but are not ' +
      'parsed by parseEventSchemas() and are not on the documented exclusion ' +
      'list. This almost always means a section heading is not a `### ` ' +
      '(level-3) heading matching SECTION_RE, or a section groups multiple ' +
      'event types under one heading with only one fenced JSON block per type ' +
      'expected. Fix the heading level/shape (see `### \\`kill_switch_activated\\` ' +
      'event` for the canonical shape) rather than weakening this test:\n  ' +
      unexpectedUnparsed.join('\n  ')
    );

    // Guard the exclusion list itself: every excluded slug must actually be
    // absent from the parsed set (else the entry is stale and should be
    // removed — it would silently stop testing anything).
    const staleExclusions = [...NON_EVENT_TYPE_LITERALS].filter(
      (slug) => declared.has(slug) && parsed.has(slug)
    );
    assert.equal(
      staleExclusions.length,
      0,
      'The following exclusion-list entries are now parsed successfully — ' +
      'remove them from NON_EVENT_TYPE_LITERALS, they no longer need an ' +
      'exclusion:\n  ' + staleExclusions.join('\n  ')
    );
  });

});
