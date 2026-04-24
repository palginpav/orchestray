#!/usr/bin/env node
'use strict';

/**
 * Tests for the `sharing: local-only` frontmatter flag (R-FED-PRIVACY, v2.1.13 W6).
 *
 * Covers:
 *   (a) Absent `sharing` key → treated as federated (back-compat): shared-tier
 *       pattern without the field is surfaced through federation reads.
 *   (b) `sharing: local-only` → excluded from federation (shared-tier) reads.
 *   (c) `sharing: local-only` → included in local reads (the owning project
 *       still sees its own local-only patterns through pattern_find).
 *
 * Also sanity-checks the exported `_isFederationContext` helper.
 *
 * Runner: node --test tests/unit/sharing-flag.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handle, _isFederationContext } = require('../../bin/mcp-server/tools/pattern_find.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-sharing-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true });
  return projectRoot;
}

function makeTmpSharedDir() {
  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shared-'));
  fs.mkdirSync(path.join(sharedRoot, 'patterns'), { recursive: true });
  return sharedRoot;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

function uniqueToken() {
  return 'zfp' + Math.random().toString(36).slice(2, 10) + 'qxj';
}

/**
 * Write a pattern file into `dir`. `sharingValue` may be:
 *   - undefined  → no `sharing` key at all (absent — back-compat case)
 *   - 'federated' → explicit opt-in
 *   - 'local-only' → never leaves this machine
 */
function writePattern(dir, slug, { description, sharingValue, extraFrontmatter = {} } = {}) {
  const lines = [
    '---',
    `name: ${slug}`,
    'category: decomposition',
    'confidence: 0.9',
    `description: ${description}`,
  ];
  if (sharingValue !== undefined) {
    lines.push(`sharing: ${sharingValue}`);
  }
  for (const [k, v] of Object.entries(extraFrontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', `## Context\n${description}\n`);
  fs.writeFileSync(path.join(dir, slug + '.md'), lines.join('\n'), 'utf8');
}

function getSlugs(result) {
  return result.structuredContent.matches.map((m) => m.slug);
}

async function callHandle(projectRoot, input) {
  const fullInput = { task_summary: 'pattern retrieval test', max_results: 10, ...input };
  return handle(fullInput, { projectRoot });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern_find: sharing: local-only flag (R-FED-PRIVACY)', () => {

  test('(a) absent sharing key → shared-tier entry surfaces (backward compat)', async (t) => {
    const projectRoot = makeTmpProject();
    const sharedRoot = makeTmpSharedDir();
    const prevEnv = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedRoot;
    t.after(() => {
      if (prevEnv === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
      else process.env.ORCHESTRAY_TEST_SHARED_DIR = prevEnv;
      cleanup(projectRoot);
      cleanup(sharedRoot);
    });

    const token = uniqueToken();
    const sharedPatterns = path.join(sharedRoot, 'patterns');
    // Pre-v2.1.13 pattern has no `sharing` key at all.
    writePattern(sharedPatterns, 'legacy-no-sharing-key', {
      description: token + ' legacy shared pattern without sharing key ' + token,
    });

    const result = await callHandle(projectRoot, {
      task_summary: token + ' legacy shared pattern',
    });
    assert.equal(result.isError, false, 'expected success');
    const slugs = getSlugs(result);
    assert.ok(
      slugs.includes('legacy-no-sharing-key'),
      'pattern without sharing key must still surface from shared tier (back-compat). Got: ' +
        slugs.join(', ')
    );
  });

  test('(b) sharing: local-only in shared tier → excluded from federation reads', async (t) => {
    const projectRoot = makeTmpProject();
    const sharedRoot = makeTmpSharedDir();
    const prevEnv = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedRoot;
    t.after(() => {
      if (prevEnv === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
      else process.env.ORCHESTRAY_TEST_SHARED_DIR = prevEnv;
      cleanup(projectRoot);
      cleanup(sharedRoot);
    });

    const token = uniqueToken();
    const sharedPatterns = path.join(sharedRoot, 'patterns');
    // A pattern that somehow landed in the shared dir but is flagged local-only
    // MUST NOT be surfaced to this installation (the federation consumer).
    writePattern(sharedPatterns, 'private-should-stay-home', {
      description: token + ' private pattern stays on origin machine ' + token,
      sharingValue: 'local-only',
    });
    // Control: a federated shared-tier pattern with the same token so we know
    // the shared-tier scan is working end-to-end.
    writePattern(sharedPatterns, 'federated-control', {
      description: token + ' federated shared pattern control ' + token,
      sharingValue: 'federated',
    });

    const result = await callHandle(projectRoot, {
      task_summary: token + ' private shared pattern',
    });
    assert.equal(result.isError, false, 'expected success');
    const slugs = getSlugs(result);
    assert.ok(
      !slugs.includes('private-should-stay-home'),
      'local-only pattern in shared tier MUST NOT surface in federation reads. Got: ' +
        slugs.join(', ')
    );
    assert.ok(
      slugs.includes('federated-control'),
      'control federated shared pattern should still surface. Got: ' + slugs.join(', ')
    );
  });

  test('(c) sharing: local-only in LOCAL tier → included in local reads', async (t) => {
    const projectRoot = makeTmpProject();
    // No ORCHESTRAY_TEST_SHARED_DIR override here — the local-read path does
    // not depend on federation being enabled. We also explicitly clear the
    // env var so a developer-set global value can't leak a real shared tier
    // into this test's projectRoot.
    const prevEnv = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    t.after(() => {
      if (prevEnv !== undefined) process.env.ORCHESTRAY_TEST_SHARED_DIR = prevEnv;
      cleanup(projectRoot);
    });

    const token = uniqueToken();
    const localPatterns = path.join(projectRoot, '.orchestray', 'patterns');
    // A local pattern marked local-only: the owning project MUST still see it
    // — that's the whole point of local-only (private to this machine, not
    // invisible to this machine).
    writePattern(localPatterns, 'my-private-biz-logic', {
      description: token + ' private business logic local pattern ' + token,
      sharingValue: 'local-only',
    });

    const result = await callHandle(projectRoot, {
      task_summary: token + ' private business logic',
    });
    assert.equal(result.isError, false, 'expected success');
    const slugs = getSlugs(result);
    assert.ok(
      slugs.includes('my-private-biz-logic'),
      'local-only pattern in local tier MUST surface in local reads. Got: ' +
        slugs.join(', ')
    );
  });
});

describe('_isFederationContext helper', () => {
  test('returns true for shared-tier entry objects', () => {
    assert.equal(_isFederationContext({ _tier: 'shared' }), true);
    assert.equal(_isFederationContext('shared'), true);
  });

  test('returns false for local-tier entry objects and unknown inputs', () => {
    assert.equal(_isFederationContext({ _tier: 'local' }), false);
    assert.equal(_isFederationContext('local'), false);
    assert.equal(_isFederationContext({}), false);
    assert.equal(_isFederationContext(null), false);
    assert.equal(_isFederationContext(undefined), false);
    assert.equal(_isFederationContext(''), false);
  });
});
