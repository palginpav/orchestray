#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/curator-recently-curated.js (H4 frontmatter stamp).
 *
 * Runner: node --test tests/_lib-curator-recently-curated.test.js
 *
 * Coverage:
 *   1. writeStamp → readStamp round-trip (all 5 keys preserved)
 *   2. Stamp appended AFTER existing frontmatter keys (order preservation)
 *   3. Multiple write calls overwrite — REPLACE semantics (§4.4)
 *   4. stripRecentlyCurated removes all 5 keys, other frontmatter untouched
 *   5. stripRecentlyCurated is idempotent (second call returns false)
 *   6. stripRecentlyCurated on pristine file returns false, no mutation
 *   7. normaliseWhy: truncates at 120 chars, strips newlines, handles colons
 *   8. Atomic write — no .tmp file left after write
 *   9. Integration: applyRollback strips stamp for promote-undo case
 *  10. signals.similarity_* round-trip in tombstone writeTombstone + listTombstones
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const path               = require('node:path');
const os                 = require('node:os');

const {
  writeStamp,
  readStamp,
  stripRecentlyCurated,
  applyStampsForRun,
  _internal: { normaliseWhy, STAMP_KEYS, MAX_WHY_LENGTH },
} = require('../bin/_lib/curator-recently-curated.js');

const {
  writeTombstone,
  startRun,
  undoById,
  undoLast,
  listTombstones,
} = require('../bin/_lib/curator-tombstone.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stamp-test-'));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write a minimal pattern file with frontmatter.
 */
function writePatternFile(dir, slug, extraFm = '') {
  const fm = `---\nname: ${slug}\ncategory: decomposition\nconfidence: 0.8\ntimes_applied: 3\n${extraFm}---\n`;
  const body = `\n# Pattern\n\nSome body content for the ${slug} pattern.\n`;
  const fp = path.join(dir, slug + '.md');
  fs.writeFileSync(fp, fm + body, 'utf8');
  return fp;
}

function readFileContent(fp) {
  return fs.readFileSync(fp, 'utf8');
}

/**
 * Build a sample stamp object.
 */
function sampleStamp(overrides = {}) {
  return Object.assign({
    at:        '2026-04-19T12:00:02Z',
    action:    'merge',
    action_id: 'curator-2026-04-19T12:00:00.000Z-1-a002',
    run_id:    'curator-2026-04-19T12:00:00.000Z-1',
    why:       'MinHash Jaccard 0.82, adversarial re-read passed',
  }, overrides);
}

// ---------------------------------------------------------------------------
// 1. Round-trip: writeStamp → readStamp
// ---------------------------------------------------------------------------

describe('writeStamp + readStamp round-trip', () => {
  test('all 5 keys round-trip losslessly', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'test-pattern');
    try {
      const stamp = sampleStamp();
      const result = writeStamp(fp, stamp);
      assert.ok(result.ok, 'writeStamp must succeed: ' + JSON.stringify(result));

      const read = readStamp(fp);
      assert.ok(read !== null, 'readStamp must return a stamp object');
      assert.strictEqual(read.at,        stamp.at);
      assert.strictEqual(read.action,    stamp.action);
      assert.strictEqual(read.action_id, stamp.action_id);
      assert.strictEqual(read.run_id,    stamp.run_id);
      assert.strictEqual(read.why,       stamp.why);
    } finally {
      cleanupDir(dir);
    }
  });

  test('readStamp returns null for file without stamp', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'pristine');
    try {
      const result = readStamp(fp);
      assert.strictEqual(result, null);
    } finally {
      cleanupDir(dir);
    }
  });

  test('readStamp returns null for unreadable file', () => {
    const result = readStamp('/nonexistent/path/pattern.md');
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 2. Stamp order preservation
// ---------------------------------------------------------------------------

describe('writeStamp — key order', () => {
  test('stamp keys appear AFTER existing frontmatter keys', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'ordered');
    try {
      writeStamp(fp, sampleStamp());
      const content = readFileContent(fp);
      // Find positions of existing and stamp keys.
      const posName      = content.indexOf('\nname:');
      const posCategory  = content.indexOf('\ncategory:');
      const posStampAt   = content.indexOf('\nrecently_curated_at:');
      assert.ok(posName    > 0, 'name key must exist');
      assert.ok(posCategory > 0, 'category key must exist');
      assert.ok(posStampAt  > 0, 'recently_curated_at key must exist');
      // Stamp keys must appear AFTER existing keys.
      assert.ok(posStampAt > posName,     'stamp must be after name');
      assert.ok(posStampAt > posCategory, 'stamp must be after category');
    } finally {
      cleanupDir(dir);
    }
  });

  test('existing fields are NOT reordered by writeStamp', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'noorder');
    try {
      const before = readFileContent(fp);
      const nameIdx     = before.indexOf('\nname:');
      const categoryIdx = before.indexOf('\ncategory:');
      const confIdx     = before.indexOf('\nconfidence:');
      writeStamp(fp, sampleStamp());
      const after = readFileContent(fp);
      const nameIdxA     = after.indexOf('\nname:');
      const categoryIdxA = after.indexOf('\ncategory:');
      const confIdxA     = after.indexOf('\nconfidence:');
      // Relative order of existing keys must be preserved.
      assert.ok(nameIdxA < categoryIdxA, 'name must still be before category');
      assert.ok(categoryIdxA < confIdxA,  'category must still be before confidence');
      // All stamp keys must appear AFTER all pre-existing keys.
      // This catches any implementation that reorders keys (e.g., alphabetical sort).
      const preExistingPositions = [nameIdxA, categoryIdxA, confIdxA,
        after.indexOf('\ntimes_applied:'), after.indexOf('\nlast_applied:')].filter(p => p > 0);
      const stampPositions = STAMP_KEYS.map(k => after.indexOf('\n' + k + ':')).filter(p => p > 0);
      const maxPreExisting = Math.max(...preExistingPositions);
      const maxStamp       = Math.max(...stampPositions);
      assert.ok(maxStamp > maxPreExisting, 'last stamp key must appear after last pre-existing key');
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. REPLACE semantics: multiple writes overwrite
// ---------------------------------------------------------------------------

describe('writeStamp — REPLACE semantics (§4.4)', () => {
  test('second stamp overwrites the first; only one set of 5 keys present', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'multi-stamp');
    try {
      writeStamp(fp, sampleStamp({ action: 'merge',     action_id: 'a001', why: 'first action' }));
      writeStamp(fp, sampleStamp({ action: 'deprecate', action_id: 'a007', why: 'second action' }));

      const content = readFileContent(fp);
      // Only a007 should be present; a001 must be gone.
      assert.ok(!content.includes('a001'), 'first action_id must be gone after overwrite');
      assert.ok(content.includes('a007'),  'second action_id must be present');
      assert.ok(content.includes('second action'), 'second why must be present');
      assert.ok(!content.includes('first action'),  'first why must be gone');

      // Count occurrences of stamp key to confirm no duplication.
      const countKey = (k) => (content.match(new RegExp('\n' + k + ':', 'g')) || []).length;
      for (const k of STAMP_KEYS) {
        assert.strictEqual(countKey(k), 1, `Key ${k} must appear exactly once, not duplicated`);
      }
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. stripRecentlyCurated: removes all 5 keys, other frontmatter untouched
// ---------------------------------------------------------------------------

describe('stripRecentlyCurated', () => {
  test('removes all 5 stamp keys; other frontmatter keys are preserved', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'strip-test');
    try {
      writeStamp(fp, sampleStamp());
      const stripped = stripRecentlyCurated(fp);
      assert.ok(stripped === true, 'stripRecentlyCurated must return true when keys were present');

      const content = readFileContent(fp);
      for (const k of STAMP_KEYS) {
        assert.ok(!content.includes('\n' + k + ':'), `Key ${k} must be absent after strip`);
      }
      // Existing fields must remain.
      assert.ok(content.includes('name: strip-test'), 'name must remain');
      assert.ok(content.includes('confidence:'), 'confidence must remain');
    } finally {
      cleanupDir(dir);
    }
  });

  test('body is preserved after strip', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'body-preserve');
    try {
      const original = readFileContent(fp);
      writeStamp(fp, sampleStamp());
      stripRecentlyCurated(fp);
      const after = readFileContent(fp);
      // Body content must be identical.
      assert.ok(after.includes('Some body content'), 'body must be preserved');
    } finally {
      cleanupDir(dir);
    }
  });

  // 5. Idempotent
  test('second strip call returns false (no-op)', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'idempotent');
    try {
      writeStamp(fp, sampleStamp());
      stripRecentlyCurated(fp);
      const result = stripRecentlyCurated(fp);
      assert.strictEqual(result, false, 'second strip must return false');
    } finally {
      cleanupDir(dir);
    }
  });

  // 6. Strip on pristine file
  test('strip on file without stamp returns false, no mutation', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'pristine-strip');
    try {
      const before = readFileContent(fp);
      const result = stripRecentlyCurated(fp);
      const after  = readFileContent(fp);
      assert.strictEqual(result, false);
      assert.strictEqual(before, after, 'file must be unchanged when no stamp present');
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. normaliseWhy
// ---------------------------------------------------------------------------

describe('normaliseWhy', () => {
  test('truncates at MAX_WHY_LENGTH (120) chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const result = normaliseWhy(long);
    assert.strictEqual(result.length, MAX_WHY_LENGTH + 3); // 120 + "..."
    assert.ok(result.endsWith('...'));
  });

  test('short string is returned as-is', () => {
    const short = 'MinHash Jaccard 0.82, adversarial re-read passed';
    assert.strictEqual(normaliseWhy(short), short);
  });

  test('multi-line why: only first line preserved', () => {
    const multiLine = 'First line here\nSecond line ignored\nThird line also gone';
    assert.strictEqual(normaliseWhy(multiLine), 'First line here');
  });

  test('CRLF newline: only first line preserved', () => {
    const crlf = 'First line\r\nSecond line';
    assert.strictEqual(normaliseWhy(crlf), 'First line');
  });

  test('trailing whitespace stripped', () => {
    assert.strictEqual(normaliseWhy('hello   '), 'hello');
  });

  test('exactly MAX_WHY_LENGTH chars not truncated', () => {
    const exact = 'a'.repeat(MAX_WHY_LENGTH);
    const result = normaliseWhy(exact);
    assert.strictEqual(result, exact);
    assert.ok(!result.endsWith('...'));
  });
});

// ---------------------------------------------------------------------------
// 8. Atomicity: no .tmp file after write
// ---------------------------------------------------------------------------

describe('writeStamp — atomic write', () => {
  test('no .tmp file left after successful write', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'atomic');
    try {
      writeStamp(fp, sampleStamp());
      assert.ok(!fs.existsSync(fp + '.stamp.tmp'), '.stamp.tmp must not remain');
    } finally {
      cleanupDir(dir);
    }
  });

  test('no .strip.tmp file left after strip', () => {
    const dir = makeTmpDir();
    const fp  = writePatternFile(dir, 'atomic-strip');
    try {
      writeStamp(fp, sampleStamp());
      stripRecentlyCurated(fp);
      assert.ok(!fs.existsSync(fp + '.strip.tmp'), '.strip.tmp must not remain');
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Integration: applyRollback strips stamp for promote-undo case
// ---------------------------------------------------------------------------

describe('applyRollback strips H4 stamp (integration via undoById)', () => {
  test('promote-undo: undoById leaves file without stamp', () => {
    // Simulate the promote scenario:
    //   1. Create a pattern file (pre-action state = no stamp).
    //   2. Write a stamp (post-action state).
    //   3. Write a tombstone with content_snapshot = pre-action content (no stamp).
    //   4. Call undoById(actionId) → calls applyRollback internally.
    //   5. Verify: no stamp keys in the restored file.

    const dir     = makeTmpDir();
    const pDir    = path.join(dir, '.orchestray', 'patterns');
    fs.mkdirSync(pDir, { recursive: true });
    const fp      = path.join(pDir, 'promote-test.md');
    const preActionContent = '---\nname: promote-test\ncategory: decomposition\nconfidence: 0.8\n---\n\nBody.\n';
    fs.writeFileSync(fp, preActionContent, 'utf8');

    // Write tombstone with pre-action snapshot.
    const opts  = { projectRoot: dir };
    const runId = startRun(opts);
    const tombstone = {
      action: 'promote',
      inputs: [{
        slug:             'promote-test',
        path:             fp,
        content_sha256:   'abc',
        content_snapshot: preActionContent,
      }],
      output: { path: 'shared/promote-test.md', action_summary: 'promoted' },
    };
    const actionId = writeTombstone(runId, tombstone, opts);

    // Write a stamp (post-action state — simulates curator writing the stamp after promotion).
    writeStamp(fp, sampleStamp({ action: 'promote' }));
    const stamped = readFileContent(fp);
    assert.ok(stamped.includes('recently_curated_at:'), 'stamp must be present before rollback');

    // Undo the action — this calls applyRollback internally.
    const result = undoById(actionId, opts);
    assert.ok(result.found, 'undoById must find the action');

    const restored = readFileContent(fp);
    // Stamp must be gone — either via snapshot restore or explicit strip.
    for (const k of STAMP_KEYS) {
      assert.ok(!restored.includes('\n' + k + ':'), `Key ${k} must be absent after rollback`);
    }
    // Pre-action content must be intact.
    assert.ok(restored.includes('confidence: 0.8'), 'confidence must remain');
    cleanupDir(dir);
  });

  test('merge-undo: undoLast snapshot overwrites stamp naturally', () => {
    // For merge, the lead file gets the merged content + stamp.
    // The snapshot is the pre-merge content (no stamp).
    // undoLast → applyRollback restores the snapshot; stamp is naturally erased.

    const dir  = makeTmpDir();
    const pDir = path.join(dir, '.orchestray', 'patterns');
    fs.mkdirSync(pDir, { recursive: true });
    const fp   = path.join(pDir, 'lead.md');
    const preContent = '---\nname: lead\ncategory: decomposition\nconfidence: 0.7\n---\n\nOriginal lead body.\n';
    fs.writeFileSync(fp, preContent, 'utf8');

    // Write tombstone with pre-merge snapshot.
    const opts  = { projectRoot: dir };
    const runId = startRun(opts);
    const tombstone = {
      action: 'merge',
      inputs: [{
        slug:             'lead',
        path:             fp,
        content_sha256:   'def',
        content_snapshot: preContent,
      }],
      output: { path: fp, action_summary: 'merged' },
    };
    writeTombstone(runId, tombstone, opts);

    // Write stamp (simulating post-merge stamp).
    writeStamp(fp, sampleStamp({ action: 'merge', why: 'merged 2 patterns' }));
    assert.ok(readFileContent(fp).includes('recently_curated_at:'));

    // Undo.
    undoLast(opts);

    const after = readFileContent(fp);
    for (const k of STAMP_KEYS) {
      assert.ok(!after.includes('\n' + k + ':'), `Key ${k} must be absent after rollback`);
    }
    assert.ok(after.includes('Original lead body.'), 'original body must be restored');
    cleanupDir(dir);
  });
});

// ---------------------------------------------------------------------------
// 11. applyStampsForRun
// ---------------------------------------------------------------------------

describe('applyStampsForRun', () => {
  /**
   * Helper: write a pattern file AND a tombstone for an action, returning { fp, actionId }.
   */
  function setupAction(dir, slug, action, runId, rationale) {
    const pDir = path.join(dir, '.orchestray', 'patterns');
    fs.mkdirSync(pDir, { recursive: true });
    const fp = path.join(pDir, slug + '.md');
    const content = `---\nname: ${slug}\ncategory: decomposition\nconfidence: 0.8\n---\n\nBody.\n`;
    fs.writeFileSync(fp, content, 'utf8');

    const tombstone = {
      action,
      inputs: [{ slug, path: fp, content_sha256: 'abc', content_snapshot: content }],
      output: { path: fp, action_summary: `${action} of ${slug}` },
    };
    if (rationale) tombstone.rationale = rationale;

    const opts     = { projectRoot: dir };
    const actionId = writeTombstone(runId, tombstone, opts);
    return { fp, actionId };
  }

  test('happy path: promote + merge + deprecate → 3 stamped, 0 skipped, 0 failed', () => {
    const dir  = makeTmpDir();
    const opts = { projectRoot: dir };
    const runId = startRun(opts);

    const { fp: fp1, actionId: a1 } = setupAction(dir, 'pat-promote',   'promote',   runId);
    const { fp: fp2, actionId: a2 } = setupAction(dir, 'pat-merge',     'merge',     runId);
    const { fp: fp3, actionId: a3 } = setupAction(dir, 'pat-deprecate', 'deprecate', runId);

    const summary = applyStampsForRun(runId, opts);

    assert.strictEqual(summary.stamped.length, 3, 'all 3 actions should be stamped');
    assert.strictEqual(summary.skipped.length, 0);
    assert.strictEqual(summary.failed.length,  0);
    assert.ok(summary.stamped.includes(a1));
    assert.ok(summary.stamped.includes(a2));
    assert.ok(summary.stamped.includes(a3));

    // Verify stamps are written.
    assert.ok(readStamp(fp1) !== null, 'promote file must have stamp');
    assert.ok(readStamp(fp2) !== null, 'merge file must have stamp');
    assert.ok(readStamp(fp3) !== null, 'deprecate file must have stamp');

    cleanupDir(dir);
  });

  test('unshare action → skipped (stamp not written)', () => {
    const dir  = makeTmpDir();
    const opts = { projectRoot: dir };
    const runId = startRun(opts);

    // unshare tombstone — file lives in shared tier, not local patterns
    const actionId = writeTombstone(runId, {
      action:  'unshare',
      inputs:  [{ slug: 'pat-unshare', path: '/shared/pat-unshare.md', content_sha256: 'xyz', content_snapshot: '---\nname: pat-unshare\n---\n' }],
      output:  { path: 'deleted', action_summary: 'unshared' },
    }, opts);

    const summary = applyStampsForRun(runId, opts);

    assert.ok(summary.skipped.includes(actionId), 'unshare must be skipped');
    assert.strictEqual(summary.stamped.length, 0);
    assert.strictEqual(summary.failed.length,  0);

    cleanupDir(dir);
  });

  test('rolled-back tombstone → skipped', () => {
    const dir  = makeTmpDir();
    const opts = { projectRoot: dir };
    const runId = startRun(opts);

    const { fp, actionId } = setupAction(dir, 'pat-rolled', 'promote', runId);

    // Roll it back so rolled_back_at is set.
    const { undoById: undoByIdFn } = require('../bin/_lib/curator-tombstone.js');
    undoByIdFn(actionId, opts);

    const summary = applyStampsForRun(runId, opts);

    assert.ok(summary.skipped.includes(actionId), 'rolled-back tombstone must be skipped');
    assert.strictEqual(summary.stamped.length, 0);

    cleanupDir(dir);
  });

  test('non-existent pattern file → failed count includes it; other stamps still apply', () => {
    const dir  = makeTmpDir();
    const opts = { projectRoot: dir };
    const runId = startRun(opts);

    // Write a tombstone pointing to a non-existent file (no actual pattern file).
    const missingActionId = writeTombstone(runId, {
      action:  'deprecate',
      inputs:  [{ slug: 'missing-pat', path: path.join(dir, '.orchestray', 'patterns', 'missing-pat.md'), content_sha256: 'abc', content_snapshot: '---\nname: missing-pat\n---\n' }],
      output:  { path: path.join(dir, '.orchestray', 'patterns', 'missing-pat.md'), action_summary: 'deprecate missing' },
    }, opts);

    // Write a real pattern that SHOULD succeed.
    const { fp: fpGood, actionId: goodActionId } = setupAction(dir, 'pat-good', 'promote', runId);

    const summary = applyStampsForRun(runId, opts);

    assert.ok(summary.failed.some(f => f.action_id === missingActionId), 'missing file must be in failed');
    assert.ok(summary.stamped.includes(goodActionId), 'good pattern must still be stamped');
    assert.ok(readStamp(fpGood) !== null, 'good pattern stamp must be on disk');

    cleanupDir(dir);
  });

  test('round-trip: applyStampsForRun → readStamp has correct action_id', () => {
    const dir  = makeTmpDir();
    const opts = { projectRoot: dir };
    const runId = startRun(opts);

    const rationale = { schema_version: 1, one_line: 'Merged duplicate patterns', signals: {}, guardrails_checked: [], considered_alternatives: [] };
    const { fp, actionId } = setupAction(dir, 'pat-rt', 'merge', runId, rationale);

    applyStampsForRun(runId, opts);

    const stamp = readStamp(fp);
    assert.ok(stamp !== null, 'stamp must be present');
    assert.strictEqual(stamp.action_id, actionId, 'action_id must match tombstone action_id');
    assert.strictEqual(stamp.run_id,    runId,    'run_id must match');
    assert.strictEqual(stamp.action,    'merge',  'action must match');
    assert.strictEqual(stamp.why,       rationale.one_line, 'why must come from rationale.one_line');

    cleanupDir(dir);
  });
});

// ---------------------------------------------------------------------------
// 10. signals.similarity_* round-trip in tombstone
// ---------------------------------------------------------------------------

describe('tombstone signals.similarity_* round-trip', () => {
  test('writeTombstone with H3 signals round-trips via listTombstones', () => {
    const dir  = makeTmpDir();
    const opts = { projectRoot: dir };

    const runId = startRun(opts);

    const tombstone = {
      action: 'merge',
      inputs: [
        {
          slug:             'decomposition-ci-cd',
          path:             path.join(dir, '.orchestray', 'patterns', 'decomposition-ci-cd.md'),
          content_sha256:   'abc123',
          content_snapshot: '---\nname: decomposition-ci-cd\n---\nbody',
        },
        {
          slug:             'decomposition-pipeline',
          path:             path.join(dir, '.orchestray', 'patterns', 'decomposition-pipeline.md'),
          content_sha256:   'def456',
          content_snapshot: '---\nname: decomposition-pipeline\n---\nbody',
        },
      ],
      output: {
        path:           path.join(dir, '.orchestray', 'patterns', 'decomposition-ci-cd.md'),
        action_summary: 'Merged decomposition-ci-cd + decomposition-pipeline; MinHash Jaccard 0.82',
      },
      rationale: {
        schema_version: 1,
        one_line:       'Merged decomposition-ci-cd + decomposition-pipeline; MinHash Jaccard 0.82',
        signals: {
          confidence:          0.77,
          decayed_confidence:  0.71,
          times_applied:       7,
          age_days:            31,
          category:            'decomposition',
          skip_penalty:        0.0,
          similarity_score:    0.82,
          similarity_method:   'minhash',
          similarity_threshold: 0.6,
          similarity_k:        5,
          similarity_m:        128,
        },
        guardrails_checked:      ['G3-same-category', 'G19-merged-from', 'G9b-adversarial-re-read'],
        considered_alternatives: [],
        adversarial_re_read:     { passed: true, missing: [], contradicted: [] },
        notes: 'Shortlist pair from v2.1.3 H3 pre-filter.',
      },
    };

    const actionId = writeTombstone(runId, tombstone, opts);
    assert.ok(typeof actionId === 'string', 'actionId must be a string');

    const { rows } = listTombstones(opts);
    const row = rows.find(r => r.action_id === actionId);
    assert.ok(row, 'tombstone row must be found');
    assert.ok(row.rationale, 'rationale must be present');
    assert.ok(row.rationale.signals, 'signals must be present');

    // Verify H3-specific fields round-trip as numbers.
    assert.strictEqual(row.rationale.signals.similarity_score,    0.82);
    assert.strictEqual(row.rationale.signals.similarity_method,   'minhash');
    assert.strictEqual(row.rationale.signals.similarity_threshold, 0.6);
    assert.strictEqual(row.rationale.signals.similarity_k,        5);
    assert.strictEqual(row.rationale.signals.similarity_m,        128);

    cleanupDir(dir);
  });
});

// ---------------------------------------------------------------------------
// 11. writeStamp error cases
// ---------------------------------------------------------------------------

describe('writeStamp — error cases', () => {
  test('returns ok: false for non-existent file', () => {
    const result = writeStamp('/nonexistent/dir/pattern.md', sampleStamp());
    assert.strictEqual(result.ok, false);
  });

  test('returns ok: false for file without frontmatter', () => {
    const dir = makeTmpDir();
    const fp  = path.join(dir, 'no-fm.md');
    fs.writeFileSync(fp, 'Just a body with no frontmatter\n', 'utf8');
    try {
      const result = writeStamp(fp, sampleStamp());
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'no_frontmatter');
    } finally {
      cleanupDir(dir);
    }
  });
});
