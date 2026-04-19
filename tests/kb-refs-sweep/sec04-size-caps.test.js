#!/usr/bin/env node
'use strict';

/**
 * Tests for SEC-04 size-cap guards in bin/kb-refs-sweep.js.
 *
 * Verifies:
 *   - _loadKbSlugs: files > 10 MiB return null (fail-open)
 *   - _loadKbSlugs: normal-size file returns a Set
 *   - _loadSlugIgnoreFile: files > 1 MiB return [] (fail-open)
 *   - _loadSlugIgnoreFile: missing file returns []
 *   - _loadSlugIgnoreFile: normal-size file returns slug array
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshSweep() {
  // Clear module caches so each test gets a clean degraded-journal _seen set.
  for (const m of [
    '../../bin/kb-refs-sweep',
    '../../bin/_lib/degraded-journal',
  ]) {
    try { delete require.cache[require.resolve(m)]; } catch (_e) {}
  }
  return require('../../bin/kb-refs-sweep');
}

function mkKbDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbrefsweep-sec04-'));
  return dir;
}

// ---------------------------------------------------------------------------
// _loadKbSlugs: index.json size cap (10 MiB)
// ---------------------------------------------------------------------------

describe('SEC-04 — _loadKbSlugs size cap (10 MiB)', () => {
  test('index.json > 10 MiB returns null (fail-open)', () => {
    const kbDir = mkKbDir();
    const indexPath = path.join(kbDir, 'index.json');
    // Write a file that exceeds 10 MiB.
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    fs.writeFileSync(indexPath, oversize);

    const { _loadKbSlugs } = freshSweep();
    const result = _loadKbSlugs(kbDir);
    assert.equal(result, null,
      'oversize index.json must return null (fail-open, not throw)');
  });

  test('valid index.json at normal size returns a Set of slugs', () => {
    const kbDir = mkKbDir();
    const indexPath = path.join(kbDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({
      entries: [
        { slug: 'my-pattern-one' },
        { slug: 'my-pattern-two', id: 'alt-id-slug' },
      ],
    }), 'utf8');

    const { _loadKbSlugs } = freshSweep();
    const result = _loadKbSlugs(kbDir);
    assert.ok(result instanceof Set, 'normal index.json must return a Set');
    assert.ok(result.has('my-pattern-one'));
    assert.ok(result.has('my-pattern-two'));
    assert.ok(result.has('alt-id-slug'));
  });

  test('missing index.json returns null without throwing', () => {
    const kbDir = mkKbDir();
    // No index.json created.
    const { _loadKbSlugs } = freshSweep();
    const result = _loadKbSlugs(kbDir);
    assert.equal(result, null, 'missing index.json must return null');
  });
});

// ---------------------------------------------------------------------------
// _loadSlugIgnoreFile: slug-ignore.txt size cap (1 MiB)
// ---------------------------------------------------------------------------

describe('SEC-04 — _loadSlugIgnoreFile size cap (1 MiB)', () => {
  test('slug-ignore.txt > 1 MiB returns [] (fail-open, does not throw)', () => {
    const kbDir = mkKbDir();
    const ignorePath = path.join(kbDir, 'slug-ignore.txt');
    const oversize = Buffer.alloc(1024 * 1024 + 1, 'x');
    fs.writeFileSync(ignorePath, oversize);

    const { _loadSlugIgnoreFile } = freshSweep();
    const result = _loadSlugIgnoreFile(kbDir);
    assert.deepEqual(result, [],
      'oversize slug-ignore.txt must return [] (fail-open)');
  });

  test('slug-ignore.txt at exactly 1 MiB is not blocked (returns whatever slugs are found)', () => {
    const kbDir = mkKbDir();
    const ignorePath = path.join(kbDir, 'slug-ignore.txt');
    // Write exactly 1 MiB of valid content (comments + one slug).
    const slug = 'foo-bar-baz\n';
    const comment = '# padding line\n';
    const target = 1024 * 1024;
    let content = slug;
    while (Buffer.byteLength(content + comment, 'utf8') <= target) {
      content += comment;
    }
    // Ensure we are at exactly target bytes.
    const buf = Buffer.from(content, 'utf8').slice(0, target);
    fs.writeFileSync(ignorePath, buf);

    const { _loadSlugIgnoreFile } = freshSweep();
    const result = _loadSlugIgnoreFile(kbDir);
    // Must not throw and must contain the valid slug that was written.
    assert.ok(Array.isArray(result), 'must return an array');
    assert.ok(result.includes('foo-bar-baz'), 'must include the valid slug');
  });

  test('missing slug-ignore.txt returns [] without throwing', () => {
    const kbDir = mkKbDir();
    // No slug-ignore.txt file created.
    const { _loadSlugIgnoreFile } = freshSweep();
    const result = _loadSlugIgnoreFile(kbDir);
    assert.deepEqual(result, [], 'missing file must return []');
  });

  test('slug-ignore.txt with valid slugs returns them filtered', () => {
    const kbDir = mkKbDir();
    const ignorePath = path.join(kbDir, 'slug-ignore.txt');
    fs.writeFileSync(ignorePath, [
      '# comment',
      'foo-bar-baz',
      'another-slug',
      'INVALID-UPPERCASE',  // must be filtered out (shape requires lowercase start)
      'ab',                 // too short — filtered out
    ].join('\n'), 'utf8');

    const { _loadSlugIgnoreFile } = freshSweep();
    const result = _loadSlugIgnoreFile(kbDir);
    assert.ok(result.includes('foo-bar-baz'));
    assert.ok(result.includes('another-slug'));
    assert.ok(!result.includes('INVALID-UPPERCASE'));
    assert.ok(!result.includes('ab'));
  });
});

// ---------------------------------------------------------------------------
// LOW-R2-03 / Fix C: KB_REF_RE and PATTERN_REF_RE must be deterministic across
// repeated calls on the same input (SEC-06 pattern applied to sibling regexes).
// ---------------------------------------------------------------------------

describe('Fix C (LOW-R2-03) — _scanFile regex determinism across repeated calls', () => {
  test('calling _scanFile twice on same content returns identical kb_ref findings', () => {
    const { _scanFile } = freshSweep();
    const kbSlugs = new Set(['my-kb-slug']);
    const patSlugs = new Set();
    const ignoreList = [];

    // A temp file with a kb ref that IS in the known set (no broken ref)
    // and one that is NOT (should be flagged).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixc-'));
    const filePath = path.join(dir, 'test.md');
    fs.writeFileSync(filePath, [
      '---',
      'slug: test-doc',
      '---',
      'See @orchestray:kb://my-kb-slug for details.',
      'Also see @orchestray:kb://missing-slug which should be flagged.',
    ].join('\n'));

    // Signature: _scanFile(filePath, kbSlugs, patSlugs, projectRoot, ignoreList)
    const result1 = _scanFile(filePath, kbSlugs, patSlugs, dir, ignoreList);
    const result2 = _scanFile(filePath, kbSlugs, patSlugs, dir, ignoreList);

    assert.equal(result1.findings.length, result2.findings.length,
      'finding count must be identical across calls (stateful /g would differ)');
    assert.deepEqual(
      result1.findings.map((f) => f.target_slug).sort(),
      result2.findings.map((f) => f.target_slug).sort(),
      'target slugs must be identical across calls'
    );
    // The broken slug must appear in both calls.
    assert.ok(result1.findings.some((f) => f.target_slug === 'missing-slug'),
      'missing-slug must be flagged in first call');
    assert.ok(result2.findings.some((f) => f.target_slug === 'missing-slug'),
      'missing-slug must be flagged in second call');
  });
});
