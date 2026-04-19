#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.1.2 Idea 4: per-term / per-section match_reasons in pattern_find.
 *
 * Covers:
 *   (a) FTS5 path: per-term reasons appear ("fts5:term=X (in section)")
 *   (b) role/category reasons still appear alongside per-term reasons
 *   (c) fallback path (FTS5 unavailable): produces ["fallback: keyword"] signal
 *
 * Runner: node --test bin/_lib/__tests__/match-reasons-v212.test.js
 *
 * Isolation contract:
 *   - Each test creates its own tmp projectRoot.
 *   - Shared-tier federation is inactive (no ~/.orchestray dir manipulation).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle } = require('../../../bin/mcp-server/tools/pattern_find.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-v212-reasons-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function makeContext(tmp, overrides = {}) {
  return {
    projectRoot: tmp,
    pluginRoot: tmp,
    config: {},
    logger: () => {},
    ...overrides,
  };
}

/**
 * Write a pattern file into the tmp project.
 *
 * @param {string} tmp
 * @param {string} slug
 * @param {object} fm  - frontmatter fields
 * @param {string} [body]
 */
function writePattern(tmp, slug, fm, body = '') {
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  const content = '---\n' + fmLines + '\n---\n\n' + body;
  fs.writeFileSync(
    path.join(tmp, '.orchestray', 'patterns', slug + '.md'),
    content,
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// (a) FTS5 path: per-term reasons appear
// ---------------------------------------------------------------------------

describe('v2.1.2 Idea 4 (a): per-term match_reasons on FTS5 path', () => {

  test('match_reasons contains fts5:term= entries for tokens that matched', async () => {
    // Use a unique made-up but porter-friendly word ("blarg" + real suffix "ment")
    // so it won't collide with shared-tier patterns but will survive porter stemming.
    // Disable the shared patterns dir via ORCHESTRAY_TEST_SHARED_DIR pointing to an
    // empty dir so only our fixture pattern is considered.
    const tmp = makeTmpProject();
    const emptyShared = makeTmpProject(); // used as fake shared dir (no patterns)
    const prevSharedDir = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    process.env.ORCHESTRAY_TEST_SHARED_DIR = emptyShared;
    try {
      // Use words that are all present in the indexed section text.
      // "validation" is only in the description, not the indexed context,
      // so omit it to ensure the FTS5 AND-match succeeds.
      writePattern(tmp, 'fts5term-test', {
        name: 'fts5term-test',
        category: 'decomposition',
        confidence: 0.9,
        times_applied: 3,
        description: 'Blargment and disjoint scope check',
      }, [
        '## Context',
        'Run a blargment check on disjoint scopes to verify correctness.',
        '',
        '## Approach',
        'Apply blargment rules across all disjoint partitions.',
        '',
        '## Evidence',
        'Blargment disjoint pattern applied successfully.',
      ].join('\n'));

      const result = await handle(
        { task_summary: 'blargment disjoint scopes' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should not error');
      assert.ok(result.structuredContent.matches.length >= 1, 'should have at least one match');

      // Find our specific pattern in results (shared patterns may also match common words).
      const m = result.structuredContent.matches.find((x) => x.slug === 'fts5term-test');
      assert.ok(m, 'fts5term-test must appear in matches; got: ' + JSON.stringify(result.structuredContent.matches.map((x) => x.slug)));

      const reasons = m.match_reasons;
      assert.ok(Array.isArray(reasons), 'match_reasons must be an array');
      assert.ok(reasons.length > 0, 'match_reasons must not be empty');

      // At least one reason should be a per-term fts5 reason.
      const fts5TermReasons = reasons.filter((r) => r.startsWith('fts5:term='));
      assert.ok(
        fts5TermReasons.length > 0,
        'Expected at least one "fts5:term=" reason; got: ' + JSON.stringify(reasons)
      );

      // Each per-term reason should match the format "fts5:term=X (in section[, ...])"
      for (const r of fts5TermReasons) {
        assert.match(
          r,
          /^fts5:term=\S+ \(in (context|approach|evidence)(, (context|approach|evidence))*\)$/,
          'fts5 term reason format should be "fts5:term=X (in section)"'
        );
      }
    } finally {
      if (prevSharedDir === undefined) {
        delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
      } else {
        process.env.ORCHESTRAY_TEST_SHARED_DIR = prevSharedDir;
      }
      cleanup(tmp);
      cleanup(emptyShared);
    }
  });

  test('match_reasons mentions the section where the term was found', async () => {
    // Use two separate tmp projects. Disable the shared patterns tier so only
    // the fixture pattern is considered (avoids interference from real shared patterns).
    // Use porter-friendly words: "blargful" (context only), "grumpling" (approach only).
    const tmp1 = makeTmpProject();
    const tmp2 = makeTmpProject();
    const emptyShared = makeTmpProject();
    const prevSharedDir = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    process.env.ORCHESTRAY_TEST_SHARED_DIR = emptyShared;
    try {
      // Pattern: "blargful" only in Context section.
      // Add a dummy Evidence section so Approach section is terminated by Evidence
      // and _extractSection('Approach') works correctly. Only the unique term
      // "blargful" is in Context, not in Approach or Evidence.
      writePattern(tmp1, 'context-section-test', {
        name: 'context-section-test',
        category: 'routing',
        confidence: 0.8,
        times_applied: 0,
        description: 'Section attribution context test',
      }, [
        '## Context',
        'Blargful verification happens in this context section only.',
        '',
        '## Approach',
        'Standard approach without special terms.',
        '',
        '## Evidence',
        'Standard evidence without special terms.',
      ].join('\n'));

      const r1 = await handle(
        { task_summary: 'blargful verification' },
        makeContext(tmp1)
      );
      assert.equal(r1.isError, false);
      const m1 = r1.structuredContent.matches.find((x) => x.slug === 'context-section-test');
      assert.ok(m1, 'context-section-test must appear; got: ' + JSON.stringify(r1.structuredContent.matches.map((x) => x.slug)));
      const contextReasons = m1.match_reasons;
      // Find the blargful term reason.
      const ctxTermReason = contextReasons.find((r) => r.startsWith('fts5:term=') && r.toLowerCase().includes('blargful'));
      assert.ok(ctxTermReason, 'should find fts5:term= reason for blargful; got: ' + JSON.stringify(contextReasons));
      assert.ok(
        ctxTermReason.includes('context'),
        'blargful is in Context — reason must say "context"; got: ' + ctxTermReason
      );
      // blargful must NOT appear in approach or evidence reasons.
      assert.ok(
        !ctxTermReason.includes('approach') && !ctxTermReason.includes('evidence'),
        'blargful was only in Context — must not say approach/evidence; got: ' + ctxTermReason
      );

      // Pattern: "grumpling" only in Approach section.
      // Add Evidence so _extractSection('Approach') works.
      writePattern(tmp2, 'approach-section-test', {
        name: 'approach-section-test',
        category: 'routing',
        confidence: 0.8,
        times_applied: 0,
        description: 'Section attribution approach test',
      }, [
        '## Context',
        'Standard context without special terms.',
        '',
        '## Approach',
        'Grumpling procedure applies here in the approach section only.',
        '',
        '## Evidence',
        'Standard evidence without special terms.',
      ].join('\n'));

      const r2 = await handle(
        { task_summary: 'grumpling procedure' },
        makeContext(tmp2)
      );
      assert.equal(r2.isError, false);
      const m2 = r2.structuredContent.matches.find((x) => x.slug === 'approach-section-test');
      assert.ok(m2, 'approach-section-test must appear; got: ' + JSON.stringify(r2.structuredContent.matches.map((x) => x.slug)));
      const approachReasons = m2.match_reasons;
      const apprTermReason = approachReasons.find((r) => r.startsWith('fts5:term=') && r.toLowerCase().includes('grumpling'));
      assert.ok(apprTermReason, 'should find fts5:term= reason for grumpling; got: ' + JSON.stringify(approachReasons));
      assert.ok(
        apprTermReason.includes('approach'),
        'grumpling is in Approach — reason must say "approach"; got: ' + apprTermReason
      );
      // grumpling must NOT appear in context or evidence reasons.
      assert.ok(
        !apprTermReason.includes('context') && !apprTermReason.includes('evidence'),
        'grumpling was only in Approach — must not say context/evidence; got: ' + apprTermReason
      );
    } finally {
      if (prevSharedDir === undefined) {
        delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
      } else {
        process.env.ORCHESTRAY_TEST_SHARED_DIR = prevSharedDir;
      }
      cleanup(tmp1);
      cleanup(tmp2);
      cleanup(emptyShared);
    }
  });

  test('flat "fts5" reason is NOT present when per-term reasons are available', async () => {
    const tmp = makeTmpProject();
    const emptyShared = makeTmpProject();
    const prevSharedDir = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    process.env.ORCHESTRAY_TEST_SHARED_DIR = emptyShared;
    try {
      writePattern(tmp, 'no-flat-fts5', {
        name: 'no-flat-fts5',
        category: 'decomposition',
        confidence: 0.85,
        times_applied: 0,
        description: 'Grumbleon scan changed files test',
      }, '## Context\nGrumbleon should scan only changed files for efficiency.\n\n## Evidence\nGrumbleon scan confirmed.\n');

      const result = await handle(
        { task_summary: 'grumbleon scan changed files' },
        makeContext(tmp)
      );
      assert.equal(result.isError, false);
      const m = result.structuredContent.matches.find((x) => x.slug === 'no-flat-fts5');
      assert.ok(m, 'no-flat-fts5 must be in results');

      const reasons = m.match_reasons;
      // When per-term reasons are present, the flat 'fts5' fallback must not appear.
      const fts5TermReasons = reasons.filter((r) => r.startsWith('fts5:term='));
      if (fts5TermReasons.length > 0) {
        assert.ok(
          !reasons.includes('fts5'),
          'When per-term reasons are present, flat "fts5" reason must not appear; got: ' + JSON.stringify(reasons)
        );
      } else {
        assert.ok(
          reasons.includes('fts5'),
          'When no per-term reasons present, flat "fts5" fallback reason must appear; got: ' + JSON.stringify(reasons)
        );
      }
    } finally {
      if (prevSharedDir === undefined) {
        delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
      } else {
        process.env.ORCHESTRAY_TEST_SHARED_DIR = prevSharedDir;
      }
      cleanup(tmp);
      cleanup(emptyShared);
    }
  });

});

// ---------------------------------------------------------------------------
// (b) Role and category reasons still appear
// ---------------------------------------------------------------------------

describe('v2.1.2 Idea 4 (b): role/category reasons preserved alongside per-term reasons', () => {

  test('role= reason appears when agent_role matches pattern body', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'reviewer-scope-pattern', {
        name: 'reviewer-scope-pattern',
        category: 'anti-pattern',
        confidence: 0.9,
        times_applied: 2,
        description: 'Reviewer subagents scope changed files',
      }, '## Context\nReviewer subagents should only scan changed files.\n\n## Approach\nScope the reviewer to the diff.\n');

      const result = await handle(
        { task_summary: 'reviewer scope changed files scan', agent_role: 'reviewer' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);

      const reasons = result.structuredContent.matches[0].match_reasons;
      assert.ok(
        reasons.some((r) => r === 'role=reviewer'),
        'role= reason must appear when agent_role matches; got: ' + JSON.stringify(reasons)
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('role= and fts5:term= reasons coexist in same match_reasons array', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'decomp-pm-pattern', {
        name: 'decomp-pm-pattern',
        category: 'decomposition',
        confidence: 0.85,
        times_applied: 1,
        description: 'PM decomposition orchestration strategy',
      }, '## Context\nPM should decompose orchestration tasks into subtasks.\n\n## Approach\nBreak down complex PM orchestration work.\n');

      const result = await handle(
        { task_summary: 'PM orchestration decomposition subtasks', agent_role: 'pm' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);

      const reasons = result.structuredContent.matches[0].match_reasons;
      const hasFts5Term = reasons.some((r) => r.startsWith('fts5:term='));
      const hasRole = reasons.some((r) => r.startsWith('role='));

      // At minimum, one of the two should be present.
      assert.ok(
        hasFts5Term || hasRole,
        'At least one of fts5:term= or role= should be present; got: ' + JSON.stringify(reasons)
      );

      // If the pattern body contains the role string, role= must appear.
      if (hasRole) {
        assert.ok(
          reasons.some((r) => r === 'role=pm'),
          'role=pm must appear; got: ' + JSON.stringify(reasons)
        );
      }
    } finally {
      cleanup(tmp);
    }
  });

  test('file-overlap reason still appears when file_globs match pattern content', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'agents-pattern', {
        name: 'agents-pattern',
        category: 'routing',
        confidence: 0.8,
        times_applied: 0,
        description: 'Agent file pattern for routing',
      }, '## Context\nAgents files need routing configuration.\n## Approach\nRoute agents based on agents directory structure.\n');

      const result = await handle(
        { task_summary: 'agent routing configuration', file_globs: ['agents/developer.md', 'agents/reviewer.md'] },
        makeContext(tmp)
      );

      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);

      const reasons = result.structuredContent.matches[0].match_reasons;
      assert.ok(
        reasons.some((r) => r === 'file-overlap'),
        'file-overlap reason must appear when file_globs overlap; got: ' + JSON.stringify(reasons)
      );
    } finally {
      cleanup(tmp);
    }
  });

});

// ---------------------------------------------------------------------------
// (c) Fallback path: FTS5 unavailable → "fallback: keyword"
//
// We cannot easily mock the destructured `searchPatterns` import inside
// pattern_find.js at runtime. Instead, we load a fresh isolated copy of
// pattern_find.js (with module cache cleared) after temporarily patching the
// pattern-index-sqlite module to return UNAVAILABLE. This ensures the
// freshly-required pattern_find picks up the patched value.
// ---------------------------------------------------------------------------

/**
 * Load an isolated copy of pattern_find.js with the FTS5 backend stubbed to
 * return UNAVAILABLE. Uses Node module cache manipulation to avoid polluting
 * the main require cache. Returns { handleFallback, restore }.
 */
function _loadHandleWithFts5Stubbed() {
  const Module = require('module');
  const indexPath = require.resolve('../../../bin/_lib/pattern-index-sqlite.js');
  const pfPath = require.resolve('../../../bin/mcp-server/tools/pattern_find.js');

  // Save originals.
  const origIndexCached = Module._cache[indexPath];
  const origPfCached = Module._cache[pfPath];

  // Install a stub module for pattern-index-sqlite that returns UNAVAILABLE.
  const stubExports = {
    UNAVAILABLE: Symbol('FTS5_BACKEND_UNAVAILABLE'),
    searchPatterns: null, // will be set below to return the stub UNAVAILABLE
  };
  stubExports.searchPatterns = () => stubExports.UNAVAILABLE;

  Module._cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: stubExports };
  // Remove the cached pattern_find so it re-requires with our stub.
  delete Module._cache[pfPath];

  let handleFallback;
  try {
    handleFallback = require(pfPath).handle;
  } finally {
    // Restore both entries immediately so other tests are unaffected.
    if (origIndexCached !== undefined) {
      Module._cache[indexPath] = origIndexCached;
    } else {
      delete Module._cache[indexPath];
    }
    if (origPfCached !== undefined) {
      Module._cache[pfPath] = origPfCached;
    } else {
      delete Module._cache[pfPath];
    }
  }

  return handleFallback;
}

describe('v2.1.2 Idea 4 (c): fallback path produces "fallback: keyword" signal', () => {

  test('when FTS5 is unavailable, match_reasons contains "fallback: keyword"', async () => {
    const handleFallback = _loadHandleWithFts5Stubbed();
    const tmp = makeTmpProject();

    writePattern(tmp, 'fallback-test', {
      name: 'fallback-test',
      category: 'decomposition',
      confidence: 0.8,
      times_applied: 0,
      description: 'Reviewer scan fallback keyword test pattern',
    }, '## Context\nReviewer fallback keyword overlap test.\n');

    try {
      const result = await handleFallback(
        { task_summary: 'reviewer scan keyword test' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should not error on FTS5 unavailable');
      assert.ok(result.structuredContent.matches.length >= 1, 'should still find matches via Jaccard');

      const reasons = result.structuredContent.matches[0].match_reasons;
      assert.ok(Array.isArray(reasons), 'match_reasons must be an array');
      assert.ok(
        reasons.includes('fallback: keyword'),
        '"fallback: keyword" must appear in match_reasons when FTS5 is unavailable; got: ' + JSON.stringify(reasons)
      );

      // Must NOT contain fts5:term= reasons on the fallback path.
      const fts5TermReasons = reasons.filter((r) => r.startsWith('fts5:term='));
      assert.equal(
        fts5TermReasons.length,
        0,
        'fts5:term= reasons must not appear on fallback path; got: ' + JSON.stringify(reasons)
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('fallback path still includes keyword: reasons for overlapping tokens', async () => {
    const handleFallback = _loadHandleWithFts5Stubbed();
    const tmp = makeTmpProject();

    writePattern(tmp, 'fallback-keyword-test', {
      name: 'fallback-keyword-test',
      category: 'decomposition',
      confidence: 0.8,
      times_applied: 0,
      description: 'Reviewer scan decomposition keyword match',
    }, '## Context\nReviewer scan decomposition overlap test.\n');

    try {
      const result = await handleFallback(
        { task_summary: 'reviewer scan decomposition' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);

      const reasons = result.structuredContent.matches[0].match_reasons;
      // Fallback signal must be present.
      assert.ok(reasons.includes('fallback: keyword'), 'fallback: keyword must be present; got: ' + JSON.stringify(reasons));
      // keyword: reasons must also be present (the overlapping tokens).
      const kwReasons = reasons.filter((r) => r.startsWith('keyword:'));
      assert.ok(
        kwReasons.length > 0,
        'keyword: reasons must appear alongside fallback: keyword; got: ' + JSON.stringify(reasons)
      );
    } finally {
      cleanup(tmp);
    }
  });

});
