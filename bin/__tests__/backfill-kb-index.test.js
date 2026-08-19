'use strict';

/**
 * backfill-kb-index.js — one-shot KB index backfill.
 *
 * Coverage:
 *   A — computePlan/run(dry-run): only never-indexed files are planned;
 *       files indexed in EITHER schema are excluded from the union diff
 *   B — run({write:true}): applies entries to the bucket array, is
 *       idempotent on a second run, omits author/topic/orchestration_id
 *   C — path normalisation: short-form vs canonical-form paths compare equal
 *   D — lock: two concurrent write runs don't corrupt the index or lose entries
 *   E — CLI: dry-run is the default; --write is required to persist
 */

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'backfill-kb-index.js');
const { run, computePlan, normalisePath, deriveId } = require('../backfill-kb-index');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-backfill-'));
  const kbDir = path.join(root, '.orchestray', 'kb');
  for (const b of ['artifacts', 'facts', 'decisions']) {
    fs.mkdirSync(path.join(kbDir, b), { recursive: true });
  }
  return root;
}

function writeMd(root, bucket, slug, body) {
  fs.writeFileSync(path.join(root, '.orchestray', 'kb', bucket, slug + '.md'), body);
}

function writeIndex(root, obj) {
  fs.writeFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), JSON.stringify(obj, null, 2));
}

function readIndex(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), 'utf8'));
}

describe('backfill-kb-index', () => {
  test('A — dry-run plans only never-indexed files (union of both schemas)', () => {
    const root = makeSandbox();
    writeMd(root, 'artifacts', 'indexed-bucket', '# Indexed via bucket\n');
    writeMd(root, 'artifacts', 'indexed-entries', '# Indexed via entries\n');
    writeMd(root, 'artifacts', 'never-indexed', '# Never indexed\n');
    writeIndex(root, {
      version: '1.0',
      entries: [{ slug: 'indexed-entries', title: 'x', type: 'artifact', path: '.orchestray/kb/artifacts/indexed-entries.md', created_at: '2026-01-01T00:00:00Z' }],
      artifacts: [{ id: 'indexed-bucket', path: 'artifacts/indexed-bucket.md', author: 'a', topic: 't' }],
    });

    const result = run({ cwd: root, write: false });
    assert.equal(result.wrote, false);
    assert.equal(result.planned.length, 1);
    assert.equal(result.planned[0].entry.path, '.orchestray/kb/artifacts/never-indexed.md');

    // Dry-run must not touch the index at all.
    const idx = readIndex(root);
    assert.equal(idx.artifacts.length, 1);
    assert.equal(idx.entries.length, 1);
  });

  test('B — write mode applies entries, is idempotent, omits guessed fields', () => {
    const root = makeSandbox();
    writeMd(root, 'facts', 'new-fact', '# A New Fact\nBody text.\n');
    writeIndex(root, { version: '1.0', entries: [] });

    const r1 = run({ cwd: root, write: true });
    assert.equal(r1.wrote, true);
    assert.equal(r1.applied.length, 1);
    const entry = r1.applied[0].entry;
    assert.equal(entry.id, 'new-fact');
    assert.equal(entry.path, '.orchestray/kb/facts/new-fact.md');
    assert.equal(entry.title, 'A New Fact');
    assert.ok(entry.created_at);
    assert.equal('author' in entry, false);
    assert.equal('topic' in entry, false);
    assert.equal('orchestration_id' in entry, false);

    const idxAfter1 = readIndex(root);
    assert.equal(idxAfter1.facts.length, 1);

    // Second run must be a no-op.
    const r2 = run({ cwd: root, write: true });
    assert.equal(r2.applied.length, 0);
    assert.equal(r2.wrote, false);
    const idxAfter2 = readIndex(root);
    assert.equal(idxAfter2.facts.length, 1);
  });

  test('C — short-form and canonical-form paths normalise equal', () => {
    assert.equal(normalisePath('artifacts/foo.md'), '.orchestray/kb/artifacts/foo.md');
    assert.equal(normalisePath('.orchestray/kb/artifacts/foo.md'), '.orchestray/kb/artifacts/foo.md');
    assert.equal(deriveId('v2318-quality-prior-art.md'), 'v2318-quality-prior-art');
  });

  test('C2 — file indexed only via short-form bucket path is excluded from plan', () => {
    const root = makeSandbox();
    writeMd(root, 'decisions', 'already-there', '# Already There\n');
    writeIndex(root, { version: '1.0', entries: [], decisions: [{ id: 'already-there', path: 'decisions/already-there.md', author: 'a', topic: 't' }] });

    const { plan } = computePlan(path.join(root, '.orchestray', 'kb'), readIndex(root));
    assert.equal(plan.length, 0);
  });

  test('D — concurrent write runs do not lose entries (locked)', () => {
    const root = makeSandbox();
    writeMd(root, 'artifacts', 'race-a', '# Race A\n');
    writeMd(root, 'artifacts', 'race-b', '# Race B\n');
    writeIndex(root, { version: '1.0', entries: [] });

    // Run two child processes concurrently against the same sandbox.
    const { spawnSync } = require('node:child_process');
    const p1 = require('node:child_process').spawn('node', [SCRIPT, '--write', root]);
    const p2 = require('node:child_process').spawn('node', [SCRIPT, '--write', root]);
    return Promise.all([
      new Promise((res) => p1.on('close', res)),
      new Promise((res) => p2.on('close', res)),
    ]).then(() => {
      const idx = readIndex(root);
      const ids = idx.artifacts.map((e) => e.id).sort();
      assert.deepEqual(ids, ['race-a', 'race-b']);
    });
  });

  test('E — CLI defaults to dry-run; --write required to persist', () => {
    const root = makeSandbox();
    writeMd(root, 'artifacts', 'cli-test', '# CLI Test\n');
    writeIndex(root, { version: '1.0', entries: [] });

    const dryOut = execFileSync('node', [SCRIPT, root], { encoding: 'utf8' });
    assert.match(dryOut, /DRY-RUN/);
    assert.match(dryOut, /No changes written/i);
    let idx = readIndex(root);
    assert.equal((idx.artifacts || []).length, 0);

    const writeOut = execFileSync('node', [SCRIPT, '--write', root], { encoding: 'utf8' });
    assert.match(writeOut, /WRITE/);
    idx = readIndex(root);
    assert.equal(idx.artifacts.length, 1);
  });
});
