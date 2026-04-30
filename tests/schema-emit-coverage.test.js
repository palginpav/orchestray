#!/usr/bin/env node
'use strict';

/**
 * schema-emit-coverage.test.js — FN-34 (v2.2.15)
 *
 * CI invariant: every event `type` observed in the last 200 rows of
 * `.orchestray/audit/events.jsonl` must be declared in
 * `agents/pm-reference/event-schemas.md` (i.e. returned by `parseEventSchemas`).
 *
 * An undeclared observed type means an agent emitted an event without a schema
 * declaration, which breaks the R-SHDW gate and allows silent drift.
 *
 * Cases:
 *   Test 1 — Happy path: every observed type in the real last-200 events.jsonl
 *             rows is present in the schema slug-set.
 *   Test 2 — Synthetic regression: drop a known slug from a fixture schema
 *             string; confirm the missing type is reported.
 *   Test 3 — Edge case: empty / missing events.jsonl → test passes (zero
 *             false-fails on a fresh checkout with no audit log).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { parseEventSchemas } = require(path.join(REPO_ROOT, 'bin', '_lib', 'event-schemas-parser'));

const EVENTS_JSONL  = path.join(REPO_ROOT, '.orchestray', 'audit', 'events.jsonl');
const SCHEMA_PATH   = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the last `n` lines from a JSONL file.
 * Returns an array of parsed objects; malformed lines are silently skipped.
 * Returns [] if the file does not exist or is empty.
 */
function readLastNLines(filePath, n) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const tail  = lines.slice(-n);
  return tail
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Extract unique observed event types from a parsed JSONL array.
 * Accepts both `type` (canonical) and `event_type` / `event` (legacy fallbacks).
 */
function extractObservedTypes(rows) {
  const types = new Set();
  for (const row of rows) {
    const t = row.type || row.event_type || row.event;
    if (t && typeof t === 'string') types.add(t);
  }
  return types;
}

/**
 * Run the coverage check: returns { missing: string[] } listing any observed
 * type not present in the given slug-set.
 */
function checkCoverage(observedTypes, declaredSlugs) {
  const missing = [];
  for (const t of observedTypes) {
    if (!declaredSlugs.has(t)) missing.push(t);
  }
  return { missing };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FN-34 — emit coverage: observed types must be declared in schema', () => {

  test('Test 1 (happy path): every observed type in the last 200 events.jsonl rows is declared in event-schemas.md', () => {
    // If events.jsonl does not exist (fresh checkout), treat as zero observations
    // and pass trivially — guarded by Test 3.
    const rows = readLastNLines(EVENTS_JSONL, 200);
    if (rows.length === 0) {
      // Nothing observed; coverage is vacuously satisfied.
      assert.ok(true, 'no events observed; coverage trivially satisfied');
      return;
    }

    const observedTypes = extractObservedTypes(rows);
    assert.ok(
      observedTypes.size > 0,
      'must extract at least one type from non-empty events.jsonl'
    );

    const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const declaredSlugs = new Set(parseEventSchemas(schemaContent).map(e => e.slug));

    const { missing } = checkCoverage(observedTypes, declaredSlugs);

    assert.equal(
      missing.length,
      0,
      `${missing.length} observed event type(s) not declared in event-schemas.md:\n` +
      missing.map(t => `  "${t}"`).join('\n') +
      '\nAdd a schema entry for each before shipping.'
    );
  });

  test('Test 2 (synthetic regression): dropping a declared slug exposes the gap', () => {
    // Build a minimal schema content that declares two events.
    const fixtureSchema = [
      '# Event Schemas',
      '',
      '### `declared_event_a` event',
      '',
      '```json',
      '{',
      '  "type": "declared_event_a",',
      '  "version": 1,',
      '  "orchestration_id": "orch-x"',
      '}',
      '```',
      '',
      '### `declared_event_b` event',
      '',
      '```json',
      '{',
      '  "type": "declared_event_b",',
      '  "version": 1,',
      '  "orchestration_id": "orch-x"',
      '}',
      '```',
      '',
    ].join('\n');

    // Schema that is MISSING declared_event_b (simulating a dropped declaration)
    const truncatedSchema = [
      '# Event Schemas',
      '',
      '### `declared_event_a` event',
      '',
      '```json',
      '{',
      '  "type": "declared_event_a",',
      '  "version": 1,',
      '  "orchestration_id": "orch-x"',
      '}',
      '```',
      '',
    ].join('\n');

    // Simulated observations: both types were emitted
    const observedTypes = new Set(['declared_event_a', 'declared_event_b']);

    // Full schema: no missing
    const fullDeclared = new Set(parseEventSchemas(fixtureSchema).map(e => e.slug));
    const fullCheck = checkCoverage(observedTypes, fullDeclared);
    assert.equal(fullCheck.missing.length, 0, 'full schema must cover both observed types');

    // Truncated schema: declared_event_b is missing
    const truncatedDeclared = new Set(parseEventSchemas(truncatedSchema).map(e => e.slug));
    const truncatedCheck = checkCoverage(observedTypes, truncatedDeclared);
    assert.equal(truncatedCheck.missing.length, 1, 'truncated schema must report exactly one missing type');
    assert.equal(truncatedCheck.missing[0], 'declared_event_b', 'the missing type must be "declared_event_b"');
  });

  test('Test 3 (edge case): missing or empty events.jsonl produces zero observed types and passes', () => {
    // Test with a non-existent path — simulates a fresh checkout
    const nonExistentPath = path.join(REPO_ROOT, '.orchestray', 'audit', 'events-does-not-exist.jsonl');
    const rowsFromMissing = readLastNLines(nonExistentPath, 200);
    assert.equal(rowsFromMissing.length, 0, 'non-existent file must return empty array');

    const observedFromMissing = extractObservedTypes(rowsFromMissing);
    assert.equal(observedFromMissing.size, 0, 'no types must be observed from a missing file');

    const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const declaredSlugs = new Set(parseEventSchemas(schemaContent).map(e => e.slug));
    const { missing } = checkCoverage(observedFromMissing, declaredSlugs);

    assert.equal(
      missing.length,
      0,
      'zero observations produce zero missing types — test must pass on fresh checkout'
    );

    // Also verify empty-string JSONL content (zero rows after filtering blanks)
    const rowsFromEmpty = ''.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    assert.equal(rowsFromEmpty.length, 0, 'empty JSONL string must yield zero rows');
    const observedFromEmpty = extractObservedTypes(rowsFromEmpty);
    assert.equal(observedFromEmpty.size, 0, 'empty JSONL must yield zero observed types');
  });

});
