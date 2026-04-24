#!/usr/bin/env node
'use strict';

/**
 * Tests for schemas/specialist.schema.js (v2.1.13 R-ZOD).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { specialistFrontmatterSchema } = require('../../schemas/specialist.schema');
const { validate } = require('../../schemas');
const { parseFrontmatter } = require('../../schemas/_yaml.js');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('specialistFrontmatterSchema — happy path', () => {
  test('minimal valid specialist (name, description, model)', () => {
    const fm = {
      name: 'my-specialist',
      description: 'Does one thing and does it well.',
      model: 'sonnet',
    };
    const r = specialistFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
  });

  test('model id prefix (e.g., claude-opus-4-7) accepted', () => {
    const fm = {
      name: 'my-specialist',
      description: 'x',
      model: 'claude-opus-4-7',
    };
    const r = specialistFrontmatterSchema.safeParse(fm);
    assert.equal(r.success, true);
  });

  test('tools can be a string or an array', () => {
    const asString = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x', model: 'sonnet',
      tools: 'Read, Glob, Grep',
    });
    assert.equal(asString.success, true);

    const asArray = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x', model: 'sonnet',
      tools: ['Read', 'Glob', 'Grep'],
    });
    assert.equal(asArray.success, true);
  });

  test('optional memory/effort when valid', () => {
    const r = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x', model: 'opus',
      memory: 'project', effort: 'high',
    });
    assert.equal(r.success, true);
  });

  test('shipped specialists all validate', () => {
    const dir = path.resolve(__dirname, '..', '..', 'specialists');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    assert.ok(files.length > 0, 'expected at least one shipped specialist');
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = parseFrontmatter(raw);
      assert.ok(parsed, 'frontmatter parse failed for ' + f);
      const r = specialistFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!r.success) {
        console.error(f, JSON.stringify(r.error.issues, null, 2));
      }
      assert.equal(r.success, true, 'shipped specialist ' + f + ' should validate');
    }
  });
});

describe('specialistFrontmatterSchema — errors', () => {
  test('missing required field (model) fails', () => {
    const r = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x',
    });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'model'));
  });

  test('invalid model alias fails', () => {
    const r = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x', model: 'gpt-5',
    });
    assert.equal(r.success, false);
    const iss = r.error.issues.find((i) => i.path[0] === 'model');
    assert.ok(iss);
    assert.match(iss.message, /haiku|sonnet|opus/);
  });

  test('invalid memory enum fails', () => {
    const r = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x', model: 'sonnet',
      memory: 'global',
    });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'memory'));
  });

  test('invalid effort enum fails', () => {
    const r = specialistFrontmatterSchema.safeParse({
      name: 's', description: 'x', model: 'sonnet',
      effort: 'moderate',
    });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'effort'));
  });

  test('description exceeding 500 chars fails', () => {
    const long = 'x'.repeat(501);
    const r = specialistFrontmatterSchema.safeParse({
      name: 's', description: long, model: 'sonnet',
    });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'description'));
  });
});

describe('specialistFrontmatterSchema — seeded malformed fixture (R-ZOD AC)', () => {
  test('fixture malformed-specialist.md fails with clear issues', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'malformed-specialist.md'), 'utf8');
    const parsed = parseFrontmatter(raw);
    assert.ok(parsed);
    const result = validate(specialistFrontmatterSchema, parsed.frontmatter, 'malformed-specialist.md');
    assert.equal(result.ok, false);
    assert.ok(result.issues.length >= 2, 'expect multiple issues');
    const paths = new Set(result.issues.map((i) => i.path));
    assert.ok(paths.size >= 2);
  });
});
