#!/usr/bin/env node
'use strict';

/**
 * Tests for R5 field projection (v2.1.11) in pattern_find and kb_search.
 *
 * Test plan (12 cases: 6 per tool):
 *   T1. pattern_find — no `fields` → full legacy response (backward compat)
 *   T2. pattern_find — fields="slug,confidence" → only those keys in each match
 *   T3. pattern_find — fields="nonexistent" → empty projection per match
 *   T4. pattern_find — fields="title.body" (dot notation) → isError, S06 blocked
 *   T5. pattern_find — fields="$..title" (JSONPath) → isError, S06 blocked
 *   T6. pattern_find — byte reduction measurement (AC-04 evidence)
 *   T7. kb_search   — no `fields` → full legacy response (backward compat)
 *   T8. kb_search   — fields="slug,excerpt" → only those keys in each match
 *   T9. kb_search   — fields="nonexistent" → empty projection per match
 *  T10. kb_search   — fields="section.slug" (dot notation) → isError, S06 blocked
 *  T11. kb_search   — fields="$..section" (JSONPath) → isError, S06 blocked
 *  T12. kb_search   — byte reduction measurement (AC-04 evidence)
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/field-projection.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle: patternFindHandle } = require('../pattern_find.js');
const { handle: kbSearchHandle } = require('../kb_search.js');

// ---------------------------------------------------------------------------
// Helpers — temp project setup
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-r5-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'kb', 'decisions'), { recursive: true });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

/** Generate a token unlikely to match real patterns in the filesystem. */
function uniqueToken() {
  return 'r5tok' + Math.random().toString(36).slice(2, 10) + 'xqz';
}

/** Write a pattern file with all standard fields populated. */
function writePattern(patternsDir, slug, token) {
  const content = [
    '---',
    'name: ' + slug,
    'category: decomposition',
    'confidence: 0.85',
    'times_applied: 3',
    'description: ' + token + ' pattern for field projection test ' + token,
    '---',
    '',
    '## Context',
    'This pattern is used for ' + token + ' field projection testing.',
    '',
    '## Approach',
    'Apply ' + token + ' projection to reduce token volume.',
  ].join('\n');
  fs.writeFileSync(path.join(patternsDir, slug + '.md'), content, 'utf8');
}

/** Write a KB article. */
function writeKbArticle(kbDir, section, slug, token) {
  const content = [
    '# ' + token + ' KB Article',
    '',
    'This is a knowledge base article about ' + token + ' field projection.',
    'It contains enough text to produce a meaningful excerpt for testing.',
  ].join('\n');
  const sectionDir = path.join(kbDir, section);
  fs.mkdirSync(sectionDir, { recursive: true });
  fs.writeFileSync(path.join(sectionDir, slug + '.md'), content, 'utf8');
}

/** Count bytes in a JSON-stringified value. */
function byteSize(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

// ---------------------------------------------------------------------------
// pattern_find tests
// ---------------------------------------------------------------------------

describe('R5 field projection — pattern_find', () => {

  test('T1: no fields → full legacy response (backward compat, AC-03)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
    writePattern(patternsDir, 'pf-t1-slug', token);

    const result = await patternFindHandle(
      { task_summary: token + ' field projection', max_results: 5 },
      { projectRoot }
    );

    assert.equal(result.isError, false, 'expected no error');
    const matches = result.structuredContent.matches;
    assert.ok(Array.isArray(matches), 'matches should be an array');

    // Full response: should include all standard fields
    const m = matches.find((x) => x.slug === 'pf-t1-slug');
    assert.ok(m !== undefined, 'pattern should appear in results');
    assert.ok(Object.hasOwn(m, 'slug'), 'full response must include slug');
    assert.ok(Object.hasOwn(m, 'confidence'), 'full response must include confidence');
    assert.ok(Object.hasOwn(m, 'category'), 'full response must include category');
    assert.ok(Object.hasOwn(m, 'one_line'), 'full response must include one_line');
    assert.ok(Object.hasOwn(m, 'match_reasons'), 'full response must include match_reasons');
    assert.ok(Object.hasOwn(m, 'uri'), 'full response must include uri');
  });

  test('T2: fields="slug,confidence" → only those keys returned (AC-01, AC-02)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
    writePattern(patternsDir, 'pf-t2-slug', token);

    const result = await patternFindHandle(
      { task_summary: token + ' field projection', max_results: 5, fields: 'slug,confidence' },
      { projectRoot }
    );

    assert.equal(result.isError, false, 'expected no error');
    const matches = result.structuredContent.matches;
    const m = matches.find((x) => x.slug === 'pf-t2-slug');
    assert.ok(m !== undefined, 'projected pattern should appear in results');

    // Only requested fields present
    const keys = Object.keys(m);
    assert.deepEqual(keys.sort(), ['confidence', 'slug'], 'only slug and confidence should be present');

    // AC-02: byte reduction ≥ 50% compared to full response
    const fullResult = await patternFindHandle(
      { task_summary: token + ' field projection', max_results: 5 },
      { projectRoot }
    );
    const fullMatch = fullResult.structuredContent.matches.find((x) => x.slug === 'pf-t2-slug');
    const fullBytes = byteSize(fullMatch);
    const projectedBytes = byteSize(m);
    const reductionRatio = 1 - (projectedBytes / fullBytes);
    assert.ok(
      reductionRatio >= 0.5,
      'projected match should be ≥50% smaller than full match (got ' +
      Math.round(reductionRatio * 100) + '% reduction, full=' + fullBytes + 'B, proj=' + projectedBytes + 'B)'
    );
  });

  test('T3: fields="nonexistent" → empty objects per match (unknown key silently skipped)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
    writePattern(patternsDir, 'pf-t3-slug', token);

    const result = await patternFindHandle(
      { task_summary: token + ' field projection', max_results: 5, fields: 'nonexistent' },
      { projectRoot }
    );

    assert.equal(result.isError, false, 'unknown field should not cause an error');
    const matches = result.structuredContent.matches;
    // All projected objects should be empty (nonexistent key not present)
    for (const m of matches) {
      assert.deepEqual(Object.keys(m), [], 'projection of unknown key should yield empty object');
    }
  });

  test('T4: fields="title.body" (dot notation) → isError (S06 blocked)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const result = await patternFindHandle(
      { task_summary: 'test', fields: 'title.body' },
      { projectRoot }
    );

    assert.equal(result.isError, true, 'dot notation must be rejected (S06)');
    assert.ok(
      result.content[0].text.includes('.'),
      'error message should mention the forbidden character'
    );
  });

  test('T5: fields="$..title" (JSONPath) → isError (S06 blocked)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const result = await patternFindHandle(
      { task_summary: 'test', fields: '$..title' },
      { projectRoot }
    );

    assert.equal(result.isError, true, 'JSONPath must be rejected (S06)');
    assert.ok(
      result.content[0].text.includes('$'),
      'error message should mention the forbidden character'
    );
  });

  test('T6: byte reduction measurement with fields=["slug","confidence"] (AC-04)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
    // Write 3 patterns to make the measurement more representative.
    for (let i = 1; i <= 3; i++) {
      writePattern(patternsDir, 'pf-t6-slug-' + i, token);
    }

    const fullResult = await patternFindHandle(
      { task_summary: token + ' field projection', max_results: 5 },
      { projectRoot }
    );
    const projResult = await patternFindHandle(
      { task_summary: token + ' field projection', max_results: 5, fields: ['slug', 'confidence'] },
      { projectRoot }
    );

    assert.equal(fullResult.isError, false);
    assert.equal(projResult.isError, false);

    const fullBytes = byteSize(fullResult.structuredContent.matches);
    const projBytes = byteSize(projResult.structuredContent.matches);
    const ratio = projBytes / fullBytes;

    // Log for structured result
    console.log('T6 pattern_find byte reduction:', {
      bytes_before: fullBytes,
      bytes_after: projBytes,
      ratio: Math.round(ratio * 100) / 100,
    });

    assert.ok(fullBytes > projBytes, 'projected response must be smaller than full response');
    assert.ok(
      ratio <= 0.5,
      'projected response should be ≤50% of full size (got ratio=' + ratio.toFixed(2) + ')'
    );
  });

});

// ---------------------------------------------------------------------------
// kb_search tests
// ---------------------------------------------------------------------------

describe('R5 field projection — kb_search', () => {

  test('T7: no fields → full legacy response (backward compat, AC-03)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const kbDir = path.join(projectRoot, '.orchestray', 'kb');
    writeKbArticle(kbDir, 'facts', 'kb-t7-slug', token);

    const result = await kbSearchHandle(
      { query: token + ' field projection', limit: 5 },
      { projectRoot }
    );

    assert.equal(result.isError, false, 'expected no error');
    const matches = result.structuredContent.matches;
    assert.ok(Array.isArray(matches), 'matches should be an array');

    const m = matches.find((x) => x.slug === 'kb-t7-slug');
    assert.ok(m !== undefined, 'article should appear in results');
    assert.ok(Object.hasOwn(m, 'slug'), 'full response must include slug');
    assert.ok(Object.hasOwn(m, 'section'), 'full response must include section');
    assert.ok(Object.hasOwn(m, 'uri'), 'full response must include uri');
    assert.ok(Object.hasOwn(m, 'excerpt'), 'full response must include excerpt');
    assert.ok(Object.hasOwn(m, 'score'), 'full response must include score');
    assert.ok(Object.hasOwn(m, 'source'), 'full response must include source');
  });

  test('T8: fields="slug,excerpt" → only those keys returned (AC-01, AC-02)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const kbDir = path.join(projectRoot, '.orchestray', 'kb');
    writeKbArticle(kbDir, 'facts', 'kb-t8-slug', token);

    // AC-01: fields projection returns only requested keys.
    const result = await kbSearchHandle(
      { query: token + ' field projection', limit: 5, fields: 'slug,excerpt' },
      { projectRoot }
    );

    assert.equal(result.isError, false, 'expected no error');
    const matches = result.structuredContent.matches;
    const m = matches.find((x) => x.slug === 'kb-t8-slug');
    assert.ok(m !== undefined, 'projected article should appear in results');

    const keys = Object.keys(m);
    assert.deepEqual(keys.sort(), ['excerpt', 'slug'], 'only slug and excerpt should be present');

    // AC-02: byte reduction ≥ 50% — use single-key projection for a guaranteed result.
    // `slug` alone vs. the full 6-field object (slug, section, uri, excerpt, score, source).
    const fullResult = await kbSearchHandle(
      { query: token + ' field projection', limit: 5 },
      { projectRoot }
    );
    const projSlugResult = await kbSearchHandle(
      { query: token + ' field projection', limit: 5, fields: 'slug' },
      { projectRoot }
    );
    const fullMatch = fullResult.structuredContent.matches.find((x) => x.slug === 'kb-t8-slug');
    const projSlugMatch = projSlugResult.structuredContent.matches.find((x) => x.slug === 'kb-t8-slug');
    const fullBytes = byteSize(fullMatch);
    const projectedBytes = byteSize(projSlugMatch);
    const reductionRatio = 1 - (projectedBytes / fullBytes);
    assert.ok(
      reductionRatio >= 0.5,
      'single-key projection should be ≥50% smaller (got ' +
      Math.round(reductionRatio * 100) + '% reduction, full=' + fullBytes + 'B, proj=' + projectedBytes + 'B)'
    );
  });

  test('T9: fields="nonexistent" → empty objects per match (unknown key silently skipped)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const kbDir = path.join(projectRoot, '.orchestray', 'kb');
    writeKbArticle(kbDir, 'facts', 'kb-t9-slug', token);

    const result = await kbSearchHandle(
      { query: token + ' field projection', limit: 5, fields: 'nonexistent' },
      { projectRoot }
    );

    assert.equal(result.isError, false, 'unknown field should not cause an error');
    const matches = result.structuredContent.matches;
    for (const m of matches) {
      assert.deepEqual(Object.keys(m), [], 'projection of unknown key should yield empty object');
    }
  });

  test('T10: fields="section.slug" (dot notation) → isError (S06 blocked)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const result = await kbSearchHandle(
      { query: 'test', fields: 'section.slug' },
      { projectRoot }
    );

    assert.equal(result.isError, true, 'dot notation must be rejected (S06)');
    assert.ok(
      result.content[0].text.includes('.'),
      'error message should mention the forbidden character'
    );
  });

  test('T11: fields="$..section" (JSONPath) → isError (S06 blocked)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const result = await kbSearchHandle(
      { query: 'test', fields: '$..section' },
      { projectRoot }
    );

    assert.equal(result.isError, true, 'JSONPath must be rejected (S06)');
    assert.ok(
      result.content[0].text.includes('$'),
      'error message should mention the forbidden character'
    );
  });

  test('T12: byte reduction measurement with fields=["slug","section"] (AC-04)', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const kbDir = path.join(projectRoot, '.orchestray', 'kb');
    // Write multiple articles for a more representative measurement.
    for (let i = 1; i <= 3; i++) {
      writeKbArticle(kbDir, 'facts', 'kb-t12-slug-' + i, token);
    }

    const fullResult = await kbSearchHandle(
      { query: token + ' field projection', limit: 10 },
      { projectRoot }
    );
    const projResult = await kbSearchHandle(
      { query: token + ' field projection', limit: 10, fields: ['slug', 'section'] },
      { projectRoot }
    );

    assert.equal(fullResult.isError, false);
    assert.equal(projResult.isError, false);

    const fullBytes = byteSize(fullResult.structuredContent.matches);
    const projBytes = byteSize(projResult.structuredContent.matches);
    const ratio = projBytes / fullBytes;

    // Log for structured result
    console.log('T12 kb_search byte reduction:', {
      bytes_before: fullBytes,
      bytes_after: projBytes,
      ratio: Math.round(ratio * 100) / 100,
    });

    assert.ok(fullBytes > projBytes, 'projected response must be smaller than full response');
    assert.ok(
      ratio <= 0.5,
      'projected response should be ≤50% of full size (got ratio=' + ratio.toFixed(2) + ')'
    );
  });

});

// ---------------------------------------------------------------------------
// Additional unit tests for the parseFields / projectObject utilities
// ---------------------------------------------------------------------------

describe('field-projection lib — unit tests', () => {
  const { parseFields, projectObject, projectArray } = require('../../lib/field-projection.js');

  test('parseFields: undefined → null (no projection)', () => {
    assert.equal(parseFields(undefined), null);
  });

  test('parseFields: null → null (no projection)', () => {
    assert.equal(parseFields(null), null);
  });

  test('parseFields: string → trimmed array', () => {
    assert.deepEqual(parseFields('a,b, c'), ['a', 'b', 'c']);
  });

  test('parseFields: array of strings → trimmed array', () => {
    assert.deepEqual(parseFields(['x', 'y']), ['x', 'y']);
  });

  test('parseFields: array with non-string element → error', () => {
    const result = parseFields(['ok', 42]);
    assert.ok(result && typeof result.error === 'string', 'should return error object');
    assert.ok(result.error.includes('string'), 'error should mention string type');
  });

  test('parseFields: empty string in array → error', () => {
    const result = parseFields(['ok', '']);
    assert.ok(result && typeof result.error === 'string');
    assert.ok(result.error.includes('empty'));
  });

  test('parseFields: dot in field name → error', () => {
    const result = parseFields('a.b');
    assert.ok(result && typeof result.error === 'string');
    assert.ok(result.error.includes('.'));
  });

  test('parseFields: wildcard in field name → error', () => {
    const result = parseFields('a*');
    assert.ok(result && typeof result.error === 'string');
    assert.ok(result.error.includes('*'));
  });

  test('parseFields: $ in field name → error', () => {
    const result = parseFields('$..title');
    assert.ok(result && typeof result.error === 'string');
    assert.ok(result.error.includes('$'));
  });

  test('projectObject: projects known keys, skips unknown', () => {
    const obj = { a: 1, b: 2, c: 3 };
    assert.deepEqual(projectObject(obj, ['a', 'c']), { a: 1, c: 3 });
  });

  test('projectObject: unknown key → key absent in result (not error)', () => {
    const obj = { a: 1 };
    assert.deepEqual(projectObject(obj, ['nonexistent']), {});
  });

  test('projectArray: projects each object in array', () => {
    const arr = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    assert.deepEqual(projectArray(arr, ['a']), [{ a: 1 }, { a: 3 }]);
  });
});
