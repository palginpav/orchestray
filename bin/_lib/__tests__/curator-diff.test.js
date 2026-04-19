#!/usr/bin/env node
'use strict';

/**
 * Tests for curator-diff.js (H6 — curate --diff incremental mode, v2.1.4).
 *
 * Runner: node --test bin/_lib/__tests__/curator-diff.test.js
 *
 * Tests:
 *   1.  isDirty: stamp-absent → dirty (stamp_absent)
 *   2.  isDirty: stamp present + body unchanged + within cutoff → clean
 *   3.  isDirty: stamp present + body changed → dirty (body_hash_drift)
 *   4.  isDirty: stamp present + body unchanged + stamp older than cutoff → dirty (stale_stamp)
 *   5.  isDirty: corrupt stamp (missing body_sha256) → dirty (stamp_absent) + journal entry
 *   6.  isDirty: stamp with action "evaluated" counts as stamped (same treatment as "promote")
 *   7.  computeBodyHash: same body → same hash across invocations
 *   8.  computeBodyHash: frontmatter-only change does NOT change the body hash
 *   9.  computeDirtySet: first run (no stamps) → all patterns dirty
 *  10.  computeDirtySet: dirty = 0 (all clean)
 *  11.  computeDirtySet: empty patterns dir → { dirty: [], corpus_size: 0 }
 *  12.  computeDirtySet: renamed pattern (mv foo.md bar.md) with unchanged body → clean
 *  13.  computeDirtySet: forced full on 10th run (run_counter % 10 === 0)
 *  14.  computeDirtySet: rollback-touched pattern → dirty (rollback_touched)
 *  15.  incrementRunCounter: absent file → starts at 1, increments on each call
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const {
  computeDirtySet,
  incrementRunCounter,
  computeBodyHash,
  _internal: { isDirty, isPatternMergeLineage, FORCED_FULL_SWEEP_EVERY },
} = require('../curator-diff.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-diff-test-'));
}

function mkProject(tmpDir) {
  const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
  const curatorDir  = path.join(tmpDir, '.orchestray', 'curator');
  const stateDir    = path.join(tmpDir, '.orchestray', 'state');
  fs.mkdirSync(patternsDir, { recursive: true });
  fs.mkdirSync(curatorDir,  { recursive: true });
  fs.mkdirSync(stateDir,    { recursive: true });
  return { patternsDir, curatorDir, stateDir };
}

/**
 * Write a minimal valid pattern file (with frontmatter) to patternsDir.
 * Returns the absolute path.
 *
 * If stampOpts.body_sha256 is the special sentinel 'AUTO', computeBodyHash is
 * called AFTER writing the body-only version (no stamp) to get the actual hash,
 * then the file is rewritten with the computed hash in the stamp.
 */
function writePattern(patternsDir, slug, body, stampOpts) {
  const absPath  = path.join(patternsDir, slug + '.md');
  const bodyText = body || '# Pattern body\n\nSome content here.\n';

  // Write body-only first so we can compute the actual hash if requested.
  let noStampContent = `---\nname: ${slug}\ncategory: routing\nconfidence: 0.7\ntimes_applied: 0\nlast_applied: null\n---\n${bodyText}`;
  fs.writeFileSync(absPath, noStampContent, 'utf8');

  if (!stampOpts) return absPath;

  // Resolve AUTO hash.
  let bodyHash = stampOpts.body_sha256;
  if (bodyHash === 'AUTO') {
    bodyHash = computeBodyHash(absPath);
  }

  let content = `---\nname: ${slug}\ncategory: routing\nconfidence: 0.7\ntimes_applied: 0\nlast_applied: null\n`;
  content += `recently_curated_at: ${stampOpts.at}\n`;
  content += `recently_curated_action: ${stampOpts.action || 'promote'}\n`;
  content += `recently_curated_action_id: ${stampOpts.action_id || 'test-action-id'}\n`;
  content += `recently_curated_run_id: ${stampOpts.run_id || 'test-run-id'}\n`;
  content += `recently_curated_why: test why\n`;
  if (bodyHash !== undefined) {
    content += `recently_curated_body_sha256: ${bodyHash}\n`;
  }
  content += `---\n${bodyText}`;
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

// ---------------------------------------------------------------------------
// Reusable cleanup
// ---------------------------------------------------------------------------

let tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  tmpDirs = [];
});

function newTmp() {
  const d = mkTmpDir();
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Tests: isDirty
// ---------------------------------------------------------------------------

describe('isDirty', () => {
  test('1. stamp absent → dirty (stamp_absent)', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const absPath = writePattern(patternsDir, 'test-pattern', 'body content\n');

    const result = isDirty({
      absPath,
      cutoffDays: 30,
      now:        new Date(),
      rolledBackIds: new Set(),
    });
    assert.equal(result.dirty, true);
    assert.equal(result.reason, 'stamp_absent');
  });

  test('2. stamp + unchanged body + within cutoff → clean', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const body    = 'body content\n';
    const recent  = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    const absPath = writePattern(patternsDir, 'test-pattern', body, {
      at:          recent,
      action:      'promote',
      body_sha256: 'AUTO',
    });

    const result = isDirty({
      absPath,
      cutoffDays: 30,
      now:        new Date(),
      rolledBackIds: new Set(),
    });
    assert.equal(result.dirty, false);
    assert.equal(result.reason, 'clean');
  });

  test('3. stamp + body changed → dirty (body_hash_drift)', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const recent  = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    // First write with original body to compute its hash.
    const absPath = writePattern(patternsDir, 'test-pattern', 'original body content\n', {
      at:          recent,
      action:      'promote',
      body_sha256: 'AUTO',  // Hash of original body stored in stamp.
    });
    // Now change the body only (keeping the stamp with old hash) to simulate drift.
    const fm      = require('../../mcp-server/lib/frontmatter.js');
    const current = fs.readFileSync(absPath, 'utf8');
    const parsed  = fm.parse(current);
    // Stamp keeps the original hash; body is replaced with different content.
    const newContent = fm.stringify({ frontmatter: parsed.frontmatter, body: '\nmodified body content\n' });
    fs.writeFileSync(absPath, newContent, 'utf8');

    const result = isDirty({
      absPath,
      cutoffDays: 30,
      now:        new Date(),
      rolledBackIds: new Set(),
    });
    assert.equal(result.dirty, true);
    assert.equal(result.reason, 'body_hash_drift');
  });

  test('4. stamp + unchanged body + stamp older than cutoff → dirty (stale_stamp)', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const body    = 'body content\n';
    const staleAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45 days ago
    const absPath = writePattern(patternsDir, 'test-pattern', body, {
      at:          staleAt,
      action:      'promote',
      body_sha256: 'AUTO',
    });

    const result = isDirty({
      absPath,
      cutoffDays: 30,  // cutoff is 30 days; stamp is 45 days old → stale
      now:        new Date(),
      rolledBackIds: new Set(),
    });
    assert.equal(result.dirty, true);
    assert.equal(result.reason, 'stale_stamp');
  });

  test('5. corrupt stamp (missing body_sha256) → dirty (stamp_absent)', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const recent  = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    // Write stamp without body_sha256 (pre-H6 style).
    const absPath = path.join(patternsDir, 'test-pattern.md');
    fs.writeFileSync(absPath, [
      '---',
      'name: test-pattern',
      'category: routing',
      `recently_curated_at: ${recent}`,
      'recently_curated_action: promote',
      'recently_curated_action_id: test-id',
      'recently_curated_run_id: test-run',
      'recently_curated_why: test',
      // NOTE: no recently_curated_body_sha256
      '---',
      '# Body',
      '',
      'Some content.',
      '',
    ].join('\n'), 'utf8');

    const result = isDirty({
      absPath,
      cutoffDays: 30,
      now:        new Date(),
      rolledBackIds: new Set(),
    });
    // Missing body_sha256 → treated as corrupt → stamp_absent
    assert.equal(result.dirty, true);
    assert.equal(result.reason, 'stamp_absent');
  });

  test('6. stamp with action "evaluated" counts as stamped (same as "promote")', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const body    = 'pattern body here\n';
    const recent  = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const absPath = writePattern(patternsDir, 'test-pattern', body, {
      at:          recent,
      action:      'evaluated',  // No tombstone action — just evaluated
      action_id:   'run-id-as-action-id',
      body_sha256: 'AUTO',
    });

    const result = isDirty({
      absPath,
      cutoffDays: 30,
      now:        new Date(),
      rolledBackIds: new Set(),
    });
    // "evaluated" stamp with fresh hash and recent timestamp → clean
    assert.equal(result.dirty, false);
    assert.equal(result.reason, 'clean');
  });
});

// ---------------------------------------------------------------------------
// Tests: computeBodyHash
// ---------------------------------------------------------------------------

describe('computeBodyHash', () => {
  test('7. same body → same hash across invocations', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const absPath = writePattern(patternsDir, 'hash-test', 'stable body content\n');

    const hash1 = computeBodyHash(absPath);
    const hash2 = computeBodyHash(absPath);
    assert.ok(hash1, 'hash should be non-null');
    assert.equal(hash1, hash2);
  });

  test('8. frontmatter-only change does NOT change body hash', () => {
    const tmp  = newTmp();
    const { patternsDir } = mkProject(tmp);
    const body    = '# Pattern\n\nThe body content.\n';
    const absPath = writePattern(patternsDir, 'fm-change-test', body);

    const hash1 = computeBodyHash(absPath);
    assert.ok(hash1, 'hash1 should be non-null');

    // Now add a stamp (frontmatter change only — body unchanged).
    const recent   = new Date().toISOString();
    const absPath2 = writePattern(patternsDir, 'fm-change-test', body, {
      at:          recent,
      action:      'promote',
      body_sha256: 'AUTO',  // AUTO uses hash of current body — consistent
    });
    // Both writePattern calls target the same absPath.
    assert.equal(absPath, absPath2);

    const hash2 = computeBodyHash(absPath);
    assert.equal(hash1, hash2, 'body hash must not change when only frontmatter changes');
  });
});

// ---------------------------------------------------------------------------
// Tests: computeDirtySet
// ---------------------------------------------------------------------------

describe('computeDirtySet', () => {
  test('9. first run (no stamps) → all patterns dirty', () => {
    const tmp  = newTmp();
    const { patternsDir, curatorDir, stateDir } = mkProject(tmp);
    const counterPath = path.join(stateDir, 'curator-diff-run-counter.json');

    writePattern(patternsDir, 'pat-a', 'body a\n');
    writePattern(patternsDir, 'pat-b', 'body b\n');
    writePattern(patternsDir, 'pat-c', 'body c\n');

    const result = computeDirtySet({
      patternsDir,
      cutoffDays:          30,
      runCounterPath:      counterPath,
      activeTombstonesPath: path.join(curatorDir, 'tombstones.jsonl'),
    });

    assert.equal(result.corpus_size, 3);
    assert.equal(result.dirty.length, 3);
    assert.equal(result.clean.length, 0);
    assert.equal(result.breakdown.stamp_absent, 3);
  });

  test('10. dirty = 0 (all clean)', () => {
    const tmp  = newTmp();
    const { patternsDir, curatorDir, stateDir } = mkProject(tmp);
    const counterPath = path.join(stateDir, 'curator-diff-run-counter.json');
    // Pre-set counter to a non-forced-full value (e.g. 3).
    fs.writeFileSync(counterPath, JSON.stringify({ run_count: 3 }), 'utf8');

    const body   = 'the body\n';
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days
    writePattern(patternsDir, 'pat-a', body, { at: recent, action: 'promote', body_sha256: 'AUTO' });
    writePattern(patternsDir, 'pat-b', body, { at: recent, action: 'evaluated', action_id: 'run-1', body_sha256: 'AUTO' });

    const result = computeDirtySet({
      patternsDir,
      cutoffDays:          30,
      runCounterPath:      counterPath,
      activeTombstonesPath: path.join(curatorDir, 'tombstones.jsonl'),
    });

    assert.equal(result.corpus_size, 2);
    assert.equal(result.dirty.length, 0);
    assert.equal(result.clean.length, 2);
  });

  test('11. empty patterns dir → corpus_size: 0', () => {
    const tmp  = newTmp();
    const { patternsDir, curatorDir, stateDir } = mkProject(tmp);
    const counterPath = path.join(stateDir, 'curator-diff-run-counter.json');

    const result = computeDirtySet({
      patternsDir,
      cutoffDays:          30,
      runCounterPath:      counterPath,
      activeTombstonesPath: path.join(curatorDir, 'tombstones.jsonl'),
    });

    assert.equal(result.corpus_size, 0);
    assert.equal(result.dirty.length, 0);
    assert.equal(result.clean.length, 0);
  });

  test('12. renamed pattern (mv foo.md bar.md) with unchanged body → clean', () => {
    const tmp  = newTmp();
    const { patternsDir, curatorDir, stateDir } = mkProject(tmp);
    const counterPath = path.join(stateDir, 'curator-diff-run-counter.json');
    // Pre-set counter to avoid forced-full.
    fs.writeFileSync(counterPath, JSON.stringify({ run_count: 3 }), 'utf8');

    const body   = 'body of renamed pattern\n';
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    // Write the pattern with a NEW name (simulating post-rename state).
    // The body and stamp are preserved via frontmatter travel with the rename.
    writePattern(patternsDir, 'bar', body, { at: recent, action: 'promote', body_sha256: 'AUTO' });

    const result = computeDirtySet({
      patternsDir,
      cutoffDays:          30,
      runCounterPath:      counterPath,
      activeTombstonesPath: path.join(curatorDir, 'tombstones.jsonl'),
    });

    // bar.md: stamp is fresh, body matches → clean
    assert.equal(result.clean.length, 1);
    assert.equal(result.dirty.length, 0);
  });

  test('13. forced full on 10th run (run_counter % 10 === 0)', () => {
    const tmp  = newTmp();
    const { patternsDir, curatorDir, stateDir } = mkProject(tmp);
    const counterPath = path.join(stateDir, 'curator-diff-run-counter.json');
    // Pre-set counter to 9 so the next increment (to 10) triggers forced full.
    fs.writeFileSync(counterPath, JSON.stringify({ run_count: 9 }), 'utf8');

    const body   = 'body\n';
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    writePattern(patternsDir, 'pat-a', body, { at: recent, action: 'promote', body_sha256: 'AUTO' });
    writePattern(patternsDir, 'pat-b', body, { at: recent, action: 'promote', body_sha256: 'AUTO' });

    const result = computeDirtySet({
      patternsDir,
      cutoffDays:          30,
      runCounterPath:      counterPath,
      activeTombstonesPath: path.join(curatorDir, 'tombstones.jsonl'),
    });

    assert.equal(result.forced_full, true, 'should be forced full on 10th run');
    assert.equal(result.dirty.length, result.corpus_size, 'forced full → all dirty');
    // Counter should now be 10.
    const counterAfter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counterAfter.run_count, 10);
  });

  test('14. rollback-touched pattern → dirty (rollback_touched)', () => {
    const tmp  = newTmp();
    const { patternsDir, curatorDir, stateDir } = mkProject(tmp);
    const counterPath = path.join(stateDir, 'curator-diff-run-counter.json');
    fs.writeFileSync(counterPath, JSON.stringify({ run_count: 3 }), 'utf8');

    const body        = 'body content\n';
    const recent      = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const actionId    = 'curator-test-a001';

    writePattern(patternsDir, 'pat-a', body, {
      at:          recent,
      action:      'promote',
      action_id:   actionId,
      body_sha256: 'AUTO',
    });

    // Write a tombstones.jsonl with a rolled-back row referencing actionId.
    const tombstonesPath = path.join(curatorDir, 'tombstones.jsonl');
    const row = JSON.stringify({
      action_id:      actionId,
      action:         'promote',
      rolled_back_at: new Date().toISOString(),
      rolled_back_by: 'undo-last',
      inputs:         [{ slug: 'pat-a' }],
    });
    fs.writeFileSync(tombstonesPath, row + '\n', 'utf8');

    const result = computeDirtySet({
      patternsDir,
      cutoffDays:          30,
      runCounterPath:      counterPath,
      activeTombstonesPath: tombstonesPath,
    });

    assert.equal(result.dirty.length, 1);
    assert.equal(result.breakdown.rollback_touched, 1);
  });
});

// ---------------------------------------------------------------------------
// Tests: incrementRunCounter
// ---------------------------------------------------------------------------

describe('incrementRunCounter', () => {
  test('15. absent file → starts at 1, increments on each call', () => {
    const tmp         = newTmp();
    const counterPath = path.join(tmp, 'counter.json');

    const c1 = incrementRunCounter(counterPath);
    assert.equal(c1, 1);

    const c2 = incrementRunCounter(counterPath);
    assert.equal(c2, 2);

    const c3 = incrementRunCounter(counterPath);
    assert.equal(c3, 3);

    // Verify file contents.
    const data = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(data.run_count, 3);
  });
});
