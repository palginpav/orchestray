#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/lib/schemas.js
 *
 * Per v2011c-stage1-plan.md §3.2 and §11.
 *
 * Contract under test:
 *   validateAskUserInput(input: unknown)
 *     -> { ok: true } | { ok: false, errors: string[] }
 *   validateAskUserOutput(output: unknown)
 *     -> { ok: true } | { ok: false, errors: string[] }
 *   validateElicitationRequestedSchema(schema: unknown)
 *     -> { ok: true } | { ok: false, errors: string[] }
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAskUserInput,
  validateAskUserOutput,
  validateElicitationRequestedSchema,
} = require('../../bin/mcp-server/lib/schemas.js');

// ---------------------------------------------------------------------------
// validateAskUserInput
// ---------------------------------------------------------------------------

describe('validateAskUserInput', () => {

  test('accepts a minimal valid input: title, question, and one text field', () => {
    const input = {
      title: 'Pick a branch',
      question: 'Which branch do you want to target?',
      form: [{ name: 'branch', label: 'Branch', type: 'text' }],
    };
    const result = validateAskUserInput(input);
    assert.deepEqual(result, { ok: true });
  });

  test('accepts a full valid input with all field types and timeout_seconds', () => {
    const input = {
      title: 'Configure deploy',
      question: 'Set all deploy parameters',
      form: [
        { name: 'target', label: 'Target', type: 'text', required: true },
        { name: 'dry_run', label: 'Dry run?', type: 'boolean', default: false },
        {
          name: 'env',
          label: 'Environment',
          type: 'select',
          choices: ['staging', 'preprod', 'prod'],
          required: true,
        },
        { name: 'retries', label: 'Retries', type: 'number', default: 3 },
      ],
      timeout_seconds: 180,
    };
    const result = validateAskUserInput(input);
    assert.deepEqual(result, { ok: true });
  });

  test('rejects input missing title with an error naming the missing field', () => {
    const input = {
      question: 'Which branch?',
      form: [{ name: 'branch', label: 'Branch', type: 'text' }],
    };
    const result = validateAskUserInput(input);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    assert.ok(
      result.errors.some((e) => String(e).includes('title')),
      `errors should mention "title"; got: ${JSON.stringify(result.errors)}`
    );
  });

  test('rejects input missing question with an error naming the missing field', () => {
    const input = {
      title: 'Pick a branch',
      form: [{ name: 'branch', label: 'Branch', type: 'text' }],
    };
    const result = validateAskUserInput(input);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => String(e).includes('question')),
      `errors should mention "question"; got: ${JSON.stringify(result.errors)}`
    );
  });

  test('rejects input missing form array with an error naming the missing field', () => {
    const input = {
      title: 'Pick a branch',
      question: 'Which branch?',
    };
    const result = validateAskUserInput(input);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => String(e).includes('form')),
      `errors should mention "form"; got: ${JSON.stringify(result.errors)}`
    );
  });

  test('rejects form with more than 5 fields (maxItems enforced)', () => {
    const mkField = (i) => ({ name: `f${i}`, label: `L${i}`, type: 'text' });
    const input = {
      title: 'Too many fields',
      question: 'Six fields is too many',
      form: [mkField(1), mkField(2), mkField(3), mkField(4), mkField(5), mkField(6)],
    };
    const result = validateAskUserInput(input);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  test('rejects form field with unknown type (e.g. "textarea")', () => {
    const input = {
      title: 'Bad type',
      question: 'What?',
      form: [{ name: 'notes', label: 'Notes', type: 'textarea' }],
    };
    const result = validateAskUserInput(input);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => String(e).toLowerCase().includes('type')),
      `errors should mention the invalid "type"; got: ${JSON.stringify(result.errors)}`
    );
  });

  test('rejects timeout_seconds outside [10, 600]', () => {
    const tooLow = {
      title: 'Bad timeout',
      question: 'What?',
      form: [{ name: 'x', label: 'X', type: 'text' }],
      timeout_seconds: 5,
    };
    const tooHigh = {
      title: 'Bad timeout',
      question: 'What?',
      form: [{ name: 'x', label: 'X', type: 'text' }],
      timeout_seconds: 601,
    };
    const low = validateAskUserInput(tooLow);
    const high = validateAskUserInput(tooHigh);
    assert.equal(low.ok, false, 'timeout_seconds=5 should be rejected');
    assert.equal(high.ok, false, 'timeout_seconds=601 should be rejected');
  });

});

// ---------------------------------------------------------------------------
// validateAskUserOutput
// ---------------------------------------------------------------------------

describe('validateAskUserOutput', () => {

  test('accepts { cancelled: false, ...answers }', () => {
    const result = validateAskUserOutput({
      cancelled: false,
      branch: 'main',
      confirm: true,
    });
    assert.deepEqual(result, { ok: true });
  });

  test('accepts { cancelled: true } with no answers', () => {
    const result = validateAskUserOutput({ cancelled: true });
    assert.deepEqual(result, { ok: true });
  });

});

// ---------------------------------------------------------------------------
// validateElicitationRequestedSchema
// ---------------------------------------------------------------------------
// Per plan §3.2: flat object, primitive types only, enums allowed on strings.
// No arrays, no nesting, no $ref/oneOf/anyOf/allOf/not/if-then-else.

describe('validateElicitationRequestedSchema', () => {

  test('rejects a nested object property (nesting not allowed)', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    };
    const result = validateElicitationRequestedSchema(schema);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  test('rejects schemas using $ref, oneOf, or anyOf', () => {
    const withRef = {
      type: 'object',
      properties: { foo: { $ref: '#/definitions/bar' } },
    };
    const withOneOf = {
      type: 'object',
      properties: { foo: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    const withAnyOf = {
      type: 'object',
      properties: { foo: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    assert.equal(validateElicitationRequestedSchema(withRef).ok, false);
    assert.equal(validateElicitationRequestedSchema(withOneOf).ok, false);
    assert.equal(validateElicitationRequestedSchema(withAnyOf).ok, false);
  });

});
