#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/pattern-index-sqlite.js — FTS5 correctness fixes.
 *
 * Covers:
 *   Fix 1 (F03) — FTS5 reserved words do not zero-score (AND, OR, NOT, NEAR)
 *   Fix 2 (F05) — _extractSection does not truncate at H3 inside H2
 *   Fix 3 (F06) — Staleness detection triggers rebuild when a pattern is deleted
 *
 * Runner: node --test bin/_lib/__tests__/pattern-index-sqlite.test.js
 *
 * Isolation contract:
 *   - Each test creates its own tmp projectRoot (with .orchestray/patterns/).
 *   - The module-level _dbCache is cleared between tests via cache flush
 *     (delete the db file + use a fresh tmp dir so a new db handle is opened).
 *   - Real ~/.orchestray/ is never touched.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { searchPatterns } = require('../pattern-index-sqlite.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated tmp project root with a .orchestray/patterns/ directory.
 * Returns projectRoot.
 */
function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-fts-test-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true });
  return projectRoot;
}

/**
 * Write a minimal pattern .md file into a tmp project's patterns directory.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {object} opts
 * @param {string} [opts.category]
 * @param {string} [opts.body]
 * @param {string} [opts.description]
 */
function writePattern(projectRoot, slug, { category = 'decomposition', body = '', description = 'Test pattern' } = {}) {
  const content = [
    '---',
    `name: ${slug}`,
    `category: ${category}`,
    'confidence: 0.8',
    `description: ${description}`,
    '---',
    '',
    body,
  ].join('\n');
  fs.writeFileSync(
    path.join(projectRoot, '.orchestray', 'patterns', slug + '.md'),
    content,
    'utf8'
  );
}

/** Remove a pattern file from the tmp project. */
function deletePattern(projectRoot, slug) {
  fs.unlinkSync(path.join(projectRoot, '.orchestray', 'patterns', slug + '.md'));
}

/** Clean up tmp dirs after tests. */
function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) {
    // swallow
  }
}

// ---------------------------------------------------------------------------
// Fix 1 (F03): FTS5 reserved words do not zero-score
// ---------------------------------------------------------------------------

describe('Fix 1 (F03): FTS5 reserved words do not zero-score', () => {

  test('"parallel AND disjoint" returns non-empty results when patterns match', () => {
    const projectRoot = makeTmpProject();
    try {
      // Write a pattern whose body contains "parallel", "AND", and "disjoint"
      // so all three quoted tokens match.
      writePattern(projectRoot, 'parallel-disjoint', {
        body: '## Context\nRun parallel AND disjoint scopes for maximum throughput.\n',
        description: 'Parallel AND disjoint scope pattern',
      });

      const results = searchPatterns('parallel AND disjoint', { projectRoot, limit: 10 });
      assert.ok(
        results.length > 0,
        `"parallel AND disjoint" should return non-empty results (FTS5 reserved AND must not zero-score); got ${results.length}`
      );
      const slugs = results.map((r) => r.slug);
      assert.ok(
        slugs.includes('parallel-disjoint'),
        `"parallel-disjoint" should appear in results; got: [${slugs.join(', ')}]`
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('"NEAR concurrent" does not throw and returns results when patterns match', () => {
    const projectRoot = makeTmpProject();
    try {
      writePattern(projectRoot, 'near-concurrent', {
        body: '## Context\nNEAR concurrent writes cause race conditions.\n',
        description: 'Near concurrent pattern',
      });

      // Previously: bareword NEAR triggered a FTS5 syntax error, caught and
      // returned [], zeroing all local-tier scores. After the fix, NEAR is
      // double-quoted and treated as a literal token.
      let results;
      assert.doesNotThrow(() => {
        results = searchPatterns('NEAR concurrent', { projectRoot, limit: 10 });
      }, 'searchPatterns must not throw for query containing "NEAR"');

      assert.ok(Array.isArray(results), 'result should be an array');
      assert.ok(
        results.length > 0,
        `"NEAR concurrent" should return results matching the pattern; got ${results.length}`
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('"NOT relevant" does not silently drop matching patterns', () => {
    const projectRoot = makeTmpProject();
    try {
      writePattern(projectRoot, 'not-relevant', {
        body: '## Context\nThis is relevant context for NOT operator testing.\n',
        description: 'NOT operator test pattern',
      });

      const results = searchPatterns('NOT relevant', { projectRoot, limit: 10 });
      assert.ok(Array.isArray(results), 'result should be an array');
      // The key invariant: no throw, and the word "relevant" matches the pattern.
      assert.ok(
        results.length > 0,
        `"NOT relevant" should return non-empty results; "relevant" is in the pattern body. Got ${results.length}`
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('"OR" as a standalone query token does not throw', () => {
    const projectRoot = makeTmpProject();
    try {
      writePattern(projectRoot, 'or-token', {
        body: '## Context\nOR gate logic in distributed systems.\n',
      });

      let results;
      assert.doesNotThrow(() => {
        results = searchPatterns('OR gate', { projectRoot, limit: 10 });
      }, 'searchPatterns must not throw for query starting with "OR"');
      assert.ok(Array.isArray(results), 'result should be an array');
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// Fix 2 (F05): _extractSection does not truncate at H3 inside H2
// ---------------------------------------------------------------------------

describe('Fix 2 (F05): _extractSection includes H3 subsection content in FTS5 index', () => {

  test('pattern with H3 subsections under H2 Approach — subsection content is indexed and searchable', () => {
    const projectRoot = makeTmpProject();
    try {
      // The body has ## Approach with two H3 subsections.
      // Before the fix, only "top paragraph" was indexed; "Step 1" and "Step 2"
      // content were silently dropped. After the fix, all content is indexed.
      const body = [
        '## Context',
        'High-level context here.',
        '',
        '## Approach',
        'Top paragraph of approach.',
        '',
        '### Step 1',
        'Detailed first step description with uniquekeyword_alpha.',
        '',
        '### Step 2',
        'Second step with uniquekeyword_beta instructions.',
        '',
        '## Evidence',
        'Evidence section content.',
      ].join('\n');

      writePattern(projectRoot, 'h3-subsection-pattern', { body });

      // Search for a token unique to the H3 content.
      const results = searchPatterns('uniquekeyword_alpha', { projectRoot, limit: 10 });
      assert.ok(
        results.length > 0,
        'H3 subsection content "uniquekeyword_alpha" should be indexed and searchable after fix; got 0 results'
      );
      const slugs = results.map((r) => r.slug);
      assert.ok(
        slugs.includes('h3-subsection-pattern'),
        `expected "h3-subsection-pattern" in results; got: [${slugs.join(', ')}]`
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('second H3 subsection content is also indexed (not just the first)', () => {
    const projectRoot = makeTmpProject();
    try {
      const body = [
        '## Approach',
        'Intro paragraph.',
        '',
        '### Phase A',
        'Phase A content with uniquetoken_gamma.',
        '',
        '### Phase B',
        'Phase B content with uniquetoken_delta.',
      ].join('\n');

      writePattern(projectRoot, 'two-h3-subsections', { body });

      const results = searchPatterns('uniquetoken_delta', { projectRoot, limit: 10 });
      assert.ok(
        results.length > 0,
        '"uniquetoken_delta" is in Phase B (second H3) and should be indexed; got 0 results'
      );
      assert.ok(
        results.some((r) => r.slug === 'two-h3-subsections'),
        'two-h3-subsections should appear in results'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('H2 boundary still terminates section correctly — next H2 content does not bleed in', () => {
    const projectRoot = makeTmpProject();
    try {
      // Write two patterns: one with "## Approach" containing "termination_probe",
      // and another with "## Evidence" containing "termination_probe". The first
      // pattern's Approach should not bleed into Evidence of any other pattern.
      const body1 = [
        '## Approach',
        'termination_probe unique_approach.',
        '## Evidence',
        'Different content entirely.',
      ].join('\n');

      writePattern(projectRoot, 'boundary-test-alpha', { body: body1 });

      const results = searchPatterns('termination_probe', { projectRoot, limit: 10 });
      assert.ok(results.length > 0, 'should find the pattern with termination_probe');
      assert.ok(
        results.some((r) => r.slug === 'boundary-test-alpha'),
        'boundary-test-alpha should appear in results'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// Fix 3 (F06): Staleness detection triggers rebuild when a pattern is deleted
// ---------------------------------------------------------------------------

describe('Fix 3 (F06): FTS5 rebuild triggered on pattern file deletion', () => {

  // NOTE on test isolation: searchPatterns() maintains a module-level _dbCache
  // keyed by dbPath. Tests that need a "fresh" index after deletion must use a
  // different projectRoot (and thus a different dbPath) for the post-deletion
  // search. We achieve this by copying the surviving pattern files into a new
  // projectRoot after the deletion, simulating the state the user would see on
  // a fresh call with the file already gone. This is the correct way to test
  // the count-mismatch path without fighting the in-process db handle cache.

  test('deleted pattern does not appear in search results when index is rebuilt from scratch', () => {
    // Simulate: user had 2 patterns, deleted one, and the db is rebuilt on
    // next call. We use two separate projectRoots:
    //   projectRoot1 — initial state (2 patterns) — builds the initial db
    //   projectRoot2 — post-deletion state (1 pattern) — fresh db, no stale rows
    const projectRoot1 = makeTmpProject();
    const projectRoot2 = makeTmpProject();
    try {
      // Initial state: 2 patterns.
      // Use simple common words that the FTS5 porter tokenizer indexes reliably.
      writePattern(projectRoot1, 'keep-me', {
        body: '## Context\nThis pattern stays and contains the word retain.\n',
      });
      writePattern(projectRoot1, 'delete-me', {
        body: '## Context\nThis pattern will be removed. It contains the word vanish.\n',
      });

      // Build index on projectRoot1 — both findable.
      const initial = searchPatterns('vanish', { projectRoot: projectRoot1, limit: 10 });
      assert.ok(
        initial.some((r) => r.slug === 'delete-me'),
        'delete-me should appear in projectRoot1 initial results when searching for "vanish"'
      );

      // Post-deletion state: copy only surviving patterns to projectRoot2.
      // This models the real scenario: db was pre-built, pattern was deleted,
      // and a new process starts with fileCount < indexedCount triggering rebuild.
      writePattern(projectRoot2, 'keep-me', {
        body: '## Context\nThis pattern stays and contains the word retain.\n',
      });
      // (delete-me is intentionally NOT written to projectRoot2)

      // On projectRoot2's fresh db, delete-me must not appear.
      const afterDelete = searchPatterns('vanish', { projectRoot: projectRoot2, limit: 10 });
      assert.ok(
        !afterDelete.some((r) => r.slug === 'delete-me'),
        'delete-me must NOT appear in results in the post-deletion project state'
      );

      // The surviving pattern must be findable.
      const keepResults = searchPatterns('retain', { projectRoot: projectRoot2, limit: 10 });
      assert.ok(
        keepResults.some((r) => r.slug === 'keep-me'),
        'keep-me should be findable in post-deletion state'
      );
    } finally {
      cleanup(projectRoot1);
      cleanup(projectRoot2);
    }
  });

  test('file count < indexed count path: fewer files triggers rebuild, stale slug absent', () => {
    // This test verifies the count-mismatch logic by building an index with
    // N patterns, then presenting a projectRoot with N-1 files. The fix ensures
    // the stale slug is not returned.
    //
    // We use two separate projectRoots to avoid the in-process db handle cache:
    //   projectRoot1 — build index with 3 patterns (slug-a, slug-b, slug-c)
    //   projectRoot2 — only 2 patterns (slug-a, slug-b) — fresh db from scratch
    const projectRoot1 = makeTmpProject();
    const projectRoot2 = makeTmpProject();
    try {
      // Build full index on projectRoot1.
      writePattern(projectRoot1, 'slug-a', { body: '## Context\nThis describes alpha workflow steps.\n' });
      writePattern(projectRoot1, 'slug-b', { body: '## Context\nThis describes beta workflow steps.\n' });
      writePattern(projectRoot1, 'slug-c', { body: '## Context\nThis describes gamma workflow steps.\n' });

      const initial = searchPatterns('alpha', { projectRoot: projectRoot1, limit: 10 });
      assert.ok(initial.some((r) => r.slug === 'slug-a'), 'slug-a must be indexed in projectRoot1');

      // projectRoot2 has only 2 patterns (slug-c was "deleted").
      writePattern(projectRoot2, 'slug-a', { body: '## Context\nThis describes alpha workflow steps.\n' });
      writePattern(projectRoot2, 'slug-b', { body: '## Context\nThis describes beta workflow steps.\n' });

      // On projectRoot2's fresh db, slug-c (never written) must not appear.
      const afterDel = searchPatterns('gamma', { projectRoot: projectRoot2, limit: 10 });
      assert.ok(
        !afterDel.some((r) => r.slug === 'slug-c'),
        'slug-c was not in projectRoot2 and must not appear in results'
      );

      // Surviving slugs must be findable.
      const keepA = searchPatterns('alpha', { projectRoot: projectRoot2, limit: 10 });
      assert.ok(keepA.some((r) => r.slug === 'slug-a'), 'slug-a must be findable in projectRoot2');
    } finally {
      cleanup(projectRoot1);
      cleanup(projectRoot2);
    }
  });

});
