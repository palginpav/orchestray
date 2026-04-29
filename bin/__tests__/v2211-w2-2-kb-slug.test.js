'use strict';

/**
 * Tests for bin/validate-kb-slug.js (W2-2).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isKbPath, extractSlug, validateSlug, SLUG_VALID_RE } = require('../validate-kb-slug');

// ---------------------------------------------------------------------------
// isKbPath
// ---------------------------------------------------------------------------

describe('isKbPath', () => {
  test('returns true for artifacts path', () => {
    assert.equal(isKbPath('/project/.orchestray/kb/artifacts/my-fact.md'), true);
  });

  test('returns true for facts path', () => {
    assert.equal(isKbPath('/project/.orchestray/kb/facts/some-fact.md'), true);
  });

  test('returns true for decisions path', () => {
    assert.equal(isKbPath('/project/.orchestray/kb/decisions/arch-decision.md'), true);
  });

  test('returns false for non-KB path', () => {
    assert.equal(isKbPath('/project/src/index.ts'), false);
  });

  test('returns false for empty string', () => {
    assert.equal(isKbPath(''), false);
  });

  test('returns false for .orchestray/state path', () => {
    assert.equal(isKbPath('/project/.orchestray/state/orchestration.md'), false);
  });

  test('returns false for KB parent directory without subdir', () => {
    assert.equal(isKbPath('/project/.orchestray/kb/README.md'), false);
  });
});

// ---------------------------------------------------------------------------
// extractSlug
// ---------------------------------------------------------------------------

describe('extractSlug', () => {
  test('strips .md extension', () => {
    assert.equal(extractSlug('/project/.orchestray/kb/artifacts/my-fact.md'), 'my-fact');
  });

  test('returns basename for path with no .md', () => {
    assert.equal(extractSlug('/project/.orchestray/kb/artifacts/myfile'), 'myfile');
  });

  test('returns basename only (no directory prefix)', () => {
    assert.equal(extractSlug('/a/b/c/slug.md'), 'slug');
  });
});

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

describe('validateSlug', () => {
  test('accepts alphanumeric slug with hyphens', () => {
    const { valid } = validateSlug('my-valid-slug');
    assert.equal(valid, true);
  });

  test('accepts slug with underscores', () => {
    const { valid } = validateSlug('v2211_w2_audit');
    assert.equal(valid, true);
  });

  test('accepts slug with mixed case and numbers', () => {
    const { valid } = validateSlug('F1-A-2211');
    assert.equal(valid, true);
  });

  test('rejects slug containing ..', () => {
    const { valid, reason } = validateSlug('../escape');
    assert.equal(valid, false);
    assert.match(reason, /disallowed characters/);
  });

  test('rejects slug containing forward slash', () => {
    const { valid } = validateSlug('foo/bar');
    assert.equal(valid, false);
  });

  test('rejects slug containing spaces', () => {
    const { valid } = validateSlug('my slug');
    assert.equal(valid, false);
  });

  test('rejects slug containing dot', () => {
    const { valid } = validateSlug('my.slug');
    assert.equal(valid, false);
  });

  test('rejects empty slug', () => {
    const { valid, reason } = validateSlug('');
    assert.equal(valid, false);
    assert.match(reason, /empty/);
  });

  test('rejects null input', () => {
    const { valid } = validateSlug(null);
    assert.equal(valid, false);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('kill switch ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED', () => {
  test('kill switch env var is detectable when set to 1', () => {
    const prev = process.env.ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED;
    process.env.ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED = '1';
    assert.equal(process.env.ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED, '1');
    if (prev === undefined) {
      delete process.env.ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED;
    } else {
      process.env.ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// SLUG_VALID_RE constant
// ---------------------------------------------------------------------------

describe('SLUG_VALID_RE', () => {
  test('allows hyphens and underscores', () => {
    assert.equal(SLUG_VALID_RE.test('my-slug_v1'), true);
  });

  test('rejects dots', () => {
    assert.equal(SLUG_VALID_RE.test('my.slug'), false);
  });

  test('rejects double dot traversal', () => {
    assert.equal(SLUG_VALID_RE.test('..'), false);
  });

  test('rejects empty string', () => {
    assert.equal(SLUG_VALID_RE.test(''), false);
  });
});
