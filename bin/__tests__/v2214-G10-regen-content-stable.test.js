#!/usr/bin/env node
'use strict';

/**
 * v2214-G10-regen-content-stable.test.js
 *
 * Verifies the G-10 content-stability guarantee for regen-schema-shadow.js:
 *   1. Regen writes the shadow file on first call (or when content changes).
 *   2. A second regen with no source change is a no-op — file mtime unchanged.
 *   3. _meta.generated_at is absent from the output (removed in v2.2.14 G-10).
 *
 * Runner: node --require ./tests/helpers/setup.js --test
 *         bin/__tests__/v2214-G10-regen-content-stable.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-G10-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* best-effort */ }
}

/**
 * Create the minimal directory structure that regen-schema-shadow.js requires.
 * Copies the real event-schemas.md so the parser produces a realistic shadow.
 */
function setupTmpRepo(dir) {
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });

  const realSchemas = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
  fs.copyFileSync(realSchemas, path.join(pmRefDir, 'event-schemas.md'));

  // regen looks for the state directory to clear the sentinel (best-effort)
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

  return path.join(pmRefDir, 'event-schemas.shadow.json');
}

// Require the module under test in the context of the given cwd.
// regen-schema-shadow.js exports main() via module.exports (if we add it),
// but currently it only exposes main via require.main guard. We invoke via
// child_process to avoid cwd coupling and zone1 side-effects.
const { execFileSync } = require('node:child_process');

function callRegen(cwd) {
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js'), '--cwd', cwd],
    { encoding: 'utf8', env: { ...process.env } }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('G-10: regen-schema-shadow content-stability', () => {
  test('1. shadow file is written on first call', () => {
    const dir = makeTmpDir();
    try {
      const outPath = setupTmpRepo(dir);
      assert.ok(!fs.existsSync(outPath), 'shadow must not exist before regen');
      callRegen(dir);
      assert.ok(fs.existsSync(outPath), 'shadow must exist after first regen');
    } finally {
      cleanupDir(dir);
    }
  });

  test('2. second regen with unchanged source does not modify mtime', () => {
    const dir = makeTmpDir();
    try {
      const outPath = setupTmpRepo(dir);

      callRegen(dir);
      const mtime1 = fs.statSync(outPath).mtimeMs;

      // Small sleep to ensure clock ticks — stat resolution on Linux is 1 ms
      // but give it a small buffer so a genuine write would show up.
      const SLEEP_MS = 20;
      const deadline = Date.now() + SLEEP_MS;
      while (Date.now() < deadline) { /* busy wait — avoids sleep() */ }

      callRegen(dir);
      const mtime2 = fs.statSync(outPath).mtimeMs;

      assert.equal(mtime1, mtime2,
        'mtime must be unchanged on second regen (no-op because content is identical)');
    } finally {
      cleanupDir(dir);
    }
  });

  test('3. _meta.generated_at is absent from shadow output', () => {
    const dir = makeTmpDir();
    try {
      const outPath = setupTmpRepo(dir);
      callRegen(dir);

      const shadow = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.ok(shadow._meta, '_meta block must be present');
      assert.equal(shadow._meta.generated_at, undefined,
        '_meta.generated_at must be absent (v2.2.14 G-10 removed it to prevent dirty git status)');
    } finally {
      cleanupDir(dir);
    }
  });

  test('4. shadow content is byte-identical between two regens with unchanged source', () => {
    const dir = makeTmpDir();
    try {
      const outPath = setupTmpRepo(dir);

      callRegen(dir);
      const content1 = fs.readFileSync(outPath, 'utf8');

      callRegen(dir);
      const content2 = fs.readFileSync(outPath, 'utf8');

      assert.equal(content1, content2,
        'shadow content must be byte-identical on repeated regens with unchanged source');
    } finally {
      cleanupDir(dir);
    }
  });

  test('5. regen does write when source content changes', () => {
    const dir = makeTmpDir();
    try {
      const outPath    = setupTmpRepo(dir);
      const mdPath     = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');

      callRegen(dir);
      const mtime1     = fs.statSync(outPath).mtimeMs;
      const content1   = fs.readFileSync(outPath, 'utf8');
      const shadow1    = JSON.parse(content1);

      // Busy-wait so clock ticks
      const deadline = Date.now() + 20;
      while (Date.now() < deadline) {}

      // Append a new dummy event section to the source
      const extra = '\n\n### `test_dummy_event_g10` event\n\n' +
        '```json\n{ "event_type": "test_dummy_event_g10" }\n```\n';
      fs.appendFileSync(mdPath, extra, 'utf8');

      callRegen(dir);
      const mtime2   = fs.statSync(outPath).mtimeMs;
      const shadow2  = JSON.parse(fs.readFileSync(outPath, 'utf8'));

      assert.notEqual(mtime1, mtime2,
        'mtime must change after source modification');
      assert.notEqual(shadow1._meta.source_hash, shadow2._meta.source_hash,
        'source_hash must change when source content changes');
    } finally {
      cleanupDir(dir);
    }
  });
});
