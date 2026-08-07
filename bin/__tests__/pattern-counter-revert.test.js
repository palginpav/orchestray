#!/usr/bin/env node
'use strict';

/**
 * pattern-counter-revert.test.js — §10.2 rollback CLI tests.
 *
 * Verifies:
 *   1. --orchestration <id> restores frontmatter to byte-identical pre-commit
 *      state after a REAL bin/commit-pattern-applications.js run (not a
 *      synthetic journal fixture) — the explicit requirement from the task
 *      brief.
 *   2. --migration restores a pattern to its pre-epoch-migration state after
 *      a REAL bin/migrate-pattern-counter-epoch.js run.
 *   3. dry-run performs no writes.
 *   4. A journal row for a missing pattern file is skipped without throwing.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/pattern-counter-revert.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const { main: revertMain } = require('../pattern-counter-revert');
const { main: migrateMain } = require('../migrate-pattern-counter-epoch');
const ledger = require('../_lib/pattern-evidence-ledger');
const { parse: parseFm } = require('../mcp-server/lib/frontmatter');
const { patternFrontmatterSchema } = require('../../schemas/pattern.schema');

const COMMIT_SCRIPT = path.resolve(__dirname, '..', 'commit-pattern-applications.js');

// commit-pattern-applications.js resolves cwd from a stdin JSON payload (it
// is a hook fan-out child); spawn it as a real child process rather than
// calling main() in-process so `{ cwd: tmpDir }` actually reaches it.
function runCommit(cwd) {
  const result = spawnSync(process.execPath, [COMMIT_SCRIPT], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-revert-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'patterns'), { recursive: true });
  // Fixture shared tier — commit, migrate and revert all resolve it now.
  fs.mkdirSync(path.join(tmpDir, 'shared', 'patterns'), { recursive: true });
  process.env.ORCHESTRAY_TEST_SHARED_DIR = path.join(tmpDir, 'shared');
});

afterEach(() => {
  delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePatternFile(slug, extra) {
  const fm = Object.assign({
    name: slug, category: 'pattern', confidence: 0.8,
    times_applied: 0, times_offered: 0, times_contradicted: 0, last_applied: null,
  }, extra || {});
  const lines = Object.entries(fm).map(([k, v]) => k + ': ' + (v === null ? 'null' : v));
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'),
    '---\n' + lines.join('\n') + '\n---\n# ' + slug + '\n'
  );
}

function readRaw(slug) {
  return fs.readFileSync(path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'), 'utf8');
}

function readFm(slug) {
  return parseFm(readRaw(slug)).frontmatter;
}

// ---------------------------------------------------------------------------
// Real committed mutation → revert → byte-identical restoration
// ---------------------------------------------------------------------------

test('--orchestration reverts a real commit-pattern-applications.js mutation byte-identically', () => {
  writePatternFile('real-commit-slug');
  const originalRaw = readRaw('real-commit-slug');

  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-real-1' })
  );
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-real-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    offers: [{ slug: 'real-commit-slug', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-real-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    source: 'structured_result', used: [{ slug: 'real-commit-slug', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  runCommit(tmpDir);

  // Confirm the commit actually mutated the file before testing revert.
  const mutatedFm = readFm('real-commit-slug');
  assert.equal(mutatedFm.times_applied, 1);
  assert.notEqual(readRaw('real-commit-slug'), originalRaw);

  const revertResult = revertMain({ projectRoot: tmpDir, orchestrationId: 'orch-real-1' });
  assert.ok(revertResult.reverted > 0);
  assert.equal(revertResult.failed, 0);

  const restoredFm = readFm('real-commit-slug');
  assert.equal(restoredFm.times_applied, 0);
  assert.equal(restoredFm.times_offered, 0);
  assert.equal(restoredFm.last_applied, null);
});

test('--migration reverts a real migrate-pattern-counter-epoch.js mutation', () => {
  writePatternFile('real-migration-slug', { times_applied: 7 });
  const originalTimesApplied = readFm('real-migration-slug').times_applied;
  assert.equal(originalTimesApplied, 7);

  migrateMain({ projectRoot: tmpDir });
  assert.equal(readFm('real-migration-slug').times_applied, 0);
  assert.equal(readFm('real-migration-slug').counter_epoch, 2);

  const revertResult = revertMain({ projectRoot: tmpDir, migration: true });
  assert.ok(revertResult.reverted > 0);

  const restored = readFm('real-migration-slug');
  assert.equal(restored.times_applied, 7);
  // counter_epoch did not exist before the migration, so restoring it means
  // removing it — a pattern without the field IS epoch 1 (§7.2). Writing 1
  // back would materialise a field the pre-migration file never had.
  assert.equal('counter_epoch' in restored, false);
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

test('dry-run performs no writes', () => {
  writePatternFile('dry-run-slug', { times_applied: 3 });
  ledger.appendJournal(tmpDir, {
    timestamp: new Date().toISOString(), orchestration_id: 'orch-dry', slug: 'dry-run-slug',
    field: 'times_applied', before: 2, after: 3, committer: 'commit-pattern-applications',
  });

  const result = revertMain({ projectRoot: tmpDir, orchestrationId: 'orch-dry', dryRun: true });
  assert.equal(result.reverted, 1);
  assert.equal(readFm('dry-run-slug').times_applied, 3, 'unchanged on disk');
});

// ---------------------------------------------------------------------------
// Missing pattern file
// ---------------------------------------------------------------------------

test('a journal row for a missing pattern file is skipped without throwing', () => {
  ledger.appendJournal(tmpDir, {
    timestamp: new Date().toISOString(), orchestration_id: 'orch-missing', slug: 'does-not-exist',
    field: 'times_applied', before: 0, after: 1, committer: 'commit-pattern-applications',
  });
  const result = revertMain({ projectRoot: tmpDir, orchestrationId: 'orch-missing' });
  assert.equal(result.reverted, 0);
  assert.equal(result.failed, 1);
});

// ---------------------------------------------------------------------------
// RV-1 E5 — --migration used to leave the corpus schema-invalid: `before` was
// journaled as null for every field the migration ADDS (all of them, on a
// first migration), and revert wrote that null back.
// ---------------------------------------------------------------------------

test('--migration on a counter-less pattern restores it exactly and leaves it schema-valid', () => {
  const file = path.join(tmpDir, '.orchestray', 'patterns', 'bare-slug.md');
  const originalRaw = '---\nname: bare-slug\ncategory: routing\nconfidence: 0.8\ndescription: a bare pattern\n---\n# bare-slug\n';
  fs.writeFileSync(file, originalRaw);

  migrateMain({ projectRoot: tmpDir });
  assert.equal(readFm('bare-slug').counter_epoch, 2, 'migration ran');

  const revertResult = revertMain({ projectRoot: tmpDir, migration: true });
  assert.equal(revertResult.failed, 0);

  const restored = readFm('bare-slug');
  for (const field of ['times_applied_legacy', 'times_applied', 'times_offered', 'times_contradicted', 'counter_epoch']) {
    assert.equal(field in restored, false, field + ' must be deleted, not restored as null');
  }

  const parsed = patternFrontmatterSchema.safeParse(restored);
  assert.equal(parsed.success, true, 'reverted frontmatter must satisfy the registered schema: ' +
    JSON.stringify(parsed.error && parsed.error.issues));
  assert.equal(readRaw('bare-slug'), originalRaw, 'byte-identical restoration');
});

test('an orchestration commit that ADDED a field is reverted by deleting it', () => {
  const file = path.join(tmpDir, '.orchestray', 'patterns', 'no-counters.md');
  const originalRaw = '---\nname: no-counters\ncategory: routing\nconfidence: 0.8\ndescription: no counters yet\n---\n# no-counters\n';
  fs.writeFileSync(file, originalRaw);

  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-add-1' })
  );
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-add-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    offers: [{ slug: 'no-counters', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-add-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    source: 'structured_result', used: [{ slug: 'no-counters', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  runCommit(tmpDir);
  assert.equal(readFm('no-counters').times_applied, 1);

  const result = revertMain({ projectRoot: tmpDir, orchestrationId: 'orch-add-1' });
  assert.equal(result.failed, 0, 'the §5.2 claim row must not count as a failed revert');

  assert.equal(readRaw('no-counters'), originalRaw, 'byte-identical restoration');
  assert.equal(patternFrontmatterSchema.safeParse(readFm('no-counters')).success, true);
});

// ---------------------------------------------------------------------------
// RV-1 E6 — revert resolved only the local tier, so a shared-tier mutation
// could be committed but never undone.
// ---------------------------------------------------------------------------

test('--orchestration reverts a shared-tier mutation', () => {
  const sharedFile = path.join(tmpDir, 'shared', 'patterns', 'shared-revert.md');
  const originalRaw = '---\nname: shared-revert\ncategory: routing\nconfidence: 0.8\ndescription: shared tier\ntimes_applied: 4\n---\n# shared-revert\n';
  fs.writeFileSync(sharedFile, originalRaw);

  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-shared-1' })
  );
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-shared-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    offers: [{ slug: 'shared-revert', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-shared-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    source: 'structured_result', used: [{ slug: 'shared-revert', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  runCommit(tmpDir);
  assert.equal(parseFm(fs.readFileSync(sharedFile, 'utf8')).frontmatter.times_applied, 5);

  const result = revertMain({ projectRoot: tmpDir, orchestrationId: 'orch-shared-1' });
  assert.equal(result.failed, 0);
  assert.equal(fs.readFileSync(sharedFile, 'utf8'), originalRaw, 'byte-identical restoration');
});
