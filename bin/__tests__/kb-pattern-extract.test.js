#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/kb-pattern-extract.js (v2.3.30 manual kb-sourced
 * extraction CLI — the human-gated counterpart to the auto-hook fallback
 * in bin/post-orchestration-extract.js).
 *
 * Runner: node --test bin/__tests__/kb-pattern-extract.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { runKbExtraction } = require('../kb-pattern-extract.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-kb-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeKbFact(slug, topic, body) {
  const dir = path.join(tmpDir, '.orchestray', 'kb', 'facts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, slug + '.md'),
    `---\nauthor: developer\ntopic: ${topic}\n---\n\n# ${slug}\n\n${body}\n`,
    'utf8'
  );
}

describe('runKbExtraction', () => {
  test('stages a proposal for a kb anti-pattern entry (human-gated categories allowed)', () => {
    writeKbFact(
      'never-mock-db',
      'this is an anti-pattern to avoid, a landmine',
      'Never do this again — mocking the database in integration tests is a gotcha that masked a broken migration.'
    );

    const result = runKbExtraction({ projectRoot: tmpDir });
    assert.equal(result.checked, 1);
    assert.deepEqual(result.staged, ['kb-never-mock-db']);
    assert.equal(result.since, null);

    const proposedPath = path.join(tmpDir, '.orchestray', 'proposed-patterns', 'kb-never-mock-db.md');
    assert.ok(fs.existsSync(proposedPath));
    const content = fs.readFileSync(proposedPath, 'utf8');
    assert.match(content, /category: anti-pattern/);
    assert.match(content, /provenance: kb/);
  });

  test('second run with nothing new since stamp stages nothing', () => {
    writeKbFact('never-mock-db', 'anti-pattern landmine', 'Never do this again, a gotcha.');
    runKbExtraction({ projectRoot: tmpDir });

    const second = runKbExtraction({ projectRoot: tmpDir });
    assert.equal(second.checked, 0);
    assert.deepEqual(second.staged, []);
    assert.notEqual(second.since, null);
  });

  test('dry-run does not write files or advance the stamp', () => {
    writeKbFact('never-mock-db', 'anti-pattern landmine', 'Never do this again, a gotcha.');
    const result = runKbExtraction({ projectRoot: tmpDir, dryRun: true });
    assert.deepEqual(result.staged, ['kb-never-mock-db']);

    const proposedDir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    assert.ok(!fs.existsSync(proposedDir));

    const stampPath = path.join(tmpDir, '.orchestray', 'state', 'kb-extract-last-run.json');
    assert.ok(!fs.existsSync(stampPath));
  });

  test('entry with no category-keyword match is skipped, not fabricated into decomposition/routing', () => {
    writeKbFact('quarterly-numbers', 'unrelated business summary', 'Revenue grew ten percent this quarter.');
    const result = runKbExtraction({ projectRoot: tmpDir });
    assert.deepEqual(result.staged, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'no_category_match');
  });

  test('slug collision with an existing active pattern is skipped', () => {
    writeKbFact('never-mock-db', 'anti-pattern landmine', 'Never do this again, a gotcha.');
    const activeDir = path.join(tmpDir, '.orchestray', 'patterns');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'kb-never-mock-db.md'), '---\nname: kb-never-mock-db\n---\n', 'utf8');

    const result = runKbExtraction({ projectRoot: tmpDir });
    assert.deepEqual(result.staged, []);
    assert.equal(result.skipped[0].reason, 'slug_collision');
  });
});
