#!/usr/bin/env node
'use strict';

/**
 * Per-keyword tests for json-schema-subset.js (v2.3.8).
 *
 * Covers:
 *   Compile-time:
 *   1.  unknown keyword rejects
 *   2.  depth cap rejects at 33+ levels
 *   3.  definitions annotation accepted
 *   4.  nested properties accepted
 *
 *   type keyword:
 *   5.  type string
 *   6.  type integer — accepts integer, rejects float and string
 *   7.  type number — accepts float, rejects string
 *   8.  type boolean
 *   9.  type null
 *   10. type array
 *   11. type object
 *
 *   String keywords:
 *   12. minLength / maxLength
 *   13. format (uuid) validates correctly
 *
 *   Numeric keywords:
 *   14. minimum / maximum
 *
 *   enum / const:
 *   15. enum with mixed types
 *   16. const exact match
 *
 *   Array keywords:
 *   17. items validates each element
 *   18. minItems / maxItems
 *
 *   Object keywords:
 *   19. required fires on missing field
 *   20. properties validates nested object
 *   21. additionalProperties: false rejects extra keys
 *
 *   Composition:
 *   22. local $ref via definitions
 *
 *   Edge cases:
 *   23. empty schema accepts anything
 *   24. integer vs number distinction
 *   25. additionalProperties with nested object
 *   26. enum with null value
 *   27. errors array shape: instancePath + message
 *
 * Runner: node --test bin/_lib/__tests__/json-schema-subset.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { compile } = require('../json-schema-subset');

// ---------------------------------------------------------------------------
// Compile-time
// ---------------------------------------------------------------------------

describe('compile — compile-time checks', () => {
  test('1. unknown keyword rejects', () => {
    assert.throws(
      () => compile({ type: 'string', evilKeyword: true }),
      (err) => { assert.match(err.message, /unknown keyword/i); return true; }
    );
  });

  test('2. depth cap rejects at >32 levels', () => {
    let schema = { type: 'string' };
    for (let i = 0; i < 34; i++) {
      schema = { type: 'object', properties: { x: schema } };
    }
    assert.throws(() => compile(schema), (err) => {
      assert.match(err.message, /schema too deep/i);
      return true;
    });
  });

  test('3. definitions annotation accepted without error', () => {
    assert.doesNotThrow(() => compile({
      $ref: '#/definitions/name',
      definitions: { name: { type: 'string' } },
    }));
  });

  test('4. nested properties accepted', () => {
    assert.doesNotThrow(() => compile({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    }));
  });
});

// ---------------------------------------------------------------------------
// type keyword
// ---------------------------------------------------------------------------

describe('type keyword', () => {
  test('5. type string', () => {
    const v = compile({ type: 'string' });
    assert.equal(v('hello').valid, true);
    assert.equal(v(42).valid, false);
    assert.equal(v(null).valid, false);
  });

  test('6. type integer: accepts integer, rejects float and string', () => {
    const v = compile({ type: 'integer' });
    assert.equal(v(42).valid, true);
    assert.equal(v(0).valid, true);
    assert.equal(v(-1).valid, true);
    assert.equal(v(3.14).valid, false);
    assert.equal(v('42').valid, false);
    assert.equal(v(null).valid, false);
  });

  test('7. type number: accepts float, rejects string', () => {
    const v = compile({ type: 'number' });
    assert.equal(v(3.14).valid, true);
    assert.equal(v(42).valid, true);
    assert.equal(v('3.14').valid, false);
    assert.equal(v(Infinity).valid, false);
  });

  test('8. type boolean', () => {
    const v = compile({ type: 'boolean' });
    assert.equal(v(true).valid, true);
    assert.equal(v(false).valid, true);
    assert.equal(v(1).valid, false);
    assert.equal(v('true').valid, false);
  });

  test('9. type null', () => {
    const v = compile({ type: 'null' });
    assert.equal(v(null).valid, true);
    assert.equal(v(0).valid, false);
    assert.equal(v('').valid, false);
  });

  test('10. type array', () => {
    const v = compile({ type: 'array' });
    assert.equal(v([]).valid, true);
    assert.equal(v([1, 2]).valid, true);
    assert.equal(v({}).valid, false);
    assert.equal(v('[]').valid, false);
  });

  test('11. type object', () => {
    const v = compile({ type: 'object' });
    assert.equal(v({}).valid, true);
    assert.equal(v({ a: 1 }).valid, true);
    assert.equal(v([]).valid, false);
    assert.equal(v(null).valid, false);
  });
});

// ---------------------------------------------------------------------------
// String keywords
// ---------------------------------------------------------------------------

describe('string keywords', () => {
  test('12. minLength / maxLength', () => {
    const v = compile({ type: 'string', minLength: 2, maxLength: 5 });
    assert.equal(v('ab').valid, true);
    assert.equal(v('abcde').valid, true);
    assert.equal(v('a').valid, false);
    assert.equal(v('abcdef').valid, false);
  });

  test('13. format uuid validates correctly', () => {
    const v = compile({ type: 'string', format: 'uuid' });
    assert.equal(v('550e8400-e29b-41d4-a716-446655440000').valid, true);
    assert.equal(v('not-a-uuid').valid, false);
  });
});

// ---------------------------------------------------------------------------
// Numeric keywords
// ---------------------------------------------------------------------------

describe('numeric keywords', () => {
  test('14. minimum / maximum', () => {
    const v = compile({ type: 'number', minimum: 0, maximum: 100 });
    assert.equal(v(0).valid, true);
    assert.equal(v(50).valid, true);
    assert.equal(v(100).valid, true);
    assert.equal(v(-1).valid, false);
    assert.equal(v(101).valid, false);
  });
});

// ---------------------------------------------------------------------------
// enum / const
// ---------------------------------------------------------------------------

describe('enum and const', () => {
  test('15. enum with mixed types', () => {
    const v = compile({ enum: ['a', 1, null, true] });
    assert.equal(v('a').valid, true);
    assert.equal(v(1).valid, true);
    assert.equal(v(null).valid, true);
    assert.equal(v(true).valid, true);
    assert.equal(v('b').valid, false);
    assert.equal(v(2).valid, false);
    assert.equal(v(false).valid, false);
  });

  test('16. const exact match', () => {
    const v = compile({ const: 42 });
    assert.equal(v(42).valid, true);
    assert.equal(v(43).valid, false);
    assert.equal(v('42').valid, false);
  });
});

// ---------------------------------------------------------------------------
// Array keywords
// ---------------------------------------------------------------------------

describe('array keywords', () => {
  test('17. items validates each element', () => {
    const v = compile({ type: 'array', items: { type: 'integer' } });
    assert.equal(v([1, 2, 3]).valid, true);
    assert.equal(v([]).valid, true);
    assert.equal(v([1, '2', 3]).valid, false);
  });

  test('18. minItems / maxItems', () => {
    const v = compile({ type: 'array', minItems: 1, maxItems: 3 });
    assert.equal(v([1]).valid, true);
    assert.equal(v([1, 2, 3]).valid, true);
    assert.equal(v([]).valid, false);
    assert.equal(v([1, 2, 3, 4]).valid, false);
  });
});

// ---------------------------------------------------------------------------
// Object keywords
// ---------------------------------------------------------------------------

describe('object keywords', () => {
  test('19. required fires on missing field', () => {
    const v = compile({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    assert.equal(v({ name: 'alice' }).valid, true);
    const r = v({});
    assert.equal(r.valid, false);
    assert.equal(r.errors.some(e => e.message === 'is required'), true);
  });

  test('20. properties validates nested object', () => {
    const v = compile({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { age: { type: 'integer' } },
          required: ['age'],
        },
      },
      required: ['user'],
    });
    assert.equal(v({ user: { age: 30 } }).valid, true);
    assert.equal(v({ user: { age: '30' } }).valid, false);
    assert.equal(v({ user: {} }).valid, false);
  });

  test('21. additionalProperties: false rejects extra keys', () => {
    const v = compile({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    assert.equal(v({ name: 'bob' }).valid, true);
    assert.equal(v({}).valid, true); // no required — extra check is about unknown keys
    assert.equal(v({ name: 'bob', extra: 1 }).valid, false);
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('composition — $ref', () => {
  test('22. local $ref via definitions', () => {
    const v = compile({
      $ref: '#/definitions/name',
      definitions: { name: { type: 'string' } },
    });
    assert.equal(v('hello').valid, true);
    assert.equal(v(42).valid, false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('23. empty schema accepts anything', () => {
    const v = compile({});
    assert.equal(v(42).valid, true);
    assert.equal(v('x').valid, true);
    assert.equal(v(null).valid, true);
    assert.equal(v([]).valid, true);
    assert.equal(v({}).valid, true);
  });

  test('24. integer vs number distinction: float fails integer', () => {
    const vi = compile({ type: 'integer' });
    const vn = compile({ type: 'number' });
    assert.equal(vi(3.14).valid, false);
    assert.equal(vn(3.14).valid, true);
  });

  test('25. additionalProperties with nested additionalProperties: false', () => {
    const v = compile({
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { x: { type: 'integer' } },
          additionalProperties: false,
        },
      },
    });
    assert.equal(v({ inner: { x: 1 } }).valid, true);
    assert.equal(v({ inner: { x: 1, y: 2 } }).valid, false);
    // outer has no additionalProperties constraint — extra key ok
    assert.equal(v({ inner: { x: 1 }, outer_extra: 'ok' }).valid, true);
  });

  test('26. enum with null value', () => {
    const v = compile({ enum: [null, 'absent'] });
    assert.equal(v(null).valid, true);
    assert.equal(v('absent').valid, true);
    assert.equal(v(0).valid, false);
  });

  test('27. error shape has instancePath and message', () => {
    const v = compile({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    });
    const r = v({});
    assert.equal(r.valid, false);
    assert.ok(Array.isArray(r.errors));
    const err = r.errors[0];
    assert.ok('instancePath' in err, 'error must have instancePath');
    assert.ok('message' in err, 'error must have message');
    assert.equal(typeof err.instancePath, 'string');
    assert.equal(typeof err.message, 'string');
  });
});
