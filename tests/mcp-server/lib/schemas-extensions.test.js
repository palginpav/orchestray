#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/lib/schemas.js validator extensions.
 *
 * Per v2011c-stage2-plan.md §5 and §13.
 *
 * Contract under test:
 *   validateAgainstSchema(value, schema)
 *     -> { ok: true } | { ok: false, errors: string[] }
 *
 *   deepFreeze(obj) -> Readonly<obj>
 *
 * This file only exercises the NEW Stage 2 constructs (array items/enum,
 * number min/max, integer min/max, maxItems, minItems, unsupported-keyword
 * rejection). Stage 1 already ships tests for validateAskUserInput /
 * validateAskUserOutput / validateElicitationRequestedSchema; those are not
 * re-tested here.
 *
 * RED PHASE: validateAgainstSchema does not yet exist in lib/schemas.js;
 * tests must fail at destructure time.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAgainstSchema,
  deepFreeze,
} = require('../../../bin/mcp-server/lib/schemas.js');

// ---------------------------------------------------------------------------
// object + required + properties
// ---------------------------------------------------------------------------

describe('validateAgainstSchema - object/required/properties', () => {

  test('accepts object with nested properties and required', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    };
    const result = validateAgainstSchema({ name: 'foo', age: 5 }, schema);
    assert.deepEqual(result, { ok: true });
  });

  test('rejects missing required property', () => {
    const schema = {
      type: 'object',
      required: ['name', 'age'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    };
    const result = validateAgainstSchema({ name: 'foo' }, schema);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => String(e).includes('age')));
  });

  test('rejects wrong type on a property', () => {
    const schema = {
      type: 'object',
      properties: {
        age: { type: 'integer' },
      },
    };
    const result = validateAgainstSchema({ age: 'not a number' }, schema);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

});

// ---------------------------------------------------------------------------
// string: minLength, maxLength, enum
// ---------------------------------------------------------------------------

describe('validateAgainstSchema - string', () => {

  test('accepts string within minLength/maxLength and matching enum', () => {
    const schema = { type: 'string', minLength: 2, maxLength: 10, enum: ['foo', 'bar'] };
    assert.deepEqual(validateAgainstSchema('foo', schema), { ok: true });
  });

  test('rejects string shorter than minLength', () => {
    const schema = { type: 'string', minLength: 3 };
    const result = validateAgainstSchema('ab', schema);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  test('rejects string longer than maxLength', () => {
    const schema = { type: 'string', maxLength: 3 };
    const result = validateAgainstSchema('abcd', schema);
    assert.equal(result.ok, false);
  });

  test('rejects string not in enum', () => {
    const schema = { type: 'string', enum: ['foo', 'bar'] };
    const result = validateAgainstSchema('baz', schema);
    assert.equal(result.ok, false);
  });

});

// ---------------------------------------------------------------------------
// integer: minimum, maximum
// ---------------------------------------------------------------------------

describe('validateAgainstSchema - integer', () => {

  test('accepts integer within minimum/maximum', () => {
    const schema = { type: 'integer', minimum: 1, maximum: 10 };
    assert.deepEqual(validateAgainstSchema(5, schema), { ok: true });
  });

  test('rejects integer below minimum', () => {
    const schema = { type: 'integer', minimum: 1, maximum: 10 };
    const result = validateAgainstSchema(0, schema);
    assert.equal(result.ok, false);
  });

  test('rejects integer above maximum', () => {
    const schema = { type: 'integer', minimum: 1, maximum: 10 };
    const result = validateAgainstSchema(11, schema);
    assert.equal(result.ok, false);
  });

  test('rejects non-integer number where integer required', () => {
    const schema = { type: 'integer' };
    const result = validateAgainstSchema(3.5, schema);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => String(e).toLowerCase().includes('integer')));
  });

});

// ---------------------------------------------------------------------------
// number: minimum, maximum
// ---------------------------------------------------------------------------

describe('validateAgainstSchema - number', () => {

  test('accepts number with minimum/maximum (e.g., confidence 0.7)', () => {
    const schema = { type: 'number', minimum: 0, maximum: 1 };
    assert.deepEqual(validateAgainstSchema(0.7, schema), { ok: true });
  });

  test('accepts integer value where number is expected', () => {
    const schema = { type: 'number', minimum: 0, maximum: 10 };
    assert.deepEqual(validateAgainstSchema(5, schema), { ok: true });
  });

  test('rejects number below minimum', () => {
    const schema = { type: 'number', minimum: 0, maximum: 1 };
    const result = validateAgainstSchema(-0.1, schema);
    assert.equal(result.ok, false);
  });

  test('rejects number above maximum', () => {
    const schema = { type: 'number', minimum: 0, maximum: 1 };
    const result = validateAgainstSchema(1.5, schema);
    assert.equal(result.ok, false);
  });

  test('rejects non-numeric value (string)', () => {
    const schema = { type: 'number' };
    const result = validateAgainstSchema('0.5', schema);
    assert.equal(result.ok, false);
  });

});

// ---------------------------------------------------------------------------
// array: items.type, items.enum, minItems, maxItems
// ---------------------------------------------------------------------------

describe('validateAgainstSchema - array', () => {

  test('accepts array with items.type=string', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    assert.deepEqual(validateAgainstSchema(['a', 'b'], schema), { ok: true });
  });

  test('rejects array when an item has wrong type', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const result = validateAgainstSchema(['a', 2], schema);
    assert.equal(result.ok, false);
  });

  test('accepts array with items.enum', () => {
    const schema = {
      type: 'array',
      items: { type: 'string', enum: ['decomposition', 'routing', 'anti-pattern'] },
    };
    assert.deepEqual(
      validateAgainstSchema(['decomposition', 'routing'], schema),
      { ok: true }
    );
  });

  test('rejects array item not in items.enum', () => {
    const schema = {
      type: 'array',
      items: { type: 'string', enum: ['decomposition', 'routing'] },
    };
    const result = validateAgainstSchema(['decomposition', 'unknown'], schema);
    assert.equal(result.ok, false);
  });

  test('rejects array exceeding maxItems', () => {
    const schema = { type: 'array', items: { type: 'string' }, maxItems: 3 };
    const result = validateAgainstSchema(['a', 'b', 'c', 'd'], schema);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => String(e).toLowerCase().includes('maxitems') ||
                                       String(e).toLowerCase().includes('max items') ||
                                       String(e).toLowerCase().includes('at most')));
  });

  test('accepts array within maxItems', () => {
    const schema = { type: 'array', items: { type: 'string' }, maxItems: 3 };
    assert.deepEqual(validateAgainstSchema(['a', 'b'], schema), { ok: true });
  });

  test('rejects array below minItems', () => {
    const schema = { type: 'array', items: { type: 'string' }, minItems: 1 };
    const result = validateAgainstSchema([], schema);
    assert.equal(result.ok, false);
  });

  test('accepts empty array when no minItems constraint', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    assert.deepEqual(validateAgainstSchema([], schema), { ok: true });
  });

});

// ---------------------------------------------------------------------------
// Unsupported schema keywords -> rejection with "unsupported" error
// ---------------------------------------------------------------------------

describe('validateAgainstSchema - unsupported keywords', () => {

  function assertUnsupported(schema, keyword) {
    const result = validateAgainstSchema({}, schema);
    assert.equal(result.ok, false,
      `schema with ${keyword} should be rejected`);
    assert.ok(
      result.errors.some((e) => String(e).toLowerCase().includes('unsupported')),
      `errors should mention "unsupported" for ${keyword}; got: ${JSON.stringify(result.errors)}`
    );
  }

  test('rejects oneOf with "unsupported" error', () => {
    assertUnsupported(
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      'oneOf'
    );
  });

  test('rejects anyOf with "unsupported" error', () => {
    assertUnsupported(
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
      'anyOf'
    );
  });

  test('rejects allOf with "unsupported" error', () => {
    assertUnsupported(
      { allOf: [{ type: 'string' }] },
      'allOf'
    );
  });

  test('rejects $ref with "unsupported" error', () => {
    assertUnsupported(
      { $ref: '#/definitions/foo' },
      '$ref'
    );
  });

  test('rejects const with "unsupported" error', () => {
    assertUnsupported(
      { const: 'foo' },
      'const'
    );
  });

  test('rejects format with "unsupported" error', () => {
    assertUnsupported(
      { type: 'string', format: 'email' },
      'format'
    );
  });

});

// ---------------------------------------------------------------------------
// deepFreeze
// ---------------------------------------------------------------------------

describe('deepFreeze', () => {

  test('freezes nested objects', () => {
    const obj = {
      a: 1,
      nested: {
        b: 2,
        deeper: { c: 3 },
      },
    };
    const frozen = deepFreeze(obj);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.nested));
    assert.ok(Object.isFrozen(frozen.nested.deeper));
    // Mutation should throw in strict mode (this file is strict).
    assert.throws(() => { frozen.a = 99; });
    assert.throws(() => { frozen.nested.b = 99; });
    assert.throws(() => { frozen.nested.deeper.c = 99; });
  });

  test('freezes arrays', () => {
    const obj = { list: [1, 2, { inner: 'x' }] };
    const frozen = deepFreeze(obj);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.list));
    assert.ok(Object.isFrozen(frozen.list[2]));
    assert.throws(() => { frozen.list.push(4); });
  });

});
