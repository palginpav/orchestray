#!/usr/bin/env node
'use strict';

/**
 * T-04: proposed-patterns exclusion from FTS5 index (v2.1.6 W4).
 *
 * Verifies:
 *   - A file in .orchestray/proposed-patterns/ is NEVER indexed by _buildIndex /
 *     searchPatterns, even if FTS5 is invoked on a projectRoot that contains both
 *     directories.
 *   - A normal .orchestray/patterns/ file IS indexed (positive control).
 *
 * Runner: node --test bin/_lib/__tests__/pattern-index-sqlite-proposed-exclusion.test.js
 *
 * Isolation contract: each test creates its own tmp projectRoot. The module-level
 * _dbCache is effectively isolated by using distinct tmp dirs so a fresh db is opened
 * per test. Real ~/.orchestray/ is never touched.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { searchPatterns, UNAVAILABLE } = require('../pattern-index-sqlite.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated tmp project root with both directory variants.
 */
function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-proposed-excl-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'proposed-patterns'), { recursive: true });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

/**
 * Write a minimal pattern file to .orchestray/patterns/.
 */
function writeActivePattern(projectRoot, slug, { body = '', description = 'active pattern' } = {}) {
  const content = [
    '---',
    `name: ${slug}`,
    'category: decomposition',
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

/**
 * Write a file to .orchestray/proposed-patterns/ simulating a staged proposal.
 */
function writeProposedPattern(projectRoot, slug, { body = '', description = 'proposed pattern' } = {}) {
  const content = [
    '---',
    `name: ${slug}`,
    'category: decomposition',
    'confidence: 0.5',
    `description: ${description}`,
    'proposed: true',
    `proposed_at: ${new Date().toISOString()}`,
    'proposed_from: orch-test-001',
    '---',
    '',
    body,
  ].join('\n');
  fs.writeFileSync(
    path.join(projectRoot, '.orchestray', 'proposed-patterns', slug + '.md'),
    content,
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Skip helper: if FTS5 is unavailable (no SQLite runtime), skip gracefully.
// ---------------------------------------------------------------------------

function isFts5Available(projectRoot) {
  try {
    const result = searchPatterns('test', { projectRoot, limit: 1 });
    return result !== UNAVAILABLE && Array.isArray(result);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern-index-sqlite: proposed-patterns exclusion (W4 T-04)', () => {

  test('T-04a: proposed-patterns file is NOT returned by searchPatterns', (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    // Write a proposed file with a distinctive token.
    const distinctiveToken = 'xyzzyghosttoken9001';
    writeProposedPattern(projectRoot, 'recovery-ghost-pattern', {
      description: `proposed description ${distinctiveToken}`,
      body: `## Context\nThis is a ghost pattern with ${distinctiveToken} that must not be indexed.\n`,
    });

    if (!isFts5Available(projectRoot)) {
      t.skip('FTS5 backend unavailable — skipping FTS5-specific assertion');
      return;
    }

    const results = searchPatterns(distinctiveToken, { projectRoot, limit: 20 });

    // The proposed-patterns file must never appear in FTS5 results.
    assert.equal(
      results.length, 0,
      `Expected 0 results for "${distinctiveToken}" but got ${results.length}: ` +
      JSON.stringify(results.map((r) => r.slug))
    );
  });

  test('T-04b: active pattern IS indexed (positive control)', (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const distinctiveToken = 'alphaactivetoken7777';
    writeActivePattern(projectRoot, 'decomposition-active-real', {
      description: `active description ${distinctiveToken}`,
      body: `## Context\nThis is a real pattern with ${distinctiveToken} that should be indexed.\n`,
    });

    if (!isFts5Available(projectRoot)) {
      t.skip('FTS5 backend unavailable — skipping FTS5-specific assertion');
      return;
    }

    const results = searchPatterns(distinctiveToken, { projectRoot, limit: 20 });

    assert.ok(
      results.length > 0,
      `Expected ≥1 result for "${distinctiveToken}" but got 0`
    );
    assert.ok(
      results.some((r) => r.slug === 'decomposition-active-real'),
      `Expected slug "decomposition-active-real" in results, got: ${results.map((r) => r.slug).join(', ')}`
    );
  });

  test('T-04c: both proposed and active exist — only active is returned', (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const proposedToken = 'proposedtoken2222xyz';
    const activeToken = 'activetoken3333abc';

    writeProposedPattern(projectRoot, 'strategy-staged-proposal', {
      description: `staged proposal ${proposedToken}`,
      body: `## Context\n${proposedToken}\n`,
    });

    writeActivePattern(projectRoot, 'decomposition-real-pattern', {
      description: `real active pattern ${activeToken}`,
      body: `## Context\n${activeToken}\n`,
    });

    if (!isFts5Available(projectRoot)) {
      t.skip('FTS5 backend unavailable — skipping FTS5-specific assertion');
      return;
    }

    // Query for the proposed token — should return nothing.
    const proposedResults = searchPatterns(proposedToken, { projectRoot, limit: 20 });
    assert.equal(
      proposedResults.length, 0,
      `Proposed token "${proposedToken}" should not be indexed, got: ` +
      JSON.stringify(proposedResults.map((r) => r.slug))
    );

    // Query for the active token — should return the active pattern.
    const activeResults = searchPatterns(activeToken, { projectRoot, limit: 20 });
    assert.ok(
      activeResults.some((r) => r.slug === 'decomposition-real-pattern'),
      `Active pattern should be found for token "${activeToken}"`
    );
  });

  test('T-04d: file with proposed:true in .orchestray/patterns/ is also excluded', (t) => {
    // Belt-and-suspenders: even if someone accidentally placed a proposed:true
    // file inside the active patterns dir, the secondary guard skips it.
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const proposedToken = 'accidentalproposedtoken8888';
    // Write a file with proposed: true directly in patterns/ (misconfigured).
    const content = [
      '---',
      'name: accidental-proposed',
      'category: routing',
      'confidence: 0.5',
      `description: accidental proposed file ${proposedToken}`,
      'proposed: true',
      '---',
      '',
      `## Context\n${proposedToken}\n`,
    ].join('\n');
    fs.writeFileSync(
      path.join(projectRoot, '.orchestray', 'patterns', 'accidental-proposed.md'),
      content,
      'utf8'
    );

    if (!isFts5Available(projectRoot)) {
      t.skip('FTS5 backend unavailable — skipping FTS5-specific assertion');
      return;
    }

    const results = searchPatterns(proposedToken, { projectRoot, limit: 20 });
    assert.equal(
      results.length, 0,
      `File with proposed:true should not be indexed, got: ` +
      JSON.stringify(results.map((r) => r.slug))
    );
  });

});
