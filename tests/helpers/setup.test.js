'use strict';

/**
 * Verifies that the global test setup in tests/helpers/setup.js runs before
 * every test file and sets ORCHESTRAY_TEST_SHARED_DIR to a path that does
 * NOT exist.
 *
 * If this test fails, the --require ./tests/helpers/setup.js wiring in
 * package.json scripts.test has been broken. Fix the test command; do not
 * delete this test.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('ORCHESTRAY_TEST_SHARED_DIR is set by global setup', () => {
  const val = process.env.ORCHESTRAY_TEST_SHARED_DIR;
  assert.ok(
    typeof val === 'string' && val.length > 0,
    'ORCHESTRAY_TEST_SHARED_DIR must be set; check --require wiring in package.json scripts.test'
  );
});

test('ORCHESTRAY_TEST_SHARED_DIR points to a non-existent path (isolation)', () => {
  const val = process.env.ORCHESTRAY_TEST_SHARED_DIR;
  assert.ok(
    typeof val === 'string' && val.length > 0,
    'ORCHESTRAY_TEST_SHARED_DIR must be set'
  );
  assert.ok(
    !fs.existsSync(val),
    'ORCHESTRAY_TEST_SHARED_DIR must point to a path that does not exist, ' +
    'so that no real shared-tier patterns can leak into tests. Got: ' + val
  );
});
