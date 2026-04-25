#!/usr/bin/env node
'use strict';

/**
 * Regression test: R-PIN Block A zone-pinned caching (v2.1.14).
 *
 * AC verified:
 *   AC1 — compose-block-a.js produces additionalContext with 3 zones in correct order
 *   AC2 — Zone 1 hash is stable when source files don't change
 *   AC3 — Zone 1 hash CHANGES when CLAUDE.md is edited
 *   AC4 — validate-cache-invariant.js detects Zone 1 mutation and emits cache_invariant_broken
 *   AC5 — validate-cache-invariant.js does NOT block (exit 0 always)
 *   AC6 — 5 violations in 24h triggers auto-disable sentinel
 *   AC7 — invalidate-block-a-zone1.js clears the recorded hash and emits block_a_zone1_invalidated
 *   AC8 — schema-shadow content included in Zone 1 when present, omitted gracefully when absent
 *   AC9 — kill switch (config.block_a_zone_caching.enabled=false) makes compose hook a no-op
 *   AC10 — kill switch (ORCHESTRAY_DISABLE_BLOCK_A_ZONES=1) makes compose hook a no-op
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const COMPOSE_SCRIPT    = path.resolve(__dirname, '../../bin/compose-block-a.js');
const VALIDATOR_SCRIPT  = path.resolve(__dirname, '../../bin/validate-cache-invariant.js');
const INVALIDATE_SCRIPT = path.resolve(__dirname, '../../bin/invalidate-block-a-zone1.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Test directory factory
// ---------------------------------------------------------------------------

function makeDir({
  orchId    = 'orch-r-pin-test',
  config    = null,
  claudeMd  = '# Project Instructions\n\nThis is CLAUDE.md content.',
  shadow    = null,
  withOrch  = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-pin-'));
  cleanup.push(dir);

  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pmRefDir, { recursive: true });

  // Write CLAUDE.md
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf8');

  // Write handoff-contract.md
  fs.writeFileSync(
    path.join(pmRefDir, 'handoff-contract.md'),
    '# Handoff Contract\n\nHandoff contract content.',
    'utf8'
  );

  // Write current-orchestration.json
  if (withOrch) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId, goal: 'Test goal', constraints: [] }),
      'utf8'
    );
  }

  // Write config
  if (config !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(config),
      'utf8'
    );
  }

  // Write shadow file
  if (shadow !== null) {
    fs.writeFileSync(
      path.join(pmRefDir, 'event-schemas.shadow.json'),
      JSON.stringify(shadow),
      'utf8'
    );
    // Write a matching event-schemas.md (needed for hash check in loadShadowWithCheck)
    const schemaContent = '# Event Schemas\n\ndummy content for hash';
    fs.writeFileSync(
      path.join(pmRefDir, 'event-schemas.md'),
      schemaContent,
      'utf8'
    );
    // Write the correct source_hash in the shadow (plain hex, no prefix — matches computeSourceHash)
    const crypto = require('node:crypto');
    const hash = crypto.createHash('sha256').update(schemaContent).digest('hex');
    const withHash = Object.assign({}, shadow, { _meta: Object.assign({}, shadow._meta, { source_hash: hash }) });
    fs.writeFileSync(
      path.join(pmRefDir, 'event-schemas.shadow.json'),
      JSON.stringify(withHash),
      'utf8'
    );
  }

  return dir;
}

function runCompose(dir, env = {}) {
  return spawnSync(process.execPath, [COMPOSE_SCRIPT], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env),
  });
}

function runValidator(dir, env = {}) {
  return spawnSync(process.execPath, [VALIDATOR_SCRIPT], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env),
  });
}

function runInvalidate(dir, reason, env = {}) {
  const args = reason ? [INVALIDATE_SCRIPT, reason] : [INVALIDATE_SCRIPT];
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, { ORCHESTRAY_CWD: dir }, env),
  });
}

function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

function readZones(dir) {
  const zonesPath = path.join(dir, '.orchestray', 'state', 'block-a-zones.json');
  if (!fs.existsSync(zonesPath)) return null;
  try { return JSON.parse(fs.readFileSync(zonesPath, 'utf8')); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// AC1 — compose produces 3 zones in correct order
// ---------------------------------------------------------------------------

describe('AC1 — compose-block-a.js zone structure', () => {
  test('produces additionalContext with zone markers in order', () => {
    const dir = makeDir();
    const result = runCompose(dir);
    assert.equal(result.status, 0, 'hook must exit 0');

    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput, 'must have hookSpecificOutput');
    assert.ok(output.hookSpecificOutput.additionalContext, 'must have additionalContext');

    const ctx = output.hookSpecificOutput.additionalContext;
    const z1pos = ctx.indexOf('<block-a-zone-1');
    const z2pos = ctx.indexOf('<block-a-zone-2');
    const z3pos = ctx.indexOf('<block-a-zone-3');

    assert.ok(z1pos >= 0, 'Zone 1 marker must be present');
    assert.ok(z3pos >= 0, 'Zone 3 marker must be present');
    assert.ok(z1pos < z3pos, 'Zone 1 must come before Zone 3');
    if (z2pos >= 0) {
      assert.ok(z1pos < z2pos, 'Zone 1 must come before Zone 2');
      assert.ok(z2pos < z3pos, 'Zone 2 must come before Zone 3');
    }
  });

  test('Zone 1 contains CLAUDE.md content', () => {
    const dir = makeDir({ claudeMd: '# My Project\n\nCustom instructions here.' });
    const result = runCompose(dir);
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    // Zone 1 section
    const z1start = ctx.indexOf('<block-a-zone-1');
    const z1end   = ctx.indexOf('</block-a-zone-1>');
    assert.ok(z1start >= 0 && z1end > z1start, 'Zone 1 delimiters must be present');
    const zone1   = ctx.substring(z1start, z1end);
    assert.ok(zone1.includes('My Project'), 'CLAUDE.md content must appear in Zone 1');
  });

  test('block_a_zone_composed audit event is emitted', () => {
    const dir    = makeDir();
    runCompose(dir);
    const events = readEvents(dir);
    const ev     = events.find(e => e && e.type === 'block_a_zone_composed');
    assert.ok(ev, 'block_a_zone_composed event must be emitted');
    assert.equal(ev.version, 1, 'version must be 1');
    assert.ok(typeof ev.zone1_hash === 'string' && ev.zone1_hash.length > 0, 'zone1_hash must be non-empty');
    assert.ok(typeof ev.zone3_bytes === 'number', 'zone3_bytes must be a number');
    assert.equal(ev.cache_breakpoints, 3, 'cache_breakpoints must be 3');
  });

  test('zones file is written with zone1_hash and zone2_hash', () => {
    const dir = makeDir();
    runCompose(dir);
    const zones = readZones(dir);
    assert.ok(zones, 'block-a-zones.json must be created');
    assert.ok(typeof zones.zone1_hash === 'string', 'zone1_hash must be stored');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Zone 1 hash stable when source files unchanged
// ---------------------------------------------------------------------------

describe('AC2 — Zone 1 hash stability', () => {
  test('same zone1_hash on two consecutive runs without file changes', () => {
    const dir = makeDir();
    runCompose(dir);
    const zones1 = readZones(dir);

    runCompose(dir);
    const zones2 = readZones(dir);

    assert.equal(zones1.zone1_hash, zones2.zone1_hash, 'Zone 1 hash must be stable');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Zone 1 hash changes when CLAUDE.md is edited
// ---------------------------------------------------------------------------

describe('AC3 — Zone 1 hash changes on CLAUDE.md edit', () => {
  test('zone1_hash differs after CLAUDE.md is modified', () => {
    const dir = makeDir({ claudeMd: '# Original content' });
    runCompose(dir);
    const zones1 = readZones(dir);
    const hash1  = zones1.zone1_hash;

    // Edit CLAUDE.md
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# MODIFIED content — different!', 'utf8');

    runCompose(dir);
    const zones2 = readZones(dir);
    const hash2  = zones2.zone1_hash;

    assert.notEqual(hash1, hash2, 'Zone 1 hash must change after CLAUDE.md edit');
  });
});

// ---------------------------------------------------------------------------
// AC4 — Validator detects Zone 1 mutation and emits cache_invariant_broken
// ---------------------------------------------------------------------------

describe('AC4 — Validator detects Zone 1 mutation', () => {
  test('emits cache_invariant_broken when CLAUDE.md changes after compose', () => {
    const dir = makeDir({ claudeMd: '# Original content' });
    // First compose sets the baseline
    runCompose(dir);

    // Edit CLAUDE.md without invalidating
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# MUTATED content!!', 'utf8');

    // Validator should detect the mutation
    const result = runValidator(dir);
    assert.equal(result.status, 0, 'validator must exit 0 (advisory)');

    const events = readEvents(dir);
    const ev = events.find(e => e && e.type === 'cache_invariant_broken');
    assert.ok(ev, 'cache_invariant_broken event must be emitted');
    assert.equal(ev.version, 1, 'version must be 1');
    assert.equal(ev.zone, 'zone1', 'zone must be zone1');
    assert.ok(typeof ev.expected_hash === 'string', 'expected_hash must be present');
    assert.ok(typeof ev.actual_hash   === 'string', 'actual_hash must be present');
    assert.notEqual(ev.expected_hash, ev.actual_hash, 'hashes must differ');
    assert.ok(Array.isArray(ev.delta_files), 'delta_files must be an array');
  });
});

// ---------------------------------------------------------------------------
// AC5 — Validator does NOT block (exit 0)
// ---------------------------------------------------------------------------

describe('AC5 — Validator is advisory only (exit 0)', () => {
  test('exits 0 even when Zone 1 mutation is detected', () => {
    const dir = makeDir();
    runCompose(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Different content', 'utf8');

    const result = runValidator(dir);
    assert.equal(result.status, 0, 'validator MUST exit 0 — it must never block');
  });

  test('exits 0 when no baseline exists yet', () => {
    const dir = makeDir();
    // No compose run — no zones file
    const result = runValidator(dir);
    assert.equal(result.status, 0, 'validator must exit 0 when no baseline');
  });
});

// ---------------------------------------------------------------------------
// AC6 — 5 violations in 24h triggers auto-disable sentinel
// ---------------------------------------------------------------------------

describe('AC6 — Auto-disable sentinel after 5 violations', () => {
  test('sentinel written after invariant_violation_threshold_24h violations', () => {
    const dir = makeDir({
      config: { block_a_zone_caching: { invariant_violation_threshold_24h: 3 } },
    });
    runCompose(dir);

    // Trigger 3 violations
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mutation #' + i, 'utf8');
      runValidator(dir);
      // Reset CLAUDE.md to original but keep zones file stale
    }

    const sentinelPath = path.join(dir, '.orchestray', 'state', '.block-a-zone-caching-disabled');
    assert.ok(fs.existsSync(sentinelPath), 'auto-disable sentinel must be written after threshold violations');
  });

  test('compose hook is no-op when sentinel exists', () => {
    const dir = makeDir();
    // Write sentinel manually
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.block-a-zone-caching-disabled'), 'disabled\n', 'utf8');

    const result = runCompose(dir);
    assert.equal(result.status, 0, 'must exit 0');
    // Should produce CONTINUE_RESPONSE (no additionalContext)
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch (_) { parsed = null; }
    const hasAdditional = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
    assert.ok(!hasAdditional, 'compose must be no-op (no additionalContext) when sentinel active');
  });
});

// ---------------------------------------------------------------------------
// AC7 — invalidate-block-a-zone1.js clears hash and emits event
// ---------------------------------------------------------------------------

describe('AC7 — invalidate-block-a-zone1.js', () => {
  test('clears zone1_hash in zones file', () => {
    const dir = makeDir();
    runCompose(dir);

    const zonesBefore = readZones(dir);
    assert.ok(zonesBefore && zonesBefore.zone1_hash, 'zone1_hash must exist before invalidation');

    runInvalidate(dir, 'test invalidation');

    const zonesAfter = readZones(dir);
    assert.ok(zonesAfter, 'zones file must still exist');
    assert.equal(zonesAfter.zone1_hash, null, 'zone1_hash must be null after invalidation');
  });

  test('emits block_a_zone1_invalidated audit event', () => {
    const dir = makeDir();
    runCompose(dir);

    runInvalidate(dir, 'user edited CLAUDE.md');

    const events = readEvents(dir);
    const ev = events.find(e => e && e.type === 'block_a_zone1_invalidated');
    assert.ok(ev, 'block_a_zone1_invalidated event must be emitted');
    assert.equal(ev.version, 1, 'version must be 1');
    assert.equal(ev.reason, 'user edited CLAUDE.md', 'reason must be preserved');
    assert.ok(typeof ev.prior_hash === 'string', 'prior_hash must be present');
  });

  test('clears auto-disable sentinel when present', () => {
    const dir      = makeDir();
    runCompose(dir);

    // Write sentinel
    const stateDir     = path.join(dir, '.orchestray', 'state');
    const sentinelPath = path.join(stateDir, '.block-a-zone-caching-disabled');
    fs.writeFileSync(sentinelPath, 'disabled\n', 'utf8');

    runInvalidate(dir, 'manual re-enable');

    assert.ok(!fs.existsSync(sentinelPath), 'sentinel must be removed by invalidate script');

    const events = readEvents(dir);
    const ev = events.find(e => e && e.type === 'block_a_zone1_invalidated');
    assert.ok(ev && ev.sentinel_cleared === true, 'sentinel_cleared must be true in event');
  });

  test('exits 0 and reports no-op when no zones file exists', () => {
    const dir    = makeDir();
    // Don't run compose — no zones file
    const result = runInvalidate(dir, 'no prior state');
    assert.equal(result.status, 0, 'must exit 0 when nothing to invalidate');
    assert.ok(result.stdout.includes('nothing to clear'), 'must report nothing to clear');
  });
});

// ---------------------------------------------------------------------------
// AC8 — Schema-shadow content included in Zone 1 when present
// ---------------------------------------------------------------------------

describe('AC8 — Schema shadow in Zone 1', () => {
  test('Zone 1 includes schema shadow content when shadow file present', () => {
    const shadow = {
      _meta: { version: 1 },
      test_event: { version: 1, required: ['type'], optional: [] },
    };
    const dir = makeDir({ shadow });
    const result = runCompose(dir);
    assert.equal(result.status, 0);

    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const z1start = ctx.indexOf('<block-a-zone-1');
    const z1end   = ctx.indexOf('</block-a-zone-1>');
    const zone1   = ctx.substring(z1start, z1end);

    assert.ok(zone1.includes('event-schema-shadow'), 'shadow XML tag must appear in Zone 1');
    assert.ok(zone1.includes('test_event'), 'shadow event types must appear in Zone 1');
  });

  test('Zone 1 composed without error when shadow absent', () => {
    const dir = makeDir();
    // No shadow file written
    const result = runCompose(dir);
    assert.equal(result.status, 0, 'must exit 0 when shadow absent');

    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext,
      'must still produce additionalContext without shadow');
  });

  test('Zone 1 hashes differ between run-with-shadow and run-without-shadow', () => {
    // With shadow
    const shadow = { _meta: { version: 1 }, my_event: { version: 1, required: ['x'], optional: [] } };
    const dirWith = makeDir({ shadow });
    runCompose(dirWith);
    const hashWith = readZones(dirWith).zone1_hash;

    // Without shadow
    const dirWithout = makeDir();
    runCompose(dirWithout);
    const hashWithout = readZones(dirWithout).zone1_hash;

    assert.notEqual(hashWith, hashWithout, 'Zone 1 hash must differ when shadow is included');
  });
});

// ---------------------------------------------------------------------------
// AC9 — config kill switch
// ---------------------------------------------------------------------------

describe('AC9 — Config kill switch', () => {
  test('compose is no-op when block_a_zone_caching.enabled=false', () => {
    const dir    = makeDir({ config: { block_a_zone_caching: { enabled: false } } });
    const result = runCompose(dir);
    assert.equal(result.status, 0);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch (_) { parsed = null; }
    const hasAdditional = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
    assert.ok(!hasAdditional, 'compose must be no-op when config.block_a_zone_caching.enabled=false');
  });

  test('validator is no-op when block_a_zone_caching.enabled=false', () => {
    const dir = makeDir({ config: { block_a_zone_caching: { enabled: false } } });
    runCompose(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Changed!', 'utf8');

    const result = runValidator(dir);
    assert.equal(result.status, 0);

    // No cache_invariant_broken event expected
    const events = readEvents(dir);
    const ev = events.find(e => e && e.type === 'cache_invariant_broken');
    assert.ok(!ev, 'validator must not emit events when config-disabled');
  });
});

// ---------------------------------------------------------------------------
// AC10 — Env var kill switch
// ---------------------------------------------------------------------------

describe('AC10 — Env var kill switch', () => {
  test('compose is no-op when ORCHESTRAY_DISABLE_BLOCK_A_ZONES=1', () => {
    const dir    = makeDir();
    const result = runCompose(dir, { ORCHESTRAY_DISABLE_BLOCK_A_ZONES: '1' });
    assert.equal(result.status, 0);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch (_) { parsed = null; }
    const hasAdditional = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
    assert.ok(!hasAdditional, 'compose must be no-op when env var set');
  });

  test('validator is no-op when ORCHESTRAY_DISABLE_BLOCK_A_ZONES=1', () => {
    const dir = makeDir();
    runCompose(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Changed!', 'utf8');

    const result = runValidator(dir, { ORCHESTRAY_DISABLE_BLOCK_A_ZONES: '1' });
    assert.equal(result.status, 0);

    // Validator events from compose run only (no validator event)
    const events  = readEvents(dir);
    const invEv   = events.find(e => e && e.type === 'cache_invariant_broken');
    assert.ok(!invEv, 'validator must not emit events when env var set');
  });
});

// ---------------------------------------------------------------------------
// Block-a-contract.md existence check
// ---------------------------------------------------------------------------

describe('block-a-contract.md exists', () => {
  test('block-a-contract.md is present in agents/pm-reference/', () => {
    const contractPath = path.resolve(__dirname, '../../agents/pm-reference/block-a-contract.md');
    assert.ok(fs.existsSync(contractPath), 'block-a-contract.md must exist');
    const content = fs.readFileSync(contractPath, 'utf8');
    assert.ok(content.includes('Zone 1'), 'must document Zone 1');
    assert.ok(content.includes('Zone 2'), 'must document Zone 2');
    assert.ok(content.includes('Zone 3'), 'must document Zone 3');
    assert.ok(content.includes('breakpoint') || content.includes('budget') || content.includes('cache_control'), 'must document breakpoint budget');
  });
});

// ---------------------------------------------------------------------------
// config-schema.js exports
// ---------------------------------------------------------------------------

describe('config-schema.js block_a_zone_caching', () => {
  test('DEFAULT_BLOCK_A_ZONE_CACHING has correct shape', () => {
    const { DEFAULT_BLOCK_A_ZONE_CACHING } = require('../../bin/_lib/config-schema');
    assert.strictEqual(DEFAULT_BLOCK_A_ZONE_CACHING.enabled, true);
    assert.strictEqual(DEFAULT_BLOCK_A_ZONE_CACHING.invariant_violation_threshold_24h, 5);
  });

  test('loadBlockAZoneCachingConfig returns defaults when no config file', () => {
    const { loadBlockAZoneCachingConfig } = require('../../bin/_lib/config-schema');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-pin-cfg-'));
    cleanup.push(dir);
    const cfg = loadBlockAZoneCachingConfig(dir);
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.invariant_violation_threshold_24h, 5);
  });

  test('validateBlockAZoneCachingConfig rejects non-boolean enabled', () => {
    const { validateBlockAZoneCachingConfig } = require('../../bin/_lib/config-schema');
    const result = validateBlockAZoneCachingConfig({ enabled: 'yes', invariant_violation_threshold_24h: 5 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('enabled')));
  });

  test('validateBlockAZoneCachingConfig rejects zero threshold', () => {
    const { validateBlockAZoneCachingConfig } = require('../../bin/_lib/config-schema');
    const result = validateBlockAZoneCachingConfig({ enabled: true, invariant_violation_threshold_24h: 0 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('invariant_violation_threshold_24h')));
  });

  test('validateBlockAZoneCachingConfig emits did-you-mean for unknown key', () => {
    const { validateBlockAZoneCachingConfig } = require('../../bin/_lib/config-schema');
    const result = validateBlockAZoneCachingConfig({ enabled: true, enabeld: true });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('enabeld')));
  });

  test('validateBlockAZoneCachingConfig accepts valid config', () => {
    const { validateBlockAZoneCachingConfig } = require('../../bin/_lib/config-schema');
    const result = validateBlockAZoneCachingConfig({ enabled: false, invariant_violation_threshold_24h: 10 });
    assert.strictEqual(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// event-schemas.md new events documented
// ---------------------------------------------------------------------------

describe('event-schemas.md has R-PIN events', () => {
  test('block_a_zone_composed is documented', () => {
    const schemasPath = path.resolve(__dirname, '../../agents/pm-reference/event-schemas.md');
    const content = fs.readFileSync(schemasPath, 'utf8');
    assert.ok(content.includes('block_a_zone_composed'), 'must document block_a_zone_composed');
  });

  test('cache_invariant_broken is documented', () => {
    const schemasPath = path.resolve(__dirname, '../../agents/pm-reference/event-schemas.md');
    const content = fs.readFileSync(schemasPath, 'utf8');
    assert.ok(content.includes('cache_invariant_broken'), 'must document cache_invariant_broken');
  });

  test('block_a_zone1_invalidated is documented', () => {
    const schemasPath = path.resolve(__dirname, '../../agents/pm-reference/event-schemas.md');
    const content = fs.readFileSync(schemasPath, 'utf8');
    assert.ok(content.includes('block_a_zone1_invalidated'), 'must document block_a_zone1_invalidated');
  });
});

// ---------------------------------------------------------------------------
// hooks.json registration
// ---------------------------------------------------------------------------

describe('hooks.json registration', () => {
  test('compose-block-a.js is registered as UserPromptSubmit hook', () => {
    const hooksPath = path.resolve(__dirname, '../../hooks/hooks.json');
    const content   = fs.readFileSync(hooksPath, 'utf8');
    assert.ok(content.includes('compose-block-a.js'), 'compose-block-a.js must be in hooks.json');
  });

  test('validate-cache-invariant.js is registered as PreToolUse hook', () => {
    const hooksPath = path.resolve(__dirname, '../../hooks/hooks.json');
    const content   = fs.readFileSync(hooksPath, 'utf8');
    assert.ok(content.includes('validate-cache-invariant.js'), 'validate-cache-invariant.js must be in hooks.json');
  });
});
