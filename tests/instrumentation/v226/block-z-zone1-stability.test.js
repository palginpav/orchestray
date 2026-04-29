#!/usr/bin/env node
'use strict';

/**
 * Block-Z zone1 stability regression test (v2.2.7).
 *
 * Root cause addressed: the zone1 hash stored in block-a-zones.json was
 * computed when the schema shadow was stale/disabled (shadow NOT included in
 * zone1). When the shadow later became non-stale, both compose-block-a.js and
 * validate-cache-invariant.js included it in the zone1 computation, producing
 * a different hash → violation → sentinel trip that silenced all Block-Z
 * telemetry for 24h and re-tripped immediately after expiry.
 *
 * Fix (regen-schema-shadow-hook.js): on every successful shadow regen, null
 * out zone1_hash in block-a-zones.json so compose-block-a.js re-pins with
 * the correct hash (including the new shadow) on the next UserPromptSubmit.
 *
 * This test asserts:
 *   T1. recomputeZone1Hash (validate-cache-invariant.js) and buildZone1
 *       (compose-block-a.js) produce the SAME hash for the same on-disk state —
 *       with shadow present and non-stale.
 *   T2. If zone1_hash was stored WITHOUT shadow (old state), validate-cache-invariant
 *       detects a mismatch when shadow is added later.
 *   T3. After regen-schema-shadow-hook's invalidateZone1Hash runs, the stored
 *       zone1_hash is null → validate-cache-invariant skips the check.
 *   T4. After compose-block-a re-pins (stores hash WITH shadow), validate-cache-invariant
 *       passes with no violation.
 *   T5. The pinned hash b6fdb3baeba9 (3-file, no shadow, \n\n join) is the
 *       expected value when shadow is stale/disabled — regression guard.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Import helpers under test
const { buildZone1, saveZoneHashes, isSentinelActive } =
  require(path.join(REPO_ROOT, 'bin', 'compose-block-a'));
const { recomputeZone1Hash } =
  // exported for test — added as part of this regression fix
  require(path.join(REPO_ROOT, 'bin', 'validate-cache-invariant'));

const VALIDATE_SCRIPT = path.join(REPO_ROOT, 'bin', 'validate-cache-invariant.js');

// ---------------------------------------------------------------------------
// Test repo factory
// ---------------------------------------------------------------------------

function makeTestRepo(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone1-stability-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });

  // Zone 1 source files (3 base files)
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
    '# CLAUDE.md test\n\nProject instructions here.\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'),
    '# Handoff Contract\n\nHandoff details.\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'phase-contract.md'),
    '# Phase Contract\n\nPhase details.\n');

  // Minimal config — caching enabled, threshold=5
  const cfg = {
    block_a_zone_caching: { enabled: true, invariant_violation_threshold_24h: 5 },
  };
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify(cfg, null, 2));

  // Schema shadow (simulated — non-stale when source hash matches)
  if (opts.includeShadow !== false) {
    const schemaContent = '## event_a\n\nSchema for event_a.\n\n## event_b\n\nSchema for event_b.\n';
    fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'), schemaContent);
    const sourceHash = crypto.createHash('sha256').update(schemaContent).digest('hex');
    const shadow = {
      _meta: { version: 1, source_hash: sourceHash, generated_at: new Date().toISOString(),
               shadow_size_bytes: 42, event_count: 2 },
      event_a: { description: 'event_a description', required: [] },
      event_b: { description: 'event_b description', required: [] },
    };
    fs.writeFileSync(
      path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
      JSON.stringify(shadow, null, 2)
    );

    if (opts.shadowStale) {
      // Make shadow stale by writing a different source_hash
      shadow._meta.source_hash = 'deadbeef'.repeat(8);
      fs.writeFileSync(
        path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
        JSON.stringify(shadow, null, 2)
      );
    }
  }

  return dir;
}

function computeZone1NoShadow(cwd) {
  const ZONE1_SOURCES = [
    'CLAUDE.md',
    'agents/pm-reference/handoff-contract.md',
    'agents/pm-reference/phase-contract.md',
  ];
  const parts = [];
  for (const relPath of ZONE1_SOURCES) {
    const text = fs.readFileSync(path.join(cwd, relPath), 'utf8');
    parts.push('<!-- zone1:file:' + relPath + ' -->\n' + text);
  }
  return crypto.createHash('sha256').update(parts.join('\n\n'), 'utf8').digest('hex');
}

function runValidator(cwd) {
  return spawnSync('node', [VALIDATE_SCRIPT], {
    cwd:      REPO_ROOT,
    input:    JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout:  8000,
  });
}

function readViolations(cwd) {
  const p = path.join(cwd, '.orchestray', 'state', 'block-a-zone-violations.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// T1: compose-block-a.buildZone1 and recomputeZone1Hash agree on the same state
// ---------------------------------------------------------------------------
describe('T1: buildZone1 and recomputeZone1Hash produce the same hash', () => {
  test('with shadow present and non-stale', () => {
    const cwd = makeTestRepo({ includeShadow: true, shadowStale: false });
    const zone1 = buildZone1(cwd);
    const { hash: recomputedHash } = recomputeZone1Hash(cwd);
    assert.equal(
      zone1.hash, recomputedHash,
      'compose and validator must agree on zone1 hash when shadow is non-stale'
    );
    assert.ok(zone1.fileHashes['agents/pm-reference/event-schemas.shadow.json'],
      'shadow key must be present in fileHashes when shadow is non-stale');
  });

  test('with shadow stale (excluded from both)', () => {
    const cwd = makeTestRepo({ includeShadow: true, shadowStale: true });
    const zone1 = buildZone1(cwd);
    const { hash: recomputedHash } = recomputeZone1Hash(cwd);
    assert.equal(zone1.hash, recomputedHash,
      'compose and validator must agree on zone1 hash when shadow is stale');
    assert.ok(!zone1.fileHashes['agents/pm-reference/event-schemas.shadow.json'],
      'shadow key must NOT be present when shadow is stale');
  });

  test('without shadow file (excluded from both)', () => {
    const cwd = makeTestRepo({ includeShadow: false });
    const zone1 = buildZone1(cwd);
    const { hash: recomputedHash } = recomputeZone1Hash(cwd);
    assert.equal(zone1.hash, recomputedHash,
      'compose and validator must agree on zone1 hash when shadow is absent');
  });
});

// ---------------------------------------------------------------------------
// T2: mismatch is detected when zone1_hash was stored without shadow and shadow appears
// ---------------------------------------------------------------------------
describe('T2: mismatch detected when zone1_hash stale (no-shadow → with-shadow transition)', () => {
  test('validator records violation when stored hash omits shadow that is now fresh', () => {
    const cwd = makeTestRepo({ includeShadow: true, shadowStale: false });

    // Store a zone1_hash computed WITHOUT shadow (simulates the old bug state)
    const hashNoShadow = computeZone1NoShadow(cwd);
    saveZoneHashes(cwd, hashNoShadow, 'empty', {
      'CLAUDE.md': crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, 'CLAUDE.md'))).digest('hex'),
      'agents/pm-reference/handoff-contract.md': crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(cwd, 'agents/pm-reference/handoff-contract.md'))).digest('hex'),
      'agents/pm-reference/phase-contract.md': crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(cwd, 'agents/pm-reference/phase-contract.md'))).digest('hex'),
      // NOTE: no shadow key — this is the old bug state
    });

    // Now run validator — should detect mismatch because recomputeZone1Hash includes shadow
    const result = runValidator(cwd);
    assert.equal(result.status, 0, 'validator must exit 0 (advisory)');
    const violations = readViolations(cwd);
    assert.ok(violations.length >= 1, 'at least one violation must be recorded: ' + JSON.stringify(violations));
    assert.equal(violations[0].expected_hash, hashNoShadow.substring(0, 12));
    assert.notEqual(violations[0].actual_hash, hashNoShadow.substring(0, 12),
      'actual hash must differ from stored (shadow was excluded)');
  });
});

// ---------------------------------------------------------------------------
// T3: validator skips check when zone1_hash is null (post-invalidation state)
// ---------------------------------------------------------------------------
describe('T3: validator skips when zone1_hash is null', () => {
  test('no violation recorded when zone1_hash is null', () => {
    const cwd = makeTestRepo({ includeShadow: true, shadowStale: false });
    saveZoneHashes(cwd, null, 'empty', null);

    const result = runValidator(cwd);
    assert.equal(result.status, 0, 'must exit 0');
    const violations = readViolations(cwd);
    assert.equal(violations.length, 0, 'no violations when zone1_hash is null');
  });
});

// ---------------------------------------------------------------------------
// T4: after compose-block-a re-pins (with shadow), validator passes with no violation
// ---------------------------------------------------------------------------
describe('T4: validator passes after compose-block-a re-pins with shadow', () => {
  test('no violation when zone1_hash was stored by buildZone1 with fresh shadow', () => {
    const cwd = makeTestRepo({ includeShadow: true, shadowStale: false });

    // Simulate compose-block-a storing zone1_hash WITH shadow
    const zone1 = buildZone1(cwd);
    saveZoneHashes(cwd, zone1.hash, 'empty', zone1.fileHashes);

    const result = runValidator(cwd);
    assert.equal(result.status, 0, 'validator must exit 0');
    const violations = readViolations(cwd);
    assert.equal(violations.length, 0, 'no violations after proper re-pin: ' + JSON.stringify(violations));
  });
});

// ---------------------------------------------------------------------------
// T5: the pinned expected hash b6fdb3baeba9 matches 3-file no-shadow computation
// (regression guard — if zone1 sources change, this test fails and reminds
// the developer to re-pin the expected hash in block-a-zones.json)
// ---------------------------------------------------------------------------
describe('T5: pinned hash b6fdb3baeba9 regression guard', () => {
  test('current zone1 sources (3 files, no shadow, \\n\\n join) hash to b6fdb3baeba9', () => {
    // This tests the PRODUCTION repo files. If CLAUDE.md, handoff-contract.md,
    // or phase-contract.md change, this test will fail, which is intentional:
    // the developer must run invalidate-block-a-zone1.js to clear the pin and let
    // compose-block-a.js re-pin on the next session.
    //
    // NOTE: the hash b6fdb3baeba9 is only valid when the schema-shadow sentinel
    // (.orchestray/state/.schema-shadow-disabled) is active (shadow disabled).
    // When shadow is enabled, the hash will be different and this test should be
    // updated or replaced with a test that computes and pins the new hash.
    const repoRoot = REPO_ROOT;
    const ZONE1_SOURCES = [
      'CLAUDE.md',
      'agents/pm-reference/handoff-contract.md',
      'agents/pm-reference/phase-contract.md',
    ];
    const shadowSentinel = path.join(repoRoot, '.orchestray', 'state', '.schema-shadow-disabled');
    const shadowDisabled = fs.existsSync(shadowSentinel);

    if (shadowDisabled) {
      // Shadow is disabled — verify the 3-file hash matches the historically-pinned value
      const parts = [];
      for (const relPath of ZONE1_SOURCES) {
        const text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
        parts.push('<!-- zone1:file:' + relPath + ' -->\n' + text);
      }
      const hash = crypto.createHash('sha256').update(parts.join('\n\n'), 'utf8').digest('hex');
      assert.equal(
        hash.substring(0, 12), 'b6fdb3baeba9',
        'Zone1 3-file hash must match pinned value b6fdb3baeba9. ' +
        'If this fails, CLAUDE.md or a zone1 source file was edited. ' +
        'Run: node bin/invalidate-block-a-zone1.js to re-pin.'
      );
    } else {
      // Shadow is enabled — verify that buildZone1 and recomputeZone1Hash agree
      // (we cannot assert a specific 12-char prefix since it depends on shadow content)
      const zone1 = buildZone1(repoRoot);
      const { hash: recomputedHash } = recomputeZone1Hash(repoRoot);
      assert.equal(zone1.hash, recomputedHash,
        'When shadow is enabled, buildZone1 and recomputeZone1Hash must agree');
    }
  });
});
