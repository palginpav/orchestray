#!/usr/bin/env node
'use strict';

/**
 * Regression test for F-M-3 (v2.1.13 W11 finding): chainable builders on
 * schemas/_validator.js must return a NEW schema each call, not mutate a
 * shared closed-over state object.
 *
 * Before the fix: `const a = z.string().min(5); const b = a.min(2)` would
 * silently poison `a` to behave like `b` (both min=2), because `.min()` was
 * mutating the same state and returning the same schema reference.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { z } = require('../../schemas/_validator');

describe('validator chainables — immutability (F-M-3)', () => {
  test('string().min() returns a new schema; original is unaffected', () => {
    const a = z.string().min(5);
    const b = a.min(2);
    assert.equal(a.safeParse('xx').success, false, 'a still requires min=5');
    assert.equal(b.safeParse('xx').success, true, 'b accepts min=2');
  });

  test('string().max() returns a new schema', () => {
    const a = z.string().max(3);
    const b = a.max(10);
    assert.equal(a.safeParse('abcdef').success, false, 'a still rejects long');
    assert.equal(b.safeParse('abcdef').success, true, 'b accepts long');
  });

  test('number().min()/.max() return new schemas', () => {
    const a = z.number().min(10);
    const b = a.min(1);
    assert.equal(a.safeParse(5).success, false);
    assert.equal(b.safeParse(5).success, true);
  });

  test('number().int() and .positive() do not poison the base', () => {
    const n = z.number();
    const nInt = n.int();
    assert.equal(n.safeParse(1.5).success, true, 'base number still accepts floats');
    assert.equal(nInt.safeParse(1.5).success, false, 'int rejects floats');
  });

  test('object().passthrough() returns a new schema', () => {
    const base = z.object({ a: z.string() });
    const passthrough = base.passthrough();
    const r1 = base.safeParse({ a: 'x', extra: 1 });
    const r2 = passthrough.safeParse({ a: 'x', extra: 1 });
    assert.equal(r1.success, true);
    assert.equal('extra' in r1.data, false, 'base strips unknown keys');
    assert.equal(r2.success, true);
    assert.equal(r2.data.extra, 1, 'passthrough preserves unknown keys');
  });

  test('array().min() returns a new schema', () => {
    const a = z.array(z.string()).min(3);
    const b = a.min(1);
    assert.equal(a.safeParse(['x']).success, false);
    assert.equal(b.safeParse(['x']).success, true);
  });

  test('string().regex() returns a new schema with its own pattern', () => {
    const digits = z.string().regex(/^\d+$/);
    const letters = digits.regex(/^[a-z]+$/);
    assert.equal(digits.safeParse('123').success, true);
    assert.equal(digits.safeParse('abc').success, false);
    assert.equal(letters.safeParse('abc').success, true);
    assert.equal(letters.safeParse('123').success, false);
  });
});
