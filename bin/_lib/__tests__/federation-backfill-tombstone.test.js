#!/usr/bin/env node
'use strict';

/**
 * Tests for P1-12 (v2.2.15): federation tombstone + provenance backfill
 *
 * Covers:
 *   - backfillPromoteLog happy path: unlogged patterns get entries appended
 *   - backfillPromoteLog skip: already-logged patterns are not duplicated
 *   - backfillPromoteLog missing sharedRoot: returns warn, does NOT throw
 *   - appendFederationTombstone happy path: tombstone entry appended
 *   - appendFederationTombstone missing slug: returns ok:false, does NOT throw
 *
 * Runner: node --test bin/_lib/__tests__/federation-backfill-tombstone.test.js
 *
 * Isolation contract:
 *   - Every test creates its own tmp dir. Real ~/.orchestray/shared is never touched.
 *   - All writes are verified by reading the log back and parsing JSON lines.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { backfillPromoteLog, appendFederationTombstone } = require('../shared-promote.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a tmp shared root with optional pattern files and optional existing log entries. */
function makeTmpSharedRoot({ patterns = [], existingLog = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fed-backfill-test-'));
  const patternsDir = path.join(root, 'patterns');
  const metaDir     = path.join(root, 'meta');
  fs.mkdirSync(patternsDir, { recursive: true });
  fs.mkdirSync(metaDir,     { recursive: true });

  for (const slug of patterns) {
    fs.writeFileSync(path.join(patternsDir, slug + '.md'),
      `---\nname: ${slug}\ncategory: decomposition\nconfidence: 0.8\ndescription: test\n---\n\nBody.\n`,
      'utf8');
  }

  if (existingLog.length > 0) {
    const logPath = path.join(metaDir, 'promote-log.jsonl');
    const lines   = existingLog.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(logPath, lines, 'utf8');
  }

  return root;
}

/** Read and parse all lines from the promote-log. */
function readLog(sharedRoot) {
  const logPath = path.join(sharedRoot, 'meta', 'promote-log.jsonl');
  try {
    return fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch (_e) {
    return [];
  }
}

/** Remove a tmp directory (best-effort). */
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// P1-12: backfillPromoteLog
// ---------------------------------------------------------------------------

describe('backfillPromoteLog — happy path', () => {
  test('adds entries for patterns not yet in log', () => {
    const sharedRoot = makeTmpSharedRoot({ patterns: ['alpha', 'beta', 'gamma'] });
    try {
      const result = backfillPromoteLog({ sharedRoot });
      assert.equal(result.warn,    null, 'no warn on success');
      assert.equal(result.added,   3,    'should add 3 entries');
      assert.equal(result.skipped, 0,    'nothing to skip');

      const log = readLog(sharedRoot);
      assert.equal(log.length, 3, 'log should have 3 entries');

      const slugs = log.map(e => e.slug).sort();
      assert.deepEqual(slugs, ['alpha', 'beta', 'gamma']);

      for (const entry of log) {
        assert.equal(entry.provenance, 'backfilled-v2.2.15', 'provenance tag must be set');
        assert.ok(entry.promoted_at,   'promoted_at must be set');
      }
    } finally {
      cleanup(sharedRoot);
    }
  });
});

describe('backfillPromoteLog — skips already-logged patterns', () => {
  test('does not duplicate entries for slugs already in log', () => {
    const sharedRoot = makeTmpSharedRoot({
      patterns:    ['alpha', 'beta'],
      existingLog: [{ slug: 'alpha', promoted_at: '2025-01-01T00:00:00.000Z', promoted_from: 'abc' }],
    });
    try {
      const result = backfillPromoteLog({ sharedRoot });
      assert.equal(result.warn,    null, 'no warn');
      assert.equal(result.added,   1,    'only beta needs backfill');
      assert.equal(result.skipped, 1,    'alpha already logged');

      const log = readLog(sharedRoot);
      // Original alpha entry + new beta entry = 2 total
      assert.equal(log.length, 2, 'log should have 2 entries total');

      // alpha entry should be unchanged (the original, not a new backfill)
      const alphaEntry = log.find(e => e.slug === 'alpha');
      assert.ok(alphaEntry, 'alpha entry must exist');
      assert.equal(alphaEntry.promoted_from, 'abc', 'original entry must be preserved');
      assert.ok(!alphaEntry.provenance, 'original entry must NOT get backfill tag');

      // beta entry should be the new backfill
      const betaEntry = log.find(e => e.slug === 'beta');
      assert.ok(betaEntry, 'beta entry must be added');
      assert.equal(betaEntry.provenance, 'backfilled-v2.2.15');
    } finally {
      cleanup(sharedRoot);
    }
  });
});

describe('backfillPromoteLog — missing sharedRoot', () => {
  test('returns warn string and does NOT throw when sharedRoot does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'orch-does-not-exist-' + Date.now());
    let result;
    assert.doesNotThrow(() => {
      result = backfillPromoteLog({ sharedRoot: nonExistent });
    }, 'must not throw on missing dir');
    assert.ok(typeof result.warn === 'string' && result.warn.length > 0, 'warn must be set');
    assert.equal(result.added,   0, 'nothing added');
    assert.equal(result.skipped, 0, 'nothing skipped');
  });
});

describe('backfillPromoteLog — dryRun mode', () => {
  test('dryRun:true logs but does not write to log file', () => {
    const sharedRoot = makeTmpSharedRoot({ patterns: ['alpha', 'beta'] });
    try {
      const result = backfillPromoteLog({ sharedRoot, dryRun: true });
      assert.equal(result.added, 2, 'should report 2 would-be additions');

      // Log file must not have been created.
      const logPath = path.join(sharedRoot, 'meta', 'promote-log.jsonl');
      assert.equal(fs.existsSync(logPath), false, 'log must not be written in dryRun mode');
    } finally {
      cleanup(sharedRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// P1-12: appendFederationTombstone
// ---------------------------------------------------------------------------

describe('appendFederationTombstone — happy path', () => {
  test('appends tombstone entry to promote-log', () => {
    const sharedRoot = makeTmpSharedRoot({
      existingLog: [{ slug: 'alpha', promoted_at: '2025-01-01T00:00:00.000Z' }],
    });
    try {
      const result = appendFederationTombstone({ slug: 'alpha', sharedRoot });
      assert.equal(result.ok, true, 'must return ok:true');

      const log = readLog(sharedRoot);
      assert.equal(log.length, 2, 'log must have original entry + tombstone');

      const tombstone = log[1];
      assert.equal(tombstone.slug,      'alpha',     'tombstone slug');
      assert.equal(tombstone.tombstone, true,        'tombstone flag');
      assert.equal(tombstone.reason,    'unshared',  'default reason');
      assert.ok(tombstone.tombstone_at, 'tombstone_at must be set');
    } finally {
      cleanup(sharedRoot);
    }
  });

  test('tombstone carries custom reason when provided', () => {
    const sharedRoot = makeTmpSharedRoot();
    try {
      const result = appendFederationTombstone({
        slug: 'beta',
        sharedRoot,
        reason: 'manual-revoke',
      });
      assert.equal(result.ok, true);
      const log = readLog(sharedRoot);
      assert.equal(log[0].reason, 'manual-revoke');
    } finally {
      cleanup(sharedRoot);
    }
  });
});

describe('appendFederationTombstone — missing slug', () => {
  test('returns ok:false with warn when slug is absent', () => {
    const sharedRoot = makeTmpSharedRoot();
    let result;
    assert.doesNotThrow(() => {
      result = appendFederationTombstone({ sharedRoot });
    });
    assert.equal(result.ok, false, 'must return ok:false');
    assert.ok(typeof result.warn === 'string' && result.warn.length > 0, 'warn must be set');
  });
});
