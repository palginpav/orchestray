#!/usr/bin/env node
'use strict';

/**
 * schema-section-type-field.test.js — FN-31 (v2.2.15)
 *
 * Regression guard: every `### …event` section in event-schemas.md must have
 * its first JSON fence contain a `"type":"<slug>"` field.  FN-30 corrected
 * sections that used `"event_type":` or omitted the discriminator; this test
 * prevents them from creeping back.
 *
 * Uses the same two-pass heading-enumeration strategy as event-schemas-parser.js
 * so this linter and the parser agree on which headings are event declarations.
 *
 * Cases:
 *   Test 1 — Happy path: every event-declaration section in the real schema
 *             file passes (first JSON fence contains `"type":`)
 *   Test 2 — Negative: section whose first JSON fence has `"event":` instead
 *             of `"type":` is caught by the linter
 *   Test 3 — Negative: section whose first JSON fence has no `"type":` field
 *             at all is caught by the linter
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Heading patterns — mirror event-schemas-parser.js exactly
// ---------------------------------------------------------------------------
//
// Shape 1: ### `slug` event ...        (backtick-wrapped slug + " event")
// Shape 2: ### slug event ...          (bare slug + " event")
// Shape 3: ### archetype_cache_* ...   (no backticks, underscore slugs)
// Shape 4: ### Prefix — `slug`         (Variant D: prefix prose then slug,
//                                       slug is at end-of-line)
//
// We deliberately exclude headings whose backtick content is followed by
// additional text (e.g. "### Tombstone `rationale` field (v2.1.2)") because
// those are changelog/structural notes, not event-type declarations.
//
const STRICT_EVENT_RE   = /^### [`]?([a-z][a-z0-9_.-]*)(?:[`]| event| Event)/mg;
const PREFIXED_EVENT_RE = /^### [^`\n]*[`]([a-z][a-z0-9_.-]*)[`]\s*$/mg;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enumerate ALL level-3 heading positions in the content.
 * Used to compute tight section boundaries so that a non-event section
 * immediately after an event section does not "bleed" its JSON fence into
 * the event section's text.
 */
function _allH3Positions(content) {
  const positions = [];
  const re = /^### /mg;
  let m;
  while ((m = re.exec(content)) !== null) {
    positions.push(m.index);
  }
  return positions;
}

/**
 * Enumerate event-declaration headings in the markdown content using the same
 * two-pass strategy as parseEventSchemas.  Returns an array of
 *   { index, slug }
 * sorted by byte offset.
 */
function _enumerateEventAnchors(content) {
  const anchors = [];
  const seenIndexes = new Set();
  let m;

  const re1 = new RegExp(STRICT_EVENT_RE.source, STRICT_EVENT_RE.flags);
  while ((m = re1.exec(content)) !== null) {
    if (!seenIndexes.has(m.index)) {
      anchors.push({ index: m.index, slug: m[1] });
      seenIndexes.add(m.index);
    }
  }

  const re2 = new RegExp(PREFIXED_EVENT_RE.source, PREFIXED_EVENT_RE.flags);
  while ((m = re2.exec(content)) !== null) {
    if (!seenIndexes.has(m.index)) {
      anchors.push({ index: m.index, slug: m[1] });
      seenIndexes.add(m.index);
    }
  }

  anchors.sort((a, b) => a.index - b.index);
  return anchors;
}

/**
 * Extract event sections from markdown content.  Each returned object has:
 *   heading        — the full heading line text
 *   slug           — the slug extracted from the heading
 *   firstJsonFence — content between the opening ```json and closing ``` fence,
 *                    or null if the section has no JSON fence
 *
 * Section boundaries are determined by ALL level-3 headings (not just event
 * headings) so that adjacent non-event sections do not bleed their fences into
 * the event section's text.
 */
function extractEventSections(content) {
  const results = [];
  const anchors = _enumerateEventAnchors(content);
  // All ### positions for computing tight section boundaries
  const allH3 = _allH3Positions(content);

  for (let i = 0; i < anchors.length; i++) {
    const { index, slug } = anchors[i];
    // Find the first ### heading that starts after this one
    const nextH3 = allH3.find(pos => pos > index);
    const sectionEnd = nextH3 !== undefined ? nextH3 : content.length;
    const sectionText = content.slice(index, sectionEnd);

    const headingEnd = sectionText.indexOf('\n');
    const heading = headingEnd === -1 ? sectionText : sectionText.slice(0, headingEnd);

    const fenceStart = sectionText.indexOf('```json');
    let firstJsonFence = null;
    if (fenceStart !== -1) {
      const contentStart = fenceStart + '```json'.length;
      const fenceEnd = sectionText.indexOf('```', contentStart);
      if (fenceEnd !== -1) {
        firstJsonFence = sectionText.slice(contentStart, fenceEnd);
      }
    }

    results.push({ heading, slug, firstJsonFence });
  }

  return results;
}

/**
 * Run the type-field lint check over the given markdown content.
 * Returns an array of { heading, problem } for each failing section.
 */
function lintTypeField(content) {
  const sections = extractEventSections(content);
  const failures = [];

  for (const { heading, firstJsonFence } of sections) {
    // Sections with no JSON fence are not subject to this lint rule
    if (firstJsonFence === null) continue;

    if (!/"type"\s*:/.test(firstJsonFence)) {
      failures.push({
        heading,
        problem: 'first JSON fence does not contain a "type": field',
        fence: firstJsonFence.slice(0, 200),
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FN-31 — schema section "type" field lint', () => {

  test('Test 1 (happy path): every ### …event section in event-schemas.md has "type": in its first JSON fence', () => {
    const schemaPath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
    const content = fs.readFileSync(schemaPath, 'utf8');

    const sections = extractEventSections(content);
    assert.ok(
      sections.length > 0,
      'must find at least one event-declaration section in event-schemas.md'
    );

    const failures = lintTypeField(content);
    assert.equal(
      failures.length,
      0,
      `${failures.length} section(s) missing "type": field:\n` +
      failures.map(f => `  ${f.heading} — ${f.problem}`).join('\n')
    );
  });

  test('Test 2 (negative): section using "event": instead of "type": is caught', () => {
    const syntheticContent = [
      '# Event Schemas',
      '',
      '### `bad_event_key` event',
      '',
      '```json',
      '{',
      '  "event": "bad_event_key",',
      '  "version": 1,',
      '  "orchestration_id": "orch-123"',
      '}',
      '```',
      '',
    ].join('\n');

    const failures = lintTypeField(syntheticContent);
    assert.equal(failures.length, 1, 'exactly one section must fail');
    assert.ok(
      failures[0].heading.includes('bad_event_key'),
      'failure must name the offending section heading'
    );
    assert.ok(
      failures[0].problem.includes('"type"'),
      'failure message must mention the missing "type" field'
    );
  });

  test('Test 3 (negative): section with no "type": field at all in its first JSON fence is caught', () => {
    const syntheticContent = [
      '# Event Schemas',
      '',
      '### `missing_type_field` event',
      '',
      '```json',
      '{',
      '  "version": 1,',
      '  "orchestration_id": "orch-123",',
      '  "description": "some description"',
      '}',
      '```',
      '',
    ].join('\n');

    const failures = lintTypeField(syntheticContent);
    assert.equal(failures.length, 1, 'section without any "type": field must be flagged');
    assert.ok(
      failures[0].heading.includes('missing_type_field'),
      'failure must name the offending heading'
    );
  });

});
