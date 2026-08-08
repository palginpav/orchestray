#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/pattern-ref-resolve.js.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/_lib/__tests__/pattern-ref-resolve.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePatternRef } = require('../pattern-ref-resolve');

const CORPUS = [
  { slug: 'anti-pattern-regex-false-positives', name: 'regex-false-positives', category: 'anti-pattern' },
  { slug: 'decomposition-multi-pass-review', name: 'multi-pass-review', category: 'decomposition' },
  // Two patterns sharing the same bare name under different categories — a
  // real ambiguity the resolver must report, not silently pick a winner.
  { slug: 'routing-shadow-ship', name: 'shadow-ship', category: 'routing' },
  { slug: 'roi-shadow-ship', name: 'shadow-ship', category: 'roi' },
];

describe('resolvePatternRef', () => {
  test('resolves by exact slug', () => {
    const r = resolvePatternRef('anti-pattern-regex-false-positives', CORPUS);
    assert.equal(r.status, 'found');
    assert.equal(r.pattern.slug, 'anti-pattern-regex-false-positives');
  });

  test('resolves by exact slug, case-insensitive', () => {
    const r = resolvePatternRef('Anti-Pattern-Regex-False-Positives', CORPUS);
    assert.equal(r.status, 'found');
    assert.equal(r.pattern.slug, 'anti-pattern-regex-false-positives');
  });

  test('resolves by bare name when unique', () => {
    const r = resolvePatternRef('multi-pass-review', CORPUS);
    assert.equal(r.status, 'found');
    assert.equal(r.pattern.slug, 'decomposition-multi-pass-review');
  });

  test('resolves by bare name, case-insensitive', () => {
    const r = resolvePatternRef('MULTI-PASS-REVIEW', CORPUS);
    assert.equal(r.status, 'found');
    assert.equal(r.pattern.slug, 'decomposition-multi-pass-review');
  });

  test('slug match wins even when it also collides with an unrelated name', () => {
    const corpus = CORPUS.concat([{ slug: 'multi-pass-review', name: 'not-the-real-one', category: 'x' }]);
    const r = resolvePatternRef('multi-pass-review', corpus);
    assert.equal(r.status, 'found');
    assert.equal(r.pattern.slug, 'multi-pass-review'); // exact slug beats name lookup
  });

  test('reports ambiguity when the bare name matches two distinct patterns', () => {
    const r = resolvePatternRef('shadow-ship', CORPUS);
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.matches.length, 2);
    const slugs = r.matches.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ['roi-shadow-ship', 'routing-shadow-ship']);
  });

  test('reports not_found for an unknown reference', () => {
    const r = resolvePatternRef('nonexistent-pattern', CORPUS);
    assert.equal(r.status, 'not_found');
  });

  test('reports not_found for empty/whitespace/non-string input', () => {
    assert.equal(resolvePatternRef('', CORPUS).status, 'not_found');
    assert.equal(resolvePatternRef('   ', CORPUS).status, 'not_found');
    assert.equal(resolvePatternRef(undefined, CORPUS).status, 'not_found');
  });

  test('reports not_found when patterns list is empty or not an array', () => {
    assert.equal(resolvePatternRef('anything', []).status, 'not_found');
    assert.equal(resolvePatternRef('anything', null).status, 'not_found');
  });

  // pattern_find's match entries (step 2 of the /orchestray:patterns skill)
  // carry `slug` and `category` but not `name` — the parity invariant means
  // name is always derivable, so the resolver must not require callers to
  // do an extra frontmatter read just to populate it.
  test('derives name from slug + category when name is absent (pattern_find shape)', () => {
    const corpus = [{ slug: 'anti-pattern-regex-false-positives', category: 'anti-pattern' }];
    const r = resolvePatternRef('regex-false-positives', corpus);
    assert.equal(r.status, 'found');
    assert.equal(r.pattern.slug, 'anti-pattern-regex-false-positives');
  });

  test('explicit name field takes precedence over slug+category derivation', () => {
    const corpus = [{ slug: 'anti-pattern-regex-false-positives', category: 'anti-pattern', name: 'explicit-name' }];
    assert.equal(resolvePatternRef('explicit-name', corpus).status, 'found');
    assert.equal(resolvePatternRef('regex-false-positives', corpus).status, 'not_found');
  });
});
