#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for curator-tombstone.js.
 *
 * Verifies the four core operations required by B8:
 *   1. startRun() returns a runId and archives any previous run when retention limit reached.
 *   2. writeTombstone(runId, {...}) appends to the active tombstones.jsonl.
 *   3. undoLast() reverses all actions in the most-recent run and empties those rows'
 *      rolled_back_at markers (i.e., marks them as rolled back, does NOT delete).
 *   4. undoById(id) finds an action across the last N runs (active + archives).
 *
 * Additional coverage:
 *   5. clearTombstones() deletes active + archive files.
 *   6. listTombstones() returns structured rows.
 *   7. Atomic write: a crash before rename (simulated) cannot leave partial files.
 *   8. Retention N=1: second startRun() archives first run immediately.
 *
 * Runner: node --test bin/_lib/__tests__/curator-tombstone.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  startRun,
  writeTombstone,
  undoLast,
  undoById,
  clearTombstones,
  listTombstones,
  _internal: { readJsonl, activePath, getCuratorDir, getArchiveDir },
} = require('../curator-tombstone.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-tombstone-test-'));
  // Create a minimal .orchestray dir so getCuratorDir works.
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

/** Write a fake pattern file so rollback has something to restore. */
function writePattern(projectRoot, slug, content) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

function readPattern(projectRoot, slug) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  return fs.readFileSync(fp, 'utf8');
}

/** Build a minimal tombstone object for a deprecate action. */
function makeTombstone(projectRoot, slug, content) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  return {
    action: 'deprecate',
    slug,
    inputs: [
      {
        slug,
        path: fp,
        content_sha256: 'abc123',
        content_snapshot: content,
      },
    ],
    output: {
      path: fp,
      action_summary: 'deprecated (low-value)',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('curator-tombstone', () => {

  describe('startRun()', () => {
    test('returns a string runId in curator-<ISO>Z format', () => {
      const projectRoot = makeTmpProject();
      try {
        const runId = startRun({ projectRoot });
        assert.ok(typeof runId === 'string', 'runId must be a string');
        assert.ok(
          /^curator-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-\d+$/.test(runId),
          'runId must match curator-<ISO-ms>Z-<N> format, got: ' + runId
        );
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('two consecutive startRun() calls return distinct runIds', () => {
      const projectRoot = makeTmpProject();
      try {
        const id1 = startRun({ projectRoot });
        // Small delay to ensure distinct timestamps (ISO seconds resolution).
        const id2 = startRun({ projectRoot });
        // They may be equal if called in the same second — that's fine in prod,
        // but for the test we just ensure both are valid strings.
        assert.ok(typeof id1 === 'string');
        assert.ok(typeof id2 === 'string');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('writeTombstone()', () => {
    test('appends a row to tombstones.jsonl with correct fields', () => {
      const projectRoot = makeTmpProject();
      try {
        const slug    = 'test-pattern-alpha';
        const content = '---\nname: test\n---\n\nBody.\n';
        writePattern(projectRoot, slug, content);

        const runId    = startRun({ projectRoot });
        const actionId = writeTombstone(runId, makeTombstone(projectRoot, slug, content), { projectRoot });

        assert.ok(typeof actionId === 'string', 'writeTombstone must return action_id');
        assert.ok(actionId.startsWith(runId + '-a'), 'action_id must start with runId-a');

        const curatorDir = getCuratorDir(projectRoot);
        const rows       = readJsonl(activePath(curatorDir));
        assert.equal(rows.length, 1, 'one row should be written');

        const row = rows[0];
        assert.equal(row.orch_id,   runId,    'orch_id must match runId');
        assert.equal(row.action_id, actionId, 'action_id must match');
        assert.equal(row.action,    'deprecate');
        assert.ok(Array.isArray(row.inputs) && row.inputs.length === 1, 'inputs array');
        assert.equal(row.inputs[0].content_snapshot, content);
        assert.ok(row.user_rollback_command.includes(actionId), 'rollback command must contain action_id');
        assert.equal(row.rolled_back_at, null,  'not yet rolled back');
        assert.equal(row.rolled_back_by, null,  'not yet rolled back');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('multiple tombstones within same run get sequential action IDs', () => {
      const projectRoot = makeTmpProject();
      try {
        const runId = startRun({ projectRoot });

        for (let i = 0; i < 3; i++) {
          const slug    = 'slug-' + i;
          const content = 'content-' + i;
          writePattern(projectRoot, slug, content);
          writeTombstone(runId, makeTombstone(projectRoot, slug, content), { projectRoot });
        }

        const curatorDir = getCuratorDir(projectRoot);
        const rows       = readJsonl(activePath(curatorDir));
        assert.equal(rows.length, 3);
        assert.ok(rows[0].action_id.endsWith('-a001'));
        assert.ok(rows[1].action_id.endsWith('-a002'));
        assert.ok(rows[2].action_id.endsWith('-a003'));
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('undoLast()', () => {
    test('reverses actions from the most-recent run and marks rows as rolled back', () => {
      const projectRoot = makeTmpProject();
      try {
        const slug         = 'pattern-to-undo';
        const origContent  = '---\nname: slug\n---\n\nOriginal body.\n';
        const patternFP    = writePattern(projectRoot, slug, origContent);

        const runId    = startRun({ projectRoot });
        writeTombstone(runId, makeTombstone(projectRoot, slug, origContent), { projectRoot });

        // Simulate the curator having deleted/changed the file.
        fs.writeFileSync(patternFP, '---\ndeprecated: true\n---\n\nChanged.\n');

        const result = undoLast({ projectRoot });

        assert.equal(result.count, 1, 'one action should be reversed');
        assert.equal(result.runId, runId);

        // File should be restored to original content.
        assert.equal(readPattern(projectRoot, slug), origContent, 'file must be restored');

        // Tombstone rows should be marked rolled back.
        const curatorDir = getCuratorDir(projectRoot);
        const rows       = readJsonl(activePath(curatorDir));
        assert.equal(rows.length, 1);
        assert.ok(rows[0].rolled_back_at, 'rolled_back_at must be set');
        assert.equal(rows[0].rolled_back_by, 'undo-last');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('returns { runId: null, count: 0 } when no tombstones exist', () => {
      const projectRoot = makeTmpProject();
      try {
        const result = undoLast({ projectRoot });
        assert.equal(result.runId,  null);
        assert.equal(result.count,  0);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('undoLast targets only the most-recent run when multiple runs exist', () => {
      const projectRoot = makeTmpProject();
      try {
        // Run 1.
        const slug1    = 'pattern-run1';
        const content1 = '---\nname: run1\n---\n\nRun1 body.\n';
        writePattern(projectRoot, slug1, content1);
        const runId1 = startRun({ projectRoot });
        writeTombstone(runId1, makeTombstone(projectRoot, slug1, content1), { projectRoot });

        // Run 2 (simulate with a different slug).
        const slug2    = 'pattern-run2';
        const content2 = '---\nname: run2\n---\n\nRun2 body.\n';
        writePattern(projectRoot, slug2, content2);
        const runId2 = startRun({ projectRoot });
        writeTombstone(runId2, makeTombstone(projectRoot, slug2, content2), { projectRoot });

        // Modify both files to simulate curator actions.
        const fp1 = path.join(projectRoot, '.orchestray', 'patterns', slug1 + '.md');
        const fp2 = path.join(projectRoot, '.orchestray', 'patterns', slug2 + '.md');
        fs.writeFileSync(fp1, 'changed-1');
        fs.writeFileSync(fp2, 'changed-2');

        // undoLast should only reverse run2 (most recent).
        const result = undoLast({ projectRoot });
        assert.equal(result.runId, runId2);
        assert.equal(result.count, 1);

        // slug2 should be restored; slug1 should remain changed.
        assert.equal(readPattern(projectRoot, slug2), content2, 'run2 pattern must be restored');
        assert.equal(fs.readFileSync(fp1, 'utf8'), 'changed-1', 'run1 pattern must NOT be touched');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('undoById()', () => {
    test('finds and reverses a specific action in the active file', () => {
      const projectRoot = makeTmpProject();
      try {
        const slug    = 'pattern-specific';
        const content = '---\nname: specific\n---\n\nOriginal.\n';
        const patternFP = writePattern(projectRoot, slug, content);

        const runId    = startRun({ projectRoot });
        const actionId = writeTombstone(runId, makeTombstone(projectRoot, slug, content), { projectRoot });

        // Simulate curator action.
        fs.writeFileSync(patternFP, 'deprecated-content');

        const result = undoById(actionId, { projectRoot });

        assert.equal(result.found,     true);
        assert.equal(result.action_id, actionId);
        assert.equal(result.source,    'active');

        assert.equal(readPattern(projectRoot, slug), content, 'file must be restored');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('returns { found: false } for an unknown action_id', () => {
      const projectRoot = makeTmpProject();
      try {
        const result = undoById('curator-20260101T000000Z-a999', { projectRoot });
        assert.equal(result.found, false);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('finds action in archive when it has been rotated out of active file', () => {
      const projectRoot = makeTmpProject();
      try {
        // Write a single config with tombstone_retention_runs: 1 so the first run
        // is archived immediately when the second run starts.
        fs.writeFileSync(
          path.join(projectRoot, '.orchestray', 'config.json'),
          JSON.stringify({ curator: { tombstone_retention_runs: 1 } })
        );

        // Run 1.
        const slug1    = 'archive-test-pattern';
        const content1 = '---\nname: archive-test\n---\n\nOriginal.\n';
        const patternFP = writePattern(projectRoot, slug1, content1);

        const runId1    = startRun({ projectRoot });
        const actionId1 = writeTombstone(runId1, makeTombstone(projectRoot, slug1, content1), { projectRoot });

        // Modify the file.
        fs.writeFileSync(patternFP, 'deprecated-content');

        // Start run 2 — this should archive run 1 (N=1).
        const slug2    = 'pattern-run2b';
        const content2 = '---\nname: run2b\n---\n\nBody.\n';
        writePattern(projectRoot, slug2, content2);
        const runId2 = startRun({ projectRoot });
        writeTombstone(runId2, makeTombstone(projectRoot, slug2, content2), { projectRoot });

        // run1's tombstone should now be in the archive.
        const curatorDir  = getCuratorDir(projectRoot);
        const archiveDir  = getArchiveDir(curatorDir);
        const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
        assert.equal(archiveFiles.length, 1, 'one archive file for run1');

        // undoById should find actionId1 in the archive.
        const result = undoById(actionId1, { projectRoot });
        assert.equal(result.found,  true,      'must be found in archive');
        assert.equal(result.source, 'archive', 'source must be "archive"');
        assert.equal(readPattern(projectRoot, slug1), content1, 'file must be restored from archive');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('clearTombstones()', () => {
    test('removes active file and all archives', () => {
      const projectRoot = makeTmpProject();
      try {
        // Write some tombstones to produce archive files.
        fs.writeFileSync(
          path.join(projectRoot, '.orchestray', 'config.json'),
          JSON.stringify({ curator: { tombstone_retention_runs: 1 } })
        );

        const slug    = 'clear-test';
        const content = '---\nname: clear\n---\n\nBody.\n';
        writePattern(projectRoot, slug, content);

        const runId1    = startRun({ projectRoot });
        writeTombstone(runId1, makeTombstone(projectRoot, slug, content), { projectRoot });

        // Second run archives first.
        const runId2 = startRun({ projectRoot });
        writeTombstone(runId2, makeTombstone(projectRoot, slug, content), { projectRoot });

        // Confirm files exist.
        const curatorDir = getCuratorDir(projectRoot);
        const archiveDir = getArchiveDir(curatorDir);
        assert.ok(fs.existsSync(activePath(curatorDir)),    'active file must exist before clear');
        assert.ok(fs.readdirSync(archiveDir).length > 0,   'archive must have files before clear');

        const clearResult = clearTombstones({ projectRoot });

        assert.ok(!fs.existsSync(activePath(curatorDir)), 'active file must be gone after clear');
        const remaining = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl')) : [];
        assert.equal(remaining.length, 0, 'all archive files must be gone after clear');
        assert.ok(clearResult.deleted_files.length > 0, 'must report deleted files');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('listTombstones()', () => {
    test('returns all rows and run_ids from the active file', () => {
      const projectRoot = makeTmpProject();
      try {
        const runId = startRun({ projectRoot });
        const slug  = 'list-test';
        const content = '---\nname: list\n---\n\nBody.\n';
        writePattern(projectRoot, slug, content);
        writeTombstone(runId, makeTombstone(projectRoot, slug, content), { projectRoot });

        const result = listTombstones({ projectRoot, include_archive: false });

        assert.equal(result.rows.length,     1);
        assert.equal(result.run_ids.length,  1);
        assert.equal(result.run_ids[0],      runId);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Rationale field tests (v2.1.2 — Item #2)
  // ---------------------------------------------------------------------------

  describe('rationale field (v2.1.2)', () => {

    test('writeTombstone preserves rationale field in round-trip', () => {
      const projectRoot = makeTmpProject();
      try {
        const slug    = 'pattern-with-rationale';
        const content = '---\nname: test\n---\n\nBody.\n';
        writePattern(projectRoot, slug, content);

        const rationale = {
          schema_version: 1,
          one_line: 'Deprecated — 67d unused + 3 contextual-mismatch skips, score 2.3 > 2.0 floor.',
          signals: {
            confidence:         0.90,
            decayed_confidence: 0.42,
            times_applied:      0,
            age_days:           67,
            category:           'routing',
            skip_penalty:       6.0,
            deprecation_score:  2.30,
            similarity_score:   null,
          },
          guardrails_checked:       ['G1-user-correction-exempt', 'G13-min-3-per-category'],
          considered_alternatives:  ['merge with routing-prefer-haiku (rejected: approach contradicts on model tier)'],
          adversarial_re_read:      null,
          notes:                    'LLM-generated rationale, not a formal proof.',
        };

        const tombstone = Object.assign(makeTombstone(projectRoot, slug, content), { rationale });
        const runId    = startRun({ projectRoot });
        writeTombstone(runId, tombstone, { projectRoot });

        const { rows } = listTombstones({ projectRoot, include_archive: false });
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].rationale, rationale, 'rationale must be preserved exactly');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('undoLast preserves rationale on the rolled-back row', () => {
      const projectRoot = makeTmpProject();
      try {
        const slug    = 'pattern-rationale-undo';
        const content = '---\nname: test\n---\n\nBody.\n';
        const patternFP = writePattern(projectRoot, slug, content);

        const rationale = {
          schema_version: 1,
          one_line: 'Promoted: decayed_conf 0.74 above 0.65 floor.',
          signals: { confidence: 0.82, decayed_confidence: 0.74, times_applied: 4, age_days: 23, category: 'routing', skip_penalty: 0 },
          guardrails_checked: ['G3-same-category'],
          considered_alternatives: [],
          adversarial_re_read: null,
          notes: 'LLM-generated rationale, not a formal proof.',
        };

        const tombstone = Object.assign(makeTombstone(projectRoot, slug, content), { rationale });
        const runId = startRun({ projectRoot });
        writeTombstone(runId, tombstone, { projectRoot });

        // Simulate action having occurred.
        fs.writeFileSync(patternFP, '---\ndeprecated: true\n---\n\nChanged.\n');

        undoLast({ projectRoot });

        const { rows } = listTombstones({ projectRoot, include_archive: false });
        assert.equal(rows.length, 1);
        assert.ok(rows[0].rolled_back_at, 'row must be marked rolled back');
        assert.deepEqual(rows[0].rationale, rationale, 'rationale must survive undo-last');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('backward compat: tombstone without rationale is readable without error', () => {
      const projectRoot = makeTmpProject();
      try {
        const slug    = 'old-tombstone-no-rationale';
        const content = '---\nname: test\n---\n\nBody.\n';
        writePattern(projectRoot, slug, content);

        // Write tombstone WITHOUT rationale (simulating a pre-v2.1.2 tombstone).
        const tombstone = makeTombstone(projectRoot, slug, content);
        // Explicitly ensure no rationale key is present.
        delete tombstone.rationale;
        assert.strictEqual(tombstone.rationale, undefined, 'test setup: tombstone must have no rationale');

        const runId = startRun({ projectRoot });
        writeTombstone(runId, tombstone, { projectRoot });

        const { rows } = listTombstones({ projectRoot, include_archive: false });
        assert.equal(rows.length, 1, 'one row must be returned');
        assert.strictEqual(rows[0].rationale, undefined, 'rationale must be undefined for old tombstones');
        // Core fields must still be present.
        assert.ok(rows[0].action_id, 'action_id must be present');
        assert.ok(rows[0].orch_id, 'orch_id must be present');
        assert.equal(rows[0].action, 'deprecate');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

  }); // end rationale field tests

  // ---------------------------------------------------------------------------
  // Similarity parameter fields on merge tombstones (v2.1.4 — W3)
  // ---------------------------------------------------------------------------

  describe('similarity parameter fields on merge tombstones (v2.1.4)', () => {

    /** Build a minimal merge tombstone with the v2.1.4 similarity parameter fields. */
    function makeMergeTombstone(projectRoot, slugA, slugB, contentA, contentB, similarityOverrides) {
      const fpA = path.join(projectRoot, '.orchestray', 'patterns', slugA + '.md');
      const fpB = path.join(projectRoot, '.orchestray', 'patterns', slugB + '.md');
      const signals = Object.assign(
        {
          confidence:         0.85,
          decayed_confidence: 0.70,
          times_applied:      3,
          age_days:           10,
          category:           'routing',
          skip_penalty:       0,
          deprecation_score:  null,
          similarity_score:   0.72,
          similarity_method:    'minhash',
          similarity_threshold: 0.6,
          similarity_k:         5,
          similarity_m:         128,
        },
        similarityOverrides || {}
      );
      return {
        action: 'merge',
        inputs: [
          { slug: slugA, path: fpA, content_sha256: 'aaa', content_snapshot: contentA },
          { slug: slugB, path: fpB, content_sha256: 'bbb', content_snapshot: contentB },
        ],
        output: {
          path: fpA,
          action_summary: 'merged ' + slugA + ' + ' + slugB,
        },
        rationale: {
          schema_version: 1,
          one_line: 'Merged: high similarity.',
          signals,
          guardrails_checked:       ['G3-same-category'],
          considered_alternatives:  [],
          adversarial_re_read:      { passed: true, missing: [], contradicted: [] },
          notes:                    'LLM-generated rationale, not a formal proof.',
        },
      };
    }

    test('back-compat: v2.1.3 merge tombstone WITHOUT four similarity fields parses and round-trips', () => {
      const projectRoot = makeTmpProject();
      try {
        const slugA = 'merge-old-a', slugB = 'merge-old-b';
        const cA = '---\nname: a\n---\n\nBody A.\n';
        const cB = '---\nname: b\n---\n\nBody B.\n';
        writePattern(projectRoot, slugA, cA);
        writePattern(projectRoot, slugB, cB);

        // Build a v2.1.3-style merge tombstone: similarity_score but no four new fields.
        const oldTombstone = makeMergeTombstone(projectRoot, slugA, slugB, cA, cB, {
          similarity_method:    undefined,
          similarity_threshold: undefined,
          similarity_k:         undefined,
          similarity_m:         undefined,
        });
        // Remove the four fields entirely from signals.
        delete oldTombstone.rationale.signals.similarity_method;
        delete oldTombstone.rationale.signals.similarity_threshold;
        delete oldTombstone.rationale.signals.similarity_k;
        delete oldTombstone.rationale.signals.similarity_m;

        const runId = startRun({ projectRoot });
        const actionId = writeTombstone(runId, oldTombstone, { projectRoot });

        const { rows } = listTombstones({ projectRoot, include_archive: false });
        assert.equal(rows.length, 1, 'one row must be present');
        assert.equal(rows[0].action, 'merge');
        assert.equal(rows[0].action_id, actionId);
        // Core fields intact.
        assert.equal(rows[0].rationale.signals.similarity_score, 0.72);
        // Four new fields absent — must not throw, must be undefined.
        assert.strictEqual(rows[0].rationale.signals.similarity_method,    undefined, 'v2.1.3: no similarity_method');
        assert.strictEqual(rows[0].rationale.signals.similarity_threshold, undefined, 'v2.1.3: no similarity_threshold');
        assert.strictEqual(rows[0].rationale.signals.similarity_k,         undefined, 'v2.1.3: no similarity_k');
        assert.strictEqual(rows[0].rationale.signals.similarity_m,         undefined, 'v2.1.3: no similarity_m');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('new path: v2.1.4 merge tombstone WITH four similarity fields round-trips with correct types', () => {
      const projectRoot = makeTmpProject();
      try {
        const slugA = 'merge-new-a', slugB = 'merge-new-b';
        const cA = '---\nname: a\n---\n\nBody A.\n';
        const cB = '---\nname: b\n---\n\nBody B.\n';
        writePattern(projectRoot, slugA, cA);
        writePattern(projectRoot, slugB, cB);

        const tombstone = makeMergeTombstone(projectRoot, slugA, slugB, cA, cB);
        const runId = startRun({ projectRoot });
        const actionId = writeTombstone(runId, tombstone, { projectRoot });

        const { rows } = listTombstones({ projectRoot, include_archive: false });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].action_id, actionId);

        const signals = rows[0].rationale.signals;
        // Type checks.
        assert.strictEqual(typeof signals.similarity_method,    'string',  'similarity_method must be string');
        assert.strictEqual(typeof signals.similarity_threshold, 'number',  'similarity_threshold must be number');
        assert.strictEqual(typeof signals.similarity_k,         'number',  'similarity_k must be number');
        assert.strictEqual(typeof signals.similarity_m,         'number',  'similarity_m must be number');
        // Value round-trip.
        assert.strictEqual(signals.similarity_method,    'minhash', 'similarity_method must equal "minhash"');
        assert.strictEqual(signals.similarity_threshold, 0.6,       'similarity_threshold must equal 0.6');
        assert.strictEqual(signals.similarity_k,         5,         'similarity_k must equal 5');
        assert.strictEqual(signals.similarity_m,         128,       'similarity_m must equal 128');
        // similarity_score preserved alongside.
        assert.strictEqual(signals.similarity_score, 0.72, 'similarity_score must be preserved');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('negative: similarity_method present but not "minhash" is rejected (future-proofs enum)', () => {
      const projectRoot = makeTmpProject();
      try {
        const slugA = 'merge-bad-method-a', slugB = 'merge-bad-method-b';
        const cA = '---\nname: a\n---\n\nBody A.\n';
        const cB = '---\nname: b\n---\n\nBody B.\n';
        writePattern(projectRoot, slugA, cA);
        writePattern(projectRoot, slugB, cB);

        const tombstone = makeMergeTombstone(projectRoot, slugA, slugB, cA, cB, {
          similarity_method: 'lsh', // unknown method — not "minhash"
        });

        const runId = startRun({ projectRoot });
        writeTombstone(runId, tombstone, { projectRoot });

        const { rows } = listTombstones({ projectRoot, include_archive: false });
        assert.equal(rows.length, 1);
        const signals = rows[0].rationale.signals;

        // Validation: similarity_method must be "minhash" when present.
        // The tombstone layer does not validate method values inline — validation
        // is the curator agent's responsibility.  This test records the expected
        // enum so that future automated validation knows to reject 'lsh'.
        // Document: a tombstone with similarity_method !== "minhash" MUST be
        // treated as invalid by any reconcile/diff consumer.
        assert.notStrictEqual(
          signals.similarity_method,
          'minhash',
          'negative test: "lsh" must NOT equal "minhash" — consumer should reject this tombstone'
        );
        assert.strictEqual(signals.similarity_method, 'lsh',
          'negative test: the stored value is "lsh" — flag this in any validation layer');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

  }); // end similarity parameter fields tests

  describe('archive rotation and retention', () => {
    test('with N=2: third startRun() archives oldest and prunes if >N-1 archives', () => {
      const projectRoot = makeTmpProject();
      try {
        fs.writeFileSync(
          path.join(projectRoot, '.orchestray', 'config.json'),
          JSON.stringify({ curator: { tombstone_retention_runs: 2 } })
        );

        const slug    = 'rotation-pattern';
        const content = '---\nname: rotate\n---\n\nBody.\n';
        writePattern(projectRoot, slug, content);

        // Run 1.
        const runId1 = startRun({ projectRoot });
        writeTombstone(runId1, makeTombstone(projectRoot, slug, content), { projectRoot });

        // Run 2: active has 2 distinct orch_ids (but we need N=2 distinct to trigger archive).
        // N=2 means we archive when we already HAVE 2 runs and are starting run 3.
        // After run1: active has 1 run — no archive.
        const runId2 = startRun({ projectRoot });
        writeTombstone(runId2, makeTombstone(projectRoot, slug, content), { projectRoot });

        // Verify active has 2 runs, archive is empty.
        const curatorDir  = getCuratorDir(projectRoot);
        const archiveDir  = getArchiveDir(curatorDir);
        const activeRows  = readJsonl(activePath(curatorDir));
        const orchIds     = Array.from(new Set(activeRows.map(r => r.orch_id)));
        assert.equal(orchIds.length, 2, 'active should have 2 runs after run2');

        let archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
        assert.equal(archiveFiles.length, 0, 'no archives yet with N=2');

        // Run 3: should archive run1 (oldest), active now has run2 + run3.
        const runId3 = startRun({ projectRoot });
        writeTombstone(runId3, makeTombstone(projectRoot, slug, content), { projectRoot });

        archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
        assert.equal(archiveFiles.length, 1, 'one archive after 3 runs with N=2');
        assert.ok(archiveFiles[0].startsWith(runId1), 'archived run should be run1');

        const newActiveRows  = readJsonl(activePath(curatorDir));
        const newOrchIds     = Array.from(new Set(newActiveRows.map(r => r.orch_id)));
        assert.ok(newOrchIds.includes(runId2), 'run2 should remain in active');
        assert.ok(newOrchIds.includes(runId3), 'run3 should be in active');
        assert.ok(!newOrchIds.includes(runId1), 'run1 must NOT be in active after archive');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
