'use strict';

/**
 * Tests for bin/_lib/models.js
 *
 * Covers: lookupModel, resolveContextWindow, modelShort
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { lookupModel, resolveContextWindow, modelShort, MODEL_UNKNOWN } = require('../../bin/_lib/models');

describe('lookupModel', () => {
  test('returns metadata for claude-sonnet-4-6', () => {
    const meta = lookupModel('claude-sonnet-4-6');
    assert.equal(meta.short, 'son-4-6');
    assert.equal(meta.window_default, 200000);
  });

  test('returns metadata for claude-opus-4-6', () => {
    const meta = lookupModel('claude-opus-4-6');
    assert.equal(meta.short, 'opu-4-6');
    assert.equal(meta.window_1m, 1000000);
  });

  test('returns metadata for claude-haiku-4-5', () => {
    const meta = lookupModel('claude-haiku-4-5');
    assert.equal(meta.short, 'hai-4-5');
  });

  test('returns MODEL_UNKNOWN for an unrecognized model ID', () => {
    const meta = lookupModel('claude-future-99');
    assert.equal(meta.short, '?');
    assert.equal(meta.window_default, 200000);
  });

  test('returns MODEL_UNKNOWN for null input', () => {
    const meta = lookupModel(null);
    assert.equal(meta.short, '?');
  });

  test('returns MODEL_UNKNOWN for empty string', () => {
    const meta = lookupModel('');
    assert.equal(meta.short, '?');
  });
});

describe('resolveContextWindow', () => {
  test('returns 200000 for sonnet (no 1M variant)', () => {
    assert.equal(resolveContextWindow('claude-sonnet-4-6', null), 200000);
  });

  test('returns 200000 for opus when display_name does not contain (1M)', () => {
    assert.equal(resolveContextWindow('claude-opus-4-6', 'Opus 4.6'), 200000);
  });

  test('returns 1000000 for opus when display_name contains (1M)', () => {
    assert.equal(resolveContextWindow('claude-opus-4-6', 'Opus 4.6 (1M)'), 1000000);
  });

  test('returns 200000 for unknown model', () => {
    assert.equal(resolveContextWindow('unknown-model', null), 200000);
  });
});

describe('modelShort', () => {
  test('returns short code for known model', () => {
    assert.equal(modelShort('claude-haiku-4-5'), 'hai-4-5');
  });

  test('returns ? for unknown model', () => {
    assert.equal(modelShort('not-a-model'), '?');
  });

  test('returns ? for null', () => {
    assert.equal(modelShort(null), '?');
  });
});
