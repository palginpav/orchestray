#!/usr/bin/env node
'use strict';

/**
 * Tests for schemas/pattern.schema.js (v2.1.13 R-ZOD).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { patternFrontmatterSchema } = require('../../schemas/pattern.schema');
const { validate } = require('../../schemas');
const { parseFrontmatter } = require('../../schemas/_yaml.js');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('patternFrontmatterSchema — happy path', () => {
  test('minimal valid pattern (all required fields present, strings ok)', () => {
    const fm = {
      name: 'my-pattern',
      category: 'anti-pattern',
      confidence: 0.7,
      description: 'example pattern',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
  });

  test('YAML-string numbers are coerced (confidence: "0.7")', () => {
    const fm = {
      name: 'my-pattern',
      category: 'anti-pattern',
      confidence: '0.7',
      description: 'example',
      times_applied: '3',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
    assert.equal(r.data.confidence, 0.7);
    assert.equal(r.data.times_applied, 3);
  });

  test('last_applied: "null" (YAML string) coerces to JS null', () => {
    const fm = {
      name: 'my-pattern',
      category: 'anti-pattern',
      confidence: 0.7,
      description: 'x',
      last_applied: 'null',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
    assert.equal(r.data.last_applied, null);
  });

  test('last_applied: ISO timestamp accepted', () => {
    const fm = {
      name: 'my-pattern',
      category: 'anti-pattern',
      confidence: 0.5,
      description: 'x',
      last_applied: '2026-04-16T14:01:00Z',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
  });

  test('deprecated: "true" (YAML string boolean) coerces', () => {
    const fm = {
      name: 'old-pat',
      category: 'anti-pattern',
      confidence: 0.4,
      description: 'x',
      deprecated: 'true',
      deprecated_reason: 'low-confidence',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
    assert.equal(r.data.deprecated, true);
  });

  test('sharing: "local-only" (v2.1.13 R-FED-PRIVACY) accepted', () => {
    const fm = {
      name: 'private-pattern',
      category: 'specialization',
      confidence: 0.6,
      description: 'x',
      sharing: 'local-only',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
  });

  test('array-valued trigger_actions passes', () => {
    const fm = {
      name: 'p',
      category: 'anti-pattern',
      confidence: 0.5,
      description: 'x',
      trigger_actions: ['new MCP tool', 'register tool'],
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
  });
});

describe('patternFrontmatterSchema — errors', () => {
  test('missing required field (description) fails', () => {
    const fm = { name: 'p', category: 'anti-pattern', confidence: 0.5 };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'description'));
  });

  test('invalid category fails', () => {
    const fm = {
      name: 'p',
      category: 'miscellaneous',
      confidence: 0.5,
      description: 'x',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'category'));
  });

  test('confidence out of [0, 1] fails', () => {
    const fm = {
      name: 'p',
      category: 'anti-pattern',
      confidence: 1.5,
      description: 'x',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'confidence'));
  });

  test('non-kebab-case name fails', () => {
    const fm = {
      name: 'MyPattern',
      category: 'anti-pattern',
      confidence: 0.5,
      description: 'x',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'name'));
  });

  test('invalid sharing value fails', () => {
    const fm = {
      name: 'p',
      category: 'anti-pattern',
      confidence: 0.5,
      description: 'x',
      sharing: 'team',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'sharing'));
  });

  test('non-ISO last_applied fails with helpful message', () => {
    const fm = {
      name: 'p',
      category: 'anti-pattern',
      confidence: 0.5,
      description: 'x',
      last_applied: 'yesterday',
    };
    const r = patternFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, false);
    const iss = r.error.issues.find((i) => i.path[0] === 'last_applied');
    assert.ok(iss);
    assert.match(iss.message, /ISO-8601/);
  });
});

describe('patternFrontmatterSchema — seeded malformed fixture (R-ZOD AC)', () => {
  test('fixture malformed-pattern.md fails with multiple issues', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'malformed-pattern.md'), 'utf8');
    const parsed = parseFrontmatter(raw);
    assert.ok(parsed && parsed.frontmatter);
    const result = validate(patternFrontmatterSchema, parsed.frontmatter, 'malformed-pattern.md');
    assert.equal(result.ok, false);
    assert.ok(result.issues.length >= 2, 'expect multiple issues');
    // Must mention at least two distinct key paths.
    const paths = new Set(result.issues.map((i) => i.path));
    assert.ok(paths.size >= 2);
  });
});
