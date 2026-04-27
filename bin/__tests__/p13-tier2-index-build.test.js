#!/usr/bin/env node
'use strict';

/**
 * P1.3 tier2-index buildIndex contract (v2.2.0).
 *
 * Asserts that buildIndex({cwd}) produces a sidecar with:
 *   - events.tier2_load entry containing line_range, short_doc, citation_anchor,
 *     and a non-empty schema.required array (AR-p13-1 evidence).
 *   - sidecar size between 4096 and MAX_INDEX_BYTES.
 *   - _meta.source_hash matches sha256 of the source bytes.
 *   - _meta.event_count matches the count of `### \`<slug>\` event` headings.
 *   - Re-running buildIndex is idempotent.
 *
 * The test stages a tmp clone of the live event-schemas.md so the live sidecar
 * is never mutated.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const crypto  = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildIndex, MAX_INDEX_BYTES } = require(
  path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js')
);
const SCHEMAS_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

function makeTmpClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-tier2-build-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMAS_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  return dir;
}

describe('P1.3 buildIndex produces a well-formed tier2-index sidecar', () => {
  test('emits events.tier2_load with line_range, short_doc, citation_anchor, schema.required', () => {
    const cwd = makeTmpClone();
    const idx = buildIndex({ cwd });

    assert.ok(idx.events, 'sidecar must have an events map');
    const entry = idx.events.tier2_load;
    assert.ok(entry, 'events.tier2_load must exist');
    assert.ok(Array.isArray(entry.line_range) && entry.line_range.length === 2,
      'line_range must be a [start,end] tuple');
    assert.ok(entry.line_range[0] >= 1, 'startLine must be >= 1');
    assert.ok(entry.line_range[1] >= entry.line_range[0], 'endLine must be >= startLine');
    assert.ok(typeof entry.short_doc === 'string' && entry.short_doc.length > 0,
      'short_doc must be a non-empty string');
    assert.match(entry.citation_anchor, /^agents\/pm-reference\/event-schemas\.md:\d+$/);
    assert.ok(entry.schema && Array.isArray(entry.schema.required) && entry.schema.required.length > 0,
      'schema.required must be a non-empty array');
  });

  test('sidecar size is in (4096, MAX_INDEX_BYTES]', () => {
    const cwd = makeTmpClone();
    const idx = buildIndex({ cwd });
    assert.ok(idx._meta.index_size_bytes > 4096,
      'index size must exceed 4 KB (otherwise something is parsing only a fraction of events)');
    assert.ok(idx._meta.index_size_bytes <= MAX_INDEX_BYTES,
      'index size must not exceed MAX_INDEX_BYTES');
  });

  test('_meta.source_hash matches sha256 of the source bytes', () => {
    const cwd = makeTmpClone();
    const idx = buildIndex({ cwd });
    const src = fs.readFileSync(path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md'), 'utf8');
    const expected = crypto.createHash('sha256').update(src).digest('hex');
    assert.equal(idx._meta.source_hash, expected);
  });

  test('_meta.event_count matches parsed event-type count and emits the sidecar to disk', () => {
    const cwd = makeTmpClone();
    const idx = buildIndex({ cwd });
    const slugs = Object.keys(idx.events);
    assert.equal(idx._meta.event_count, slugs.length);
    assert.ok(slugs.length >= 50, 'expected the live source to declare at least 50 event types');

    const sidecarPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.tier2-index.json');
    assert.ok(fs.existsSync(sidecarPath), 'sidecar file must be written to disk');
    const onDisk = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(onDisk._meta.event_count, idx._meta.event_count);
  });

  test('buildIndex is idempotent — same source produces identical _meta.source_hash', () => {
    const cwd = makeTmpClone();
    const a = buildIndex({ cwd });
    const b = buildIndex({ cwd });
    assert.equal(a._meta.source_hash, b._meta.source_hash);
    assert.equal(a._meta.event_count, b._meta.event_count);
    assert.equal(JSON.stringify(Object.keys(a.events).sort()),
                 JSON.stringify(Object.keys(b.events).sort()));
  });

  test('fingerprint contains one line per event_type', () => {
    const cwd = makeTmpClone();
    const idx = buildIndex({ cwd });
    const fpLines = idx.fingerprint.split('\n').filter(l => l && !l.startsWith('#'));
    assert.equal(fpLines.length, idx._meta.event_count,
      'fingerprint must have exactly one non-comment line per event');
    // Every entry slug must appear in the fingerprint
    for (const slug of Object.keys(idx.events)) {
      assert.ok(idx.fingerprint.includes(slug),
        'fingerprint must mention slug: ' + slug);
    }
  });
});
