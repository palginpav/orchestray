#!/usr/bin/env node
'use strict';

/**
 * Tests for curator-reconcile.js (W1 — atomicity fix, Option B).
 *
 * These tests simulate the phantom-success scenario: a tombstone is written
 * claiming a promote/unshare/merge/deprecate succeeded, but the corresponding
 * file operation never happened (truncated agent turn).  reconcile() must
 * detect the mismatch and either auto-repair (promote, unshare) or flag
 * (merge, deprecate).
 *
 * Runner: node --test bin/_lib/__tests__/curator-reconcile.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { reconcile, _internal: { _verifyOne, _isDeprecated } } = require('../curator-reconcile.js');
const { startRun, writeTombstone } = require('../curator-tombstone.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-reconcile-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

function makeTmpShared() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shared-test-'));
  fs.mkdirSync(path.join(dir, 'patterns'), { recursive: true });
  return dir;
}

function writeLocalPattern(projectRoot, slug, content) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

function writeSharedPattern(sharedRoot, slug, content) {
  const fp = path.join(sharedRoot, 'patterns', slug + '.md');
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

/** Build a promote tombstone object (action happened from local → shared). */
function makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot) {
  const srcPath  = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
  return {
    action: 'promote',
    inputs: [{ slug, path: srcPath, content_sha256: 'abc123', content_snapshot: snapshot }],
    output: { path: destPath, action_summary: 'promoted to shared tier' },
  };
}

/** Build a deprecate tombstone object. */
function makeDeprecateTombstone(projectRoot, slug, snapshot) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  return {
    action: 'deprecate',
    inputs: [{ slug, path: fp, content_sha256: 'abc123', content_snapshot: snapshot }],
    output: { path: fp, action_summary: 'deprecated (low-value)' },
  };
}

/** Build a merge tombstone object. */
function makeMergeTombstone(projectRoot, outputSlug, inputSlugs, snapshot) {
  const inputs = inputSlugs.map(s => ({
    slug: s,
    path: path.join(projectRoot, '.orchestray', 'patterns', s + '.md'),
    content_sha256: 'abc123',
    content_snapshot: snapshot,
  }));
  const outputPath = path.join(projectRoot, '.orchestray', 'patterns', outputSlug + '.md');
  return {
    action: 'merge',
    inputs,
    output: { path: outputPath, action_summary: 'merged ' + inputSlugs.join(' + ') },
  };
}

/** Build an unshare tombstone object. */
function makeUnshareTombstone(sharedRoot, slug, snapshot) {
  const fp = path.join(sharedRoot, 'patterns', slug + '.md');
  return {
    action: 'unshare',
    inputs: [{ slug, path: fp, content_sha256: 'abc123', content_snapshot: snapshot }],
    output: { path: 'deleted', action_summary: 'user unshared ' + slug },
  };
}

// ---------------------------------------------------------------------------
// _isDeprecated unit tests
// ---------------------------------------------------------------------------

describe('_isDeprecated()', () => {
  test('returns true when frontmatter contains "deprecated: true"', () => {
    const content = '---\nname: foo\ndeprecated: true\n---\n\nBody.\n';
    assert.strictEqual(_isDeprecated(content), true);
  });

  test('returns false when deprecated key is missing', () => {
    const content = '---\nname: foo\nconfidence: 0.8\n---\n\nBody.\n';
    assert.strictEqual(_isDeprecated(content), false);
  });

  test('returns false when deprecated: false', () => {
    const content = '---\nname: foo\ndeprecated: false\n---\n\nBody.\n';
    assert.strictEqual(_isDeprecated(content), false);
  });

  test('returns false when there is no frontmatter', () => {
    const content = 'No frontmatter here.\n';
    assert.strictEqual(_isDeprecated(content), false);
  });
});

// ---------------------------------------------------------------------------
// Promote reconciliation — the primary truncation bug site
// ---------------------------------------------------------------------------

describe('reconcile() — promote', () => {
  test('CORE: phantom-success detected and auto-repaired when shared-tier file absent', () => {
    // This test simulates the exact incident:
    //   1. Curator writes tombstone (claims promote succeeded)
    //   2. Agent turn truncates — file copy never happens
    //   3. reconcile() detects the missing shared-tier file
    //   4. reconcile() copies content_snapshot to the dest path (auto-repair)

    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'anti-pattern-phantom-promote';
      const snapshot = '---\nname: ' + slug + '\ncategory: anti-pattern\nconfidence: 0.8\ndescription: test\n---\n\n# Pattern\n\n## Context\nTest.\n';

      writeLocalPattern(projectRoot, slug, snapshot);

      // Step 1: curator writes tombstone (claiming the promote will happen).
      const runId = startRun({ projectRoot });
      writeTombstone(runId, makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot), { projectRoot });

      // Step 2: agent truncates — NO file copy happens.
      // (Intentionally omitted: fs.copyFileSync would go here.)

      // The shared-tier file does NOT exist.
      const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
      assert.strictEqual(fs.existsSync(destPath), false, 'shared-tier file must be absent before reconcile');

      // Step 3: reconcile() detects the phantom-success and repairs it.
      const report = reconcile({ projectRoot, runId, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.repaired.length, 1, 'exactly one repair expected');
      assert.strictEqual(report.flagged.length,  0, 'no flags expected');
      assert.ok(report.repaired[0].detail.includes('promote mismatch'), 'detail must mention promote mismatch');

      // The shared-tier file must now exist with the correct content.
      assert.strictEqual(fs.existsSync(destPath), true, 'shared-tier file must exist after reconcile');
      assert.strictEqual(fs.readFileSync(destPath, 'utf8'), snapshot, 'shared-tier file content must match snapshot');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });

  test('returns ok when shared-tier file already exists (no-op)', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'routing-promote-existing';
      const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.7\ndescription: test\n---\n\nBody.\n';

      writeLocalPattern(projectRoot, slug, snapshot);
      // Shared-tier file already exists (promote succeeded before truncation).
      writeSharedPattern(sharedRoot, slug, snapshot);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot), { projectRoot });

      const report = reconcile({ projectRoot, runId, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.repaired.length, 0);
      assert.strictEqual(report.flagged.length,  0);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });

  test('skips promote tombstone when sharedDir is null (federation not configured)', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'decomposition-no-shared';
      const snapshot = '---\nname: ' + slug + '\ncategory: decomposition\nconfidence: 0.6\ndescription: test\n---\n\nBody.\n';

      writeLocalPattern(projectRoot, slug, snapshot);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot), { projectRoot });

      // Pass sharedDir: null to simulate federation not configured.
      const report = reconcile({ projectRoot, runId, sharedDir: null });

      assert.strictEqual(report.repaired.length, 0);
      assert.strictEqual(report.flagged.length,  0);
      assert.strictEqual(report.skipped, 1);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });

  test('skips rows that have already been rolled back', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'specialization-rolled-back';
      const snapshot = '---\nname: ' + slug + '\ncategory: specialization\nconfidence: 0.75\ndescription: test\n---\n\nBody.\n';

      writeLocalPattern(projectRoot, slug, snapshot);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot), { projectRoot });

      // Manually mark the tombstone as rolled back by reading+editing the file.
      const curatorDir = path.join(projectRoot, '.orchestray', 'curator');
      const activeFP   = path.join(curatorDir, 'tombstones.jsonl');
      const rows = fs.readFileSync(activeFP, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      rows[0].rolled_back_at = new Date().toISOString();
      rows[0].rolled_back_by = 'undo-last';
      const tmp = activeFP + '.tmp';
      fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, activeFP);

      const report = reconcile({ projectRoot, runId, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.skipped, 1);
      assert.strictEqual(report.repaired.length, 0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Deprecate reconciliation
// ---------------------------------------------------------------------------

describe('reconcile() — deprecate', () => {
  test('flags mismatch when file exists without deprecated: true', () => {
    const projectRoot = makeTmpProject();

    try {
      const slug    = 'routing-unflagged-deprecate';
      const content = '---\nname: ' + slug + '\nconfidence: 0.3\n---\n\nBody.\n';
      writeLocalPattern(projectRoot, slug, content);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeDeprecateTombstone(projectRoot, slug, content), { projectRoot });

      // Truncation: the MCP deprecate tool call never happened, so the file
      // still lacks `deprecated: true`.

      const report = reconcile({ projectRoot, runId, sharedDir: null });

      assert.strictEqual(report.flagged.length, 1, 'one flag expected');
      assert.ok(report.flagged[0].detail.includes('deprecate mismatch'), 'detail must mention deprecate mismatch');
      assert.strictEqual(report.ok, false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('ok when file has deprecated: true', () => {
    const projectRoot = makeTmpProject();

    try {
      const slug    = 'routing-already-deprecated';
      const content = '---\nname: ' + slug + '\nconfidence: 0.3\ndeprecated: true\n---\n\nBody.\n';
      writeLocalPattern(projectRoot, slug, content);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeDeprecateTombstone(projectRoot, slug, content), { projectRoot });

      const report = reconcile({ projectRoot, runId, sharedDir: null });

      assert.strictEqual(report.flagged.length, 0);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('ok when deprecated file is absent (already cleaned up)', () => {
    const projectRoot = makeTmpProject();

    try {
      const slug    = 'routing-deleted-after-deprecate';
      const content = '---\nname: ' + slug + '\nconfidence: 0.2\n---\n\nBody.\n';

      // Write then delete — simulates a cleanup pass after deprecation.
      writeLocalPattern(projectRoot, slug, content);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeDeprecateTombstone(projectRoot, slug, content), { projectRoot });

      // Simulate file having been removed after deprecation.
      fs.unlinkSync(path.join(projectRoot, '.orchestray', 'patterns', slug + '.md'));

      const report = reconcile({ projectRoot, runId, sharedDir: null });

      assert.strictEqual(report.flagged.length, 0);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Merge reconciliation
// ---------------------------------------------------------------------------

describe('reconcile() — merge', () => {
  test('flags mismatch when merged output file is absent', () => {
    const projectRoot = makeTmpProject();

    try {
      const inputSlugs = ['decomp-input-a', 'decomp-input-b'];
      // Use a distinct output slug so the output file is NOT one of the input files.
      const outputSlug = 'decomp-merged-output';
      const snapshot   = '---\nname: test\nconfidence: 0.7\n---\n\nBody.\n';

      inputSlugs.forEach(s => writeLocalPattern(projectRoot, s, snapshot));
      // NOTE: intentionally do NOT write outputSlug — it should be absent (truncation).

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeMergeTombstone(projectRoot, outputSlug, inputSlugs, snapshot), { projectRoot });

      // Truncation: the merged output file was never written.

      const report = reconcile({ projectRoot, runId, sharedDir: null });

      assert.strictEqual(report.flagged.length, 1, 'one flag expected for absent merge output');
      assert.ok(report.flagged[0].detail.includes('merge mismatch'), 'detail must mention merge mismatch');
      assert.strictEqual(report.ok, false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('ok when merged output file exists', () => {
    const projectRoot = makeTmpProject();

    try {
      const inputSlugs = ['decomp-input-c', 'decomp-input-d'];
      const outputSlug = 'decomp-merged-result';
      const snapshot   = '---\nname: test\nconfidence: 0.7\n---\n\nBody.\n';

      inputSlugs.forEach(s => writeLocalPattern(projectRoot, s, snapshot));
      // Merged output already written (successful merge, distinct from inputs).
      writeLocalPattern(projectRoot, outputSlug, snapshot);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeMergeTombstone(projectRoot, outputSlug, inputSlugs, snapshot), { projectRoot });

      const report = reconcile({ projectRoot, runId, sharedDir: null });

      assert.strictEqual(report.flagged.length, 0);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unshare reconciliation
// ---------------------------------------------------------------------------

describe('reconcile() — unshare', () => {
  test('auto-repairs when shared-tier file is still present after unshare tombstone', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'routing-still-shared';
      const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.6\ndescription: test\n---\n\nBody.\n';

      // Shared file still present (unshare action was recorded but not applied).
      writeSharedPattern(sharedRoot, slug, snapshot);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeUnshareTombstone(sharedRoot, slug, snapshot), { projectRoot });

      const report = reconcile({ projectRoot, runId, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.repaired.length, 1, 'one repair expected');
      assert.ok(report.repaired[0].detail.includes('unshare mismatch'), 'detail must mention unshare mismatch');

      const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
      assert.strictEqual(fs.existsSync(destPath), false, 'shared-tier file must be absent after repair');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });

  test('ok when shared-tier file is already absent', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'routing-already-gone';
      const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.6\ndescription: test\n---\n\nBody.\n';

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makeUnshareTombstone(sharedRoot, slug, snapshot), { projectRoot });

      // File was never present (or already cleaned up).
      const report = reconcile({ projectRoot, runId, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.repaired.length, 0);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Rationale field — backward compat (v2.1.2)
// ---------------------------------------------------------------------------

describe('reconcile() — rationale as opaque field', () => {
  test('rationale-bearing tombstone reconciles identically to one without rationale', () => {
    // A promote tombstone with rationale should behave identically to one without.
    // When shared-tier file is absent → repaired. When present → ok.
    // Rationale must not alter reconcile behavior.

    const projectRoot  = makeTmpProject();
    const sharedRoot   = makeTmpShared();

    try {
      const slug     = 'routing-rationale-reconcile';
      const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.8\ndescription: test\n---\n\nBody.\n';

      writeLocalPattern(projectRoot, slug, snapshot);

      const rationale = {
        schema_version: 1,
        one_line: 'Promoted: decayed_conf 0.74 above 0.65 floor.',
        signals: { confidence: 0.82, decayed_confidence: 0.74, times_applied: 4, age_days: 23, category: 'routing', skip_penalty: 0 },
        guardrails_checked: [],
        considered_alternatives: [],
        adversarial_re_read: null,
        notes: 'LLM-generated rationale, not a formal proof.',
      };

      // Tombstone WITH rationale — shared file absent (phantom-success).
      const tombstoneWithRationale = Object.assign(
        makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot),
        { rationale }
      );
      const runIdWith = startRun({ projectRoot });
      writeTombstone(runIdWith, tombstoneWithRationale, { projectRoot });

      const reportWith = reconcile({ projectRoot, runId: runIdWith, sharedDir: path.join(sharedRoot, 'patterns') });
      assert.strictEqual(reportWith.repaired.length, 1, 'rationale-bearing tombstone must be repaired');
      assert.strictEqual(reportWith.flagged.length,  0);
      assert.ok(reportWith.repaired[0].detail.includes('promote mismatch'));

      // Now verify that shared file is present (repaired above).
      const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
      assert.strictEqual(fs.existsSync(destPath), true, 'file must be repaired regardless of rationale');

      // Clean up the repaired file before next check.
      fs.unlinkSync(destPath);

      // Tombstone WITHOUT rationale — same slug, same behavior expected.
      const tombstoneWithout = makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot);
      const runIdWithout = startRun({ projectRoot });
      writeTombstone(runIdWithout, tombstoneWithout, { projectRoot });

      const reportWithout = reconcile({ projectRoot, runId: runIdWithout, sharedDir: path.join(sharedRoot, 'patterns') });
      assert.strictEqual(reportWithout.repaired.length, 1, 'tombstone without rationale must also be repaired');
      assert.strictEqual(reportWithout.flagged.length,  0);

      // Both reports have the same structure — rationale is opaque to reconcile.
      assert.strictEqual(reportWith.repaired.length, reportWithout.repaired.length, 'behavior must be identical');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });

  test('old tombstone (no rationale) reconciles identically to new tombstone — ok path', () => {
    // When shared file IS present, both should return ok regardless of rationale.
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'routing-rationale-ok';
      const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.7\ndescription: test\n---\n\nBody.\n';

      writeLocalPattern(projectRoot, slug, snapshot);
      writeSharedPattern(sharedRoot, slug, snapshot);  // already present

      const rationale = { schema_version: 1, one_line: 'Promoted.', signals: {}, guardrails_checked: [], considered_alternatives: [], adversarial_re_read: null, notes: '' };

      // With rationale
      const tombWith  = Object.assign(makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot), { rationale });
      const runWith   = startRun({ projectRoot });
      writeTombstone(runWith, tombWith, { projectRoot });
      const repWith   = reconcile({ projectRoot, runId: runWith, sharedDir: path.join(sharedRoot, 'patterns') });

      // Without rationale (separate run)
      const tombWithout = makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot);
      const runWithout  = startRun({ projectRoot });
      writeTombstone(runWithout, tombWithout, { projectRoot });
      const repWithout  = reconcile({ projectRoot, runId: runWithout, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(repWith.ok, true);
      assert.strictEqual(repWithout.ok, true);
      assert.strictEqual(repWith.repaired.length, 0);
      assert.strictEqual(repWithout.repaired.length, 0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('reconcile() — edge cases', () => {
  test('returns empty result when no tombstones exist', () => {
    const projectRoot = makeTmpProject();

    try {
      const report = reconcile({ projectRoot, sharedDir: null });

      assert.strictEqual(report.checked, 0);
      assert.strictEqual(report.repaired.length, 0);
      assert.strictEqual(report.flagged.length, 0);
      assert.strictEqual(report.ok, true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('reconciles most-recent run when runId is not specified', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      const slug     = 'decomp-most-recent';
      const snapshot = '---\nname: ' + slug + '\ncategory: decomposition\nconfidence: 0.8\ndescription: test\n---\n\nBody.\n';
      writeLocalPattern(projectRoot, slug, snapshot);

      // Run 1 — a clean deprecate (file has deprecated: true).
      const slug1    = 'routing-clean';
      const content1 = '---\nname: ' + slug1 + '\nconfidence: 0.3\ndeprecated: true\n---\n\nBody.\n';
      writeLocalPattern(projectRoot, slug1, content1);
      const runId1 = startRun({ projectRoot });
      writeTombstone(runId1, makeDeprecateTombstone(projectRoot, slug1, content1), { projectRoot });

      // Run 2 — a phantom promote.
      const runId2 = startRun({ projectRoot });
      writeTombstone(runId2, makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot), { projectRoot });

      // No runId specified — should target run 2 (most-recent).
      const report = reconcile({ projectRoot, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.runId, runId2, 'should target most-recent run');
      assert.strictEqual(report.repaired.length, 1, 'phantom promote in run2 should be repaired');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });

  test('mixed run: one promote repaired + one deprecate flagged', () => {
    const projectRoot = makeTmpProject();
    const sharedRoot  = makeTmpShared();

    try {
      // Pattern A: promote tombstone, but shared-tier file missing (truncation).
      const slugA    = 'anti-pattern-truncated-promote';
      const snapshotA = '---\nname: ' + slugA + '\ncategory: anti-pattern\nconfidence: 0.8\ndescription: test\n---\n\nBody A.\n';
      writeLocalPattern(projectRoot, slugA, snapshotA);

      // Pattern B: deprecate tombstone, but file lacks deprecated: true (truncation).
      const slugB    = 'routing-truncated-deprecate';
      const contentB = '---\nname: ' + slugB + '\nconfidence: 0.2\n---\n\nBody B.\n';
      writeLocalPattern(projectRoot, slugB, contentB);

      const runId = startRun({ projectRoot });
      writeTombstone(runId, makePromoteTombstone(projectRoot, sharedRoot, slugA, snapshotA), { projectRoot });
      writeTombstone(runId, makeDeprecateTombstone(projectRoot, slugB, contentB), { projectRoot });

      const report = reconcile({ projectRoot, runId, sharedDir: path.join(sharedRoot, 'patterns') });

      assert.strictEqual(report.repaired.length, 1, 'promote must be auto-repaired');
      assert.strictEqual(report.flagged.length,  1, 'deprecate must be flagged');
      assert.strictEqual(report.checked, 2);
      assert.strictEqual(report.ok, false, 'ok must be false when flagged items exist');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sharedRoot,  { recursive: true, force: true });
    }
  });
});
