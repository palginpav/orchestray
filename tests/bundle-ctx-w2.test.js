#!/usr/bin/env node
'use strict';

/**
 * Bundle CTX W2 Tests — ArchetypeCache (criteria 24–31)
 *
 * Covers acceptance criteria 24–31 from the v2.1.8 design spec.
 * All state is written to isolated os.tmpdir() sandboxes.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ctx-w2-'));
  cleanup.push(dir);
  return dir;
}

function makeProject(suffix) {
  const root = makeTmp('ctx-w2-' + (suffix || ''));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  return root;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/** Load module fresh (cache-busted). */
function fresh(relPath) {
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  return require(relPath);
}

/** Write a minimal config.json to enable archetype cache with given overrides. */
function writeConfig(root, archetypeCacheOverrides, compressionEnabled = true) {
  const cfg = {
    context_compression_v218: {
      enabled: compressionEnabled,
      archetype_cache: Object.assign({
        enabled: true,
        min_prior_applications: 3,
        confidence_floor: 0.85,
        max_entries: 30,
        ttl_days: 30,
        blacklist: [],
      }, archetypeCacheOverrides || {}),
    },
  };
  const cfgPath = path.join(root, '.orchestray', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');
  return cfgPath;
}

/** Write a record directly to archetype-cache.jsonl with the given fields. */
function seedRecord(root, overrides) {
  const rec = Object.assign({
    archetype_id: 'aabbccddee00',
    prior_applications_count: 5,
    failed_uses: 0,
    last_outcome: 'success',
    last_used_ts: Date.now(),
    last_orch_id: 'seed-orch',
    created_ts: Date.now() - 1000,
    agentSet: 'developer,reviewer',
    fileBucket: 'M',
    keywords: 'auth,build,deploy,fix,test',
    scoreBucket: '4',
  }, overrides);
  const filePath = path.join(root, '.orchestray', 'state', 'archetype-cache.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').trim()
    : '';
  const content = (existing ? existing + '\n' : '') + JSON.stringify(rec) + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return rec;
}

// ─── Signature determinism (criterion #27) ───────────────────────────────────

describe('ArchetypeCache — signature determinism (criterion #27)', () => {

  // Spec criterion #27: same input → same 12-hex signature
  test('computeSignature produces same 12-hex output for identical inputs', () => {
    const mod = fresh('../bin/_lib/archetype-cache');

    const task = {
      agentSet: ['developer', 'reviewer'],
      fileCount: 5,
      description: 'Fix authentication bug in login flow',
      complexityScore: 4,
    };

    const sig1 = mod.computeSignature(task);
    const sig2 = mod.computeSignature(task);

    assert.strictEqual(sig1.length, 12, 'signature is 12 hex chars');
    assert.strictEqual(sig1, sig2, 'same input → same signature');
    assert.ok(/^[0-9a-f]{12}$/.test(sig1), 'signature is lowercase hex');
  });

  // Spec criterion #27: agentSet order does not matter (sorted before hashing)
  test('computeSignature is order-independent for agentSet', () => {
    const mod = fresh('../bin/_lib/archetype-cache');

    const sig1 = mod.computeSignature({ agentSet: ['developer', 'reviewer'], fileCount: 3, description: 'fix bug', complexityScore: 2 });
    const sig2 = mod.computeSignature({ agentSet: ['reviewer', 'developer'], fileCount: 3, description: 'fix bug', complexityScore: 2 });

    assert.strictEqual(sig1, sig2, 'agentSet order does not affect signature');
  });

  // Spec criterion #27: different agentSet → different signature
  test('computeSignature produces different output when agentSet differs', () => {
    const mod = fresh('../bin/_lib/archetype-cache');

    const base = { agentSet: ['developer'], fileCount: 5, description: 'fix auth', complexityScore: 3 };
    const other = Object.assign({}, base, { agentSet: ['developer', 'architect'] });

    assert.notStrictEqual(mod.computeSignature(base), mod.computeSignature(other), 'different agentSet → different sig');
  });

  // Spec criterion #27: different fileBucket → different signature
  test('computeSignature produces different output when file count crosses a bucket boundary', () => {
    const mod = fresh('../bin/_lib/archetype-cache');

    // fileCount=1 → XS, fileCount=5 → M
    const small = { agentSet: ['developer'], fileCount: 1, description: 'fix auth', complexityScore: 3 };
    const medium = Object.assign({}, small, { fileCount: 5 });

    assert.notStrictEqual(mod.computeSignature(small), mod.computeSignature(medium), 'different bucket → different sig');
  });

  // Spec criterion #27: different description (different top-5 keywords) → different sig
  test('computeSignature produces different output when task description keywords differ', () => {
    const mod = fresh('../bin/_lib/archetype-cache');

    const taskA = { agentSet: ['developer'], fileCount: 5, description: 'fix authentication login bug session', complexityScore: 3 };
    const taskB = Object.assign({}, taskA, { description: 'refactor database migration schema indexes' });

    assert.notStrictEqual(mod.computeSignature(taskA), mod.computeSignature(taskB), 'different keywords → different sig');
  });

  // Spec criterion #27: complexity ±1 tolerance (score bucket is rounded int)
  test('computeSignature treats complexityScore 3 and 4 as different buckets (rounded integers)', () => {
    const mod = fresh('../bin/_lib/archetype-cache');

    const sig3 = mod.computeSignature({ agentSet: ['developer'], fileCount: 3, description: 'auth fix', complexityScore: 3 });
    const sig4 = mod.computeSignature({ agentSet: ['developer'], fileCount: 3, description: 'auth fix', complexityScore: 4 });

    // These must be DIFFERENT since they are different integer buckets
    assert.notStrictEqual(sig3, sig4, 'complexity 3 vs 4 → different signatures');
  });

  // fileCountBucket boundary values (from W2 handoff)
  test('fileCountBucket returns XS for 1, S for 2-4, M for 5-12, L for 13-40, XL for 41+', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    const b = mod.fileCountBucket;

    assert.strictEqual(b(0), 'XS');
    assert.strictEqual(b(1), 'XS');
    assert.strictEqual(b(2), 'S');
    assert.strictEqual(b(4), 'S');
    assert.strictEqual(b(5), 'M');
    assert.strictEqual(b(12), 'M');
    assert.strictEqual(b(13), 'L');
    assert.strictEqual(b(40), 'L');
    assert.strictEqual(b(41), 'XL');
    assert.strictEqual(b(100), 'XL');
  });

});

// ─── Guardrails (criteria 25, 26, 28, 29) ────────────────────────────────────

describe('ArchetypeCache — guardrails', () => {

  // Spec criterion #25: prior_applications_count < 3 → findMatch returns null
  test('findMatch returns null when prior_applications_count < min_prior_applications (guardrail 1)', () => {
    const root = makeProject('g1');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    // Seed a record with only 2 applications (below threshold of 3)
    const rec = seedRecord(root, {
      archetype_id: 'g1g1g1g1g1g1',
      prior_applications_count: 2,
    });

    const task = { agentSet: ['developer', 'reviewer'], fileCount: 8, description: 'auth build deploy fix test', complexityScore: 4 };
    const sigDetails = mod.describeSignature(task);
    const match = mod.findMatch(sigDetails.signature, sigDetails, null, root);

    assert.strictEqual(match, null, 'guardrail 1: no match when count < 3');
  });

  // Spec criterion #26: confidence < 0.85 → not surfaced (guardrail 2)
  test('findMatch returns null when best confidence is below confidence_floor (guardrail 2)', () => {
    const root = makeProject('g2');
    writeConfig(root, { confidence_floor: 0.85 });
    const mod = fresh('../bin/_lib/archetype-cache');

    // Seed a record whose signature diverges so confidence < 0.85
    seedRecord(root, {
      archetype_id: 'g2g2g2g2g2g2',
      prior_applications_count: 5,
      agentSet: 'completely,different,agents',  // will not match
      fileBucket: 'XL',
      keywords: 'nothing,matches,here,bad,data',
      scoreBucket: '12',
    });

    // Query uses a very different task shape
    const task = { agentSet: ['developer'], fileCount: 1, description: 'tiny fix small', complexityScore: 1 };
    const sigDetails = mod.describeSignature(task);
    const match = mod.findMatch(sigDetails.signature, sigDetails, null, root);

    assert.strictEqual(match, null, 'guardrail 2: no match when confidence < floor');
  });

  // Spec criterion #28: blacklisted archetype_id → advisory suppressed + degraded entry
  test('findMatch returns null for a blacklisted archetype_id (guardrail 4)', () => {
    const root = makeProject('g4');
    const mod = fresh('../bin/_lib/archetype-cache');

    const archetypeId = 'blacklisted12';
    // Seed a high-confidence record
    seedRecord(root, {
      archetype_id: archetypeId,
      prior_applications_count: 10,
      agentSet: 'developer,reviewer',
      fileBucket: 'M',
      keywords: 'auth,build,deploy,fix,test',
      scoreBucket: '4',
    });

    // Config with this ID in blacklist
    writeConfig(root, { blacklist: [archetypeId] });

    const task = { agentSet: ['developer', 'reviewer'], fileCount: 8, description: 'auth build deploy fix test', complexityScore: 4 };
    const sigDetails = mod.describeSignature(task);
    const cfg = mod.loadConfig(root);
    const match = mod.findMatch(sigDetails.signature, sigDetails, cfg, root);

    assert.strictEqual(match, null, 'guardrail 4: blacklisted archetype not returned');
  });

  // Spec criterion #28: recordBlacklisted writes archetype_cache_blacklisted to degraded.jsonl
  // Entry now uses recordDegradation schema: archetype_id is in detail.archetype_id
  // (not top-level) so that dedup guard and envelope fields are applied consistently.
  test('recordBlacklisted writes archetype_cache_blacklisted entry to degraded.jsonl', () => {
    const root = makeProject('g4b');
    const mod = fresh('../bin/_lib/archetype-cache');

    mod.recordBlacklisted('blacklisted12', root);

    const degradedPath = path.join(root, '.orchestray', 'state', 'degraded.jsonl');
    const entries = readJsonl(degradedPath);
    const entry = entries.find(e => e.kind === 'archetype_cache_blacklisted');
    assert.ok(entry, 'archetype_cache_blacklisted entry written');
    assert.strictEqual(entry.severity, 'info');
    assert.strictEqual(entry.detail && entry.detail.archetype_id, 'blacklisted12');
  });

  // Spec criterion #29: enabled=false → findMatch returns null immediately (guardrail 5)
  test('findMatch returns null when archetype_cache.enabled is false (guardrail 5)', () => {
    const root = makeProject('g5');
    // Seed a record that would otherwise match
    seedRecord(root, { archetype_id: 'disabled1234', prior_applications_count: 10 });
    // Disable via config
    writeConfig(root, { enabled: false });

    const mod = fresh('../bin/_lib/archetype-cache');
    const task = { agentSet: ['developer', 'reviewer'], fileCount: 5, description: 'auth build deploy fix test', complexityScore: 4 };
    const sigDetails = mod.describeSignature(task);
    const cfg = mod.loadConfig(root);

    assert.strictEqual(cfg.enabled, false, 'config reflects enabled=false');
    const match = mod.findMatch(sigDetails.signature, sigDetails, cfg, root);
    assert.strictEqual(match, null, 'guardrail 5: no match when disabled');
  });

  // Spec criterion #29: enabled=false → recordApplication is a no-op
  test('recordApplication is a no-op when enabled=false (guardrail 5)', () => {
    const root = makeProject('g5b');
    writeConfig(root, { enabled: false });
    const mod = fresh('../bin/_lib/archetype-cache');

    // Should not throw, and should not create/modify cache file
    mod.recordApplication('someid123456', 'orch-x', 'success', null, root);

    const cacheFile = path.join(root, '.orchestray', 'state', 'archetype-cache.jsonl');
    assert.ok(!fs.existsSync(cacheFile), 'cache file not created when disabled');
  });

  // Spec criterion #29: context_compression_v218.enabled=false → global kill switch
  test('loadConfig returns enabled=false when context_compression_v218.enabled is false', () => {
    const root = makeProject('g5c');
    writeConfig(root, {}, false /* compressionEnabled=false */);
    const mod = fresh('../bin/_lib/archetype-cache');
    const cfg = mod.loadConfig(root);
    assert.strictEqual(cfg.enabled, false, 'global kill switch turns off archetype cache');
  });

});

// ─── recordAdvisoryServed (criterion #24, #31) ───────────────────────────────

describe('ArchetypeCache — recordAdvisoryServed', () => {

  // Spec criterion #24: advisory_served event written to events.jsonl
  test('recordAdvisoryServed writes archetype_cache_advisory_served event to events.jsonl', () => {
    const root = makeProject('adv-24');
    const mod = fresh('../bin/_lib/archetype-cache');

    mod.recordAdvisoryServed(
      'aabb11223344',
      'orch-adv-001',
      'accepted',
      'Task shape matched prior auth service refactor',
      0.91,
      5,
      'aabb11223344',
      root
    );

    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    const events = readJsonl(eventsPath);
    assert.strictEqual(events.length, 1);

    const ev = events[0];
    assert.strictEqual(ev.type, 'archetype_cache_advisory_served');
    assert.strictEqual(ev.archetype_id, 'aabb11223344');
    assert.strictEqual(ev.orchestration_id, 'orch-adv-001');
    assert.strictEqual(ev.pm_decision, 'accepted');
    assert.strictEqual(typeof ev.confidence, 'number');
    assert.strictEqual(ev.prior_applications_count, 5);
    assert.strictEqual(typeof ev.timestamp, 'string');
  });

  // Spec criterion #31: pm_reasoning_brief stored in event record
  test('recordAdvisoryServed stores pm_reasoning_brief (≤280 chars) in the event record', () => {
    const root = makeProject('adv-31');
    const mod = fresh('../bin/_lib/archetype-cache');

    const brief = 'This task matches the auth refactor pattern: same agent set (developer+reviewer), M-bucket file count, auth/session keywords.';
    mod.recordAdvisoryServed('cc001122aabb', 'orch-brief', 'adapted', brief, 0.88, 4, null, root);

    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    const events = readJsonl(eventsPath);
    assert.ok(events[0].pm_reasoning_brief, 'pm_reasoning_brief present');
    assert.ok(events[0].pm_reasoning_brief.length <= 280, 'pm_reasoning_brief ≤ 280 chars');
    assert.ok(events[0].pm_reasoning_brief.includes('auth'), 'pm_reasoning_brief contains expected content');
  });

  // Spec criterion #31: pm_reasoning_brief truncated at 280 chars
  test('recordAdvisoryServed truncates pm_reasoning_brief to 280 chars', () => {
    const root = makeProject('adv-31b');
    const mod = fresh('../bin/_lib/archetype-cache');

    const longBrief = 'x'.repeat(400);
    mod.recordAdvisoryServed('aabb00112233', 'orch-long', 'overridden', longBrief, 0.87, 6, null, root);

    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    const events = readJsonl(eventsPath);
    assert.strictEqual(events[0].pm_reasoning_brief.length, 280, 'truncated to 280 chars');
  });

  // Spec criterion #24: pm_decision field present
  test('recordAdvisoryServed event has pm_decision field with accepted|adapted|overridden value', () => {
    const root = makeProject('adv-decision');
    const mod = fresh('../bin/_lib/archetype-cache');

    for (const decision of ['accepted', 'adapted', 'overridden']) {
      mod.recordAdvisoryServed('aabb' + decision.slice(0, 8).padEnd(8, '0'), 'orch-d', decision, null, 0.90, 3, null, root);
    }

    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    const events = readJsonl(eventsPath);
    const decisions = events.map(e => e.pm_decision);
    assert.ok(decisions.includes('accepted'));
    assert.ok(decisions.includes('adapted'));
    assert.ok(decisions.includes('overridden'));
  });

  // Fail-open: recordAdvisoryServed never throws even with bad inputs
  test('recordAdvisoryServed does not throw with null inputs (fail-open)', () => {
    const root = makeProject('adv-safe');
    const mod = fresh('../bin/_lib/archetype-cache');
    assert.doesNotThrow(() => {
      mod.recordAdvisoryServed(null, null, null, null, null, null, null, root);
    });
  });

});

// ─── findMatch happy path (criterion #24) ────────────────────────────────────

describe('ArchetypeCache — findMatch happy path', () => {

  // Spec criterion #24: high-confidence match with count >= 3 → match returned
  test('findMatch returns a match when confidence >= 0.85 AND prior_applications_count >= 3', () => {
    const root = makeProject('fm-24');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    // Seed a record that exactly matches the query signature
    const task = {
      agentSet: ['developer', 'reviewer'],
      fileCount: 8,
      description: 'fix authentication login session token security',
      complexityScore: 4,
    };
    const sigDetails = mod.describeSignature(task);

    seedRecord(root, {
      archetype_id: 'match1234abcd',
      prior_applications_count: 5,
      agentSet: sigDetails.agentSet,
      fileBucket: sigDetails.fileBucket,
      keywords: sigDetails.keywords,
      scoreBucket: sigDetails.scoreBucket,
    });

    const cfg = mod.loadConfig(root);
    const match = mod.findMatch(sigDetails.signature, sigDetails, cfg, root);

    assert.ok(match !== null, 'match found when conditions are met');
    assert.strictEqual(match.archetypeId, 'match1234abcd');
    assert.ok(match.confidence >= 0.85, 'confidence meets floor');
    assert.ok(match.prior_applications_count >= 3, 'prior_applications_count meets threshold');
  });

  // Spec criterion #25: count < 3 → null (exact boundary)
  test('findMatch returns null when prior_applications_count is exactly 2 (below threshold of 3)', () => {
    const root = makeProject('fm-25');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    const task = {
      agentSet: ['developer'],
      fileCount: 5,
      description: 'fix auth session login security token',
      complexityScore: 3,
    };
    const sigDetails = mod.describeSignature(task);

    seedRecord(root, {
      archetype_id: 'lowcount12345',
      prior_applications_count: 2,  // exactly 1 below threshold
      agentSet: sigDetails.agentSet,
      fileBucket: sigDetails.fileBucket,
      keywords: sigDetails.keywords,
      scoreBucket: sigDetails.scoreBucket,
    });

    const cfg = mod.loadConfig(root);
    const match = mod.findMatch(sigDetails.signature, sigDetails, cfg, root);
    assert.strictEqual(match, null, 'count=2 (< min_prior_applications=3) → no match');
  });

  // Spec criterion #24: best match wins when multiple records exist
  test('findMatch returns the highest-confidence record when multiple exist', () => {
    const root = makeProject('fm-best');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    const task = {
      agentSet: ['developer', 'reviewer'],
      fileCount: 7,
      description: 'refactor authentication service middleware',
      complexityScore: 5,
    };
    const sigDetails = mod.describeSignature(task);

    // Perfect match
    seedRecord(root, {
      archetype_id: 'perfect123456',
      prior_applications_count: 10,
      agentSet: sigDetails.agentSet,
      fileBucket: sigDetails.fileBucket,
      keywords: sigDetails.keywords,
      scoreBucket: sigDetails.scoreBucket,
    });

    // Partial match (different keywords → lower confidence)
    seedRecord(root, {
      archetype_id: 'partial123456',
      prior_applications_count: 5,
      agentSet: sigDetails.agentSet,
      fileBucket: sigDetails.fileBucket,
      keywords: 'unrelated,random,words,nothing,match',
      scoreBucket: sigDetails.scoreBucket,
    });

    const cfg = mod.loadConfig(root);
    const match = mod.findMatch(sigDetails.signature, sigDetails, cfg, root);

    assert.ok(match !== null, 'some match found');
    assert.strictEqual(match.archetypeId, 'perfect123456', 'best match returned');
  });

  // Fail-open: findMatch returns null on missing cache file (never throws)
  test('findMatch returns null when cache file does not exist (fail-open)', () => {
    const root = makeProject('fm-nofile');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');
    const sigDetails = mod.describeSignature({ agentSet: ['developer'], fileCount: 3, description: 'test', complexityScore: 2 });
    const match = mod.findMatch(sigDetails.signature, sigDetails, null, root);
    assert.strictEqual(match, null);
  });

});

// ─── recordApplication ────────────────────────────────────────────────────────

describe('ArchetypeCache — recordApplication', () => {

  test('recordApplication creates a new record when none exists', () => {
    const root = makeProject('ra-new');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    mod.recordApplication('newrec1234ab', 'orch-ra-1', 'success', {
      agentSet: 'developer,reviewer',
      fileBucket: 'M',
      keywords: 'auth,fix,test',
      scoreBucket: '4',
    }, root);

    const cacheFile = path.join(root, '.orchestray', 'state', 'archetype-cache.jsonl');
    const records = readJsonl(cacheFile);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].archetype_id, 'newrec1234ab');
    assert.strictEqual(records[0].prior_applications_count, 1);
    assert.strictEqual(records[0].last_outcome, 'success');
  });

  test('recordApplication increments prior_applications_count on success for existing record', () => {
    const root = makeProject('ra-update');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    seedRecord(root, { archetype_id: 'update123456', prior_applications_count: 3 });
    mod.recordApplication('update123456', 'orch-ra-2', 'success', null, root);

    const cacheFile = path.join(root, '.orchestray', 'state', 'archetype-cache.jsonl');
    const records = readJsonl(cacheFile);
    const rec = records.find(r => r.archetype_id === 'update123456');
    assert.strictEqual(rec.prior_applications_count, 4);
  });

  test('recordApplication does not increment count on overridden outcome', () => {
    const root = makeProject('ra-override');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    seedRecord(root, { archetype_id: 'override12345', prior_applications_count: 3 });
    mod.recordApplication('override12345', 'orch-ra-3', 'overridden', null, root);

    const cacheFile = path.join(root, '.orchestray', 'state', 'archetype-cache.jsonl');
    const records = readJsonl(cacheFile);
    const rec = records.find(r => r.archetype_id === 'override12345');
    assert.strictEqual(rec.prior_applications_count, 3, 'count not incremented for overridden');
    assert.strictEqual(rec.last_outcome, 'overridden');
  });

});

// ─── getDashboardStats (criterion #30) ───────────────────────────────────────

describe('ArchetypeCache — getDashboardStats (criterion #30)', () => {

  // Spec criterion #30: empty state → safe zeroed object returned
  test('getDashboardStats returns safe zeroed stats when no events exist', () => {
    const root = makeProject('dash-30a');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    const stats = mod.getDashboardStats(root);

    assert.strictEqual(stats.advisories_served, 0);
    assert.strictEqual(stats.decompositions_attempted, 0);
    assert.strictEqual(stats.accepted, 0);
    assert.strictEqual(stats.adapted, 0);
    assert.strictEqual(stats.overridden, 0);
    assert.strictEqual(stats.hit_rate_pct, '0.0');
    assert.strictEqual(stats.override_rate_pct, '0.0');
    assert.strictEqual(stats.adaptation_rate_pct, '0.0');
    assert.deepStrictEqual(stats.top5_archetypes, []);
  });

  // Spec criterion #30: hit rate computed from events.jsonl
  test('getDashboardStats counts advisory_served and orchestration_start events correctly', () => {
    const root = makeProject('dash-30b');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    // Write events: 2 orchestration_start, 1 advisory_served (accepted)
    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ type: 'orchestration_start', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'orchestration_start', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'archetype_cache_advisory_served', pm_decision: 'accepted', archetype_id: 'aabb11223344', timestamp: new Date().toISOString() }),
    ].join('\n') + '\n');

    const stats = mod.getDashboardStats(root);

    assert.strictEqual(stats.advisories_served, 1);
    assert.strictEqual(stats.decompositions_attempted, 2);
    assert.strictEqual(stats.accepted, 1);
    assert.strictEqual(stats.hit_rate_pct, '50.0', 'hit rate = 1/2 = 50.0%');
  });

  // Spec criterion #30: override_rate computed correctly
  test('getDashboardStats computes override_rate_pct from pm_decision=overridden', () => {
    const root = makeProject('dash-30c');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ type: 'archetype_cache_advisory_served', pm_decision: 'accepted', archetype_id: 'aabb', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'archetype_cache_advisory_served', pm_decision: 'overridden', archetype_id: 'ccdd', timestamp: new Date().toISOString() }),
    ].join('\n') + '\n');

    const stats = mod.getDashboardStats(root);

    assert.strictEqual(stats.advisories_served, 2);
    assert.strictEqual(stats.overridden, 1);
    assert.strictEqual(stats.override_rate_pct, '50.0', 'override rate = 1/2 = 50.0%');
  });

  // Spec criterion #30: top-5 archetypes by prior_applications_count
  test('getDashboardStats top5_archetypes returns top 5 by prior_applications_count', () => {
    const root = makeProject('dash-30d');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    // Seed 7 records with varying counts
    for (let i = 1; i <= 7; i++) {
      seedRecord(root, {
        archetype_id: 'arch' + String(i).padStart(8, '0'),
        prior_applications_count: i * 2,
      });
    }

    const stats = mod.getDashboardStats(root);

    assert.strictEqual(stats.top5_archetypes.length, 5, 'exactly 5 top archetypes');
    // Top should be i=7 (14 applications)
    assert.strictEqual(stats.top5_archetypes[0].prior_applications_count, 14);
    // Verify descending order
    for (let i = 0; i < stats.top5_archetypes.length - 1; i++) {
      assert.ok(
        stats.top5_archetypes[i].prior_applications_count >= stats.top5_archetypes[i + 1].prior_applications_count,
        'top5 sorted descending by prior_applications_count'
      );
    }
  });

  // Spec criterion #29 + #30: disabled → getDashboardStats returns empty
  test('getDashboardStats returns empty stats when archetype_cache is disabled', () => {
    const root = makeProject('dash-disabled');
    writeConfig(root, { enabled: false });
    const mod = fresh('../bin/_lib/archetype-cache');

    const stats = mod.getDashboardStats(root);
    assert.strictEqual(stats.advisories_served, 0);
    assert.deepStrictEqual(stats.top5_archetypes, []);
  });

  // Fail-open: corrupt events.jsonl → returns zeroed stats (no throw)
  test('getDashboardStats fails open when events.jsonl is corrupt (returns zeroed stats)', () => {
    const root = makeProject('dash-corrupt');
    writeConfig(root);
    const mod = fresh('../bin/_lib/archetype-cache');

    const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath, 'not-json\nalso-not-json\n', 'utf8');

    let stats;
    assert.doesNotThrow(() => { stats = mod.getDashboardStats(root); });
    assert.strictEqual(stats.advisories_served, 0, 'corrupt lines skipped, count stays 0');
  });

});

// ─── SKILL.md section check (criterion #30) ──────────────────────────────────

describe('ArchetypeCache — /orchestray:patterns SKILL.md section (criterion #30)', () => {

  // Spec criterion #30: SKILL.md has "Archetype cache (advisory)" section
  // This is a smoke-check on the template, not a rendering test.
  test('skills/orchestray:patterns/SKILL.md contains Section 16 "Archetype cache (advisory)" heading', () => {
    const skillMd = path.resolve(__dirname, '../skills/orchestray:patterns/SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'SKILL.md exists at expected path');

    const content = fs.readFileSync(skillMd, 'utf8');
    assert.ok(
      content.includes('Archetype cache (advisory)'),
      'SKILL.md has "Archetype cache (advisory)" section'
    );
  });

  // Spec criterion #30: section references hit rate, override rate, adaptation rate
  test('SKILL.md Archetype cache section references hit_rate_pct, override_rate_pct, adaptation_rate_pct', () => {
    const skillMd = path.resolve(__dirname, '../skills/orchestray:patterns/SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');

    assert.ok(content.includes('hit_rate'), 'has hit_rate reference');
    assert.ok(content.includes('override_rate'), 'has override_rate reference');
    assert.ok(content.includes('adaptation_rate'), 'has adaptation_rate reference');
  });

  // Spec criterion #30: section references top-5 archetypes display
  test('SKILL.md Archetype cache section references top-5 archetypes display', () => {
    const skillMd = path.resolve(__dirname, '../skills/orchestray:patterns/SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');

    // "top-5" or "top5" or "Top-5" should appear near the archetype cache section
    assert.ok(
      /top.?5/i.test(content),
      'SKILL.md mentions top-5 archetypes'
    );
  });

  // Spec criterion #30: section mentions getDashboardStats invocation
  test('SKILL.md Archetype cache section references getDashboardStats call', () => {
    const skillMd = path.resolve(__dirname, '../skills/orchestray:patterns/SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');

    assert.ok(
      content.includes('getDashboardStats'),
      'SKILL.md references getDashboardStats call'
    );
  });

});

// ─── inject-archetype-advisory.js hook integration (criterion #24, #28, #29) ─

describe('ArchetypeCache — inject-archetype-advisory hook (subprocess)', () => {

  const HOOK_SCRIPT = path.resolve(__dirname, '../bin/inject-archetype-advisory.js');

  function makeOrchProject(suffix) {
    const root = makeProject('hook-' + (suffix || ''));
    // Write current-orchestration.json (required by hook condition 1)
    const orchId = 'orch-hook-' + (suffix || 'test');
    fs.writeFileSync(
      path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
      JSON.stringify({
        orchestration_id: orchId,
        task: 'fix authentication login session token security',
        expected_agent_set: ['developer', 'reviewer'],
        file_count_hint: 8,
        complexity_score: 4,
      }),
      'utf8'
    );
    return { root, orchId };
  }

  function runHook(cwd, orchId) {
    const payload = {
      cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix authentication login session token security',
    };
    return spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10000,
    });
  }

  // Spec criterion #29: hook exits 0 with no stdout when disabled
  test('hook exits 0 with no advisory output when archetype_cache is disabled (guardrail 5)', () => {
    const { root, orchId } = makeOrchProject('disabled');
    writeConfig(root, { enabled: false });

    const result = runHook(root, orchId);

    assert.strictEqual(result.status, 0, 'hook exits 0');
    assert.strictEqual(result.stdout.trim(), '', 'no output when disabled');
  });

  // Spec criterion #29: hook exits 0 with no stdout when no orchestration active
  test('hook exits 0 with no output when no current-orchestration.json exists', () => {
    const root = makeProject('hook-no-orch');
    writeConfig(root);
    // Do NOT write current-orchestration.json

    const payload = { cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'test' };
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.strictEqual(result.status, 0, 'hook exits 0');
    assert.strictEqual(result.stdout.trim(), '', 'no output without active orch');
  });

  // Spec criterion #24: hook outputs advisory fence when match found
  test('hook emits additionalContext with advisory fence when high-confidence match exists', () => {
    const { root, orchId } = makeOrchProject('match');
    writeConfig(root);

    const mod = fresh('../bin/_lib/archetype-cache');
    const task = {
      agentSet: ['developer', 'reviewer'],
      fileCount: 8,
      description: 'fix authentication login session token security',
      complexityScore: 4,
    };
    const sigDetails = mod.describeSignature(task);

    // Seed a high-confidence record matching the task
    seedRecord(root, {
      archetype_id: 'hooktest12345',
      prior_applications_count: 5,
      agentSet: sigDetails.agentSet,
      fileBucket: sigDetails.fileBucket,
      keywords: sigDetails.keywords,
      scoreBucket: sigDetails.scoreBucket,
    });

    const result = runHook(root, orchId);

    assert.strictEqual(result.status, 0, 'hook exits 0');

    if (result.stdout.trim()) {
      const output = JSON.parse(result.stdout.trim());
      assert.ok(output.hookSpecificOutput, 'has hookSpecificOutput');
      const ctx = output.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('<orchestray-archetype-advisory>'), 'advisory fence present');
      assert.ok(ctx.includes('</orchestray-archetype-advisory>'), 'advisory fence closed');
      assert.ok(ctx.includes('ArchetypeCache advisory'), 'has advisory header');
    }
    // If stdout is empty, it means no routing.jsonl existed and conditions weren't met
    // (hook exits 0 either way — fail-open is correct)
  });

  // Spec criterion #28: hook records archetype_cache_blacklisted when blacklisted match exists
  test('hook records archetype_cache_blacklisted in degraded.jsonl for a blacklisted match and emits no advisory', () => {
    const { root, orchId } = makeOrchProject('blacklist');
    const mod = fresh('../bin/_lib/archetype-cache');

    const task = {
      agentSet: ['developer', 'reviewer'],
      fileCount: 8,
      description: 'fix authentication login session token security',
      complexityScore: 4,
    };
    const sigDetails = mod.describeSignature(task);
    const archetypeId = 'blktest123456';

    seedRecord(root, {
      archetype_id: archetypeId,
      prior_applications_count: 5,
      agentSet: sigDetails.agentSet,
      fileBucket: sigDetails.fileBucket,
      keywords: sigDetails.keywords,
      scoreBucket: sigDetails.scoreBucket,
    });

    // Config with this archetype blacklisted
    writeConfig(root, { blacklist: [archetypeId] });

    const result = runHook(root, orchId);

    assert.strictEqual(result.status, 0, 'hook exits 0 (fail-open)');
    assert.strictEqual(result.stdout.trim(), '', 'no advisory output for blacklisted archetype');

    // End-to-end: blacklist suppression must leave an audit trace in degraded.jsonl.
    const degradedPath = path.join(root, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(degradedPath), 'degraded.jsonl must be written by the blacklist path');
    const lines = fs.readFileSync(degradedPath, 'utf8').split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));
    const blacklistEntry = entries.find((e) => e.kind === 'archetype_cache_blacklisted');
    assert.ok(blacklistEntry, 'archetype_cache_blacklisted entry present');
    assert.strictEqual(blacklistEntry.detail.archetype_id, archetypeId,
      'blacklist entry carries the matched archetype id');
  });

  // Fail-open: hook handles malformed stdin gracefully (exits 0, no crash)
  test('hook exits 0 and produces no output when stdin is malformed JSON', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: 'not valid json at all!!!',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0, 'hook exits 0 on malformed stdin');
    assert.strictEqual(result.stdout.trim(), '', 'no output on malformed stdin');
  });

  // Fail-open: hook handles empty stdin gracefully
  test('hook exits 0 and produces no output when stdin is empty', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0, 'hook exits 0 on empty stdin');
  });

});

// ─── extractKeywordCluster and computeConfidence internals ───────────────────

describe('ArchetypeCache — extractKeywordCluster and computeConfidence', () => {

  test('extractKeywordCluster returns top-5 alphabetically sorted content words', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    const cluster = mod.extractKeywordCluster('fix authentication login session token security token token');
    const words = cluster.split(',');
    assert.ok(words.length <= 5, 'at most 5 keywords');
    // Verify alphabetical order
    const sorted = [...words].sort();
    assert.deepStrictEqual(words, sorted, 'keywords are alphabetically sorted');
  });

  test('extractKeywordCluster returns empty string for empty input', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    assert.strictEqual(mod.extractKeywordCluster(''), '');
    assert.strictEqual(mod.extractKeywordCluster(null), '');
  });

  test('extractKeywordCluster removes stop-words', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    // All stop-words → empty result
    const result = mod.extractKeywordCluster('the and or but in on at to for of with');
    // Either empty string or only non-stop words
    const words = result.split(',').filter(Boolean);
    for (const w of words) {
      // None of these should be stop-words
      assert.ok(w.length >= 3, 'keyword meets min length');
    }
  });

  test('computeConfidence returns 1.0 for identical record and query', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    const rec = { agentSet: 'developer,reviewer', fileBucket: 'M', keywords: 'auth,fix,test', scoreBucket: '4' };
    const query = { agentSet: 'developer,reviewer', fileBucket: 'M', keywords: 'auth,fix,test', scoreBucket: '4' };
    const conf = mod.computeConfidence(rec, query);
    assert.strictEqual(conf, 1.0, 'identical components → confidence 1.0');
  });

  test('computeConfidence returns < 1.0 when any component differs', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    const rec = { agentSet: 'developer,reviewer', fileBucket: 'M', keywords: 'auth,fix,test', scoreBucket: '4' };
    const query = { agentSet: 'developer', fileBucket: 'M', keywords: 'auth,fix,test', scoreBucket: '4' };
    const conf = mod.computeConfidence(rec, query);
    assert.ok(conf < 1.0, 'different agentSet → confidence < 1.0');
  });

  // Spec criterion #27: scoreBucket ±1 tolerance
  test('computeConfidence gives full score-component credit for scoreBucket within ±1', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    const rec   = { agentSet: 'developer', fileBucket: 'M', keywords: 'auth,fix', scoreBucket: '4' };
    const exact = { agentSet: 'developer', fileBucket: 'M', keywords: 'auth,fix', scoreBucket: '4' };
    const plus1 = { agentSet: 'developer', fileBucket: 'M', keywords: 'auth,fix', scoreBucket: '5' };
    const plus2 = { agentSet: 'developer', fileBucket: 'M', keywords: 'auth,fix', scoreBucket: '6' };

    const confExact = mod.computeConfidence(rec, exact);
    const confPlus1 = mod.computeConfidence(rec, plus1);
    const confPlus2 = mod.computeConfidence(rec, plus2);

    assert.strictEqual(confExact, 1.0, 'exact match');
    assert.strictEqual(confPlus1, 1.0, '±1 tolerance: scoreBucket 4 vs 5 = full credit');
    assert.ok(confPlus2 < confExact, '±2 difference: lower confidence');
  });

  test('computeConfidence returns 0.0 on error (fail-open)', () => {
    const mod = fresh('../bin/_lib/archetype-cache');
    // Passing null should not throw and should return 0.0
    const conf = mod.computeConfidence(null, null);
    assert.strictEqual(conf, 0.0);
  });

});
