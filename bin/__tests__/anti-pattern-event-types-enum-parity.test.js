#!/usr/bin/env node
'use strict';

/**
 * anti-pattern-event-types-enum-parity.test.js — C-03 hard-block parity gate
 * (v2.2.15 P1-02).
 *
 * Mechanises anti-pattern `half-shipped-enum`. Verifies that every event-type
 * declared in `agents/pm-reference/event-schemas.md` (canonical source) is
 * also listed in the `EVENT_TYPES` constant inside
 * `bin/mcp-server/tools/history_query_events.js` (the MCP tool's enum). Drift
 * in either direction is a silent regression — clients filter by an enum that
 * does not match the audit corpus.
 *
 * v2.2.15 ships HARD-BLOCK (failure raises). The recurrence pattern (v2.0.21,
 * v2.0.22) confirms the prose-only rule fails repeatedly; telemetry ramp adds
 * no value.
 *
 * KNOWN_EXCLUSIONS — events declared in event-schemas.md but intentionally
 * omitted from the query enum (e.g. low-cardinality housekeeping or debug-
 * only events that are not user-queryable). Each entry MUST justify itself
 * inline.
 *
 * Kill switch: `ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED=1`.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const path               = require('node:path');

const { parseEventSchemas } = require('../_lib/event-schemas-parser');

const REPO_ROOT          = path.resolve(__dirname, '..', '..');
const EVENT_SCHEMAS_MD   = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const HISTORY_TOOL_JS    = path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools', 'history_query_events.js');

// ---------------------------------------------------------------------------
// Allowed exclusions
// ---------------------------------------------------------------------------

/**
 * Event-types declared in event-schemas.md but intentionally absent from the
 * `history_query_events` EVENT_TYPES enum. Each entry must justify why the
 * event is not user-queryable (rare/debug/curator-internal/etc).
 *
 * The current `EVENT_TYPES` in history_query_events.js exposes a deliberately
 * narrow subset (the lifecycle + routing events most useful for retro-
 * orchestration analysis). The vast majority of newer telemetry events
 * (curator_*, schema_shadow_*, tokenwright_*, etc.) are NOT in EVENT_TYPES
 * and surface only via direct events.jsonl reads.
 *
 * The lint therefore enforces a one-way invariant:
 *   - every slug listed in EVENT_TYPES MUST be declared in event-schemas.md
 *     (slug typos / phantom enums fail).
 *   - the reverse direction (event-schemas → EVENT_TYPES) is NOT enforced
 *     because the enum is a curated subset.
 *
 * If a future release wants to require the reverse direction, flip the
 * STRICT_REVERSE flag below to true and add justified entries here.
 */
const KNOWN_EXCLUSIONS = new Set([
  // Reserved slot: justified non-queryable events would land here when the
  // strict-reverse flag is enabled.
]);

/**
 * EVENT_TYPES → declared exclusions. The history_query_events EVENT_TYPES
 * enum lists 4 phantoms that no source emits today — kept defensively so the
 * MCP tool's `event_types` filter accepts a stable historical vocabulary
 * even if the underlying emitters are reactivated. Each entry justifies its
 * presence and links to the canonical emit-site (or notes "no current emit").
 *
 * Adding to this list is a deliberate cross-cut requiring code review.
 * Removing an entry (when the matching emit-site lands) MUST be paired with
 * a `### \`<slug>\` event` declaration in `event-schemas.md`.
 */
const ENUM_PHANTOM_EXCLUSIONS = new Set([
  // Reserved for the v2.2.x elicitation pipeline. Today the live audit
  // ledger uses `mcp_tool_call` with `tool_name: "ask_user"` instead. The
  // enum entries remain so future first-class `elicitation_*` events do not
  // require a downstream `event_types` filter migration.
  'elicitation_requested',
  'elicitation_answered',

  // `orchestration_end` was the v2.0.x-name for what the v2.0.21 pipeline
  // standardised on `orchestration_complete`. EVENT_TYPES retains the old
  // slug for backwards compatibility on archived events.jsonl files written
  // before the rename.
  'orchestration_end',

  // `verify_fix_attempt` was an early stage 2 event-name; the live emitters
  // use `verify_fix_start` / `verify_fix_pass` / `verify_fix_fail`. Kept so
  // historical filters remain valid.
  'verify_fix_attempt',
]);

const STRICT_REVERSE = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDisabled() {
  return process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED === '1';
}

/**
 * Extract the EVENT_TYPES array literal from history_query_events.js source.
 * Tolerates either `const EVENT_TYPES = [ ... ];` or `EVENT_TYPES = [...]`.
 * Returns Set<string>.
 */
function parseEventTypesEnum(src) {
  const m = src.match(/EVENT_TYPES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('parseEventTypesEnum: EVENT_TYPES literal not found');
  const body = m[1];
  const slugs = new Set();
  const RE = /['"]([a-z][a-z0-9_.-]*)['"]/g;
  let m2;
  while ((m2 = RE.exec(body)) !== null) {
    slugs.add(m2[1]);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Real-source parity tests (HARD-BLOCK)
// ---------------------------------------------------------------------------

describe('event-types-enum-parity: real source', () => {
  test('every EVENT_TYPES slug is declared in event-schemas.md', () => {
    if (isDisabled()) {
      assert.ok(true, 'parity check disabled');
      return;
    }
    const md  = fs.readFileSync(EVENT_SCHEMAS_MD, 'utf8');
    const tool = fs.readFileSync(HISTORY_TOOL_JS, 'utf8');

    const declared = new Set(parseEventSchemas(md).map((e) => e.slug));
    const enumSlugs = parseEventTypesEnum(tool);

    assert.ok(declared.size > 0, 'parser found at least one declared event slug');
    assert.ok(enumSlugs.size > 0, 'parser found at least one EVENT_TYPES slug');

    const phantom = [];
    for (const slug of enumSlugs) {
      if (declared.has(slug)) continue;
      if (ENUM_PHANTOM_EXCLUSIONS.has(slug)) continue;
      phantom.push(slug);
    }
    phantom.sort();
    assert.deepStrictEqual(
      phantom,
      [],
      'EVENT_TYPES slugs not declared in event-schemas.md and not in ' +
        'ENUM_PHANTOM_EXCLUSIONS: ' + JSON.stringify(phantom)
    );
  });

  test('strict-reverse direction (event-schemas → EVENT_TYPES) is currently disabled', () => {
    // Documents the asymmetry. EVENT_TYPES is a curated subset; flipping
    // STRICT_REVERSE = true requires populating KNOWN_EXCLUSIONS.
    assert.strictEqual(STRICT_REVERSE, false);
    if (STRICT_REVERSE) {
      // Future v2.2.x+: enforce reverse direction with justified exclusions.
      const md  = fs.readFileSync(EVENT_SCHEMAS_MD, 'utf8');
      const tool = fs.readFileSync(HISTORY_TOOL_JS, 'utf8');
      const declared = new Set(parseEventSchemas(md).map((e) => e.slug));
      const enumSlugs = parseEventTypesEnum(tool);
      const undeclared = [];
      for (const slug of declared) {
        if (enumSlugs.has(slug)) continue;
        if (KNOWN_EXCLUSIONS.has(slug)) continue;
        undeclared.push(slug);
      }
      assert.deepStrictEqual(undeclared, []);
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic fixture tests (negative + edge)
// ---------------------------------------------------------------------------

const SYNTH_SCHEMA_BASIC = `
### \`foo_event\` event

\`\`\`json
{
  "type": "foo_event",
  "version": 1,
  "agent_role": "developer"
}
\`\`\`

### \`bar_event\` event

\`\`\`json
{
  "type": "bar_event",
  "version": 1
}
\`\`\`
`;

const SYNTH_TOOL_FOO_ONLY = `
'use strict';
const EVENT_TYPES = [
  'foo_event',
];
module.exports = { EVENT_TYPES };
`;

const SYNTH_TOOL_PHANTOM = `
'use strict';
const EVENT_TYPES = [
  'foo_event',
  'phantom_event',
];
`;

const SYNTH_TOOL_BOTH = `
'use strict';
const EVENT_TYPES = [
  'foo_event',
  'bar_event',
];
`;

describe('event-types-enum-parity: synthetic fixtures', () => {
  test('positive: enum is subset of declared → no phantom', () => {
    const declared = new Set(parseEventSchemas(SYNTH_SCHEMA_BASIC).map((e) => e.slug));
    const enumSlugs = parseEventTypesEnum(SYNTH_TOOL_FOO_ONLY);
    const phantom = [...enumSlugs].filter((s) => !declared.has(s));
    assert.deepStrictEqual(phantom, []);
  });

  test('positive: enum exactly matches → no phantom, no missing', () => {
    const declared = new Set(parseEventSchemas(SYNTH_SCHEMA_BASIC).map((e) => e.slug));
    const enumSlugs = parseEventTypesEnum(SYNTH_TOOL_BOTH);
    const phantom = [...enumSlugs].filter((s) => !declared.has(s));
    const missing = [...declared].filter((s) => !enumSlugs.has(s));
    assert.deepStrictEqual(phantom, []);
    assert.deepStrictEqual(missing.sort(), []);
  });

  test('negative: enum has phantom_event not declared → flagged', () => {
    const declared = new Set(parseEventSchemas(SYNTH_SCHEMA_BASIC).map((e) => e.slug));
    const enumSlugs = parseEventTypesEnum(SYNTH_TOOL_PHANTOM);
    const phantom = [...enumSlugs].filter((s) => !declared.has(s));
    assert.deepStrictEqual(phantom, ['phantom_event']);
  });

  test('negative (strict-reverse hypothetical): schema declares bar, enum missing it', () => {
    const declared = new Set(parseEventSchemas(SYNTH_SCHEMA_BASIC).map((e) => e.slug));
    const enumSlugs = parseEventTypesEnum(SYNTH_TOOL_FOO_ONLY);
    const undeclared = [...declared].filter((s) => !enumSlugs.has(s));
    assert.deepStrictEqual(undeclared.sort(), ['bar_event']);
  });

  test('edge: KNOWN_EXCLUSIONS allows justified omissions in strict-reverse mode', () => {
    const declared = new Set(parseEventSchemas(SYNTH_SCHEMA_BASIC).map((e) => e.slug));
    const enumSlugs = parseEventTypesEnum(SYNTH_TOOL_FOO_ONLY);
    const synthExclusions = new Set(['bar_event']);
    const undeclared = [...declared]
      .filter((s) => !enumSlugs.has(s))
      .filter((s) => !synthExclusions.has(s));
    assert.deepStrictEqual(undeclared, []);
  });

  test('parser robustness: malformed enum literal raises', () => {
    assert.throws(
      () => parseEventTypesEnum("'use strict';\nconst OTHER = [];\n"),
      /EVENT_TYPES literal not found/
    );
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('event-types-enum-parity: kill switch', () => {
  test('isDisabled false by default', () => {
    const prev = process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED;
    delete process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED;
    try {
      assert.strictEqual(isDisabled(), false);
    } finally {
      if (prev !== undefined) process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED = prev;
    }
  });

  test('isDisabled true when env var = 1', () => {
    const prev = process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED;
    process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED = '1';
    try {
      assert.strictEqual(isDisabled(), true);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED;
      else process.env.ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED = prev;
    }
  });
});
