#!/usr/bin/env node
'use strict';

/**
 * v2219-double-fire-shim-rename.test.js — S3 shim rename acceptance tests.
 *
 * Verifies that bin/_lib/tokenwright/double-fire-guard.js (the shim) renames
 * dedup_key → dedup_token in the emitted doubleFireEvent, so the payload
 * matches the compression_double_fire_detected schema.
 *
 * Tests:
 *   1. First checkDoubleFire call → shouldFire:true, doubleFireEvent:null.
 *   2. Second checkDoubleFire call (same dedupToken) → shouldFire:false,
 *      doubleFireEvent has dedup_token (not dedup_key).
 *   3. doubleFireEvent passes schema validation (type field matches, required
 *      dedup_token field present, dedup_key field absent).
 *
 * Runner: node --test bin/__tests__/v2219-double-fire-shim-rename.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const SHIM_PATH  = path.join(REPO_ROOT, 'bin', '_lib', 'tokenwright', 'double-fire-guard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpStateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2219-dfshim-'));
  const stateDir = path.join(root, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2219-S3-double-fire-shim-rename', () => {

  test('1. first call with a fresh dedupToken → shouldFire:true, no doubleFireEvent', () => {
    const { stateDir } = makeTmpStateDir();
    const { checkDoubleFire } = require(SHIM_PATH);

    const result = checkDoubleFire({
      dedupToken:       'test-token-abc123',
      callerPath:       '/fake/inject-tokenwright.js',
      stateDir,
      orchestrationId:  'orch-shim-test',
    });

    assert.equal(result.shouldFire, true, 'first call should fire');
    assert.equal(result.doubleFireEvent, null,
      'first call should not produce a doubleFireEvent');
  });

  test('2. second call with same dedupToken → shouldFire:false, doubleFireEvent has dedup_token not dedup_key', () => {
    const { stateDir } = makeTmpStateDir();
    // Require fresh instance to avoid module cache from test 1.
    // Use a unique token to avoid any state bleed.
    const shimPath = require.resolve(SHIM_PATH);
    // Clear module cache for a clean slate.
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'bin', '_lib', 'double-fire-guard'))];
    delete require.cache[shimPath];
    const { checkDoubleFire } = require(SHIM_PATH);

    const dedupToken = 'test-token-unique-' + Date.now();
    const callerPath = '/fake/inject-tokenwright.js';

    // First call registers the token.
    const first = checkDoubleFire({
      dedupToken,
      callerPath,
      stateDir,
      orchestrationId: 'orch-shim-test-2',
    });
    assert.equal(first.shouldFire, true, 'first call should fire');

    // Second call from a different caller path within TTL triggers double-fire.
    const second = checkDoubleFire({
      dedupToken,
      callerPath:      '/fake/other-install/inject-tokenwright.js',
      stateDir,
      orchestrationId: 'orch-shim-test-2',
    });

    assert.equal(second.shouldFire, false, 'second call should not fire');
    assert.ok(second.doubleFireEvent, 'second call should produce a doubleFireEvent');

    const evt = second.doubleFireEvent;
    assert.ok('dedup_token' in evt,
      'doubleFireEvent must have dedup_token field (S3 shim rename)');
    assert.ok(!('dedup_key' in evt),
      'doubleFireEvent must NOT have dedup_key field after shim rename');
    assert.equal(evt.dedup_token, dedupToken,
      'dedup_token value must match the input dedupToken');
  });

  test('3. doubleFireEvent type field is compression_double_fire_detected', () => {
    const { stateDir } = makeTmpStateDir();
    // Fresh module cache again.
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'bin', '_lib', 'double-fire-guard'))];
    delete require.cache[require.resolve(SHIM_PATH)];
    const { checkDoubleFire } = require(SHIM_PATH);

    const dedupToken = 'test-token-type-check-' + Date.now();

    // First call.
    checkDoubleFire({
      dedupToken,
      callerPath:      '/fake/install-a/inject-tokenwright.js',
      stateDir,
      orchestrationId: 'orch-shim-test-3',
    });

    // Second call (different caller path to trigger double-fire).
    const result = checkDoubleFire({
      dedupToken,
      callerPath:      '/fake/install-b/inject-tokenwright.js',
      stateDir,
      orchestrationId: 'orch-shim-test-3',
    });

    assert.ok(result.doubleFireEvent, 'doubleFireEvent should be present');
    const evt = result.doubleFireEvent;

    assert.equal(evt.type, 'compression_double_fire_detected',
      'type field must be compression_double_fire_detected');
    assert.equal(evt.event_type, 'compression_double_fire_detected',
      'event_type field must be compression_double_fire_detected');
    assert.ok('dedup_token' in evt,
      'dedup_token must be present (schema required field)');
    assert.ok(!('dedup_key' in evt),
      'dedup_key must be absent (renamed to dedup_token)');
  });

});
