#!/usr/bin/env node
'use strict';

/**
 * migrate-pattern-counter-epoch.test.js — §7.2 migration tests.
 *
 * Verifies:
 *   1. times_applied_legacy preserves the prior value; times_applied resets to 0.
 *   2. times_offered seeds from pattern_skip_enriched rows, deduped on
 *      (timestamp, orchestration_id, pattern_name) — the 3.4x trap fixture:
 *      the SAME row present in the live log and two history/** archives
 *      must still yield times_offered: 1.
 *   3. Two DISTINCT orchestration_ids each carrying the row yields times_offered: 2.
 *   4. Idempotency — a second run against an already-migrated pattern is a no-op.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/migrate-pattern-counter-epoch.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { main, MIGRATION_SENTINEL } = require('../migrate-pattern-counter-epoch');
const { parse: parseFm } = require('../mcp-server/lib/frontmatter');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-migrate-epoch-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'history'), { recursive: true });
  // The migration now covers the shared tier — point it at a fixture dir so it
  // can never touch the machine's real federation corpus.
  fs.mkdirSync(path.join(tmpDir, 'shared', 'patterns'), { recursive: true });
  process.env.ORCHESTRAY_TEST_SHARED_DIR = path.join(tmpDir, 'shared');
});

afterEach(() => {
  delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePatternFile(slug, extra) {
  const fm = Object.assign({ name: slug, category: 'pattern', confidence: 0.8, times_applied: 5 }, extra || {});
  const lines = Object.entries(fm).map(([k, v]) => k + ': ' + (v === null ? 'null' : v));
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'),
    '---\n' + lines.join('\n') + '\n---\n# ' + slug + '\n'
  );
}

function readFm(slug) {
  const content = fs.readFileSync(path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'), 'utf8');
  return parseFm(content).frontmatter;
}

function skipEnrichedRow(slug, orchId, ts) {
  return JSON.stringify({ type: 'pattern_skip_enriched', pattern_name: slug, orchestration_id: orchId, timestamp: ts });
}

function writeLiveEvents(lines) {
  fs.writeFileSync(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'), lines.join('\n') + '\n');
}

function writeHistoryEvents(orchId, lines) {
  const dir = path.join(tmpDir, '.orchestray', 'history', orchId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------

test('epochs a legacy pattern: times_applied_legacy preserved, times_applied reset to 0', () => {
  writePatternFile('legacy-slug', { times_applied: 5 });
  const result = main({ projectRoot: tmpDir });
  assert.equal(result.migrated, 1);

  const fm = readFm('legacy-slug');
  assert.equal(fm.times_applied_legacy, 5);
  assert.equal(fm.times_applied, 0);
  assert.equal(fm.times_contradicted, 0);
  assert.equal(fm.counter_epoch, 2);
});

test('the 3.4x dedupe trap: the same row live + two history copies yields times_offered: 1', () => {
  writePatternFile('dupe-slug', { times_applied: 0 });
  const ts = '2026-08-01T00:00:00.000Z';
  writeLiveEvents([skipEnrichedRow('dupe-slug', 'orch-1', ts)]);
  writeHistoryEvents('orch-1', [skipEnrichedRow('dupe-slug', 'orch-1', ts)]);
  writeHistoryEvents('orch-1-copy', [skipEnrichedRow('dupe-slug', 'orch-1', ts)]); // same identical row, different archive dir

  main({ projectRoot: tmpDir });

  assert.equal(readFm('dupe-slug').times_offered, 1);
});

test('two distinct orchestration_ids yield times_offered: 2', () => {
  writePatternFile('multi-orch-slug', { times_applied: 0 });
  writeLiveEvents([
    skipEnrichedRow('multi-orch-slug', 'orch-1', '2026-08-01T00:00:00.000Z'),
    skipEnrichedRow('multi-orch-slug', 'orch-2', '2026-08-02T00:00:00.000Z'),
  ]);

  main({ projectRoot: tmpDir });

  assert.equal(readFm('multi-orch-slug').times_offered, 2);
});

test('idempotent: a pattern already at counter_epoch 2 is skipped on a second run', () => {
  writePatternFile('already-migrated', { times_applied: 0, counter_epoch: 2, times_applied_legacy: 3 });
  const result = main({ projectRoot: tmpDir });
  assert.equal(result.migrated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(readFm('already-migrated').times_applied_legacy, 3);
});

test('journals every field write with the MIGRATION_SENTINEL orchestration_id', () => {
  writePatternFile('journaled-slug', { times_applied: 2 });
  main({ projectRoot: tmpDir });

  const journalPath = path.join(tmpDir, '.orchestray', 'state', 'pattern-counter-journal.jsonl');
  const rows = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.orchestration_id === MIGRATION_SENTINEL));
  assert.ok(rows.some((r) => r.slug === 'journaled-slug' && r.field === 'counter_epoch' && r.after === 2));
});

test('dry-run performs no writes', () => {
  writePatternFile('dry-run-slug', { times_applied: 4 });
  const result = main({ projectRoot: tmpDir, dryRun: true });
  assert.equal(result.migrated, 1);
  assert.equal(readFm('dry-run-slug').times_applied, 4, 'unchanged on disk');
  assert.equal(readFm('dry-run-slug').counter_epoch, undefined);
});

// ---------------------------------------------------------------------------
// RV-1 E5 — a field the migration ADDS was journaled as before: null (or a
// 0 / epoch-1 default), so the revert materialised counters that never
// existed and wrote a null the registered schema rejects. Absence is now
// journaled as absence.
// ---------------------------------------------------------------------------

test('fields absent before the migration are journaled with before_absent', () => {
  // A pattern with no counter fields at all — the first-migration shape.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'patterns', 'bare-slug.md'),
    '---\nname: bare-slug\ncategory: pattern\nconfidence: 0.8\n---\n# bare-slug\n'
  );

  main({ projectRoot: tmpDir });

  const rows = fs.readFileSync(path.join(tmpDir, '.orchestray', 'state', 'pattern-counter-journal.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.slug === 'bare-slug');

  for (const field of ['times_applied_legacy', 'times_applied', 'times_offered', 'times_contradicted', 'counter_epoch']) {
    const row = rows.find((r) => r.field === field);
    assert.ok(row, 'journaled ' + field);
    assert.equal(row.before_absent, true, field + ' was absent, and must be journaled as absent');
  }
});

test('a field that existed before the migration is not marked absent', () => {
  writePatternFile('present-slug', { times_applied: 5, times_offered: 2 });
  main({ projectRoot: tmpDir });

  const rows = fs.readFileSync(path.join(tmpDir, '.orchestray', 'state', 'pattern-counter-journal.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.slug === 'present-slug');

  const applied = rows.find((r) => r.field === 'times_applied');
  assert.equal(applied.before_absent, false);
  assert.equal(applied.before, 5);
  assert.equal(rows.find((r) => r.field === 'times_offered').before, 2);
});

// ---------------------------------------------------------------------------
// RV-1 E6 — the shared tier was never migrated, so shared patterns kept
// epoch-1 values forever while local ones reset to 0, skewing every ranking
// that tiebreaks on times_applied.
// ---------------------------------------------------------------------------

test('a shared-tier pattern is migrated and journaled with its tier', () => {
  const sharedFile = path.join(tmpDir, 'shared', 'patterns', 'shared-legacy.md');
  fs.writeFileSync(
    sharedFile,
    '---\nname: shared-legacy\ncategory: pattern\nconfidence: 0.8\ntimes_applied: 6\n---\n# shared-legacy\n'
  );

  const result = main({ projectRoot: tmpDir });
  assert.equal(result.migrated, 1);

  const fm = parseFm(fs.readFileSync(sharedFile, 'utf8')).frontmatter;
  assert.equal(fm.times_applied, 0);
  assert.equal(fm.times_applied_legacy, 6);
  assert.equal(fm.counter_epoch, 2);

  const rows = fs.readFileSync(path.join(tmpDir, '.orchestray', 'state', 'pattern-counter-journal.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.slug === 'shared-legacy' && r.tier === 'shared'));
});
