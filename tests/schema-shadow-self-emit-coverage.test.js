#!/usr/bin/env node
'use strict';

/**
 * schema-shadow-self-emit-coverage.test.js — FN-T22 (v2.2.21 W4-T17)
 *
 * Guards three invariants surfaced by the T2 debugger findings F-13, F-19, F-21:
 *
 *   Test 1 (F-19) — `audit_event_autofilled` is declared in the shadow with
 *     `r` (required count) covering event_type and fields_autofilled.
 *
 *   Test 2 (meta-count) — shadow's `_meta.event_count` matches the number of
 *     event types returned by parseEventSchemas on event-schemas.md.
 *     (These two counts must agree; a grep-based count differs because some
 *     headings use an alias format parsed by SECTION_RE_PREFIXED.)
 *
 *   Test 3 (F-21) — Fixture emit of `archetype_cache_advisory_served` with
 *     a 12-char hex `archetype_id` passes schema-emit-validator.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..');
const SHADOW_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

const { parseEventSchemas } = require(path.join(REPO_ROOT, 'bin', '_lib', 'event-schemas-parser'));
const { validateEvent, clearCache } = require(path.join(REPO_ROOT, 'bin', '_lib', 'schema-emit-validator'));

// ---------------------------------------------------------------------------
// Test 1 — audit_event_autofilled declared in shadow with correct required fields
// ---------------------------------------------------------------------------

describe('FN-T22 — schema shadow self-emit coverage', () => {

  test('Test 1 (F-19): audit_event_autofilled in shadow with event_type and fields_autofilled required', () => {
    assert.ok(fs.existsSync(SHADOW_PATH), 'shadow file must exist at ' + SHADOW_PATH);

    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));

    assert.ok(
      shadow.audit_event_autofilled !== undefined && shadow.audit_event_autofilled !== null,
      'audit_event_autofilled must be declared in event-schemas.shadow.json'
    );

    const entry = shadow.audit_event_autofilled;

    // The shadow stores required COUNT (r), not a list. Verify r >= 2 (event_type + fields_autofilled).
    // Actual value is 3 (version, event_type, fields_autofilled) since version is always required.
    assert.ok(
      typeof entry.r === 'number' && entry.r >= 2,
      'audit_event_autofilled must have at least 2 required fields (event_type, fields_autofilled); got r=' + entry.r
    );

    // Verify via parser that the actual required list includes the two mandated fields.
    const md = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const events = parseEventSchemas(md);
    const schemaEntry = events.find(e => e.slug === 'audit_event_autofilled');

    assert.ok(schemaEntry, 'audit_event_autofilled must be parseable from event-schemas.md');
    assert.ok(
      schemaEntry.required.includes('event_type'),
      'audit_event_autofilled required list must include "event_type"; got ' + JSON.stringify(schemaEntry.required)
    );
    assert.ok(
      schemaEntry.required.includes('fields_autofilled'),
      'audit_event_autofilled required list must include "fields_autofilled"; got ' + JSON.stringify(schemaEntry.required)
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2 — shadow _meta.event_count matches parseEventSchemas count
  // ---------------------------------------------------------------------------

  test('Test 2 (meta-count): shadow _meta.event_count matches parseEventSchemas count', () => {
    assert.ok(fs.existsSync(SHADOW_PATH), 'shadow file must exist');

    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    const metaCount = shadow._meta.event_count;

    assert.ok(typeof metaCount === 'number' && metaCount > 0, '_meta.event_count must be a positive number');

    // Count shadow keys (excluding _meta) as independent check
    const shadowKeyCount = Object.keys(shadow).filter(k => k !== '_meta').length;
    assert.equal(
      shadowKeyCount,
      metaCount,
      'shadow key count must equal _meta.event_count: keys=' + shadowKeyCount + ' meta=' + metaCount
    );

    // Also verify against the live parser to catch regen drift
    const md = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const parsed = parseEventSchemas(md);
    assert.equal(
      parsed.length,
      metaCount,
      'parseEventSchemas count must equal shadow _meta.event_count — regen may be stale. ' +
      'parsed=' + parsed.length + ' meta=' + metaCount
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3 — archetype_cache_advisory_served with 12-char-hex archetype_id passes validator
  // ---------------------------------------------------------------------------

  test('Test 3 (F-21): archetype_cache_advisory_served with 12-char-hex archetype_id passes schema-emit-validator', () => {
    // Clear any process-level schema cache so we read the live event-schemas.md.
    clearCache();

    // 12-char hex string matching the format seen in archetype-cache.jsonl (e.g. "474114d0fc32")
    const ARCHETYPE_ID_12HEX = 'abc123def456';
    assert.match(ARCHETYPE_ID_12HEX, /^[0-9a-f]{12}$/, 'fixture archetype_id must be 12-char lowercase hex');

    const fixture = {
      type:                    'archetype_cache_advisory_served',
      version:                 1,
      timestamp:               '2026-05-01T00:00:00.000Z',
      orchestration_id:        'orch-test-12345',
      archetype_id:            ARCHETYPE_ID_12HEX,
      confidence:              0.92,
      task_shape_hash:         'abc123',
      prior_applications_count: 4,
      pm_decision:             'apply',
      pm_reasoning_brief:      'high confidence archetype match',
    };

    const result = validateEvent(REPO_ROOT, fixture);

    assert.ok(
      result.valid,
      'archetype_cache_advisory_served with 12-char-hex archetype_id must pass validation. ' +
      'Errors: ' + JSON.stringify(result.errors)
    );
    assert.deepEqual(result.errors, [], 'no validation errors expected');
    assert.equal(result.event_type, 'archetype_cache_advisory_served');
  });

});
