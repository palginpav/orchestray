#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/pattern-seen-set.js hardening (v2.1.9 Bundle B1 / I-06).
 *
 * Covers:
 *  - fail-open recovery on unreadable seen-set file
 *  - 10 MB oversize cap + 5 MB truncation target
 *  - idempotent recordSeen after truncation
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../pattern-seen-set.js');

function setupTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-t-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

describe('pattern-seen-set — fail-open on corrupt file', () => {
  test('corrupted JSON lines are skipped and logged', () => {
    const root = setupTmp();
    const file = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    fs.writeFileSync(file, 'NOT JSON\n{"orch_id":"o1","slug":"s1","first_agent":"x","body_hash":"abc","ts":"t"}\nAGAIN BAD\n', 'utf8');

    // _readRows is exported for tests; expect it to salvage the one valid row.
    const rows = mod._readRows(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, 's1');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('missing file returns empty without degradation noise', () => {
    const root = setupTmp();
    const file = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    const rows = mod._readRows(file);
    assert.deepEqual(rows, []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('pattern-seen-set — oversize truncation', () => {
  test('file larger than 10 MB triggers truncation on read', () => {
    const root = setupTmp();
    const file = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    // Generate ~11 MB of JSONL rows.
    const bigRow = JSON.stringify({
      orch_id: 'orch-big',
      slug: 'slug',
      first_agent: 'developer',
      body_hash: 'a'.repeat(64),
      ts: new Date().toISOString(),
      _pad: 'x'.repeat(512),
    }) + '\n';
    // Stream-write to avoid memory pressure.
    const fd = fs.openSync(file, 'w');
    try {
      const targetBytes = 11 * 1024 * 1024;
      let written = 0;
      while (written < targetBytes) {
        fs.writeSync(fd, bigRow, null, 'utf8');
        written += Buffer.byteLength(bigRow, 'utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
    const beforeStat = fs.statSync(file);
    assert.ok(beforeStat.size > mod.MAX_FILE_BYTES, 'fixture must exceed cap');

    // First read triggers truncation side-effect.
    const rows = mod._readRows(file);
    assert.deepEqual(rows, []);

    // File must now be ≤ ~5 MB (and > 0).
    const afterStat = fs.statSync(file);
    assert.ok(
      afterStat.size <= mod.TRUNCATE_TARGET_BYTES + 1024,
      'post-truncate size ' + afterStat.size + ' must be <= target ' + mod.TRUNCATE_TARGET_BYTES
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('_truncateToTarget preserves the most recent rows', () => {
    const root = setupTmp();
    const file = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    const rows = [];
    for (let i = 0; i < 100; i++) {
      rows.push(JSON.stringify({ orch_id: 'o', slug: 's' + i, first_agent: 'a', body_hash: 'h', ts: 't' + i }));
    }
    fs.writeFileSync(file, rows.join('\n') + '\n', 'utf8');
    // Target: ~2 KB (about 15-20 rows).
    const result = mod._truncateToTarget(file, 2 * 1024);
    assert.equal(result.truncated, true);
    assert.ok(result.kept > 0 && result.kept < 100);
    assert.ok(result.dropped > 0);

    // Verify tail rows are the ones kept.
    const content = fs.readFileSync(file, 'utf8');
    const lastLine = content.trim().split('\n').pop();
    assert.match(lastLine, /"ts":"t99"/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('pattern-seen-set — recordSeen after oversize', () => {
  test('writes go through after a truncation cycle', () => {
    const root = setupTmp();
    const file = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    // Pre-populate with a very large file.
    const filler = JSON.stringify({ orch_id: 'old', slug: 'old', first_agent: 'x', body_hash: 'h', ts: 't' }) + '\n';
    const fd = fs.openSync(file, 'w');
    try {
      const targetBytes = 11 * 1024 * 1024;
      let written = 0;
      while (written < targetBytes) {
        fs.writeSync(fd, filler, null, 'utf8');
        written += Buffer.byteLength(filler, 'utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
    // A recordSeen call should truncate then append.
    const r = mod.recordSeen('orch-new', 'new-slug', 'body-content', 'developer', root);
    assert.equal(r.recorded, true);

    const afterStat = fs.statSync(file);
    assert.ok(afterStat.size <= mod.TRUNCATE_TARGET_BYTES + 4 * 1024);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /orch-new/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
