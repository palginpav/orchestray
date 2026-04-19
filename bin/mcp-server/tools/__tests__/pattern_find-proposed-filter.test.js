#!/usr/bin/env node
'use strict';

/**
 * Tests for the proposed-pattern filter in pattern_find (v2.1.6 W4).
 *
 * Covers:
 *   - Default call excludes files under .orchestray/proposed-patterns/.
 *   - include_proposed: true makes proposed entries appear; they carry
 *     proposed: true and uri 'orchestray:proposed-pattern://...'.
 *   - Path-based filter excludes a file even if it has proposed: false in
 *     frontmatter but lives under proposed-patterns/ (belt-and-suspenders).
 *   - Existing pattern_find input shape is not regressed (no new required fields).
 *
 * Note on federation: getSharedPatternsDir() reads the global ~/.orchestray
 * config and may inject shared-tier patterns from the real corpus into each
 * call. Tests use distinctive random tokens in both task_summary and description
 * so the proposed entry scores higher than any real pattern by keyword overlap.
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/pattern_find-proposed-filter.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle } = require('../pattern_find.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pf-proposed-'));
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
 * Write a pattern file. description is used for both the frontmatter `description`
 * and the body ## Context section so keyword scoring can match it.
 */
function writePattern(dir, slug, { description = 'test pattern', proposed = null } = {}) {
  const lines = [
    '---',
    `name: ${slug}`,
    'category: decomposition',
    'confidence: 0.8',
    `description: ${description}`,
  ];
  if (proposed !== null) {
    lines.push(`proposed: ${proposed}`);
  }
  lines.push('---', '', `## Context\n${description}\n`);
  fs.writeFileSync(path.join(dir, slug + '.md'), lines.join('\n'), 'utf8');
}

/**
 * Generate a unique token that is very unlikely to appear in real patterns.
 */
function uniqueToken() {
  return 'zkw' + Math.random().toString(36).slice(2, 10) + 'xqz';
}

async function callHandle(projectRoot, extraInput = {}) {
  const input = { task_summary: 'pattern retrieval test', max_results: 10, ...extraInput };
  return handle(input, { projectRoot });
}

function getSlugs(result) {
  return result.structuredContent.matches.map((m) => m.slug);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern_find: proposed-pattern filter (W4)', () => {

  test('default call does NOT include proposed-patterns/ entries', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
    writePattern(proposedDir, 'staged-proposal', {
      description: token + ' staged proposal exclusion test ' + token,
      proposed: true,
    });

    // Use the token as task_summary so it would score if not filtered.
    const result = await callHandle(projectRoot, {
      task_summary: token + ' staged proposal',
      max_results: 10,
    });
    assert.equal(result.isError, false, 'expected success result');

    const slugs = getSlugs(result);
    assert.ok(
      !slugs.includes('staged-proposal'),
      'proposed pattern must NOT appear in default results, got: ' + slugs.join(', ')
    );
  });

  test('include_proposed: true includes proposed-patterns/ entries', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
    writePattern(proposedDir, 'staged-abc-proposal', {
      description: token + ' staged proposal inclusion test ' + token,
      proposed: true,
    });

    // Use the token so the proposed entry gets high Jaccard score.
    const result = await callHandle(projectRoot, {
      task_summary: token + ' staged proposal',
      max_results: 10,
      include_proposed: true,
    });
    assert.equal(result.isError, false);

    const slugs = getSlugs(result);
    assert.ok(
      slugs.includes('staged-abc-proposal'),
      'proposed pattern should appear when include_proposed:true, got slugs: ' + slugs.join(', ')
    );
  });

  test('proposed entry carries proposed: true and proposed-pattern URI', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
    writePattern(proposedDir, 'uri-check-proposal', {
      description: token + ' uri check proposal test ' + token,
      proposed: true,
    });

    const result = await callHandle(projectRoot, {
      task_summary: token + ' uri check proposal',
      max_results: 10,
      include_proposed: true,
    });
    assert.equal(result.isError, false);

    const entry = result.structuredContent.matches.find((m) => m.slug === 'uri-check-proposal');
    assert.ok(entry, 'uri-check-proposal should appear in results; got: ' +
      getSlugs(result).join(', '));
    assert.equal(entry.proposed, true, 'entry.proposed should be true');
    assert.ok(
      entry.uri.startsWith('orchestray:proposed-pattern://'),
      'uri should use proposed-pattern:// namespace, got: ' + entry.uri
    );
  });

  test('path-based filter excludes proposed-patterns/ file even with proposed: false frontmatter', async (t) => {
    // Belt-and-suspenders: file is under proposed-patterns/ but frontmatter says proposed: false.
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
    writePattern(proposedDir, 'belt-suspenders-xyz', {
      description: token + ' belt suspenders path filter test ' + token,
      proposed: false, // frontmatter says false, but path is still proposed-patterns/
    });

    const result = await callHandle(projectRoot, {
      task_summary: token + ' belt suspenders',
      max_results: 10,
    });
    assert.equal(result.isError, false);

    const slugs = getSlugs(result);
    assert.ok(
      !slugs.includes('belt-suspenders-xyz'),
      'file under proposed-patterns/ should be excluded regardless of proposed flag'
    );
  });

  test('no regression: existing call shape works without include_proposed', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const result = await callHandle(projectRoot, {
      task_summary: 'routing decision for haiku model',
      max_results: 5,
    });
    assert.equal(result.isError, false, 'should succeed without include_proposed');
    assert.ok(Array.isArray(result.structuredContent.matches), 'matches should be an array');
  });

  test('include_proposed: false is equivalent to omitting the field', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const token = uniqueToken();
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
    writePattern(proposedDir, 'omit-vs-false-proposal', {
      description: token + ' omit vs false test ' + token,
      proposed: true,
    });

    const resultDefault = await callHandle(projectRoot, {
      task_summary: token,
      max_results: 10,
    });
    const resultExplicit = await callHandle(projectRoot, {
      task_summary: token,
      max_results: 10,
      include_proposed: false,
    });

    assert.equal(resultDefault.isError, false);
    assert.equal(resultExplicit.isError, false);

    // Both should exclude the proposed slug.
    assert.ok(!getSlugs(resultDefault).includes('omit-vs-false-proposal'),
      'default should exclude proposed');
    assert.ok(!getSlugs(resultExplicit).includes('omit-vs-false-proposal'),
      'explicit false should exclude proposed');
  });

  test('active pattern in patterns/ is not tagged as proposed', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const activeToken = uniqueToken();
    const proposedToken = uniqueToken();

    const activeDir = path.join(projectRoot, '.orchestray', 'patterns');
    const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');

    writePattern(activeDir, 'confirmed-active-abc', {
      description: activeToken + ' active pattern unique desc',
    });
    writePattern(proposedDir, 'pending-staged-abc', {
      description: proposedToken + ' proposed pattern unique desc',
      proposed: true,
    });

    // Query for proposed token with include_proposed: true — the proposed entry
    // should score high enough to appear.
    const result = await callHandle(projectRoot, {
      task_summary: proposedToken + ' proposed pattern unique',
      max_results: 10,
      include_proposed: true,
    });
    assert.equal(result.isError, false);

    const proposedEntry = result.structuredContent.matches.find((m) => m.slug === 'pending-staged-abc');
    assert.ok(proposedEntry, 'proposed entry should appear in results when queried with its token; ' +
      'got: ' + getSlugs(result).join(', '));
    assert.equal(proposedEntry.proposed, true, 'proposed entry should be tagged');
    assert.ok(proposedEntry.uri.includes('proposed-pattern://'), 'proposed entry should use proposed URI');
  });

});
