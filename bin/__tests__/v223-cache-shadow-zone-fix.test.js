#!/usr/bin/env node
'use strict';

/**
 * v2.2.3 P0-2 — Cache-shadow zone-1 exclusion regression suite.
 *
 * Pre-fix bug: `agents/pm-reference/event-schemas.shadow.json` was folded
 * into the zone-1 invariant hash. Every release that added a new event
 * type regenerated the shadow, the hash drifted, and PreToolUse hook
 * emitted 38+ `cache_invariant_broken` events plus latched the
 * `.block-a-zone-caching-disabled` sentinel for 24h. Net cache savings
 * = 0 for 24h after every release.
 *
 * Fix: shadow content is excluded from the invariant hash. Cache prefix
 * still includes shadow content (compose-block-a.buildZone1 emits it),
 * but invariant tracking is decoupled. Shadow drift is surfaced via the
 * separate `cache_zone_shadow_regen_observed` event.
 *
 * What this suite asserts:
 *   1. Shadow regen alone does NOT change zone-1 invariant hash
 *      (regression guard for the original 38-event self-trip).
 *   2. CLAUDE.md drift DOES still change zone-1 hash (regression guard
 *      that the fix doesn't disable the invariant entirely).
 *   3. compose-block-a.buildZone1 hash matches
 *      validate-cache-invariant.recomputeZone1Hash output (consistency
 *      guard — if these diverge the validator self-trips on every
 *      compose).
 *   4. The new `cache_zone_shadow_regen_observed` event fires when the
 *      stored shadow hash differs from the recomputed one, but does NOT
 *      trip the invariant or write the sentinel.
 *   5. Sentinel is NOT written by a shadow-only regen even when prior
 *      violation count is non-zero (the threshold path must not be
 *      reachable via shadow drift alone).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VALIDATE_SCRIPT = path.join(REPO_ROOT, 'bin', 'validate-cache-invariant.js');

const validator    = require('../validate-cache-invariant.js');
const composeBlockA = require('../compose-block-a.js');

const ZONE1_SOURCES = [
  'CLAUDE.md',
  'agents/pm-reference/handoff-contract.md',
  'agents/pm-reference/phase-contract.md',
];

function makeRepo(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-shadow-zone-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });

  // Seed Zone 1 source files with deterministic content.
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\nseed-' + (opts.claudeSeed || 'A') + '\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'),
    '# handoff\nseed-' + (opts.handoffSeed || 'A') + '\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'phase-contract.md'),
    '# phase\nseed-' + (opts.phaseSeed || 'A') + '\n');

  // Seed config with auto-rebaseline enabled (default-on per project memory).
  const cfg = {
    block_a_zone_caching: { enabled: true, invariant_violation_threshold_24h: 5 },
    caching: {
      cache_invariant_validator: { auto_rebaseline_enabled: true },
    },
  };
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify(cfg, null, 2));

  return dir;
}

function writeShadow(dir, eventTypes) {
  const shadow = { _meta: { version: 1, source_hash: 'x'.repeat(64), generated_at: new Date().toISOString(), shadow_size_bytes: 0 } };
  for (const t of (eventTypes || ['agent_start', 'agent_stop'])) {
    shadow[t] = { version: 1, required: ['type'], optional: [], enum_dialect_hash: 'h' };
  }
  const out = path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
  fs.writeFileSync(out, JSON.stringify(shadow, null, 2));
  return shadow;
}

function seedZonesFile(dir, opts) {
  opts = opts || {};
  const { hash, fileHashes, shadowHash } = validator.recomputeZone1Hash(dir);
  const data = {
    zone1_hash:        opts.overrideHash || hash,
    zone2_hash:        'empty',
    updated_at:        new Date().toISOString(),
    zone1_file_hashes: fileHashes,
  };
  if (shadowHash && opts.includeShadow !== false) {
    data.zone1_shadow_hash = opts.overrideShadowHash || shadowHash;
  }
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'state', 'block-a-zones.json'),
    JSON.stringify(data, null, 2)
  );
  return data;
}

function runValidator(cwd) {
  return spawnSync('node', [VALIDATE_SCRIPT], {
    cwd: REPO_ROOT,
    input: JSON.stringify({ cwd, tool_name: 'Read', tool_input: {} }),
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

describe('v2.2.3 P0-2 — schema shadow excluded from zone-1 invariant', () => {
  test('shadow regen alone does NOT change zone-1 invariant hash', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_start', 'agent_stop']);
    const beforeHash = validator.recomputeZone1Hash(dir).hash;

    // Regen shadow with new event types — simulates a release that adds
    // R-DOCUMENTER-EVENT or R-ARCHETYPE-EVENT.
    writeShadow(dir, ['agent_start', 'agent_stop', 'new_event_type_v223']);
    const afterHash = validator.recomputeZone1Hash(dir).hash;

    assert.equal(beforeHash, afterHash,
      'zone-1 invariant hash MUST be stable across shadow regen');
  });

  test('CLAUDE.md drift DOES change zone-1 invariant hash (negative regression)', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_start']);
    const beforeHash = validator.recomputeZone1Hash(dir).hash;

    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\nMUTATED\n');
    const afterHash = validator.recomputeZone1Hash(dir).hash;

    assert.notEqual(beforeHash, afterHash,
      'invariant must still trip on a real Zone 1 source mutation');
  });

  test('compose-block-a.buildZone1 hash matches validator.recomputeZone1Hash', () => {
    // Consistency guard: if these diverge, every compose self-trips the
    // invariant on the next PreToolUse — that is exactly the bug v2.2.3 P0-2
    // fixes.
    const dir = makeRepo();
    writeShadow(dir, ['agent_start', 'agent_stop']);

    const fromCompose  = composeBlockA.buildZone1(dir);
    const fromValidate = validator.recomputeZone1Hash(dir);

    assert.equal(fromCompose.hash, fromValidate.hash,
      'compose and validator must agree on the invariant hash');
    assert.ok(fromCompose.shadowHash,
      'compose must surface shadowHash separately');
    assert.equal(fromCompose.shadowHash, fromValidate.shadowHash,
      'compose and validator must agree on shadowHash too');
  });

  test('shadow drift fires cache_zone_shadow_regen_observed without tripping invariant', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_start']);
    seedZonesFile(dir);

    // Regenerate shadow → its hash changes, zone-1 invariant hash does NOT.
    writeShadow(dir, ['agent_start', 'agent_stop', 'fresh_event']);

    const r = runValidator(dir);
    assert.equal(r.status, 0, 'validator must exit 0 (advisory); stderr=' + r.stderr);

    const events = readEvents(dir);
    const broken  = events.filter(e => e.type === 'cache_invariant_broken');
    const observed = events.filter(e => e.type === 'cache_zone_shadow_regen_observed');

    assert.equal(broken.length, 0,
      'shadow-only drift must NOT emit cache_invariant_broken');
    assert.equal(observed.length, 1,
      'shadow-only drift must emit exactly one cache_zone_shadow_regen_observed');
    assert.equal(observed[0].zone, 'zone1');
    assert.ok(observed[0].previous_shadow_hash, 'previous_shadow_hash present');
    assert.ok(observed[0].current_shadow_hash, 'current_shadow_hash present');
    assert.notEqual(observed[0].previous_shadow_hash, observed[0].current_shadow_hash);
  });

  test('shadow regen does NOT write .block-a-zone-caching-disabled sentinel', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_start']);
    seedZonesFile(dir);

    // Simulate prior violations being recorded by writing the JSONL
    // directly — pre-fix this would have been triggered by 5 shadow regens
    // and a sentinel would already exist. We test that with the fix in
    // place even one more shadow regen does not trip the validator and
    // write a sentinel.
    const violationsPath = path.join(dir, '.orchestray', 'state', 'block-a-zone-violations.jsonl');
    const lines = [];
    for (let i = 0; i < 4; i++) {
      lines.push(JSON.stringify({
        ts: new Date(Date.now() - (60 * 60 * 1000) * (i + 1)).toISOString(),
        expected_hash: 'a'.repeat(12),
        actual_hash:   String(i).repeat(12),
      }));
    }
    fs.writeFileSync(violationsPath, lines.join('\n') + '\n');

    writeShadow(dir, ['agent_start', 'agent_stop', 'newly_added_event']);

    const r = runValidator(dir);
    assert.equal(r.status, 0);

    const sentinelPath = path.join(dir, '.orchestray', 'state', '.block-a-zone-caching-disabled');
    assert.ok(!fs.existsSync(sentinelPath),
      'shadow regen must never write the cache-disable sentinel');
  });

  test('block-a-zones.json gains zone1_shadow_hash on stable invariant', () => {
    // After validator runs and zone-1 hash matches, it should opportunistically
    // refresh the persisted shadow hash so the next regen has a fresh baseline
    // for telemetry. This is additive — it does NOT touch zone1_hash.
    const dir = makeRepo();
    writeShadow(dir, ['agent_start']);
    const seeded = seedZonesFile(dir, { includeShadow: false });
    assert.equal(seeded.zone1_shadow_hash, undefined,
      'precondition: zones file starts without zone1_shadow_hash');

    const r = runValidator(dir);
    assert.equal(r.status, 0);

    const after = JSON.parse(fs.readFileSync(
      path.join(dir, '.orchestray', 'state', 'block-a-zones.json'), 'utf8'));
    assert.equal(after.zone1_hash, seeded.zone1_hash,
      'zone1_hash MUST be untouched by additive shadow refresh');
    assert.ok(typeof after.zone1_shadow_hash === 'string' && after.zone1_shadow_hash.length === 64,
      'zone1_shadow_hash must be persisted as 64-char hex');
  });

  test('shadow absent (file missing) — validator still treats invariant as stable', () => {
    // Older installs and tests may run without a shadow file. The validator
    // must not trip the invariant in that case.
    const dir = makeRepo();
    // Do NOT writeShadow — simulate older install or pre-shadow project.
    seedZonesFile(dir, { includeShadow: false });

    const r = runValidator(dir);
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const broken = events.filter(e => e.type === 'cache_invariant_broken');
    assert.equal(broken.length, 0,
      'missing shadow must not be treated as zone-1 violation');
  });
});
