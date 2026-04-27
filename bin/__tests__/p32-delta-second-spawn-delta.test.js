#!/usr/bin/env node
'use strict';

/**
 * P3.2 second-spawn (delta) behaviour (v2.2.0).
 *
 * Asserts the delta path: same static portion across spawns produces a
 * hash-anchored delta block instead of re-emitting the full prompt.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const pathMod = require('node:path');

const REPO_ROOT = pathMod.resolve(__dirname, '..', '..');
const { computeDelta, __resetCache } = require(pathMod.join(REPO_ROOT, 'bin', '_lib', 'spawn-context-delta.js'));
const {
  buildManifest,
  registerOpportunisticArtifact,
  drainOpportunisticArtifacts,
  __resetOpportunisticQueue,
} = require(pathMod.join(REPO_ROOT, 'bin', '_lib', 'cache-breakpoint-manifest.js'));

function makeTmpRoot() {
  return fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p32-second-spawn-'));
}

// Realistic static body: in production this is many KB (handoff contract,
// rubric format, exploration discipline, repo map). Keep this large enough
// that the delta block's fixed-overhead anchor comments (~250 bytes) remain
// smaller than the avoided prefix.
const STATIC_BODY = (
  '## Handoff Contract\nfollow contract.md\n\n' +
  '## Pre-Flight\n- read repo map\n- list files\n\n' +
  '## Repo Map\n' + ('[entry]\n'.repeat(40)) +
  '## Exploration Discipline\n' + ('check existing patterns; cite sources.\n'.repeat(20))
);
const PER_SPAWN_V1 = '## Task\nimplement feature X\n';
const PER_SPAWN_V2 = '## Task\nfix feature Y\n## Files\n- src/foo.ts\n';

function buildPrompt(staticBody, perSpawnBody) {
  return (
    '<!-- delta:static-begin -->\n' +
    staticBody +
    '\n<!-- delta:static-end -->\n' +
    '<!-- delta:per-spawn-begin -->\n' +
    perSpawnBody +
    '\n<!-- delta:per-spawn-end -->'
  );
}

describe('P3.2 second spawn returns delta when static portion unchanged', () => {
  test('full → delta transition, hash stable, full_bytes_avoided > 0, delta < prefix', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const promptV1 = buildPrompt(STATIC_BODY, PER_SPAWN_V1);
    const promptV2 = buildPrompt(STATIC_BODY, PER_SPAWN_V2);

    const r1 = computeDelta(promptV1, { orchestration_id: 'orch-B', agent_type: 'developer', cwd });
    assert.equal(r1.type, 'full');

    const r2 = computeDelta(promptV2, { orchestration_id: 'orch-B', agent_type: 'developer', cwd });
    assert.equal(r2.type, 'delta', 'second spawn with same static portion must be delta');
    assert.equal(r2.reason, null, 'happy delta path has reason=null');
    assert.equal(r2.prefix_hash, r1.prefix_hash, 'delta hash matches first spawn hash');

    assert.ok(r2.delta_text.startsWith('<!-- delta:reference prefix_hash="'),
      'delta_text must lead with the machine-readable anchor comment');
    assert.ok(r2.delta_text.includes(PER_SPAWN_V2),
      'delta_text contains the per-spawn portion of promptV2');
    assert.ok(r2.delta_text.includes('<!-- delta:per-spawn-begin -->'),
      'delta_text contains the per-spawn-begin marker');
    assert.ok(r2.delta_text.endsWith('<!-- delta:per-spawn-end -->'),
      'delta_text ends with the per-spawn-end marker');
    assert.ok(!r2.delta_text.includes(STATIC_BODY),
      'delta_text excludes the static portion');

    assert.equal(r2.full_bytes_avoided, r1.prefix_bytes, 'full_bytes_avoided equals the prefix bytes');
    assert.ok(r2.full_bytes_avoided > 0, 'savings must be positive');
    assert.ok(r2.delta_bytes < r2.prefix_bytes, 'delta payload smaller than the avoided prefix');
  });

  test('different agent_type on same orch starts fresh — type=full', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const promptV1 = buildPrompt(STATIC_BODY, PER_SPAWN_V1);
    computeDelta(promptV1, { orchestration_id: 'orch-B', agent_type: 'developer', cwd });
    const r = computeDelta(promptV1, { orchestration_id: 'orch-B', agent_type: 'reviewer', cwd });
    assert.equal(r.type, 'full');
    assert.equal(r.reason, 'first_spawn',
      'different agent_type on same orch is a fresh first_spawn');
  });

  test('Slot-4 dormant branch flipped: artifact-aware offset placed BEFORE the largest artifact', () => {
    __resetOpportunisticQueue();
    // Build a manifest with a registered artifact via the buildManifest API
    // path. The artifact's bytes drive slot4 marker_byte_offset OFF total_bytes.
    const blockZ = { text: 'Z'.repeat(50), hash: 'z', error: null };
    const zone1  = { content: 'A'.repeat(80), hash: 'a', bytes: 80 };
    const zone2  = { content: 'B'.repeat(40), hash: 'b', bytes: 40 };
    const zone3  = { content: 'C'.repeat(120), bytes: 120 };

    const m = buildManifest({
      blockZ, zone1, zone2, zone3,
      opportunisticArtifacts: [{ path: 'foo.txt', bytes: 30 }, { path: 'bar.txt', bytes: 100 }],
    });
    assert.equal(m.error, null);
    const slot4 = m.slots.find(s => s.slot === 4);
    assert.ok(slot4, 'manifest has a slot 4');
    assert.ok(slot4.marker_byte_offset !== m.total_bytes,
      'slot4 marker_byte_offset must NOT equal total_bytes when an artifact is registered');
    assert.equal(slot4.marker_byte_offset, m.total_bytes - 100,
      'slot4 marker_byte_offset = total_bytes - largest_artifact.bytes');
  });

  test('registerOpportunisticArtifact + drainOpportunisticArtifacts round-trip', () => {
    __resetOpportunisticQueue();
    registerOpportunisticArtifact({ slot: 4, path: 'p.txt', bytes: 100, prefix_hash: 'h', orchestration_id: 'orch-Q' });
    registerOpportunisticArtifact({ slot: 4, path: 'q.txt', bytes: 200, prefix_hash: 'h2', orchestration_id: 'orch-Q' });
    const drained = drainOpportunisticArtifacts('orch-Q');
    assert.equal(drained.length, 2);
    assert.equal(drained[0].bytes, 100);
    assert.equal(drained[1].bytes, 200);
    // Drain is destructive
    const second = drainOpportunisticArtifacts('orch-Q');
    assert.equal(second.length, 0, 'second drain must be empty');

    // Wrong slot is rejected
    registerOpportunisticArtifact({ slot: 3, path: 'x.txt', bytes: 1, orchestration_id: 'orch-Q' });
    const post = drainOpportunisticArtifacts('orch-Q');
    assert.equal(post.length, 0, 'slot != 4 rejected');
  });
});
