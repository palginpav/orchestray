#!/usr/bin/env node
'use strict';

/**
 * v2.2.14 G-05 — dossier_orphan_threshold config-schema registration tests.
 *
 * Verifies that:
 *   1. validateDossierOrphanThreshold(7) passes.
 *   2. validateDossierOrphanThreshold(undefined) passes with default 5.
 *   3. validateDossierOrphanThreshold(-1) rejects (below min).
 *   4. validateDossierOrphanThreshold("abc") rejects (wrong type).
 *   5. Config-repair round-trip: loadDossierOrphanConfig on a config with
 *      dossier_orphan_threshold:12 returns 12, not stripped.
 *
 * Source: W2 finding C2 at .orchestray/kb/artifacts/v2214-W2-wide-audit.md.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const {
  DEFAULT_DOSSIER_ORPHAN_THRESHOLD,
  loadDossierOrphanConfig,
  validateDossierOrphanThreshold,
} = require('../_lib/config-schema.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-G05-'));
  fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
  return tmp;
}

function writeConfig(cwd, obj) {
  fs.writeFileSync(
    path.join(cwd, '.orchestray', 'config.json'),
    JSON.stringify(obj, null, 2),
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Case 1: validate with dossier_orphan_threshold: 7 — should pass
// ---------------------------------------------------------------------------

describe('v2.2.14 G-05 — Case 1: valid integer 7 passes validation', () => {
  test('validateDossierOrphanThreshold(7) returns valid:true', () => {
    const result = validateDossierOrphanThreshold(7);
    assert.equal(result.valid, true, 'integer 7 should be valid');
  });
});

// ---------------------------------------------------------------------------
// Case 2: validate without the key (absent/undefined) — should pass with default 5
// ---------------------------------------------------------------------------

describe('v2.2.14 G-05 — Case 2: absent key uses default 5', () => {
  test('validateDossierOrphanThreshold(undefined) returns valid:true', () => {
    const result = validateDossierOrphanThreshold(undefined);
    assert.equal(result.valid, true, 'absent key should be valid (optional field)');
  });

  test('DEFAULT_DOSSIER_ORPHAN_THRESHOLD is 5', () => {
    assert.equal(DEFAULT_DOSSIER_ORPHAN_THRESHOLD, 5, 'default should be 5 per v2.2.13 G-08');
  });

  test('loadDossierOrphanConfig on empty config returns default 5', () => {
    const cwd = makeTmpDir();
    writeConfig(cwd, {});
    const result = loadDossierOrphanConfig(cwd);
    assert.equal(
      result.dossier_orphan_threshold,
      5,
      'absent key should return default 5'
    );
  });

  test('loadDossierOrphanConfig on missing config file returns default 5', () => {
    const cwd = makeTmpDir();
    // No config file written — directory exists but file does not.
    const result = loadDossierOrphanConfig(cwd);
    assert.equal(
      result.dossier_orphan_threshold,
      5,
      'missing config file should return default 5'
    );
  });
});

// ---------------------------------------------------------------------------
// Case 3: validate with dossier_orphan_threshold: -1 — should reject (below min)
// ---------------------------------------------------------------------------

describe('v2.2.14 G-05 — Case 3: value -1 is rejected (below min)', () => {
  test('validateDossierOrphanThreshold(-1) returns valid:false', () => {
    const result = validateDossierOrphanThreshold(-1);
    assert.equal(result.valid, false, '-1 should be invalid (must be >= 1)');
    assert.ok(
      Array.isArray(result.errors) && result.errors.length > 0,
      'errors array should be non-empty'
    );
    assert.match(
      result.errors[0],
      /positive integer/i,
      'error message should mention positive integer'
    );
  });

  test('validateDossierOrphanThreshold(0) returns valid:false', () => {
    const result = validateDossierOrphanThreshold(0);
    assert.equal(result.valid, false, '0 should be invalid (must be >= 1)');
  });
});

// ---------------------------------------------------------------------------
// Case 4: validate with dossier_orphan_threshold: "abc" — should reject (wrong type)
// ---------------------------------------------------------------------------

describe('v2.2.14 G-05 — Case 4: string "abc" is rejected (wrong type)', () => {
  test('validateDossierOrphanThreshold("abc") returns valid:false', () => {
    const result = validateDossierOrphanThreshold('abc');
    assert.equal(result.valid, false, 'string "abc" should be invalid (must be integer)');
    assert.ok(
      Array.isArray(result.errors) && result.errors.length > 0,
      'errors array should be non-empty'
    );
  });

  test('validateDossierOrphanThreshold(3.7) returns valid:false (non-integer)', () => {
    const result = validateDossierOrphanThreshold(3.7);
    assert.equal(result.valid, false, 'float 3.7 should be invalid (must be integer)');
  });
});

// ---------------------------------------------------------------------------
// Case 5: config-repair round-trip — value 12 must NOT be stripped
// ---------------------------------------------------------------------------

describe('v2.2.14 G-05 — Case 5: config-repair round-trip preserves dossier_orphan_threshold:12', () => {
  test('loadDossierOrphanConfig reads dossier_orphan_threshold:12 from config', () => {
    const cwd = makeTmpDir();
    writeConfig(cwd, { dossier_orphan_threshold: 12 });

    const result = loadDossierOrphanConfig(cwd);
    assert.equal(
      result.dossier_orphan_threshold,
      12,
      'user-set value 12 must be returned, not stripped or replaced with default'
    );
  });

  test('loadDossierOrphanConfig reads dossier_orphan_threshold:1 (boundary)', () => {
    const cwd = makeTmpDir();
    writeConfig(cwd, { dossier_orphan_threshold: 1 });

    const result = loadDossierOrphanConfig(cwd);
    assert.equal(result.dossier_orphan_threshold, 1, 'minimum valid value 1 should be preserved');
  });

  test('loadDossierOrphanConfig on malformed JSON returns default 5', () => {
    const cwd = makeTmpDir();
    fs.writeFileSync(
      path.join(cwd, '.orchestray', 'config.json'),
      '{not valid json}',
      'utf8'
    );
    const result = loadDossierOrphanConfig(cwd);
    assert.equal(result.dossier_orphan_threshold, 5, 'malformed JSON should fall back to default');
  });

  test('loadDossierOrphanConfig with invalid value falls back to default 5', () => {
    const cwd = makeTmpDir();
    writeConfig(cwd, { dossier_orphan_threshold: 'not-a-number' });

    const result = loadDossierOrphanConfig(cwd);
    assert.equal(
      result.dossier_orphan_threshold,
      5,
      'invalid value type should fall back to default 5'
    );
  });
});
