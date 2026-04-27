#!/usr/bin/env node
'use strict';

/**
 * P2.1 manifest invariant (v2.2.0).
 *
 * Asserts validate-cache-invariant.js --manifest exit codes for the 4-slot
 * manifest invariant: well-formed manifest exits 0; malformed manifest emits
 * cache_invariant_broken[zone='manifest', reason=<...>] in advisory mode and
 * exits 0; in strict mode (caching.engineered_breakpoints.strict_invariant
 * === true), malformed manifest exits 2 EXCEPT manifest_missing which is
 * always advisory (legitimate first-turn-after-install case).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', 'validate-cache-invariant.js');

function makeRepo(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-invariant-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  // Minimal config — strict_invariant flag controlled by test
  const cfg = {
    block_a_zone_caching: { enabled: true, invariant_violation_threshold_24h: 5 },
    caching: {
      block_z: { enabled: true },
      engineered_breakpoints: {
        enabled: true,
        strict_invariant: opts.strictInvariant === true,
      },
    },
  };
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify(cfg, null, 2));
  return dir;
}

function writeManifest(cwd, manifest) {
  fs.writeFileSync(
    path.join(cwd, '.orchestray', 'state', 'cache-breakpoint-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

function makeWellFormedManifest() {
  const hex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return {
    slots: [
      { slot: 1, ttl: '1h', marker_byte_offset: 100, prefix_hash: hex64, prefix_token_estimate: 25 },
      { slot: 2, ttl: '1h', marker_byte_offset: 200, prefix_hash: hex64, prefix_token_estimate: 50 },
      { slot: 3, ttl: '5m', marker_byte_offset: 250, prefix_hash: hex64, prefix_token_estimate: 62 },
      { slot: 4, ttl: '5m', marker_byte_offset: 300, prefix_hash: hex64, prefix_token_estimate: 75 },
    ],
    total_bytes: 300,
    ttl_downgrade_applied: false,
    block_z_hash: 'a'.repeat(64),
    block_z_components: [],
    composed_at: new Date().toISOString(),
    error: null,
  };
}

function runManifestMode(cwd) {
  return spawnSync('node', [SCRIPT, '--manifest'], {
    cwd: REPO_ROOT,
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 8000,
  });
}

function readEvents(cwd) {
  const events = [];
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return events;
  const raw = fs.readFileSync(eventsPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (_e) {}
  }
  return events;
}

describe('P2.1 manifest invariant (validate-cache-invariant.js --manifest)', () => {
  test('well-formed manifest → exit 0, no cache_invariant_broken event', () => {
    const cwd = makeRepo();
    writeManifest(cwd, makeWellFormedManifest());
    const r = runManifestMode(cwd);
    assert.equal(r.status, 0, 'well-formed manifest must exit 0; stderr=' + r.stderr);
    const broken = readEvents(cwd).filter(e => e.type === 'cache_invariant_broken');
    assert.equal(broken.length, 0, 'no cache_invariant_broken expected');
  });

  test('manifest with 3 slots (slot_count_mismatch) → advisory exit 0 + event', () => {
    const cwd = makeRepo({ strictInvariant: false });
    const m = makeWellFormedManifest();
    m.slots = m.slots.slice(0, 3);
    writeManifest(cwd, m);
    const r = runManifestMode(cwd);
    assert.equal(r.status, 0, 'advisory mode must exit 0');
    const broken = readEvents(cwd).filter(e => e.type === 'cache_invariant_broken');
    assert.ok(broken.length >= 1);
    assert.equal(broken[0].zone, 'manifest');
    assert.equal(broken[0].reason, 'slot_count_mismatch');
  });

  test('strict mode + slot_count_mismatch → exit 2', () => {
    const cwd = makeRepo({ strictInvariant: true });
    const m = makeWellFormedManifest();
    m.slots = m.slots.slice(0, 3);
    writeManifest(cwd, m);
    const r = runManifestMode(cwd);
    assert.equal(r.status, 2, 'strict mode must exit 2 on malformed manifest');
  });

  test('non-monotonic offsets → reason=non_monotonic_offsets', () => {
    const cwd = makeRepo();
    const m = makeWellFormedManifest();
    m.slots[1].marker_byte_offset = 50; // less than slot 1's 100
    writeManifest(cwd, m);
    const r = runManifestMode(cwd);
    assert.equal(r.status, 0);
    const broken = readEvents(cwd).filter(e => e.type === 'cache_invariant_broken');
    assert.equal(broken[0].reason, 'non_monotonic_offsets');
  });

  test('invalid ttl (e.g. "15m") → reason=invalid_ttl', () => {
    const cwd = makeRepo();
    const m = makeWellFormedManifest();
    m.slots[0].ttl = '15m';
    writeManifest(cwd, m);
    const r = runManifestMode(cwd);
    assert.equal(r.status, 0);
    const broken = readEvents(cwd).filter(e => e.type === 'cache_invariant_broken');
    assert.equal(broken[0].reason, 'invalid_ttl');
  });

  test('missing manifest → reason=manifest_missing, ALWAYS advisory even in strict mode', () => {
    const cwd = makeRepo({ strictInvariant: true });
    // Do NOT write manifest
    const r = runManifestMode(cwd);
    assert.equal(r.status, 0, 'missing manifest must always be advisory exit 0');
    const broken = readEvents(cwd).filter(e => e.type === 'cache_invariant_broken');
    assert.equal(broken[0].reason, 'manifest_missing');
  });
});
