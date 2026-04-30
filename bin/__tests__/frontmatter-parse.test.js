#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/frontmatter-parse.js
 *
 * Runner: node --test bin/__tests__/frontmatter-parse.test.js
 *
 * Coverage:
 *   1. Empty string → null
 *   2. Content with no frontmatter → null
 *   3. Simple frontmatter with 3 string keys
 *   4. Quoted value with embedded `:`
 *   5. Frontmatter with no closing `---` → null
 *   6. Boolean/number coercion
 *   7. Inline array value
 *   8. Null value (key: null)
 *   9. CRLF line endings
 *  10. Body preserved correctly after frontmatter
 *  11. Non-string input → null
 *  12. Empty frontmatter block (valid --- block with no keys)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter } = require('../_lib/frontmatter-parse');

// ---------------------------------------------------------------------------
// 1. Empty content → null
// ---------------------------------------------------------------------------

test('empty string returns null', () => {
  assert.equal(parseFrontmatter(''), null);
});

// ---------------------------------------------------------------------------
// 2. Content with no frontmatter → null
// ---------------------------------------------------------------------------

test('content with no frontmatter returns null', () => {
  const content = '# Just a heading\n\nSome body text.\n';
  assert.equal(parseFrontmatter(content), null);
});

// ---------------------------------------------------------------------------
// 3. Simple frontmatter with 3 string keys
// ---------------------------------------------------------------------------

test('simple frontmatter with 3 string keys', () => {
  const content = '---\nname: my-pattern\ncategory: decomposition\nstatus: active\n---\n\nBody text here.\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null, 'should return non-null');
  assert.equal(result.frontmatter.name, 'my-pattern');
  assert.equal(result.frontmatter.category, 'decomposition');
  assert.equal(result.frontmatter.status, 'active');
  // Body starts at the newline character of the closing --- line.
  assert.equal(result.body, '\n\nBody text here.\n');
});

// ---------------------------------------------------------------------------
// 4. Quoted value with embedded `:`
// ---------------------------------------------------------------------------

test('quoted value with embedded colon', () => {
  const content = '---\ndescription: "A value with: a colon inside"\nname: test\n---\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.equal(result.frontmatter.description, 'A value with: a colon inside');
});

// ---------------------------------------------------------------------------
// 5. Frontmatter with no closing `---` → null
// ---------------------------------------------------------------------------

test('frontmatter with no closing delimiter returns null', () => {
  const content = '---\nname: incomplete\nmodel: sonnet\n';
  assert.equal(parseFrontmatter(content), null);
});

// ---------------------------------------------------------------------------
// 6. Boolean/number coercion
// ---------------------------------------------------------------------------

test('boolean and number values are coerced to typed values', () => {
  const content = '---\nenabled: true\ndisabled: false\ntimes_applied: 42\nconfidence: 0.75\n---\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.equal(result.frontmatter.enabled, true);
  assert.equal(result.frontmatter.disabled, false);
  assert.equal(result.frontmatter.times_applied, 42);
  assert.equal(result.frontmatter.confidence, 0.75);
});

// ---------------------------------------------------------------------------
// 7. Inline array value
// ---------------------------------------------------------------------------

test('inline array value', () => {
  const content = '---\ntools: [Read, Write, Bash]\n---\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.deepEqual(result.frontmatter.tools, ['Read', 'Write', 'Bash']);
});

// ---------------------------------------------------------------------------
// 8. Null value
// ---------------------------------------------------------------------------

test('null scalar value', () => {
  const content = '---\nlast_applied: null\nother: ~\n---\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.equal(result.frontmatter.last_applied, null);
  assert.equal(result.frontmatter.other, null);
});

// ---------------------------------------------------------------------------
// 9. CRLF line endings
// ---------------------------------------------------------------------------

test('CRLF line endings handled correctly', () => {
  const content = '---\r\nname: crlf-test\r\nmodel: sonnet\r\n---\r\n\r\nBody.\r\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.equal(result.frontmatter.name, 'crlf-test');
  assert.equal(result.frontmatter.model, 'sonnet');
});

// ---------------------------------------------------------------------------
// 10. Body preserved correctly
// ---------------------------------------------------------------------------

test('body is preserved verbatim after frontmatter block', () => {
  // The canonical parser includes the newline of the closing --- in body.
  const bodyAfterDelim = '\n# Section\n\nSome **markdown** content.\n\n- item 1\n- item 2\n';
  const content = '---\nname: test\n---' + bodyAfterDelim;
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.equal(result.body, bodyAfterDelim);
});

// ---------------------------------------------------------------------------
// 11. Non-string input → null
// ---------------------------------------------------------------------------

test('non-string input returns null', () => {
  assert.equal(parseFrontmatter(null), null);
  assert.equal(parseFrontmatter(undefined), null);
  assert.equal(parseFrontmatter(42), null);
});

// ---------------------------------------------------------------------------
// 12. Empty frontmatter block
// ---------------------------------------------------------------------------

test('valid empty frontmatter block (--- / ---) returns empty object', () => {
  const content = '---\n---\n\nBody.\n';
  const result = parseFrontmatter(content);
  assert.ok(result !== null);
  assert.deepEqual(result.frontmatter, {});
  // Body starts at the newline of the closing --- line.
  assert.equal(result.body, '\n\nBody.\n');
});
