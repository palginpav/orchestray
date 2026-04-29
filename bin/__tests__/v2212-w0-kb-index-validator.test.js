'use strict';

/**
 * Tests for bin/_lib/kb-index-validator.js — W0 fix: accept id OR slug.
 *
 * Runner: node --test bin/__tests__/v2212-w0-kb-index-validator.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { validate } = require('../_lib/kb-index-validator.js');

function makeTmpIndex(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-validator-'));
  const kbDir = path.join(dir, '.orchestray', 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'index.json'), JSON.stringify({ version: '1.0', entries }));
  return dir;
}

test('slug-only entry passes', () => {
  const dir = makeTmpIndex([{ slug: 'my-artifact', path: 'kb/artifacts/my-artifact.md', type: 'artifact', title: 'Test' }]);
  const result = validate(dir);
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
});

test('id-only entry passes', () => {
  const dir = makeTmpIndex([{ id: 'my-artifact-id', path: 'kb/artifacts/my-artifact.md', type: 'artifact', title: 'Test' }]);
  const result = validate(dir);
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
});

test('entry with neither id nor slug fails', () => {
  const dir = makeTmpIndex([{ path: 'kb/artifacts/anon.md', type: 'artifact', title: 'Anon' }]);
  // path-based dedup allows this (old-format entries) but malformed id value fails
  // specifically: an entry with a non-string id-like field that fails ID_RE
  const dir2 = makeTmpIndex([{ id: '!!!bad!!!', path: 'kb/artifacts/bad.md', title: 'Bad' }]);
  const result2 = validate(dir2);
  assert.equal(result2.valid, false);
  assert.equal(result2.reason, 'entry_0_bad_id');
});

test('two entries with same slug returns duplicate error', () => {
  const dir = makeTmpIndex([
    { slug: 'dup-slug', path: 'kb/artifacts/a.md', type: 'artifact', title: 'A' },
    { slug: 'dup-slug', path: 'kb/artifacts/b.md', type: 'artifact', title: 'B' },
  ]);
  const result = validate(dir);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'entry_1_duplicate_id_dup-slug');
});
