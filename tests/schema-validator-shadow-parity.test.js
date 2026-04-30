#!/usr/bin/env node
'use strict';

/**
 * schema-validator-shadow-parity.test.js — FN-29 (v2.2.15)
 *
 * Guards the invariant established by FN-28: after the validator was refactored
 * to route through the canonical `parseEventSchemas` parser, the slug-set
 * produced by `parseEventSchemas` and the slug-set stored in the validator's
 * internal Map must always be identical.
 *
 * If they diverge again (e.g. someone re-introduces a local parse pass into
 * schema-emit-validator.js), these tests will fail before the shadow can drift.
 *
 * Cases:
 *   Test 1 — Happy path: canonical event-schemas.md → parser slugs ≡ validator slugs
 *   Test 2 — Variant D heading style: `### Prefix — \`slug\`` recovered by both
 *   Test 3 — "event_type" key in JSON fence (not "type"): both skip it identically
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { parseEventSchemas } = require(path.join(REPO_ROOT, 'bin', '_lib', 'event-schemas-parser'));
const { parseSchemas } = require(path.join(REPO_ROOT, 'bin', '_lib', 'schema-emit-validator'));

describe('FN-29 — schema-validator-shadow parity', () => {

  test('Test 1 (happy path): canonical event-schemas.md produces identical slug-sets in parser and validator', () => {
    const schemaPath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
    const content = fs.readFileSync(schemaPath, 'utf8');

    const parserSlugs   = parseEventSchemas(content).map(e => e.slug).sort();
    const validatorSlugs = [...parseSchemas(content).keys()].sort();

    assert.ok(parserSlugs.length > 0, 'parser must return at least one slug from the real schema file');
    assert.ok(validatorSlugs.length > 0, 'validator must return at least one slug from the real schema file');

    // The sets must be identical — same length and same members in same order
    assert.equal(
      parserSlugs.length,
      validatorSlugs.length,
      `slug count mismatch: parser=${parserSlugs.length} vs validator=${validatorSlugs.length}`
    );
    assert.deepEqual(
      parserSlugs,
      validatorSlugs,
      'parser and validator must agree on every slug'
    );
  });

  test('Test 2 (Variant D heading style): "### Prefix — `slug`" recovered by both parser and validator', () => {
    // This is the heading shape that FN-32 added SECTION_RE_PREFIXED to handle.
    // The validator now routes through the parser so both must see this slug.
    const content = [
      '# Event Schemas',
      '',
      '### Variant D — `my_variant_event`',
      '',
      '```json',
      '{',
      '  "type": "my_variant_event",',
      '  "version": 1,',
      '  "orchestration_id": "orch-123"',
      '}',
      '```',
      '',
    ].join('\n');

    const parserSlugs   = parseEventSchemas(content).map(e => e.slug).sort();
    const validatorSlugs = [...parseSchemas(content).keys()].sort();

    assert.deepEqual(parserSlugs, ['my_variant_event'], 'parser must recover Variant D slug');
    assert.deepEqual(validatorSlugs, ['my_variant_event'], 'validator must recover Variant D slug');

    // Cross-check: both produce the exact same set
    assert.deepEqual(parserSlugs, validatorSlugs, 'parser and validator slug-sets must be identical');
  });

  test('Test 3 ("event_type" key instead of "type"): both parser and validator agree to skip it', () => {
    // FN-30 corrected sections that used "event_type" to "type".
    // A section still using "event_type" in its JSON fence should be ignored
    // (or at most recovered via the heading slug), and both parser and validator
    // must see the same result — no divergence even for malformed content.
    const contentWithEventTypeKey = [
      '# Event Schemas',
      '',
      '### `bad_event_type_key` event',
      '',
      '```json',
      '{',
      '  "event_type": "bad_event_type_key",',
      '  "version": 1,',
      '  "orchestration_id": "orch-xyz"',
      '}',
      '```',
      '',
      '### `good_event` event',
      '',
      '```json',
      '{',
      '  "type": "good_event",',
      '  "version": 1,',
      '  "orchestration_id": "orch-xyz"',
      '}',
      '```',
      '',
    ].join('\n');

    const parserSlugs   = parseEventSchemas(contentWithEventTypeKey).map(e => e.slug).sort();
    const validatorSlugs = [...parseSchemas(contentWithEventTypeKey).keys()].sort();

    // Both must agree — whatever each decides about the "event_type" section,
    // the sets must be identical (no divergence between parser and validator).
    assert.deepEqual(
      parserSlugs,
      validatorSlugs,
      'parser and validator must agree on slug-set even when "event_type" key is used instead of "type"'
    );

    // The correctly-keyed section must be in both
    assert.ok(parserSlugs.includes('good_event'), 'well-formed section with "type" key must be in parser output');
    assert.ok(validatorSlugs.includes('good_event'), 'well-formed section with "type" key must be in validator output');
  });

});
