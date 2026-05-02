#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for plugin-input-schema-validator.js (v2.3.0 — W-SEC-9).
 *
 * Covers:
 *   Happy paths:
 *   1. trivial-valid-schema       Simple object schema compiles and validates input ok.
 *   2. safe-local-ref             Local $ref (#/definitions/foo) compiles without error.
 *   3. allowed-format-uuid        format:"uuid" (in allowlist) compiles without error.
 *
 *   Negatives:
 *   4. remote-ref-https           https:// $ref → throws "remote $ref rejected"
 *   5. remote-ref-data            data: $ref → throws "remote $ref rejected"
 *   6. remote-ref-file            file:// $ref → throws "remote $ref rejected"
 *   7. disallowed-format-phone    format:"phone" → throws "unsupported format"
 *   8. disallowed-format-regex    format:"regex" → throws (ReDoS protection)
 *   9. unknown-keyword-strict     Unknown keyword → ajv compile fails (strict mode)
 *  10. deep-nesting-safety        50-level deep object tree either compiles <500ms or
 *                                 rejects with depth error; must NOT hang/crash node.
 *  11. input-validation           {type:"integer"} validates 42 ok, rejects "42".
 *
 * Runner: node --test bin/_lib/__tests__/plugin-input-schema-validator.smoke.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  compileToolInputSchema,
  validateInput,
} = require('../plugin-input-schema-validator');

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('compileToolInputSchema — happy paths', () => {
  test('1. trivial-valid-schema: simple object schema compiles and validates', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      additionalProperties: false,
    };
    const validator = compileToolInputSchema(schema);
    assert.equal(typeof validator, 'function', 'should return a validator function');

    const { ok, errors } = validateInput(schema, { q: 'hello' });
    assert.equal(ok, true, 'valid input should pass');
    assert.equal(errors, null, 'errors should be null on success');
  });

  test('2. safe-local-ref: local #/definitions ref compiles without error', () => {
    const schema = {
      $ref: '#/definitions/foo',
      definitions: { foo: { type: 'string' } },
    };
    // Should not throw — local refs are safe.
    const validator = compileToolInputSchema(schema);
    assert.equal(typeof validator, 'function');
  });

  test('3. allowed-format-uuid: format "uuid" is in whitelist and compiles', () => {
    const schema = { type: 'string', format: 'uuid' };
    const validator = compileToolInputSchema(schema);
    assert.equal(typeof validator, 'function');
  });
});

// ---------------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------------

describe('compileToolInputSchema — negatives (security rejections)', () => {
  test('4. remote-ref-https: rejects https:// $ref with "remote $ref rejected"', () => {
    const schema = { $ref: 'https://attacker.com/schema.json' };
    assert.throws(
      () => compileToolInputSchema(schema),
      (err) => {
        assert.match(err.message, /remote \$ref rejected/i);
        return true;
      }
    );
  });

  test('5. remote-ref-data: rejects data: $ref with "remote $ref rejected"', () => {
    const schema = { $ref: 'data:application/json,{"type":"string"}' };
    assert.throws(
      () => compileToolInputSchema(schema),
      (err) => {
        assert.match(err.message, /remote \$ref rejected/i);
        return true;
      }
    );
  });

  test('6. remote-ref-file: rejects file:// $ref with "remote $ref rejected"', () => {
    const schema = { $ref: 'file:///etc/passwd' };
    assert.throws(
      () => compileToolInputSchema(schema),
      (err) => {
        assert.match(err.message, /remote \$ref rejected/i);
        return true;
      }
    );
  });

  test('7. disallowed-format-phone: rejects format "phone" (not in allowlist)', () => {
    const schema = { type: 'string', format: 'phone' };
    assert.throws(
      () => compileToolInputSchema(schema),
      (err) => {
        assert.match(err.message, /unsupported format 'phone'/i);
        return true;
      }
    );
  });

  test('8. disallowed-format-regex: rejects format "regex" (ReDoS protection)', () => {
    const schema = { type: 'string', format: 'regex' };
    assert.throws(
      () => compileToolInputSchema(schema),
      (err) => {
        assert.match(err.message, /unsupported format 'regex'/i);
        return true;
      }
    );
  });

  test('9. unknown-keyword-strict: unknown keyword triggers ajv StrictMode error', () => {
    // Ajv strict mode rejects unknown keywords.
    const schema = { type: 'string', evilKeyword: true };
    assert.throws(
      () => compileToolInputSchema(schema),
      (err) => {
        // The error is caught and re-thrown as "ajv compile failed: ..."
        assert.match(err.message, /ajv compile failed/i);
        return true;
      }
    );
  });

  test('10. deep-nesting-safety: 50-level nested object rejects or compiles within 500ms', () => {
    // Build a 50-level deep schema — maxes out well above the depth cap of 32.
    let schema = { type: 'string' };
    for (let i = 0; i < 50; i++) {
      schema = { type: 'object', properties: { nested: schema }, additionalProperties: false };
    }

    const start = Date.now();
    let threw = false;
    try {
      compileToolInputSchema(schema);
    } catch (_err) {
      threw = true;
    }
    const elapsed = Date.now() - start;

    // Either it threw (depth cap triggered) OR it compiled — but it must not have hung.
    assert.equal(elapsed < 500, true, `should complete in <500ms, took ${elapsed}ms`);

    // At 50 levels deep the pre-checker MUST have thrown (depth cap is 32).
    assert.equal(threw, true, 'expected depth-cap error for 50-level schema');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('validateInput — input validation', () => {
  test('11. integer-schema: validates 42 ok, rejects "42"', () => {
    const schema = { type: 'integer' };

    const pass = validateInput(schema, 42);
    assert.equal(pass.ok, true, '42 should be valid');
    assert.equal(pass.errors, null, 'no errors on valid input');

    const fail = validateInput(schema, '42');
    assert.equal(fail.ok, false, '"42" (string) should be invalid');
    assert.notEqual(fail.errors, null, 'errors should be present on invalid input');
    assert.equal(Array.isArray(fail.errors), true, 'errors should be an array');
  });
});
