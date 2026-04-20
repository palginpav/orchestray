#!/usr/bin/env node
'use strict';

/**
 * Tests for the v2.1.9 I-04 curator cursor-reset dedup behavior.
 *
 * To trigger `_journalCorrupt`, we craft a pattern with a stamp that passes
 * the existence gate (has `recently_curated_action_id`) but is missing the
 * primary `recently_curated_at` key, forcing isDirty into the _journalCorrupt
 * branch.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CURATOR_DIFF = path.resolve(__dirname, '..', 'curator-diff.js');

function buildHarness(curatorDiffAbs) {
  return `
const path = require('node:path');
const fs = require('node:fs');
const root = process.env.TEST_ROOT;
process.chdir(root);
const diff = require(${JSON.stringify(curatorDiffAbs)});

const patternsDir = path.join(root, '.orchestray', 'patterns');
fs.mkdirSync(patternsDir, { recursive: true });
// Stamp is "corrupt" — has action_id but no at/body_sha256 → triggers _journalCorrupt.
const corrupt = [
  '---',
  'recently_curated_action_id: action-123',
  '---',
  '# corrupt pattern',
  'body text here',
  ''
].join('\\n');
for (const name of ['a.md', 'b.md', 'c.md']) {
  fs.writeFileSync(path.join(patternsDir, name), corrupt, 'utf8');
}

const res = diff.computeDirtySet({
  patternsDir,
  cutoffDays: 30,
  runCounterPath: path.join(root, 'run-counter.json'),
  activeTombstonesPath: path.join(root, 'tombstones.jsonl'),
});
process.stdout.write(JSON.stringify({ dirty: res.dirty.length }));
`;
}

describe('curator cursor reset — dedup via session sentinel', () => {
  test('first call emits curator_cursor_reset; second call does not add a new one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-dedup-'));
    const harnessPath = path.join(root, 'harness.js');
    fs.writeFileSync(harnessPath, buildHarness(CURATOR_DIFF), 'utf8');
    const env = Object.assign({}, process.env, {
      TEST_ROOT: root,
      CLAUDE_SESSION_ID: 'test-session-42',
    });

    const r1 = spawnSync('node', [harnessPath], { env, cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.equal(r1.status, 0, 'first run failed: ' + r1.stderr);

    const journalPath = path.join(root, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(journalPath), 'expected degraded.jsonl to exist after first run');
    const journal1 = fs.readFileSync(journalPath, 'utf8');
    const firstCount = (journal1.match(/curator_cursor_reset/g) || []).length;
    assert.ok(firstCount >= 1, 'expected >=1 curator_cursor_reset after first run, got ' + firstCount +
      '\njournal: ' + journal1);

    // Sentinel file should exist after first run.
    const sentinels = fs.readdirSync(path.join(root, '.orchestray', 'state'))
      .filter(n => n.startsWith('.curator-cursor-reset-'));
    assert.equal(sentinels.length, 1, 'expected one session sentinel, got ' + sentinels.join(','));

    // Second run in a NEW process (same session id) — sentinel must suppress
    // a fresh emission.
    const r2 = spawnSync('node', [harnessPath], { env, cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.equal(r2.status, 0, 'second run failed: ' + r2.stderr);

    const journal2 = fs.readFileSync(journalPath, 'utf8');
    const secondCount = (journal2.match(/curator_cursor_reset/g) || []).length;
    assert.equal(
      secondCount,
      firstCount,
      'second run must not emit a new curator_cursor_reset (before=' + firstCount + ', after=' + secondCount + ')'
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('different session IDs get separate sentinels', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-diff-'));
    const harnessPath = path.join(root, 'harness.js');
    fs.writeFileSync(harnessPath, buildHarness(CURATOR_DIFF), 'utf8');

    for (const sid of ['sess-1', 'sess-2']) {
      const env = Object.assign({}, process.env, { TEST_ROOT: root, CLAUDE_SESSION_ID: sid });
      const r = spawnSync('node', [harnessPath], { env, cwd: root, encoding: 'utf8', timeout: 15_000 });
      assert.equal(r.status, 0, sid + ' stderr: ' + r.stderr);
    }
    const stateDir = path.join(root, '.orchestray', 'state');
    const sentinels = fs.readdirSync(stateDir).filter(n => n.startsWith('.curator-cursor-reset-'));
    assert.equal(sentinels.length, 2, 'expected two session sentinels, got ' + sentinels.join(','));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
