#!/usr/bin/env node
'use strict';

/**
 * archetype-cache-seeder.test.js — tests for bin/seed-archetype-cache.js (v2.2.20 T6).
 *
 * Covers the 6 required test cases plus additional coverage per T2 test plan:
 *   U1 — Kill switch env var
 *   U2 — Sentinel guard (second run is no-op)
 *   U3 — Fresh cache writes 10 records, sentinel created
 *   U4 — Signatures consistent (each record's archetype_id matches computeSignature())
 *   U5 — Timestamps fresh
 *   U6 — Merge no-downgrade (--force preserves higher prior_applications_count)
 *   U7 — Merge adds missing seed archetype
 *   U10 — Dry run does not write
 *   U11 — Config kill switch
 *   U12 — Warm cache skip
 *   I1  — findMatch() works on seeded cache
 *   H1  — Hook entry in hooks.json validates (no duplicates, correct shape)
 *
 * Runner: node --test tests/archetype-cache-seeder.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT         = path.resolve(__dirname, '..');
const SEEDER_SCRIPT = path.join(ROOT, 'bin', 'seed-archetype-cache.js');
const HOOKS_FILE    = path.join(ROOT, 'hooks', 'hooks.json');

const {
  runSeeder,
  mergeNoDowngrade,
  loadSeeds,
  isCacheWarm,
  _CACHE_REL,
  _SENTINEL_REL,
} = require('../bin/seed-archetype-cache');

const {
  computeSignature,
  findMatch,
} = require('../bin/_lib/archetype-cache');

// ─── Helper: create temp project directory ────────────────────────────────────

function makeTempProject(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-seeder-' + label + '-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'),  { recursive: true });
  return tmp;
}

function readCacheRecords(cwd) {
  const p = path.join(cwd, _CACHE_REL);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function sentinelExists(cwd) {
  return fs.existsSync(path.join(cwd, _SENTINEL_REL));
}

// ─── U1 — Kill switch env var ─────────────────────────────────────────────────

describe('U1 — kill switch env var', () => {
  test('ORCHESTRAY_ARCHETYPE_SEEDER_DISABLED=1 causes exit 0 without writing', () => {
    const tmp = makeTempProject('u1');

    const result = spawnSync('node', [SEEDER_SCRIPT], {
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, {
        ORCHESTRAY_ARCHETYPE_SEEDER_DISABLED: '1',
      }),
      cwd: tmp,
    });

    assert.equal(result.status, 0, 'must exit 0');
    assert.ok(!fs.existsSync(path.join(tmp, _CACHE_REL)),
      'cache must NOT be written when kill switch is active');
    assert.ok(!sentinelExists(tmp),
      'sentinel must NOT be written when kill switch is active');
  });
});

// ─── U2 — Sentinel guard ─────────────────────────────────────────────────────

describe('U2 — sentinel guard prevents re-run', () => {
  test('second invocation with sentinel exits 0 without modifying cache', () => {
    const tmp = makeTempProject('u2');

    // First run — seeds the cache and writes sentinel
    runSeeder({ cwd: tmp });
    assert.ok(sentinelExists(tmp), 'sentinel must exist after first run');

    const firstRecords = readCacheRecords(tmp);
    assert.equal(firstRecords.length, 10, 'first run must write 10 records');

    // Mutate cache to detect if second run touches it
    const cachePath = path.join(tmp, _CACHE_REL);
    fs.writeFileSync(cachePath, firstRecords.map(r => JSON.stringify(r)).join('\n') + '\nMUTATED\n');

    // Second run
    const stats = runSeeder({ cwd: tmp });
    assert.deepEqual(stats, { seed_count: 0, mined_count: 0, merged_count: 0, skipped_count: 0 },
      'second run must be a no-op');

    const raw = fs.readFileSync(cachePath, 'utf8');
    assert.ok(raw.includes('MUTATED'), 'cache must not be rewritten on second run');
  });
});

// ─── U3 — Fresh cache writes 10 records and sentinel ─────────────────────────

describe('U3 — fresh cache seeded with 10 records', () => {
  let tmp;
  let records;

  before(() => {
    tmp = makeTempProject('u3');
    runSeeder({ cwd: tmp });
    records = readCacheRecords(tmp);
  });

  test('exactly 10 records written', () => {
    assert.equal(records.length, 10, 'must write exactly 10 seed records');
  });

  test('all records have prior_applications_count: 3', () => {
    for (const r of records) {
      assert.equal(r.prior_applications_count, 3,
        `record ${r.archetype_id} must have prior_applications_count 3`);
    }
  });

  test('sentinel created', () => {
    assert.ok(sentinelExists(tmp), 'sentinel must be created after successful seeder run');
  });
});

// ─── U4 — Signatures consistent ──────────────────────────────────────────────

describe('U4 — seed archetype_id matches computeSignature()', () => {
  test('each seed record archetype_id is consistent with its sigDetails', () => {
    const seeds = loadSeeds();
    for (const seed of seeds) {
      const agentSet = seed.agentSet.split(',');
      // fileBucket maps to fileCount: XS=0, S=2, M=5, L=15, XL=50
      const fileBucketToCount = { XS: 0, S: 2, M: 5, L: 15, XL: 50 };
      const fileCount = fileBucketToCount[seed.fileBucket] || 0;
      // scoreBucket is the complexity score directly
      const complexityScore = parseInt(seed.scoreBucket, 10);

      // Build a description that produces the exact keyword cluster stored in seed.
      // The stored keywords ARE the cluster — feed them as the description.
      const description = seed.keywords.split(',').join(' ');

      const sig = computeSignature({
        agentSet,
        fileCount,
        description,
        complexityScore,
      });

      assert.equal(sig, seed.archetype_id,
        `Seed "${seed.archetype_name}" (${seed.archetype_id}): ` +
        `computeSignature returned "${sig}" — seed catalog may be stale`);
    }
  });
});

// ─── U5 — Timestamps fresh ───────────────────────────────────────────────────

describe('U5 — timestamps injected at seed time', () => {
  test('last_used_ts and created_ts are within 5 seconds of Date.now()', () => {
    const tmp = makeTempProject('u5');
    const before = Date.now();
    runSeeder({ cwd: tmp });
    const after = Date.now();

    const records = readCacheRecords(tmp);
    for (const r of records) {
      assert.ok(Number.isFinite(r.last_used_ts),
        `${r.archetype_id}: last_used_ts must be a number`);
      assert.ok(Number.isFinite(r.created_ts),
        `${r.archetype_id}: created_ts must be a number`);
      assert.ok(r.last_used_ts >= before - 5000 && r.last_used_ts <= after + 5000,
        `${r.archetype_id}: last_used_ts ${r.last_used_ts} not within 5s of run`);
      assert.ok(r.created_ts >= before - 5000 && r.created_ts <= after + 5000,
        `${r.archetype_id}: created_ts ${r.created_ts} not within 5s of run`);
    }
  });
});

// ─── U6 — Merge no-downgrade ──────────────────────────────────────────────────

describe('U6 — --force merge preserves higher prior_applications_count', () => {
  test('existing record with count=7 preserved; not reset to seed baseline of 3', () => {
    const tmp = makeTempProject('u6');

    // Seed initial
    runSeeder({ cwd: tmp });

    // Manually elevate one record to count=7
    const records = readCacheRecords(tmp);
    const target = records[0];
    target.prior_applications_count = 7;
    target.last_outcome = 'success';
    const cachePath = path.join(tmp, _CACHE_REL);
    fs.writeFileSync(cachePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    // Force re-run
    runSeeder({ cwd: tmp, force: true });

    const updated = readCacheRecords(tmp);
    const found = updated.find(r => r.archetype_id === target.archetype_id);
    assert.ok(found, 'target record must still exist after force merge');
    assert.equal(found.prior_applications_count, 7,
      'no-downgrade: count must remain 7, not be reset to seed baseline 3');
  });
});

// ─── U7 — Merge adds missing seed ────────────────────────────────────────────

describe('U7 — --force adds missing seed archetype', () => {
  test('cache missing one seed gets the missing record added on --force', () => {
    const tmp = makeTempProject('u7');

    // Seed initial
    runSeeder({ cwd: tmp });

    // Remove one seed record from cache
    const records = readCacheRecords(tmp);
    assert.equal(records.length, 10, 'precondition: 10 records');
    const removed = records.splice(0, 1)[0]; // remove first record
    const cachePath = path.join(tmp, _CACHE_REL);
    fs.writeFileSync(cachePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    // Remove sentinel so force actually runs the merge
    fs.unlinkSync(path.join(tmp, _SENTINEL_REL));

    // Force re-run
    runSeeder({ cwd: tmp, force: true });

    const updated = readCacheRecords(tmp);
    assert.equal(updated.length, 10, 'must restore to 10 records after merge');
    const restored = updated.find(r => r.archetype_id === removed.archetype_id);
    assert.ok(restored, 'removed record must be re-added by force merge');
  });
});

// ─── U10 — Dry run does not write ────────────────────────────────────────────

describe('U10 — --dry-run does not write files', () => {
  test('--dry-run produces no cache file and no sentinel', () => {
    const tmp = makeTempProject('u10');

    const result = spawnSync('node', [SEEDER_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1' }),
      cwd: tmp,
    });

    assert.equal(result.status, 0, 'must exit 0');
    assert.ok(!fs.existsSync(path.join(tmp, _CACHE_REL)),
      'cache must NOT be written in dry-run mode');
    assert.ok(!sentinelExists(tmp),
      'sentinel must NOT be written in dry-run mode');
  });
});

// ─── U11 — Config kill switch ────────────────────────────────────────────────

describe('U11 — config kill switch', () => {
  test('seeder_disabled: true in config causes early exit without writing', () => {
    const tmp = makeTempProject('u11');

    // Write config with kill switch
    fs.writeFileSync(path.join(tmp, '.orchestray', 'config.json'), JSON.stringify({
      context_compression_v218: {
        archetype_cache: {
          enabled: true,
          seeder_disabled: true,
        },
      },
    }));

    // Run via CLI (not library) so config kill switch path is exercised
    const result = spawnSync('node', [SEEDER_SCRIPT], {
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1' }),
      cwd: tmp,
    });

    assert.equal(result.status, 0, 'must exit 0');
    assert.ok(!fs.existsSync(path.join(tmp, _CACHE_REL)),
      'cache must NOT be written when config kill switch is set');
    assert.ok(!sentinelExists(tmp),
      'sentinel must NOT be written when config kill switch is set');
  });
});

// ─── U12 — Warm cache skip ───────────────────────────────────────────────────

describe('U12 — warm cache is skipped on hook invocation', () => {
  test('cache with existing records and no sentinel: seeder writes sentinel but does not overwrite', () => {
    const tmp = makeTempProject('u12');

    // Pre-populate cache with a synthetic record (simulates prior real usage)
    const existingRecord = {
      archetype_id: 'aabbccddeeff',
      prior_applications_count: 10,
      failed_uses: 0,
      last_outcome: 'success',
      last_used_ts: Date.now(),
      last_orch_id: 'orch-existing',
      created_ts: Date.now(),
      agentSet: 'developer',
      fileBucket: 'S',
      keywords: 'existing,record',
      scoreBucket: '3',
    };
    const cachePath = path.join(tmp, _CACHE_REL);
    fs.writeFileSync(cachePath, JSON.stringify(existingRecord) + '\n');

    // Run seeder (no sentinel, warm cache)
    runSeeder({ cwd: tmp });

    // Cache should be unchanged (warm cache skipped)
    const records = readCacheRecords(tmp);
    assert.equal(records.length, 1, 'warm cache must not be overwritten');
    assert.equal(records[0].archetype_id, 'aabbccddeeff',
      'original record must still be present');
    assert.ok(sentinelExists(tmp), 'sentinel must be written even on warm-cache skip');
  });
});

// ─── I1 — findMatch() works on seeded cache ──────────────────────────────────

describe('I1 — findMatch() returns a hit on seeded cache', () => {
  test('seeded record with matching signature is returned by findMatch()', () => {
    const tmp = makeTempProject('i1');
    runSeeder({ cwd: tmp });

    // Use the "audit-fix" seed: agentSet=developer,reviewer fileBucket=M keywords=audit,bugs,...
    // Construct a signature that matches it
    const agentSet = ['developer', 'reviewer'];
    const description = 'audit bugs corrections errors feedback';
    const fileCount = 5; // maps to M bucket
    const complexityScore = 5;

    const sig = computeSignature({ agentSet, fileCount, description, complexityScore });
    assert.equal(sig, '5459be41500b', 'precondition: signature matches audit-fix seed');

    const { describeSignature } = require('../bin/_lib/archetype-cache');
    const querySig = describeSignature({ agentSet, fileCount, description, complexityScore });

    const match = findMatch(sig, querySig, undefined, tmp);
    assert.ok(match !== null, 'findMatch must return a hit on a seeded cache');
    assert.equal(match.archetypeId, '5459be41500b',
      'findMatch must return the correct seed archetype_id');
    assert.ok(match.prior_applications_count >= 3,
      'matched record must have prior_applications_count >= 3');
  });
});

// ─── H1 — Hook entry shape in hooks.json ─────────────────────────────────────

describe('H1 — hooks.json contains correct SessionStart entry for seeder', () => {
  let hooksData;

  before(() => {
    const raw = fs.readFileSync(HOOKS_FILE, 'utf8');
    hooksData = JSON.parse(raw);
  });

  test('hooks.json is valid JSON with a SessionStart array', () => {
    assert.ok(hooksData.hooks, 'hooks.json must have a hooks object');
    assert.ok(Array.isArray(hooksData.hooks.SessionStart),
      'SessionStart must be an array');
  });

  test('SessionStart contains exactly one entry for seed-archetype-cache.js', () => {
    const seedEntries = hooksData.hooks.SessionStart.filter(entry => {
      return Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h.command && h.command.includes('seed-archetype-cache.js'));
    });
    assert.equal(seedEntries.length, 1,
      'must have exactly one SessionStart entry for seed-archetype-cache.js');
  });

  test('seeder hook entry has type=command and timeout=10', () => {
    const seedEntry = hooksData.hooks.SessionStart.find(entry => {
      return Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h.command && h.command.includes('seed-archetype-cache.js'));
    });
    assert.ok(seedEntry, 'seeder hook entry must exist');
    const hook = seedEntry.hooks.find(h => h.command && h.command.includes('seed-archetype-cache.js'));
    assert.equal(hook.type, 'command', 'hook type must be "command"');
    assert.equal(hook.timeout, 10, 'hook timeout must be 10');
  });

  test('seeder command uses ${CLAUDE_PLUGIN_ROOT} prefix', () => {
    const seedEntry = hooksData.hooks.SessionStart.find(entry => {
      return Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h.command && h.command.includes('seed-archetype-cache.js'));
    });
    const hook = seedEntry.hooks.find(h => h.command && h.command.includes('seed-archetype-cache.js'));
    assert.ok(hook.command.startsWith('${CLAUDE_PLUGIN_ROOT}'),
      'command must use ${CLAUDE_PLUGIN_ROOT} prefix for plugin-root resolution');
  });
});

// ─── mergeNoDowngrade unit test ───────────────────────────────────────────────

describe('mergeNoDowngrade unit', () => {
  test('does not decrease prior_applications_count or failed_uses', () => {
    const existing = [
      { archetype_id: 'aaa', prior_applications_count: 7, failed_uses: 2, last_used_ts: 9999 },
    ];
    const seeds = [
      { archetype_id: 'aaa', prior_applications_count: 3, failed_uses: 0 },
      { archetype_id: 'bbb', prior_applications_count: 3, failed_uses: 0 },
    ];
    const { merged, addedCount, skippedCount } = mergeNoDowngrade(existing, seeds, Date.now());
    const aaa = merged.find(r => r.archetype_id === 'aaa');
    assert.equal(aaa.prior_applications_count, 7, 'must keep 7, not downgrade to 3');
    assert.equal(aaa.failed_uses, 2, 'must keep 2, not downgrade to 0');
    assert.equal(addedCount, 1, 'one new record added');
    assert.equal(skippedCount, 1, 'one existing record skipped');
  });
});
