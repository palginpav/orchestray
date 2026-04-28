#!/usr/bin/env node
'use strict';

/**
 * block-z-cli-regen-invalidates.test.js — CLI regen zone1 invalidation test (v2.2.7).
 *
 * Root cause: bin/regen-schema-shadow.js (the CLI path invoked during installs,
 * releases, and CI) did NOT call invalidateZone1Hash after regenerating the
 * shadow, so block-a-zones.json.zone1_hash remained stale.  On the next session
 * start, compose-block-a.js rebuilt zone1 WITH the fresh shadow → hash mismatch
 * → violation recorded → 24-hour quarantine sentinel tripped → Block-Z silenced.
 *
 * Fix (v2.2.7 W2): regen-schema-shadow.js now calls invalidateZone1Hash from
 * bin/_lib/invalidate-block-a-zone1.js after every successful regen.
 *
 * Tests:
 *   T1. After CLI regen, zone1_hash in block-a-zones.json is null.
 *   T2. Idempotency: second CLI regen leaves zone1_hash still null.
 *   T3. If block-a-zones.json has no zone1_hash (already null), regen still
 *       succeeds and zone1_hash remains null (no-op invalidation path).
 *   T4. If block-a-zones.json does not exist, regen still succeeds (fail-open).
 */

const { test, describe } = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const os        = require('node:os');
const path      = require('node:path');
const crypto    = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..', '..');
const REGEN_CLI   = path.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js');

// ---------------------------------------------------------------------------
// Minimal test repo factory
// ---------------------------------------------------------------------------

function makeTestRepo(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-cli-z1-'));

  // Required directory layout
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });

  // Minimal event-schemas.md that the parser can handle
  // Minimal event-schemas.md that the parser can handle.
  // The parser (bin/_lib/event-schemas-parser.js) walks level-3 headings
  // matching /^### [`]?([a-z][a-z0-9_.-]*)/ and extracts the first ```json
  // fence. The "type" field in the fence is the event slug.
  const schemaContent = [
    '## Section 1: Test Events',
    '',
    '### `agent_start` event',
    '',
    '```json',
    '{ "type": "agent_start", "version": 1, "required": ["orchestration_id"], "optional": ["label"] }',
    '```',
    '',
    '### `agent_stop` event',
    '',
    '```json',
    '{ "type": "agent_stop", "version": 1, "required": ["orchestration_id"], "optional": [] }',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'),
    schemaContent
  );

  // Minimal config (not required for regen, but keeps future hooks happy)
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({ block_a_zone_caching: { enabled: true } }, null, 2)
  );

  if (opts.withStaleHash) {
    // Seed block-a-zones.json with a known non-null zone1_hash to simulate
    // the pre-fix state where CLI regen left the stored hash stale.
    const zones = {
      zone1_hash: 'aabbccdd1122334455667788aabbccdd1122334455667788aabbccdd11223344',
      zone1_file_hashes: { 'CLAUDE.md': 'deadbeef' },
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'block-a-zones.json'),
      JSON.stringify(zones, null, 2) + '\n'
    );
  }

  if (opts.withNullHash) {
    // block-a-zones.json exists but zone1_hash is already null
    const zones = {
      zone1_hash: null,
      zone1_file_hashes: null,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'block-a-zones.json'),
      JSON.stringify(zones, null, 2) + '\n'
    );
  }

  // opts.noZonesFile — leave block-a-zones.json absent (default when neither flag set)

  return dir;
}

function runRegenCli(cwd) {
  return spawnSync('node', [REGEN_CLI, '--cwd', cwd], {
    cwd:      REPO_ROOT,
    encoding: 'utf8',
    timeout:  10000,
  });
}

function readZonesFile(cwd) {
  const p = path.join(cwd, '.orchestray', 'state', 'block-a-zones.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// T1: stale hash is cleared after CLI regen
// ---------------------------------------------------------------------------
describe('T1: CLI regen invalidates stale zone1_hash', () => {
  test('zone1_hash is null after successful regen (was non-null before)', () => {
    const cwd = makeTestRepo({ withStaleHash: true });

    // Pre-condition: zones file has a non-null hash
    const before = readZonesFile(cwd);
    assert.ok(before && before.zone1_hash, 'pre-condition: zone1_hash must be non-null');

    const result = runRegenCli(cwd);
    assert.equal(result.status, 0,
      'CLI regen must exit 0; stderr: ' + result.stderr);

    // Post-condition: zone1_hash must be null
    const after = readZonesFile(cwd);
    assert.ok(after, 'block-a-zones.json must still exist after regen');
    assert.strictEqual(after.zone1_hash, null,
      'zone1_hash must be null after CLI regen');
  });
});

// ---------------------------------------------------------------------------
// T2: idempotency — second run leaves zone1_hash still null
// ---------------------------------------------------------------------------
describe('T2: idempotency — second CLI regen leaves zone1_hash null', () => {
  test('running regen twice yields null zone1_hash on both runs', () => {
    const cwd = makeTestRepo({ withStaleHash: true });

    const r1 = runRegenCli(cwd);
    assert.equal(r1.status, 0, 'first regen must exit 0');
    const after1 = readZonesFile(cwd);
    assert.strictEqual(after1.zone1_hash, null,
      'zone1_hash must be null after first regen');

    const r2 = runRegenCli(cwd);
    assert.equal(r2.status, 0, 'second regen must exit 0');
    const after2 = readZonesFile(cwd);
    assert.strictEqual(after2.zone1_hash, null,
      'zone1_hash must still be null after second regen');
  });
});

// ---------------------------------------------------------------------------
// T3: no-op when zone1_hash is already null
// ---------------------------------------------------------------------------
describe('T3: no-op when zone1_hash already null', () => {
  test('regen succeeds and zone1_hash stays null when it was already null', () => {
    const cwd = makeTestRepo({ withNullHash: true });

    const result = runRegenCli(cwd);
    assert.equal(result.status, 0,
      'CLI regen must exit 0 even when zone1_hash was already null; stderr: ' + result.stderr);

    const after = readZonesFile(cwd);
    assert.ok(after, 'block-a-zones.json must still exist');
    assert.strictEqual(after.zone1_hash, null,
      'zone1_hash must remain null');
  });
});

// ---------------------------------------------------------------------------
// T4: fail-open — block-a-zones.json absent
// ---------------------------------------------------------------------------
describe('T4: fail-open when block-a-zones.json is absent', () => {
  test('regen succeeds even when block-a-zones.json does not exist', () => {
    // makeTestRepo with no zone options — no zones file
    const cwd = makeTestRepo({});

    assert.ok(!readZonesFile(cwd), 'pre-condition: no zones file');

    const result = runRegenCli(cwd);
    assert.equal(result.status, 0,
      'CLI regen must exit 0 when zones file is absent; stderr: ' + result.stderr);

    // Zones file should still not exist (no hash was there to clear)
    assert.ok(!readZonesFile(cwd), 'zones file must remain absent (nothing to create)');
  });
});
