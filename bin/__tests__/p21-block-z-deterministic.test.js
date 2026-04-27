#!/usr/bin/env node
'use strict';

/**
 * P2.1 Block-Z determinism (v2.2.0).
 *
 * Asserts that buildBlockZ produces a byte-stable output across two invocations
 * against the same on-disk content, that the sha256 fingerprint is the LAST
 * line and matches the returned hash, that the hash is sensitive to one-byte
 * changes, that mtime changes do NOT affect the hash, and that missing-input
 * fail-soft returns the documented shape.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildBlockZ, DEFAULT_COMPONENTS } = require(path.join(REPO_ROOT, 'bin', '_lib', 'block-z.js'));

function makeTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-blockz-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'pm.md'),                          'PM body line one\nPM body line two\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),                                  'CLAUDE body\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'), 'handoff body\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'phase-contract.md'),    'phase body\n');
  return dir;
}

describe('P2.1 buildBlockZ determinism', () => {
  test('two successive invocations produce identical text/hash/components', () => {
    const cwd = makeTmpRepo();
    const a = buildBlockZ({ cwd });
    const b = buildBlockZ({ cwd });
    assert.equal(a.text, b.text, 'Block-Z text must be byte-stable');
    assert.equal(a.hash, b.hash, 'Block-Z hash must be byte-stable');
    assert.equal(JSON.stringify(a.components), JSON.stringify(b.components));
    assert.equal(a.error, null);
  });

  test('fingerprint comment is the last line and matches returned hash', () => {
    const cwd = makeTmpRepo();
    const r = buildBlockZ({ cwd });
    const lines = r.text.split('\n');
    const last = lines[lines.length - 1];
    assert.match(last, /^<!-- block-z:sha256=[0-9a-f]{64} -->$/);
    const embeddedHash = last.replace(/^<!-- block-z:sha256=/, '').replace(/ -->$/, '');
    assert.equal(embeddedHash, r.hash);
  });

  test('hash is sensitive to a single-byte change in any component', () => {
    const cwd = makeTmpRepo();
    const baseline = buildBlockZ({ cwd });
    // Append one byte to pm.md
    fs.appendFileSync(path.join(cwd, 'agents', 'pm.md'), 'X');
    const after = buildBlockZ({ cwd });
    assert.notEqual(after.hash, baseline.hash, 'hash must invert on one-byte component change');
  });

  test('hash is INSENSITIVE to file mtime changes (content-only)', () => {
    const cwd = makeTmpRepo();
    const baseline = buildBlockZ({ cwd });
    const future = new Date('2030-01-01T00:00:00Z');
    fs.utimesSync(path.join(cwd, 'agents', 'pm.md'), future, future);
    const after = buildBlockZ({ cwd });
    assert.equal(after.hash, baseline.hash, 'mtime change must not affect content hash');
  });

  test('missing-input → fail-soft shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-blockz-missing-'));
    // Intentionally create only some components
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'only CLAUDE');
    const r = buildBlockZ({ cwd: dir });
    assert.equal(r.text, '');
    assert.equal(r.hash, null);
    assert.deepEqual(r.components, []);
    assert.equal(r.error, 'missing_input');
  });

  test('DEFAULT_COMPONENTS is frozen and lists the four expected names', () => {
    assert.equal(DEFAULT_COMPONENTS.length, 4);
    assert.equal(DEFAULT_COMPONENTS[0].name, 'agents/pm.md');
    assert.equal(DEFAULT_COMPONENTS[1].name, 'CLAUDE.md');
    assert.equal(DEFAULT_COMPONENTS[2].name, 'agents/pm-reference/handoff-contract.md');
    assert.equal(DEFAULT_COMPONENTS[3].name, 'agents/pm-reference/phase-contract.md');
    assert.throws(() => { DEFAULT_COMPONENTS.push({ name: 'x', rel: 'x' }); });
  });
});
