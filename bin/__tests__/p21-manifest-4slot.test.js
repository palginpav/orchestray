#!/usr/bin/env node
'use strict';

/**
 * P2.1 manifest shape (v2.2.0).
 *
 * Asserts buildManifest returns exactly 4 slots with monotonic offsets, the
 * slot.slot values are 1..4, every prefix_hash is 64-char hex, and the
 * degenerate Slot 4 anchors at total_bytes when no opportunisticArtifacts are
 * supplied.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildManifest } = require(path.join(REPO_ROOT, 'bin', '_lib', 'cache-breakpoint-manifest.js'));

function fakeBlockZ() {
  // Pretend buildBlockZ returned this — text length matters for byte offsets.
  const text = '<!-- block-z:component:agents/pm.md -->\nbody\n<!-- block-z:sha256=' + 'a'.repeat(64) + ' -->';
  return {
    text,
    hash: 'a'.repeat(64),
    components: [{ name: 'agents/pm.md', sha: 'a'.repeat(64), byte_offset: 0 }],
    error: null,
  };
}

function fakeZone(content) {
  return {
    content,
    hash: content ? 'b'.repeat(64) : 'empty',
    bytes: Buffer.byteLength(content || '', 'utf8'),
  };
}

describe('P2.1 buildManifest 4-slot shape', () => {
  test('returns exactly 4 slots with monotonic offsets when Block-Z is healthy', () => {
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1 content'),
      zone2:  fakeZone('zone2 content'),
      zone3:  fakeZone('zone3 content'),
      pmProtocol: { estimated_orch_duration_minutes: 60 },
      opportunisticArtifacts: [],
    });
    assert.equal(m.error, null);
    assert.equal(m.slots.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(m.slots[i].slot, i + 1);
    }
    for (let i = 1; i < 4; i++) {
      assert.ok(m.slots[i].marker_byte_offset >= m.slots[i - 1].marker_byte_offset,
        'offsets must be monotonically non-decreasing at slot ' + i);
    }
  });

  test('every prefix_hash is a 64-char hex string', () => {
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone('zone2'),
      zone3:  fakeZone('zone3'),
    });
    for (const s of m.slots) {
      assert.match(s.prefix_hash, /^[0-9a-f]{64}$/);
      assert.ok(typeof s.prefix_token_estimate === 'number' && s.prefix_token_estimate >= 0);
    }
  });

  test('Slot 4 is degenerate (offset === total_bytes) when no opportunistic artifacts', () => {
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone('zone2'),
      zone3:  fakeZone('zone3'),
      opportunisticArtifacts: [],
    });
    assert.equal(m.slots[3].marker_byte_offset, m.total_bytes);
  });

  test('Block-Z error → manifest fail-soft (slots: [], error: block_z_missing)', () => {
    const m = buildManifest({
      blockZ: { text: '', hash: null, components: [], error: 'missing_input' },
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone('zone2'),
      zone3:  fakeZone('zone3'),
    });
    assert.equal(m.error, 'block_z_missing');
    assert.deepEqual(m.slots, []);
  });

  test('zone2 absent: slot offsets remain monotonic (slot 2 == end of zone1)', () => {
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone(''),
      zone3:  fakeZone('zone3'),
    });
    assert.equal(m.slots.length, 4);
    for (let i = 1; i < 4; i++) {
      assert.ok(m.slots[i].marker_byte_offset >= m.slots[i - 1].marker_byte_offset);
    }
  });
});
