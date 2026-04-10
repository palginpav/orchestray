#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/lib/frontmatter.js
 *
 * Per v2011c-stage2-plan.md §6 and §13.
 *
 * Contract under test:
 *   parse(content: string) -> { frontmatter, body, hasFrontmatter }
 *   stringify({ frontmatter, body }) -> string
 *   rewriteField(filepath, fieldName, newValue)
 *     -> { ok: true } | { ok: false, error: string }
 *
 * Concurrent-writer behavior is undefined in Stage 2 — see v2011c-stage2-plan.md §6
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parse,
  stringify,
  rewriteField,
} = require('../../../bin/mcp-server/lib/frontmatter.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-frontmatter-test-'));
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('parse', () => {

  test('returns empty frontmatter for content without --- delimiters', () => {
    const content = '# Hello\n\nNo frontmatter here.\n';
    const result = parse(content);
    assert.equal(result.hasFrontmatter, false);
    assert.deepEqual(result.frontmatter, {});
    assert.equal(result.body, content);
  });

  test('returns empty frontmatter for content with only opening ---', () => {
    // No closing --- -> treat as no frontmatter (or partial).
    const content = '---\nname: foo\n# Missing closing delimiter\n';
    const result = parse(content);
    // Per §6 Failure modes: a file with opening --- but no closing ---
    // is malformed. parse must be tolerant and return a result; it must
    // NOT throw. hasFrontmatter may be false (since we couldn't parse)
    // or true with a partial result. Either shape is legal — the test
    // only enforces that parse doesn't throw and that it yields some
    // result object with the expected keys.
    assert.ok('frontmatter' in result);
    assert.ok('body' in result);
    assert.ok('hasFrontmatter' in result);
  });

  test('extracts flat key: value pairs', () => {
    const content = '---\nname: foo\ncategory: decomposition\n---\n\n# Body\n';
    const result = parse(content);
    assert.equal(result.hasFrontmatter, true);
    assert.equal(result.frontmatter.name, 'foo');
    assert.equal(result.frontmatter.category, 'decomposition');
  });

  test('preserves body byte-identically after closing ---', () => {
    const body = '\n# Pattern: Foo\n\n## Context\n\nA line with \ttabs\t and  spaces.\n';
    const content = '---\nname: foo\n---' + body;
    const result = parse(content);
    assert.equal(result.body, body);
  });

  test('parses integer values as numbers', () => {
    const content = '---\ntimes_applied: 3\n---\n';
    const result = parse(content);
    assert.equal(result.frontmatter.times_applied, 3);
    assert.equal(typeof result.frontmatter.times_applied, 'number');
  });

  test('parses decimal values as numbers', () => {
    const content = '---\nconfidence: 0.75\n---\n';
    const result = parse(content);
    assert.equal(result.frontmatter.confidence, 0.75);
    assert.equal(typeof result.frontmatter.confidence, 'number');
  });

  test('parses "true" and "false" as booleans', () => {
    const content = '---\nactive: true\nstale: false\n---\n';
    const result = parse(content);
    assert.equal(result.frontmatter.active, true);
    assert.equal(result.frontmatter.stale, false);
    assert.equal(typeof result.frontmatter.active, 'boolean');
    assert.equal(typeof result.frontmatter.stale, 'boolean');
  });

  test('parses "null" as null', () => {
    const content = '---\nlast_applied: null\n---\n';
    const result = parse(content);
    assert.equal(result.frontmatter.last_applied, null);
  });

  test('handles double-quoted strings and strips the quotes', () => {
    const content = '---\ndescription: "A quoted string with: colons"\n---\n';
    const result = parse(content);
    assert.equal(result.frontmatter.description, 'A quoted string with: colons');
  });

  test('handles single-quoted strings and strips the quotes', () => {
    const content = "---\ndescription: 'single-quoted value'\n---\n";
    const result = parse(content);
    assert.equal(result.frontmatter.description, 'single-quoted value');
  });

  test('preserves ISO-8601 timestamp strings verbatim', () => {
    const content = '---\nlast_applied: 2026-04-09T10:00:00Z\n---\n';
    const result = parse(content);
    // Timestamps should survive as strings (or the equivalent — what
    // matters is that the original value can be round-tripped).
    assert.equal(String(result.frontmatter.last_applied), '2026-04-09T10:00:00Z');
  });

  test('does not throw on malformed key line; yields partial result', () => {
    // A line with no colon is malformed. parse must not throw.
    const content = '---\nname: foo\nthis_is_garbage_no_colon\ncategory: x\n---\n\n# Body\n';
    let result;
    assert.doesNotThrow(() => { result = parse(content); });
    // The parser should still produce a frontmatter object with the
    // valid keys it could extract. The malformed line is either skipped
    // or preserved verbatim — both are acceptable.
    assert.equal(result.frontmatter.name, 'foo');
    assert.equal(result.frontmatter.category, 'x');
  });

  test('preserves unknown fields verbatim for round-trip', () => {
    const content = '---\nname: foo\nsome_custom_field: custom_value\n---\n\n# Body\n';
    const result = parse(content);
    assert.equal(result.frontmatter.name, 'foo');
    assert.equal(result.frontmatter.some_custom_field, 'custom_value');
  });

});

// ---------------------------------------------------------------------------
// stringify
// ---------------------------------------------------------------------------

describe('stringify', () => {

  test('returns body without --- when frontmatter is empty', () => {
    const result = stringify({ frontmatter: {}, body: '# Hello\n' });
    assert.equal(result, '# Hello\n');
  });

  test('produces --- delimited frontmatter and preserves body', () => {
    const result = stringify({
      frontmatter: { name: 'foo', category: 'decomposition' },
      body: '\n# Body\n',
    });
    assert.ok(result.startsWith('---\n'));
    assert.ok(result.includes('name: foo'));
    assert.ok(result.includes('category: decomposition'));
    assert.ok(result.endsWith('# Body\n'));
    // The closing --- must precede the body.
    const bodyIdx = result.indexOf('# Body');
    const closingIdx = result.indexOf('---', 4); // skip opening
    assert.ok(closingIdx > 0 && closingIdx < bodyIdx, 'closing --- must appear before body');
  });

  test('preserves key insertion order', () => {
    const result = stringify({
      frontmatter: { zzz: 1, aaa: 2, mmm: 3 },
      body: '',
    });
    const zIdx = result.indexOf('zzz:');
    const aIdx = result.indexOf('aaa:');
    const mIdx = result.indexOf('mmm:');
    assert.ok(zIdx < aIdx, 'zzz should come before aaa (insertion order)');
    assert.ok(aIdx < mIdx, 'aaa should come before mmm (insertion order)');
  });

  test('roundtrips with parse (parse -> stringify -> parse)', () => {
    const original = '---\nname: foo\ntimes_applied: 3\nconfidence: 0.75\n---\n\n# Body\n\ncontent\n';
    const parsed = parse(original);
    const restringed = stringify({ frontmatter: parsed.frontmatter, body: parsed.body });
    const reparsed = parse(restringed);
    assert.deepEqual(reparsed.frontmatter, parsed.frontmatter);
    assert.equal(reparsed.body, parsed.body);
  });

});

// ---------------------------------------------------------------------------
// rewriteField
// ---------------------------------------------------------------------------

describe('rewriteField', () => {

  test('updates an existing field and preserves other frontmatter byte-identically', () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'foo.md');
      const before = '---\nname: foo\ncategory: decomposition\ntimes_applied: 2\nconfidence: 0.7\n---\n\n# Pattern: Foo\n\nBody.\n';
      fs.writeFileSync(file, before);
      const result = rewriteField(file, 'times_applied', 3);
      assert.equal(result.ok, true, 'rewriteField should return ok:true');
      const after = fs.readFileSync(file, 'utf8');
      // The times_applied value must have changed.
      assert.ok(after.includes('times_applied: 3'));
      assert.ok(!after.includes('times_applied: 2'));
      // Other frontmatter fields must be preserved.
      assert.ok(after.includes('name: foo'));
      assert.ok(after.includes('category: decomposition'));
      assert.ok(after.includes('confidence: 0.7'));
      // Body must be preserved byte-identically.
      assert.ok(after.endsWith('# Pattern: Foo\n\nBody.\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('adds a missing field at end of frontmatter', () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'foo.md');
      const before = '---\nname: foo\ncategory: decomposition\n---\n\n# Body\n';
      fs.writeFileSync(file, before);
      const result = rewriteField(file, 'times_applied', 1);
      assert.equal(result.ok, true);
      const after = fs.readFileSync(file, 'utf8');
      assert.ok(after.includes('times_applied: 1'));
      assert.ok(after.includes('name: foo'));
      assert.ok(after.includes('category: decomposition'));
      // The new field should be inside the frontmatter block (before the body).
      const closingIdx = after.indexOf('---', 4);
      const newFieldIdx = after.indexOf('times_applied');
      assert.ok(newFieldIdx > 0 && newFieldIdx < closingIdx,
        'added field must be inside frontmatter block');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('updates a string-valued field (e.g., last_applied ISO timestamp)', () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'foo.md');
      const before = '---\nname: foo\nlast_applied: 2026-04-09T10:00:00Z\n---\n\n# Body\n';
      fs.writeFileSync(file, before);
      const result = rewriteField(file, 'last_applied', '2026-04-10T12:00:00Z');
      assert.equal(result.ok, true);
      const after = fs.readFileSync(file, 'utf8');
      assert.ok(after.includes('last_applied: 2026-04-10T12:00:00Z'));
      assert.ok(!after.includes('2026-04-09T10:00:00Z'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns ENOENT when file is missing without throwing', () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'does-not-exist.md');
      let result;
      assert.doesNotThrow(() => {
        result = rewriteField(file, 'times_applied', 1);
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'ENOENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns malformed_frontmatter when opening --- has no closing ---', () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'foo.md');
      // Opening --- but no closing ---.
      const before = '---\nname: foo\ntimes_applied: 1\n# no closing delimiter\n';
      fs.writeFileSync(file, before);
      let result;
      assert.doesNotThrow(() => {
        result = rewriteField(file, 'times_applied', 2);
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'malformed_frontmatter');
      // Original file must be untouched.
      const after = fs.readFileSync(file, 'utf8');
      assert.equal(after, before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('atomic: no temp files left behind on successful write', () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'foo.md');
      const before = '---\nname: foo\ntimes_applied: 1\n---\n\n# Body\n';
      fs.writeFileSync(file, before);
      const result = rewriteField(file, 'times_applied', 2);
      assert.equal(result.ok, true);
      const entries = fs.readdirSync(dir);
      // Only foo.md should remain — no .tmp or ~ files.
      const strays = entries.filter((e) => e !== 'foo.md');
      assert.deepEqual(strays, [],
        `expected no stray files, got: ${JSON.stringify(strays)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('single writer: sequential increments produce expected final value', () => {
    // Concurrent-writer behavior is undefined in Stage 2 — see v2011c-stage2-plan.md §6
    // This test only verifies the single-writer case: after N sequential
    // writes, the final file contains the last value written.
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, 'foo.md');
      fs.writeFileSync(
        file,
        '---\nname: foo\ntimes_applied: 0\n---\n\n# Body\n'
      );
      for (let i = 1; i <= 5; i++) {
        const result = rewriteField(file, 'times_applied', i);
        assert.equal(result.ok, true, `iteration ${i} should succeed`);
      }
      const final = fs.readFileSync(file, 'utf8');
      assert.ok(final.includes('times_applied: 5'));
      assert.ok(!final.includes('times_applied: 0'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
