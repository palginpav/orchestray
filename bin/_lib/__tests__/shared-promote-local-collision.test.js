#!/usr/bin/env node
'use strict';

/**
 * Tests for the W6 local collision pre-check in bin/_lib/shared-promote.js.
 *
 * The collision check runs AFTER all sanitization stages. It compares:
 *   - The body of the EXISTING shared-tier file (~/.orchestray/shared/patterns/<slug>.md)
 *   - Against the sanitized body being promoted now.
 *
 * If those differ → emit pattern_collision_local_warn (warn only; promote continues).
 * If no existing shared file → no check.
 * If local file has deprecated: true → skip check.
 * If hashes match → no warning.
 *
 * Covers:
 *   1. Existing shared file identical to newly promoted body → no warning.
 *   2. Existing shared file with different body → pattern_collision_local_warn emitted;
 *      promote still succeeds.
 *   3. Local file marked deprecated: true → no warning even if bodies differ.
 *   4. No existing shared file → no warning (control; first-ever promote).
 *   5. _bodyHash: CRLF normalisation.
 *   6. _localCollisionCheck: no local pattern file → no warning.
 *
 * Runner: node --test bin/_lib/__tests__/shared-promote-local-collision.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const os       = require('node:os');

const { promotePattern, _bodyHash, _localCollisionCheck } = require('../shared-promote.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject({ sensitivity = 'shareable' } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-collision-test-'));
  fs.mkdirSync(path.join(projectDir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.orchestray', 'audit'), { recursive: true });

  const config = {
    federation: {
      shared_dir_enabled: true,
      sensitivity,
      shared_dir_path: '~/.orchestray/shared',
    },
  };
  fs.writeFileSync(
    path.join(projectDir, '.orchestray', 'config.json'),
    JSON.stringify(config),
    'utf8'
  );

  // Create isolated shared dir.
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-collision-shared-'));
  fs.mkdirSync(path.join(sharedDir, 'patterns'), { recursive: true });

  return { projectDir, sharedDir };
}

function writePattern(projectDir, slug, { frontmatter = {}, body = '### Section\n\nContent.\n' } = {}) {
  const fm = Object.assign(
    { name: slug, category: 'decomposition', confidence: 0.8, description: 'Test pattern' },
    frontmatter
  );
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  const content = `---\n${fmLines}\n---\n\n${body}`;
  const p = path.join(projectDir, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** Write a file directly into the (isolated) shared patterns dir. */
function writeSharedPattern(sharedDir, slug, content) {
  const p = path.join(sharedDir, 'patterns', slug + '.md');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

async function runPromote(slug, projectDir, sharedDir, extraOpts = {}) {
  const prev = process.env.ORCHESTRAY_TEST_SHARED_DIR;
  process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedDir;
  try {
    return await promotePattern(slug, { cwd: projectDir, ...extraOpts });
  } finally {
    if (prev === undefined) {
      delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    } else {
      process.env.ORCHESTRAY_TEST_SHARED_DIR = prev;
    }
  }
}

function readEvents(projectDir) {
  const eventsPath = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');
  try {
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_e) {
    return [];
  }
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// 1. Identical shared body → no warning
// ---------------------------------------------------------------------------

test('identical shared body: no pattern_collision_local_warn event', async () => {
  const { projectDir, sharedDir } = makeTmpProject();
  try {
    const body = '### Context\n\nPatterns context text here.\n';
    // First promote: establishes shared version.
    writePattern(projectDir, 'same-slug', { body });
    const first = await runPromote('same-slug', projectDir, sharedDir);
    assert.equal(first.ok, true, 'first promote should succeed');

    // Second promote: same body → no collision.
    writePattern(projectDir, 'same-slug', { body });
    const second = await runPromote('same-slug', projectDir, sharedDir);
    assert.equal(second.ok, true, 'second promote should succeed');

    const events = readEvents(projectDir);
    const collision = events.filter((e) => e.type === 'pattern_collision_local_warn');
    assert.equal(collision.length, 0, 'no collision event for re-promote with same body');
  } finally {
    cleanup(projectDir, sharedDir);
  }
});

// ---------------------------------------------------------------------------
// 2. Different shared body → warn event; promote still succeeds
// ---------------------------------------------------------------------------

test('different shared body: pattern_collision_local_warn emitted, promote succeeds', async () => {
  const { projectDir, sharedDir } = makeTmpProject();
  try {
    const originalBody = '### Original\n\nOriginal shared content.\n';
    const newBody      = '### Updated\n\nDifferent content for the new version.\n';

    // Establish a shared version with originalBody.
    writeSharedPattern(sharedDir, 'change-slug',
      `---\nname: change-slug\ncategory: decomposition\nconfidence: 0.8\ndescription: Test\norigin: shared\npromoted_at: 2026-01-01\npromoted_from: abcdef01\n---\n\n${originalBody}`
    );

    // Now promote with a different body.
    writePattern(projectDir, 'change-slug', { body: newBody });
    const result = await runPromote('change-slug', projectDir, sharedDir);
    assert.equal(result.ok, true, 'promote should still succeed despite collision warning');

    const events = readEvents(projectDir);
    const collision = events.filter((e) => e.type === 'pattern_collision_local_warn');
    assert.equal(collision.length, 1, 'one collision warning event expected');
    assert.equal(collision[0].slug, 'change-slug');
    assert.ok(typeof collision[0].local_hash === 'string');
    assert.ok(typeof collision[0].promoted_hash === 'string');
    assert.notEqual(collision[0].local_hash, collision[0].promoted_hash);
  } finally {
    cleanup(projectDir, sharedDir);
  }
});

// ---------------------------------------------------------------------------
// 3. Deprecated local file → no warning
// ---------------------------------------------------------------------------

test('deprecated local file: no collision warning even if shared body differs', async () => {
  const { projectDir, sharedDir } = makeTmpProject();
  try {
    const originalBody = '### Original\n\nShared content.\n';
    const newBody      = '### New\n\nDifferent local deprecated content.\n';

    // Establish a shared version.
    writeSharedPattern(sharedDir, 'deprecated-slug',
      `---\nname: deprecated-slug\ncategory: decomposition\nconfidence: 0.8\ndescription: Test\norigin: shared\npromoted_at: 2026-01-01\npromoted_from: abcdef01\n---\n\n${originalBody}`
    );

    // Local file is deprecated.
    writePattern(projectDir, 'deprecated-slug', {
      body: newBody,
      frontmatter: { deprecated: true, deprecated_at: '2026-03-01', deprecated_reason: 'superseded' },
    });

    const result = await runPromote('deprecated-slug', projectDir, sharedDir);
    assert.equal(result.ok, true, 'promote should succeed');

    const events = readEvents(projectDir);
    const collision = events.filter((e) => e.type === 'pattern_collision_local_warn');
    assert.equal(collision.length, 0, 'no warning for deprecated local file');
  } finally {
    cleanup(projectDir, sharedDir);
  }
});

// ---------------------------------------------------------------------------
// 4. No existing shared file → no warning (first-ever promote)
// ---------------------------------------------------------------------------

test('no existing shared file: no collision warning on first promote', async () => {
  const { projectDir, sharedDir } = makeTmpProject();
  try {
    writePattern(projectDir, 'brand-new', { body: '### New\n\nFresh content.\n' });
    const result = await runPromote('brand-new', projectDir, sharedDir);
    assert.equal(result.ok, true);

    const events = readEvents(projectDir);
    const collision = events.filter((e) => e.type === 'pattern_collision_local_warn');
    assert.equal(collision.length, 0, 'no collision warning for first-ever promote');
  } finally {
    cleanup(projectDir, sharedDir);
  }
});

// ---------------------------------------------------------------------------
// 5. Direct test: _localCollisionCheck with non-existent local file
// ---------------------------------------------------------------------------

test('_localCollisionCheck: non-existent local pattern file → no warning', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.orchestray', 'patterns'), { recursive: true });

    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg) => { stderrLines.push(String(msg)); return true; };

    const prev = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    process.env.ORCHESTRAY_TEST_SHARED_DIR = tmpDir;
    try {
      _localCollisionCheck('nonexistent-slug', 'some body content', tmpDir);
    } finally {
      process.stderr.write = origWrite;
      if (prev === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
      else process.env.ORCHESTRAY_TEST_SHARED_DIR = prev;
    }

    const warnings = stderrLines.filter((l) => l.includes('collision'));
    assert.equal(warnings.length, 0, 'no warning when local pattern file does not exist');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
});

// ---------------------------------------------------------------------------
// 6. _bodyHash: CRLF normalisation
// ---------------------------------------------------------------------------

test('_bodyHash: CRLF-normalized bodies produce same hash', () => {
  const a = 'Some body\n\nWith content\n';
  const b = 'Some body\r\n\r\nWith content\r\n';
  assert.equal(_bodyHash(a), _bodyHash(b));
});

test('_bodyHash: different content produces different hash', () => {
  assert.notEqual(_bodyHash('Body A\n'), _bodyHash('Body B\n'));
});
