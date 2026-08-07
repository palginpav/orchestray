'use strict';

/**
 * event-schemas-parser-fallback-scrape.test.js — D6 (v2.3.18 W1b)
 *
 * Regression guard for the shadow-generator false-positive fix: the FN-32
 * fallback pass (`SECTION_RE_PREFIXED`) anchors on ANY "### <prose> `slug`"
 * heading, including ones that are documentation prose about a field/file
 * name (e.g. "### Tombstone `rationale` field") rather than an event
 * declaration. Before this fix those headings were registered as bogus
 * event types whenever the section happened to contain a `\`\`\`json` fence
 * with no matching top-level "type" key — each producing a permanent false
 * "dark event" alarm (never fires because it was never a real event type).
 *
 * Fix: a fallback-sourced anchor may only become an event when its section's
 * json fence contains an explicit `"type": "<same-or-different-slug>"` match.
 * Canonical anchors (`### \`slug\`` / `### slug event`) keep the old
 * fallback-to-heading-slug behavior, since the heading itself IS the
 * declaration there.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseEventSchemas, parseEventSchemasWithRanges } = require('../event-schemas-parser');

describe('parseEventSchemas — fallback-heading scrape guard (D6)', () => {

  test('prose heading mentioning a field name in backticks is NOT registered as an event', () => {
    const content = `
### Tombstone \`rationale\` field (v2.1.2, curator actions)

Some prose explaining the field. Followed by an unrelated example block:

\`\`\`json
{
  "rationale": "example value, not an event",
  "other_field": 1
}
\`\`\`
`;
    const events = parseEventSchemas(content);
    assert.equal(events.length, 0, 'no bogus "rationale" event type registered');
  });

  test('multiple prose headings collapsing to the same incidental slug stay unregistered', () => {
    const content = `
### Degraded-journal \`kind\` additions (v2.1.3)

\`\`\`json
{ "kind": "example", "path": "x" }
\`\`\`

### Degraded-journal \`kind\` additions (v2.1.6)

\`\`\`json
{ "kind": "example-2", "path": "y" }
\`\`\`
`;
    const events = parseEventSchemas(content);
    assert.equal(events.length, 0, 'no bogus "kind" event type registered');
  });

  test('a genuine prefix-prose event declaration (Variant D style) still registers', () => {
    const content = `
### Variant D — \`routing_decision\` (merged, v2.0.18+)

\`\`\`json
{
  "timestamp": "...",
  "type": "routing_decision",
  "orchestration_id": "...",
  "agent_id": "..."
}
\`\`\`
`;
    const events = parseEventSchemas(content);
    assert.equal(events.length, 1);
    assert.equal(events[0].slug, 'routing_decision');
  });

  test('canonical heading (slug immediately after ###) still falls back to the heading slug', () => {
    const content = `
### \`tier2_load\` event

\`\`\`json
{
  "version": 1,
  "orchestration_id": "..."
}
\`\`\`
`;
    // No "type" key in the fence at all — canonical headings are still
    // allowed to fall back to the heading-captured slug.
    const events = parseEventSchemas(content);
    assert.equal(events.length, 1);
    assert.equal(events[0].slug, 'tier2_load');
  });

  test('parseEventSchemasWithRanges agrees with parseEventSchemas on the fallback guard', () => {
    const content = `
### Install manifest v2 (\`manifest.json\`)

\`\`\`json
{ "manifest_version": 2 }
\`\`\`
`;
    assert.equal(parseEventSchemas(content).length, 0);
    assert.equal(parseEventSchemasWithRanges(content).length, 0);
  });

});
