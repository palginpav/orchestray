#!/usr/bin/env node
'use strict';

/**
 * validate-config-resume-race.test.js
 *
 * Regression tests for the SessionStart:resume ENOENT race fix (v2.3.11).
 *
 * Root cause: during an in-flight orchestration, a concurrent runtime writer
 * (atomic rename or unlink of patterns/*.md) could remove a file between
 * readdirSync and readFileSync, causing an ENOENT → exit 1 → boot failure.
 *
 * Test matrix:
 *   1. ENOENT race: a pattern file vanishes mid-scan → skipped (ok:true), exit 0
 *   2. Severity split (configOnlyExit):
 *      a. valid config + schema-invalid pattern (missing category) → exit 0
 *      b. invalid config.json → exit 1
 *   3. Truncated/proposed pattern file (no closing ---) → configOnlyExit → exit 0
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { run, validatePatternFiles } = require(path.join(REPO_ROOT, 'bin', 'validate-config.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'patterns'), { recursive: true });
  return tmp;
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

/** Write a minimal valid config.json under cwd. */
function writeValidConfig(tmp) {
  const dir = path.join(tmp, '.orchestray');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ complexity_threshold: 5 }),
    'utf8'
  );
}

/** Write a valid pattern .md under .orchestray/patterns/. */
function writeValidPattern(tmp, name) {
  const content = [
    '---',
    'name: ' + name,
    'category: routing',
    'confidence: 0.8',
    'description: A test pattern',
    '---',
    '',
    '# Body',
  ].join('\n');
  fs.writeFileSync(path.join(tmp, '.orchestray', 'patterns', name + '.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Test 1 — ENOENT race: file vanishes between readdirSync and readFileSync
// ---------------------------------------------------------------------------

describe('validate-config-resume-race — ENOENT mid-scan is non-fatal', () => {
  test('Test 1: pattern file vanishes during scan → skipped, configOnlyExit returns 0', () => {
    const tmp = makeTmp('vcr-t1-');
    try {
      writeValidConfig(tmp);
      writeValidPattern(tmp, 'my-pattern');

      // Stub fs.readFileSync to throw ENOENT for the pattern file specifically.
      const origReadFileSync = fs.readFileSync;
      const patternPath = path.join(tmp, '.orchestray', 'patterns', 'my-pattern.md');
      fs.readFileSync = function(p, enc) {
        if (p === patternPath) {
          const err = new Error('ENOENT: no such file or directory, open \'' + p + '\'');
          err.code = 'ENOENT';
          throw err;
        }
        return origReadFileSync.call(this, p, enc);
      };

      let code;
      try {
        code = run({ cwd: tmp, configOnlyExit: true });
      } finally {
        fs.readFileSync = origReadFileSync;
      }

      assert.equal(code, 0, 'configOnlyExit must return 0 when only a pattern vanished mid-scan');

      // Also verify validatePatternFiles directly marks it as skipped
      fs.readFileSync = function(p, enc) {
        if (p === patternPath) {
          const err = new Error('ENOENT: no such file or directory, open \'' + p + '\'');
          err.code = 'ENOENT';
          throw err;
        }
        return origReadFileSync.call(this, p, enc);
      };
      let patResults;
      try {
        patResults = validatePatternFiles(tmp);
      } finally {
        fs.readFileSync = origReadFileSync;
      }
      assert.equal(patResults.length, 1, 'should have one result entry');
      assert.equal(patResults[0].ok, true, 'vanished file should be ok:true');
      assert.ok(patResults[0].skipped, 'vanished file should have a skipped note');
      assert.ok(
        patResults[0].skipped.includes('concurrent write') || patResults[0].skipped.includes('vanished'),
        'skipped note should mention concurrent write; got: ' + patResults[0].skipped
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2a — severity split: valid config + schema-invalid pattern → exit 0
// ---------------------------------------------------------------------------

describe('validate-config-resume-race — severity split: artifact failures non-fatal with configOnlyExit', () => {
  test('Test 2a: valid config + schema-invalid pattern (missing category) → configOnlyExit returns 0', () => {
    const tmp = makeTmp('vcr-t2a-');
    try {
      writeValidConfig(tmp);

      // Write a pattern missing the required `category` field.
      const badPattern = [
        '---',
        'name: bad-pattern',
        'confidence: 0.5',
        'description: Missing category field',
        '---',
        '',
        '# Body',
      ].join('\n');
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'patterns', 'bad-pattern.md'),
        badPattern,
        'utf8'
      );

      const code = run({ cwd: tmp, configOnlyExit: true });
      assert.equal(code, 0, 'configOnlyExit must return 0 when only a pattern is schema-invalid');
    } finally {
      cleanup(tmp);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2b — severity split: invalid config.json → exit 1 even with configOnlyExit
  // ---------------------------------------------------------------------------

  test('Test 2b: invalid config.json → configOnlyExit returns 1', () => {
    const tmp = makeTmp('vcr-t2b-');
    try {
      // Write a config.json that fails zod (schema-invalid value type)
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ complexity_threshold: 'not-a-number' }),
        'utf8'
      );

      const code = run({ cwd: tmp, configOnlyExit: true });
      assert.equal(code, 1, 'configOnlyExit must return 1 when config.json fails validation');
    } finally {
      cleanup(tmp);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2c — default (no configOnlyExit): schema-invalid pattern → exit 1
  // ---------------------------------------------------------------------------

  test('Test 2c: default run (no configOnlyExit) exits 1 on schema-invalid pattern', () => {
    const tmp = makeTmp('vcr-t2c-');
    try {
      writeValidConfig(tmp);

      const badPattern = [
        '---',
        'name: bad-pattern',
        'confidence: 0.5',
        'description: Missing category field',
        '---',
        '',
        '# Body',
      ].join('\n');
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'patterns', 'bad-pattern.md'),
        badPattern,
        'utf8'
      );

      const code = run({ cwd: tmp }); // no configOnlyExit
      assert.equal(code, 1, 'default run must return 1 when any artifact fails validation');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — truncated/proposed pattern file (no closing ---) → configOnlyExit → exit 0
// ---------------------------------------------------------------------------

describe('validate-config-resume-race — truncated pattern is non-fatal with configOnlyExit', () => {
  test('Test 3: pattern with no closing --- → configOnlyExit returns 0', () => {
    const tmp = makeTmp('vcr-t3-');
    try {
      writeValidConfig(tmp);

      // Truncated: frontmatter block never closed — parseFrontmatter returns null
      const truncated = [
        '---',
        'name: truncated-pattern',
        'category: routing',
        '(file truncated mid-write)',
      ].join('\n');
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'patterns', 'truncated-pattern.md'),
        truncated,
        'utf8'
      );

      const code = run({ cwd: tmp, configOnlyExit: true });
      assert.equal(code, 0, 'configOnlyExit must return 0 when only a truncated pattern fails');
    } finally {
      cleanup(tmp);
    }
  });
});
