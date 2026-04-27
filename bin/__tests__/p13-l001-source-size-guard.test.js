#!/usr/bin/env node
'use strict';

/**
 * p13-l001-source-size-guard.test.js — W6 L-001 regression (W7, v2.2.0).
 *
 * Asserts that buildIndex() and getChunk() refuse to read pathologically
 * large event-schemas.md files. The 5 MB ceiling (MAX_SCHEMA_BYTES) is
 * 25× the current ~226 KB source — generous headroom but bounded so a
 * malicious commit cannot OOM the in-process MCP server.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildIndex, getChunk, MAX_SCHEMA_BYTES } = require(
  path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js')
);

function makeTmpProject(sourceContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-l001-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'),
    sourceContent,
    'utf8',
  );
  return dir;
}

describe('P1.3 L-001 regression — MAX_SCHEMA_BYTES guard', () => {
  test('MAX_SCHEMA_BYTES is exported and is a positive number', () => {
    assert.equal(typeof MAX_SCHEMA_BYTES, 'number');
    assert.ok(MAX_SCHEMA_BYTES > 0, 'MAX_SCHEMA_BYTES must be > 0');
    // Sanity: at least 1 MB.
    assert.ok(MAX_SCHEMA_BYTES >= 1024 * 1024, 'MAX_SCHEMA_BYTES must be >= 1 MB');
  });

  test('buildIndex rejects a source larger than MAX_SCHEMA_BYTES', () => {
    // Build a 6 MB synthetic source (just padding — buildIndex would normally
    // fail to parse it; we just need the size guard to trip first).
    const padding = 'x'.repeat(6 * 1024 * 1024);
    const dir = makeTmpProject(padding);
    try {
      assert.throws(
        () => buildIndex({ cwd: dir }),
        /exceeds .* bytes|refusing to load/i,
        'buildIndex must reject sources larger than MAX_SCHEMA_BYTES',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getChunk returns a structured error on oversize source', () => {
    // Need a sidecar to exist for getChunk to even reach the source-read path.
    // Strategy: build the sidecar against a small valid source, then swap the
    // source for a 6 MB blob and assert getChunk surfaces a parser/source
    // error rather than crashing.
    const tinySource = [
      '### `dummy_event` event',
      '',
      'Tiny event for testing.',
      '',
      '```json',
      '{ "version": 1, "type": "dummy_event", "timestamp": "ISO" }',
      '```',
      '',
    ].join('\n');
    const dir = makeTmpProject(tinySource);
    try {
      buildIndex({ cwd: dir });
      // Replace the source with a 6 MB blob (sidecar still references valid
      // line ranges from the tiny version).
      fs.writeFileSync(
        path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'),
        'x'.repeat(6 * 1024 * 1024),
        'utf8',
      );
      const result = getChunk('dummy_event', { cwd: dir });
      assert.equal(result.found, false,
        'oversize source must yield a structured non-hit (no full-file read)');
      // Either source_read_failed (size guard threw) OR stale_index (hash
      // changed). Both are acceptable — the contract is "do not OOM and
      // do not return a chunk we cannot trust."
      assert.ok(
        ['source_read_failed', 'stale_index'].includes(result.error),
        'expected source_read_failed or stale_index; got ' + result.error,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
