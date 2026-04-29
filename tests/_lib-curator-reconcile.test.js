#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/curator-reconcile.js + writeTombstone schema_version.
 *
 * Runner: node --test tests/_lib-curator-reconcile.test.js
 *
 * Coverage:
 *   1. writeTombstone stamps `schema_version: 2` on every new tombstone
 *   2. reconcile resolves shared-tier paths from output.path (handles
 *      `{category}-{slug}.md` filenames; the v2.2.10 bug)
 *   3. reconcile falls back to slug-suffix scan when output.path is unusable
 *   4. reconcile expands `~/` in output.path
 *   5. reconcile flags absent shared-tier files for pre-v2.1.6 tombstones
 *   6. reconcile no longer false-flags v2.1.6+ tombstones for present files
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const path               = require('node:path');
const os                 = require('node:os');

const { reconcile } = require('../bin/_lib/curator-reconcile.js');
const {
  writeTombstone,
  startRun,
  listTombstones,
} = require('../bin/_lib/curator-tombstone.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reconcile-test-'));
}
function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeSharedDir(root) {
  const d = path.join(root, 'shared', 'patterns');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------------------
// 1. writeTombstone stamps schema_version: 2
// ---------------------------------------------------------------------------

describe('writeTombstone schema_version stamp', () => {
  test('every new tombstone carries schema_version: 2 at the top level', () => {
    const dir   = makeTmpDir();
    const opts  = { projectRoot: dir };
    const runId = startRun(opts);

    writeTombstone(runId, {
      action:  'promote',
      inputs:  [{ slug: 'pat-a', path: 'foo.md', content_sha256: 'x', content_snapshot: '---\nname: pat-a\n---\n' }],
      output:  { path: '~/shared/patterns/anti-pattern-pat-a.md', action_summary: 'promoted' },
    }, opts);

    const { rows } = listTombstones({ only_run_id: runId, projectRoot: dir, include_archive: false });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].schema_version, 2,
      'new tombstones must carry schema_version: 2 so the v2.1.6 reconciler gate works');

    cleanupDir(dir);
  });

  test('caller-supplied schema_version cannot override the writer stamp', () => {
    const dir   = makeTmpDir();
    const opts  = { projectRoot: dir };
    const runId = startRun(opts);

    writeTombstone(runId, {
      schema_version: 1,
      action:  'deprecate',
      inputs:  [{ slug: 'pat-b', path: 'foo.md', content_sha256: 'x', content_snapshot: 'x' }],
      output:  { path: '/tmp/foo.md', action_summary: 'deprecated' },
    }, opts);

    const { rows } = listTombstones({ only_run_id: runId, projectRoot: dir, include_archive: false });
    assert.strictEqual(rows[0].schema_version, 2,
      'writer override block must clobber any caller-supplied schema_version');

    cleanupDir(dir);
  });
});

// ---------------------------------------------------------------------------
// 2-6. reconcile path resolution
// ---------------------------------------------------------------------------

describe('reconcile shared-tier path resolution', () => {
  test('regression: output.path pointing at {category}-{slug}.md is honoured (not flagged)', () => {
    // Reproduces the v2.2.10 bug: reconcile built `{slug}.md` and ignored
    // output.path, missing every file named `{category}-{slug}.md` and
    // tripping the schema_version gate as a false positive.
    const dir       = makeTmpDir();
    const sharedDir = makeSharedDir(dir);
    const opts      = { projectRoot: dir };
    const runId     = startRun(opts);

    const fileName = 'anti-pattern-doesnotthrow-only-masks-behavior.md';
    fs.writeFileSync(path.join(sharedDir, fileName), '---\nname: x\n---\n', 'utf8');

    writeTombstone(runId, {
      action:  'promote',
      inputs:  [{ slug: 'doesnotthrow-only-masks-behavior',
                  path: '.orchestray/patterns/' + fileName,
                  content_sha256: 'abc', content_snapshot: '---\nname: x\n---\n' }],
      output:  { path: path.join(sharedDir, fileName), action_summary: 'promoted' },
    }, opts);

    const result = reconcile({ projectRoot: dir, sharedDir });
    assert.strictEqual(result.flagged.length, 0, 'present file must not flag — output.path is authoritative');

    cleanupDir(dir);
  });

  test('legacy tombstone (no output.path) → slug-suffix scan finds {category}-{slug}.md', () => {
    // Defense-in-depth: legacy tombstones omit output.path. The slug-suffix
    // fallback must scan sharedDir for any `*-{slug}.md` filename.
    const dir       = makeTmpDir();
    const sharedDir = makeSharedDir(dir);
    const opts      = { projectRoot: dir };
    const runId     = startRun(opts);

    const fileName = 'anti-pattern-legacy-pat.md';
    fs.writeFileSync(path.join(sharedDir, fileName), '---\nname: legacy-pat\n---\n', 'utf8');

    // Hand-craft a legacy-shape tombstone (omits output.path).
    const tombstonesPath = path.join(dir, '.orchestray', 'curator', 'tombstones.jsonl');
    fs.mkdirSync(path.dirname(tombstonesPath), { recursive: true });
    const legacyRow = {
      ts:        new Date().toISOString(),
      orch_id:   runId,
      action_id: runId + '-a001',
      action:    'promote',
      schema_version: 2,
      inputs:    [{ slug: 'legacy-pat', path: 'irrelevant',
                    content_sha256: 'x', content_snapshot: 'x' }],
      output:    { path: '', action_summary: 'promoted' },
    };
    fs.writeFileSync(tombstonesPath, JSON.stringify(legacyRow) + '\n', 'utf8');

    const result = reconcile({ projectRoot: dir, sharedDir });
    assert.strictEqual(result.flagged.length, 0, 'slug-suffix fallback must locate the file');

    cleanupDir(dir);
  });

  test('output.path with ~/ is expanded to the real home directory', () => {
    // Place a file in ~/.orchestray/curator-reconcile-test-XXX/ and point
    // output.path at it via ~/ to verify expansion.
    const tmpName  = 'orch-reconcile-home-' + Date.now();
    const homeDir  = path.join(os.homedir(), tmpName);
    fs.mkdirSync(homeDir, { recursive: true });
    const fileName = 'anti-pattern-home-test.md';
    fs.writeFileSync(path.join(homeDir, fileName), '---\nname: home-test\n---\n', 'utf8');

    try {
      const dir   = makeTmpDir();
      const opts  = { projectRoot: dir };
      const runId = startRun(opts);

      writeTombstone(runId, {
        action:  'promote',
        inputs:  [{ slug: 'home-test', path: '.orchestray/patterns/anti-pattern-home-test.md',
                    content_sha256: 'x', content_snapshot: 'x' }],
        output:  { path: '~/' + tmpName + '/' + fileName, action_summary: 'promoted' },
      }, opts);

      const result = reconcile({ projectRoot: dir, sharedDir: path.join(dir, 'unused-shared-dir') });
      assert.strictEqual(result.flagged.length, 0, '~/ in output.path must be expanded');
      assert.strictEqual(result.checked, 1);

      cleanupDir(dir);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('absent shared-tier file with old tombstone (no schema_version) → flagged', () => {
    const dir       = makeTmpDir();
    const sharedDir = makeSharedDir(dir);
    const opts      = { projectRoot: dir };
    const runId     = startRun(opts);

    // Hand-craft a legacy-shape tombstone (no schema_version), bypassing writeTombstone.
    const tombstonesPath = path.join(dir, '.orchestray', 'curator', 'tombstones.jsonl');
    fs.mkdirSync(path.dirname(tombstonesPath), { recursive: true });
    const legacyRow = {
      ts:        new Date().toISOString(),
      orch_id:   runId,
      action_id: runId + '-a001',
      action:    'promote',
      inputs:    [{ slug: 'absent-pat', path: 'foo.md',
                    content_sha256: 'x', content_snapshot: 'x' }],
      output:    { path: path.join(sharedDir, 'absent-pat.md'), action_summary: 'promoted' },
      // NOTE: no schema_version field — pre-v2.1.6 shape
    };
    fs.writeFileSync(tombstonesPath, JSON.stringify(legacyRow) + '\n', 'utf8');

    const result = reconcile({ projectRoot: dir, sharedDir });
    assert.strictEqual(result.flagged.length, 1, 'absent file + legacy tombstone must flag');
    assert.match(result.flagged[0].detail, /schema_version_pre_v216/);

    cleanupDir(dir);
  });

  test('absent shared-tier file with new tombstone (schema_version=2) → not gated by schema check', () => {
    const dir       = makeTmpDir();
    const sharedDir = makeSharedDir(dir);
    const opts      = { projectRoot: dir };
    const runId     = startRun(opts);

    writeTombstone(runId, {
      action:  'promote',
      inputs:  [{ slug: 'absent-pat-new', path: 'foo.md',
                  content_sha256: 'x', content_snapshot: 'x' }],
      output:  { path: path.join(sharedDir, 'specialization-absent-pat-new.md'), action_summary: 'promoted' },
    }, opts);

    const result = reconcile({ projectRoot: dir, sharedDir });
    assert.strictEqual(result.flagged.length, 1, 'absent file still flags (auto-repair disabled)');
    // But the detail must NOT cite pre_v216 — the new tombstone passes the schema gate.
    assert.doesNotMatch(result.flagged[0].detail, /pre_v216/);
    assert.match(result.flagged[0].detail, /auto.repair/);

    cleanupDir(dir);
  });
});
