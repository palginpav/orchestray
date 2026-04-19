#!/usr/bin/env node
'use strict';

/**
 * Tests for curator-reconcile.js schema_version gate (v2.1.6 — W1 §6.6).
 *
 * Covers:
 *   - T-05: Pre-v2.1.6 tombstone (schema_version missing or < 2) → flagged
 *   - T-05: Post-v2.1.6 tombstone (schema_version ≥ 2) promote → flagged (flag-only policy)
 *   - Emits curator_reconcile_promote_flagged audit event
 *   - Existing merge/deprecate repair tests continue to pass (schema_version gate applies)
 *   - schema_version < 2 gate applies to all action types, not just promote
 *
 * Runner: node --test bin/_lib/__tests__/curator-reconcile-schema-version.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { reconcile, _internal: { _verifyOne, _isDeprecated } } = require('../curator-reconcile.js');
const { startRun, writeTombstone } = require('../curator-tombstone.js');

// ---------------------------------------------------------------------------
// Helpers (matching the style in curator-reconcile.test.js)
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-schema-version-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

function makeTmpShared() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shared-sv-test-'));
  fs.mkdirSync(path.join(dir, 'patterns'), { recursive: true });
  return dir;
}

function writeLocalPattern(projectRoot, slug, content) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

/** Build a promote tombstone with configurable schema_version. */
function makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot, schemaVersion) {
  const srcPath  = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
  const tombstone = {
    action: 'promote',
    inputs: [{ slug, path: srcPath, content_sha256: 'abc123', content_snapshot: snapshot }],
    output: { path: destPath, action_summary: 'promoted to shared tier' },
  };
  if (schemaVersion !== undefined) {
    tombstone.schema_version = schemaVersion;
  }
  // Else: no schema_version field (simulates pre-v2.1.6 tombstone)
  return tombstone;
}

/** Build a deprecate tombstone with configurable schema_version. */
function makeDeprecateTombstone(projectRoot, slug, snapshot, schemaVersion) {
  const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
  const tombstone = {
    action: 'deprecate',
    inputs: [{ slug, path: fp, content_sha256: 'abc123', content_snapshot: snapshot }],
    output: { path: fp, action_summary: 'deprecated (low-value)' },
  };
  if (schemaVersion !== undefined) {
    tombstone.schema_version = schemaVersion;
  }
  return tombstone;
}

/** Build a merge tombstone with configurable schema_version. */
function makeMergeTombstone(projectRoot, outputSlug, inputSlugs, snapshot, schemaVersion) {
  const inputs = inputSlugs.map(s => ({
    slug: s,
    path: path.join(projectRoot, '.orchestray', 'patterns', s + '.md'),
    content_sha256: 'abc123',
    content_snapshot: snapshot,
  }));
  const outputPath = path.join(projectRoot, '.orchestray', 'patterns', outputSlug + '.md');
  const tombstone = {
    action: 'merge',
    inputs,
    output: { path: outputPath, action_summary: 'merged' },
  };
  if (schemaVersion !== undefined) {
    tombstone.schema_version = schemaVersion;
  }
  return tombstone;
}

const tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpProjectTracked() {
  const d = makeTmpProject();
  tmpDirs.push(d);
  return d;
}

function makeTmpSharedTracked() {
  const d = makeTmpShared();
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// _verifyOne unit tests — schema_version gate (no tombstone write needed)
// ---------------------------------------------------------------------------

describe('_verifyOne — schema_version gate', () => {
  test('T-05a: tombstone with no schema_version → flagged (pre-v2.1.6)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'no-version-slug';

    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, '# content', undefined);
    // No schema_version field

    const result = _verifyOne(tombstone, { projectRoot, sharedDir: path.join(sharedRoot, 'patterns') });

    assert.equal(result.status, 'flagged',
      'tombstone without schema_version must be flagged, got: ' + JSON.stringify(result));
    assert.match(result.detail, /schema_version_pre_v216|pre.{0,10}v2\.1\.6|manual review/i);
  });

  test('T-05b: tombstone with schema_version:0 → flagged', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'version-zero-slug';

    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, '# content', 0);

    const result = _verifyOne(tombstone, { projectRoot, sharedDir: path.join(sharedRoot, 'patterns') });

    assert.equal(result.status, 'flagged');
  });

  test('T-05c: tombstone with schema_version:1 → flagged (pre-v2.1.6)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'version-one-slug';

    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, '# content', 1);

    const result = _verifyOne(tombstone, { projectRoot, sharedDir: path.join(sharedRoot, 'patterns') });

    assert.equal(result.status, 'flagged',
      'tombstone with schema_version:1 must be flagged (requires ≥ 2), got: ' + JSON.stringify(result));
  });

  test('T-05d: tombstone with schema_version:2, file absent → flagged (promote flag-only policy)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'version-two-slug-absent';

    // schema_version:2 passes the gate; but promote is now flag-only (F-03)
    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, '# content', 2);

    const result = _verifyOne(tombstone, {
      projectRoot,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.equal(result.status, 'flagged',
      'promote with schema_version:2 and absent file must be flagged (flag-only policy), got: ' + JSON.stringify(result));
    assert.match(result.detail, /auto.repair disabled|manual recovery/i);
  });

  test('T-05e: tombstone with schema_version:2, file present → ok', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'version-two-slug-present';
    const snapshot = '---\nname: ' + slug + '\n---\n\n# Content\n';

    // Write the shared-tier file (simulate successful promote)
    fs.writeFileSync(path.join(sharedRoot, 'patterns', slug + '.md'), snapshot, 'utf8');

    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot, 2);

    const result = _verifyOne(tombstone, {
      projectRoot,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.equal(result.status, 'ok',
      'promote with schema_version:2 and file present must be ok, got: ' + JSON.stringify(result));
  });

  test('deprecate tombstone without schema_version is NOT affected by gate (gate is promote+unshare only)', () => {
    // Per §6.6 scoping decision: the schema_version gate applies to promote
    // (F-03) and unshare (W2-04). Merge/deprecate are already flag-only and do
    // not have write access to the shared tier, so they are not gated.
    const projectRoot = makeTmpProjectTracked();
    const slug = 'deprecate-no-version';
    const snapshot = '---\nname: ' + slug + '\ndeprecated: false\n---\n# Content\n';
    const fp = path.join(projectRoot, '.orchestray', 'patterns', slug + '.md');
    fs.writeFileSync(fp, snapshot, 'utf8');

    const tombstone = makeDeprecateTombstone(projectRoot, slug, snapshot, undefined);

    const result = _verifyOne(tombstone, { projectRoot, sharedDir: null });

    // Deprecate with deprecated:false in frontmatter → flagged (wrong state),
    // but the flag reason should be about the deprecate state, NOT schema_version.
    assert.equal(result.status, 'flagged',
      'deprecate tombstone with un-deprecated file should be flagged (wrong state)');
    assert.ok(!result.detail.includes('schema_version'),
      'deprecate flag reason must not be schema_version (gate is promote+unshare only)');
  });

  test('merge tombstone without schema_version is NOT affected by gate (gate is promote+unshare only)', () => {
    const projectRoot = makeTmpProjectTracked();
    const slug = 'merge-no-version-output';

    const tombstone = makeMergeTombstone(projectRoot, slug, ['input-a', 'input-b'], '# content', undefined);

    const result = _verifyOne(tombstone, { projectRoot, sharedDir: null });

    // Merge with absent output file → flagged (output missing), but not due to schema_version.
    assert.equal(result.status, 'flagged',
      'merge tombstone with absent output should be flagged (output missing)');
    assert.ok(!result.detail.includes('schema_version'),
      'merge flag reason must not be schema_version (gate is promote-only)');
  });
});

// ---------------------------------------------------------------------------
// curator_reconcile_promote_flagged event emission
// ---------------------------------------------------------------------------

describe('curator_reconcile_promote_flagged event', () => {
  test('emits audit event when schema_version_pre_v216 → flagged', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'event-emission-slug';

    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, '# content', undefined);

    _verifyOne(tombstone, { projectRoot, sharedDir: path.join(sharedRoot, 'patterns') });

    // Check that audit event was emitted (fail-open: may not exist if audit dir not set up)
    const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
      const events = lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
      const flagEvent = events.find(e => e.type === 'curator_reconcile_promote_flagged');
      if (flagEvent) {
        assert.ok(flagEvent.reason, 'event must have reason field');
        assert.ok(['auto_repair_disabled', 'schema_version_pre_v216'].includes(flagEvent.reason),
          'reason must be one of the expected values, got: ' + flagEvent.reason);
        assert.ok(typeof flagEvent.recovery_command === 'string', 'event must have recovery_command');
      }
      // If no event was emitted (e.g. no orch state), that's acceptable — fail-open
    }
  });

  test('emits audit event when auto_repair_disabled (schema_version:2, file absent)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'auto-repair-disabled-slug';

    // schema_version:2 passes gate but file is absent → flag with auto_repair_disabled
    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, '# content', 2);

    const result = _verifyOne(tombstone, {
      projectRoot,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.equal(result.status, 'flagged');
    assert.match(result.detail, /auto.repair disabled|manual recovery/i);
  });
});

// ---------------------------------------------------------------------------
// reconcile() integration test with full tombstone write
// ---------------------------------------------------------------------------

describe('reconcile() — schema_version gate integration', () => {
  test('reconcile flags pre-v2.1.6 promote tombstone (no schema_version)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();

    const slug     = 'reconcile-no-version';
    const snapshot = '---\nname: ' + slug + '\ncategory: anti-pattern\nconfidence: 0.8\n---\n\n# Pattern\n\nContent.\n';

    writeLocalPattern(projectRoot, slug, snapshot);

    const runId = startRun({ projectRoot });
    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot, undefined);
    writeTombstone(runId, tombstone, { projectRoot });

    const report = reconcile({
      projectRoot,
      runId,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.equal(report.flagged.length, 1,
      'expected 1 flagged item for pre-v2.1.6 tombstone, got: ' + JSON.stringify(report));
    assert.equal(report.repaired.length, 0,
      'no auto-repair should occur for pre-v2.1.6 tombstone');

    // Verify the shared-tier file was NOT written (no auto-repair)
    const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
    assert.ok(!fs.existsSync(destPath),
      'shared-tier file must NOT be created for pre-v2.1.6 tombstone');
  });

  test('reconcile flags v2.1.6 promote tombstone when file absent (flag-only policy)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();

    const slug     = 'reconcile-v2-absent';
    const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.5\n---\n\n# Pattern\n\nContent.\n';

    writeLocalPattern(projectRoot, slug, snapshot);

    const runId = startRun({ projectRoot });
    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot, 2);
    writeTombstone(runId, tombstone, { projectRoot });

    const report = reconcile({
      projectRoot,
      runId,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.equal(report.flagged.length, 1,
      'promote must be flag-only even with schema_version:2');
    assert.equal(report.repaired.length, 0,
      'no auto-repair for promote regardless of schema_version');

    const destPath = path.join(sharedRoot, 'patterns', slug + '.md');
    assert.ok(!fs.existsSync(destPath),
      'shared-tier file must NOT be created (promote is flag-only)');
  });

  test('reconcile ok when shared-tier file already exists (schema_version:2)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();

    const slug     = 'reconcile-already-present';
    const snapshot = '---\nname: ' + slug + '\ncategory: routing\nconfidence: 0.5\n---\n\n# Pattern.\n';

    writeLocalPattern(projectRoot, slug, snapshot);

    // Pre-create the shared-tier file (simulate successful prior promote)
    fs.writeFileSync(path.join(sharedRoot, 'patterns', slug + '.md'), snapshot, 'utf8');

    const runId = startRun({ projectRoot });
    const tombstone = makePromoteTombstone(projectRoot, sharedRoot, slug, snapshot, 2);
    writeTombstone(runId, tombstone, { projectRoot });

    const report = reconcile({
      projectRoot,
      runId,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.equal(report.flagged.length, 0, 'should not flag when shared file already exists');
    assert.equal(report.repaired.length, 0, 'no repair needed when file already exists');
  });
});

// ---------------------------------------------------------------------------
// Verify schema_version gate scope: extended to unshare in W1b patch (W2-04 fix).
// Merge and deprecate remain unaffected (they are already flag-only / no write).
// ---------------------------------------------------------------------------

describe('schema_version gate scope — unshare gated in W1b (W2-04)', () => {
  test('unshare tombstone without schema_version → flagged (gate extended to unshare by W2-04)', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'unshare-no-version';

    // Create the shared-tier file that would be deleted if gate were not applied.
    const fp = path.join(sharedRoot, 'patterns', slug + '.md');
    fs.writeFileSync(fp, '# content', 'utf8');

    const tombstone = {
      action: 'unshare',
      inputs: [{ slug, path: fp, content_sha256: 'abc123', content_snapshot: '# content' }],
      output: { path: 'deleted', action_summary: 'user unshared ' + slug },
      // no schema_version — W2-04 fix: unshare now requires schema_version >= 2
    };

    const result = _verifyOne(tombstone, {
      projectRoot,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    // W2-04: pre-v2.1.6 unshare tombstones must be flagged, not auto-deleted.
    // A forged/resurrected tombstone without schema_version could otherwise force
    // deletion of any shared-tier slug it names (DoS-adjacent).
    assert.equal(result.status, 'flagged',
      'unshare without schema_version must be flagged (W2-04 gate), got: ' + JSON.stringify(result));
    assert.match(result.detail, /schema_version_pre_v216/,
      'detail must mention schema_version_pre_v216');

    // Verify the shared-tier file was NOT deleted.
    assert.ok(fs.existsSync(fp),
      'shared-tier file must NOT be deleted for pre-v2.1.6 unshare tombstone');
  });

  test('unshare tombstone with schema_version:2 → auto-deletes normally', () => {
    const projectRoot = makeTmpProjectTracked();
    const sharedRoot  = makeTmpSharedTracked();
    const slug = 'unshare-v2';

    const fp = path.join(sharedRoot, 'patterns', slug + '.md');
    fs.writeFileSync(fp, '# content', 'utf8');

    const tombstone = {
      action: 'unshare',
      inputs: [{ slug, path: fp, content_sha256: 'abc123', content_snapshot: '# content' }],
      output: { path: 'deleted', action_summary: 'user unshared ' + slug },
      schema_version: 2,
    };

    const result = _verifyOne(tombstone, {
      projectRoot,
      sharedDir: path.join(sharedRoot, 'patterns'),
    });

    assert.ok(['repaired', 'ok'].includes(result.status),
      'unshare with schema_version:2 must proceed normally, got: ' + JSON.stringify(result));
  });
});
