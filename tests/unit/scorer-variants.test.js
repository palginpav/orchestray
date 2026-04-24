#!/usr/bin/env node
'use strict';

/**
 * Tests for W8 (v2.1.13 R-RET-PROMOTE) scorer variant promotion.
 *
 * Covers:
 *   A. Default variant resolves to `baseline` (scorerForVariant + _selectScorer).
 *   B. All 4 variants produce deterministic output on fixture inputs.
 *   C. Announcer fires once per install (sentinel gate + per-process guard).
 *   D. Shadow telemetry continues to emit under non-baseline variants
 *      (i.e. scorer-shadow.js still gets called through pattern_find's seam).
 *
 * Runner: node --test tests/unit/scorer-variants.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

// Module under test — kept at path that matches bin/_lib layout.
const variants = require('../../bin/_lib/scorer-variants');
const announcer = require('../../bin/mcp-server/announce-scorer-variants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makePattern(opts) {
  return Object.assign({
    slug:         'some-slug',
    confidence:   0.8,
    overlapRatio: 0.5,
    roleBonus:    0,
    fileBonus:    0,
    timesApplied: 0,
  }, opts || {});
}

// ---------------------------------------------------------------------------
// A. Default variant = baseline
// ---------------------------------------------------------------------------

describe('W8 A: default variant resolves to baseline', () => {
  test('scorerForVariant(undefined) returns scoreBaseline', () => {
    const fn = variants.scorerForVariant(undefined);
    assert.strictEqual(fn, variants.scoreBaseline);
  });

  test('scorerForVariant("baseline") returns scoreBaseline', () => {
    const fn = variants.scorerForVariant('baseline');
    assert.strictEqual(fn, variants.scoreBaseline);
  });

  test('scorerForVariant(unknown) falls back to scoreBaseline', () => {
    const fn = variants.scorerForVariant('banana-ranking');
    assert.strictEqual(fn, variants.scoreBaseline);
  });

  test('scorerForVariant(null) falls back to scoreBaseline', () => {
    const fn = variants.scorerForVariant(null);
    assert.strictEqual(fn, variants.scoreBaseline);
  });

  test('VALID_VARIANTS lists all 4 promoted values', () => {
    assert.deepStrictEqual(variants.VALID_VARIANTS,
      ['baseline', 'skip-down', 'local-success', 'composite']);
  });
});

// ---------------------------------------------------------------------------
// B. Each variant produces deterministic output on fixture inputs
// ---------------------------------------------------------------------------

describe('W8 B: 4 variants produce deterministic output', () => {
  // Fixture: neutral pattern, no skip / success signal → all variants should
  // collapse to the same baseline number.
  test('no-signal: all 4 variants equal baseline', () => {
    const p   = makePattern({ slug: 'neutral', confidence: 0.9, overlapRatio: 0.5 });
    const ctx = { skipCounts: new Map(), successCounts: new Map() };

    const expected = 0.9 * 0.5; // 0.45
    assert.strictEqual(variants.scoreBaseline(p, ctx),     expected);
    assert.strictEqual(variants.scoreSkipDown(p, ctx),     expected);
    assert.strictEqual(variants.scoreLocalSuccess(p, ctx), expected);
    assert.strictEqual(variants.scoreComposite(p, ctx),    expected);
  });

  test('baseline: confidence * (overlap + role + file)', () => {
    const p = makePattern({
      confidence: 0.7,
      overlapRatio: 0.4,
      roleBonus: 0.3,
      fileBonus: 0.2,
    });
    assert.strictEqual(variants.scoreBaseline(p, {}), 0.7 * (0.4 + 0.3 + 0.2));
  });

  test('skip-down: Laplace-smoothed penalty, bounded by floor', () => {
    const p = makePattern({
      slug: 'skipped-often',
      confidence: 1,
      overlapRatio: 1,
      timesApplied: 0,
    });
    const ctx = {
      skipCounts: new Map([
        ['skipped-often', { 'contextual-mismatch': 10, superseded: 0 }],
      ]),
    };
    // skipRate = 10 / (0 + 10 + 1) = 10/11 ≈ 0.909
    // penalty  = 1 - 0.909 * 0.6 ≈ 0.4545
    // baseline = 1 * 1 = 1
    // raw      = 0.4545…; floor = 0.01 → result = raw (> floor)
    const result = variants.scoreSkipDown(p, ctx);
    const expected = 1 * (1 - (10 / 11) * 0.6);
    assert.ok(Math.abs(result - expected) < 1e-9,
      `skip-down: expected ~${expected}, got ${result}`);

    // Determinism: same inputs → same output across two calls.
    assert.strictEqual(variants.scoreSkipDown(p, ctx), result);
  });

  test('skip-down: ignores non-counted skip categories', () => {
    const p = makePattern({ slug: 'x', confidence: 1, overlapRatio: 1 });
    const ctx = {
      skipCounts: new Map([
        // Only contextual-mismatch + superseded are counted by buildSkipCounts,
        // but defensive: even if caller hands in other keys, the scorer only
        // reads the two counted ones.
        ['x', { 'contextual-mismatch': 0, superseded: 0 }],
      ]),
    };
    // No counted skips → penalty = 1 → score = baseline.
    assert.strictEqual(variants.scoreSkipDown(p, ctx), 1);
  });

  test('skip-down: floor prevents zeroing out', () => {
    // Construct a pathological case: many skips, no applies.
    const p = makePattern({
      slug: 'disaster',
      confidence: 1,
      overlapRatio: 1,
      timesApplied: 0,
    });
    const ctx = {
      skipCounts: new Map([
        ['disaster', { 'contextual-mismatch': 1000000, superseded: 0 }],
      ]),
    };
    const result = variants.scoreSkipDown(p, ctx);
    // Floor = baseline * 0.01 = 0.01 — penalty can never push below this.
    // Asymptotic max penalty = 0.6, so score asymptotes at baseline*(1-0.6)=0.4
    // but never quite reaches it (Laplace +1 keeps skipRate < 1).
    assert.ok(result >= 0.01, 'floor enforced: result >= 0.01');
    assert.ok(result > 0.4 && result < 0.41,
      'penalty asymptotes toward 0.4 but stays above it: got ' + result);
  });

  test('local-success: boost scales with success rate, max +40%', () => {
    const p = makePattern({
      slug: 'proven',
      confidence: 1,
      overlapRatio: 1,
      timesApplied: 4,
    });
    const ctx = {
      successCounts: new Map([['proven', 5]]),
    };
    // rawRate = 5 / (4 + 1) = 1.0; clamped to 1.0
    // boost   = 1 + 1.0 * 0.4 = 1.4
    // score   = 1 * 1.4
    const result = variants.scoreLocalSuccess(p, ctx);
    assert.ok(Math.abs(result - 1.4) < 1e-9,
      `local-success: expected 1.4, got ${result}`);
  });

  test('local-success: no successes → baseline unchanged', () => {
    const p = makePattern({
      slug: 'untried',
      confidence: 0.8,
      overlapRatio: 0.5,
      timesApplied: 0,
    });
    const ctx = { successCounts: new Map() };
    assert.strictEqual(variants.scoreLocalSuccess(p, ctx), 0.8 * 0.5);
  });

  test('composite: multiplicative stack of skip penalty + success boost', () => {
    const p = makePattern({
      slug: 'mixed',
      confidence: 1,
      overlapRatio: 1,
      timesApplied: 4,
    });
    const ctx = {
      skipCounts:    new Map([['mixed', { 'contextual-mismatch': 1, superseded: 0 }]]),
      successCounts: new Map([['mixed', 5]]),
    };

    const skip    = variants.scoreSkipDown(p, ctx);
    const success = variants.scoreLocalSuccess(p, ctx);
    const base    = variants.scoreBaseline(p, ctx);
    const comp    = variants.scoreComposite(p, ctx);

    // composite = baseline * (skip / baseline) * (success / baseline)
    const expected = base * (skip / base) * (success / base);
    assert.ok(Math.abs(comp - expected) < 1e-9,
      `composite expected ${expected}, got ${comp}`);
  });

  test('composite: degenerate baseline=0 returns 0 without NaN', () => {
    const p = makePattern({ slug: 'zero', confidence: 0, overlapRatio: 0 });
    const ctx = { skipCounts: new Map(), successCounts: new Map() };
    assert.strictEqual(variants.scoreComposite(p, ctx), 0);
  });

  test('buildSkipCounts: folds events, ignores non-counted categories', () => {
    const events = [
      { pattern_name: 'a', skip_category: 'contextual-mismatch' },
      { pattern_name: 'a', skip_category: 'contextual-mismatch' },
      { pattern_name: 'a', skip_category: 'superseded' },
      { pattern_name: 'b', skip_category: 'forgotten' },             // NOT counted
      { pattern_name: 'c', skip_category: 'operator-override' },     // NOT counted
      { pattern_name: 'c', skip_category: 'superseded' },
      { skip_category: 'contextual-mismatch' },                      // missing pattern_name
      null,                                                          // null event
    ];
    const counts = variants.buildSkipCounts(events);
    assert.deepStrictEqual(counts.get('a'),
      { 'contextual-mismatch': 2, superseded: 1 });
    assert.strictEqual(counts.has('b'), false);
    assert.deepStrictEqual(counts.get('c'),
      { 'contextual-mismatch': 0, superseded: 1 });
  });

  test('buildSuccessCounts: only applied-success on pattern_record_application', () => {
    const events = [
      { tool_name: 'pattern_record_application', outcome: 'applied-success', input: { slug: 'x' } },
      { tool_name: 'pattern_record_application', outcome: 'applied-success', slug: 'x' },
      { tool_name: 'pattern_record_application', outcome: 'applied-failure', input: { slug: 'x' } },
      { tool_name: 'pattern_find',               outcome: 'applied-success', input: { slug: 'y' } },
      { tool_name: 'pattern_record_application', outcome: 'applied-success', input: { slug: 'z' } },
      null,
    ];
    const counts = variants.buildSuccessCounts(events);
    assert.strictEqual(counts.get('x'), 2);
    assert.strictEqual(counts.has('y'), false);
    assert.strictEqual(counts.get('z'), 1);
  });
});

// ---------------------------------------------------------------------------
// C. Announcer fires once and only once
// ---------------------------------------------------------------------------

describe('W8 C: announcer fires exactly once per install', () => {
  test('first call writes sentinel + returns true; subsequent calls return false', (t) => {
    const projectRoot = makeTmpDir('scorer-variants-ann-');
    t.after(() => {
      try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
    });
    announcer._resetForTests();

    // Capture stderr writes so we can assert on the printed message.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured  = [];
    process.stderr.write = (chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    t.after(() => { process.stderr.write = origWrite; });

    const first  = announcer.maybeAnnounce(projectRoot);
    const second = announcer.maybeAnnounce(projectRoot);
    const third  = announcer.maybeAnnounce(projectRoot);

    assert.strictEqual(first,  true,  'first call emits announcement');
    assert.strictEqual(second, false, 'second call is a no-op (per-process guard)');
    assert.strictEqual(third,  false, 'third call is a no-op');

    // Sentinel file was created.
    const sentinelPath = path.join(projectRoot, '.orchestray', 'state',
      announcer.SENTINEL_FILENAME);
    assert.ok(fs.existsSync(sentinelPath),
      'sentinel file created at ' + sentinelPath);

    // Only ONE stderr emission total.
    const announcements = captured.filter((s) => s.includes('scorer_variant'));
    assert.strictEqual(announcements.length, 1,
      'exactly one announcement printed to stderr; got ' + announcements.length);
    assert.ok(announcements[0].includes('skip-down'));
    assert.ok(announcements[0].includes('local-success'));
    assert.ok(announcements[0].includes('composite'));
  });

  test('sentinel survives process restart (second process is silent)', (t) => {
    const projectRoot = makeTmpDir('scorer-variants-ann-');
    t.after(() => {
      try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
    });

    // Simulate install 1.
    announcer._resetForTests();
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured1 = [];
    process.stderr.write = (chunk) => {
      captured1.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    const firstCall = announcer.maybeAnnounce(projectRoot);
    process.stderr.write = origWrite;
    assert.strictEqual(firstCall, true, 'first install call emits');
    assert.strictEqual(
      captured1.filter((s) => s.includes('scorer_variant')).length, 1,
      'one announcement in install 1');

    // Simulate a fresh process: reset per-process guard, sentinel remains.
    announcer._resetForTests();
    let captured2 = [];
    process.stderr.write = (chunk) => {
      captured2.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    const secondCall = announcer.maybeAnnounce(projectRoot);
    process.stderr.write = origWrite;
    assert.strictEqual(secondCall, false, 'second process sees sentinel, skips');
    assert.strictEqual(
      captured2.filter((s) => s.includes('scorer_variant')).length, 0,
      'no announcement in install 2');
  });

  test('missing projectRoot → silent no-op', () => {
    announcer._resetForTests();
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured  = [];
    process.stderr.write = (chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    try {
      const r1 = announcer.maybeAnnounce('');
      const r2 = announcer.maybeAnnounce(undefined);
      const r3 = announcer.maybeAnnounce(null);
      assert.strictEqual(r1, false);
      assert.strictEqual(r2, false);
      assert.strictEqual(r3, false);
      const announcements = captured.filter((s) => s.includes('scorer_variant'));
      assert.strictEqual(announcements.length, 0);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// D. Shadow telemetry continues emitting under non-baseline variants
// ---------------------------------------------------------------------------

describe('W8 D: shadow telemetry is independent of active variant', () => {
  test('maybeRunShadowScorers schedules work under non-baseline variant', async (t) => {
    // Invariant: shadow telemetry continues to run when scorer_variant is
    // non-baseline. We observe this by watching for a scorer-shadow.jsonl
    // write to the tmp project root's audit/state directory.
    const shadow = require('../../bin/_lib/scorer-shadow');
    const cs     = require('../../bin/_lib/config-schema');

    const projectRoot = makeTmpDir('shadow-telemetry-under-variant-');
    t.after(() => {
      try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
    });

    // Monkey-patch loadRetrievalConfig so the harness sees a non-baseline
    // variant but still has shadow_scorers configured.
    const origLoad = cs.loadRetrievalConfig;
    cs.loadRetrievalConfig = function () {
      return {
        scorer_variant:        'composite',
        shadow_scorers:        ['skip-down'],
        top_k:                 10,
        jsonl_max_bytes:       1024 * 1024,
        jsonl_max_generations: 3,
        global_kill_switch:    false,
      };
    };
    t.after(() => { cs.loadRetrievalConfig = origLoad; });

    shadow.maybeRunShadowScorers({
      query:          'some task about retrieval scoring',
      baselineScored: [{ slug: 'pattern-a', _score: 0.5 }],
      candidates:     [{
        slug:        'pattern-a',
        frontmatter: { name: 'pattern-a', confidence: 0.8, times_applied: 0 },
        body:        '## Context\nwhatever',
        filepath:    path.join(projectRoot, 'pattern-a.md'),
        _tier:       'local',
      }],
      inputContext: {
        projectRoot,
        agentRole: null,
        fileGlobs: [],
        nowMs:     Date.now(),
      },
      maxResults: 5,
    });

    // Shadow work runs on setImmediate — yield twice to let it complete.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Confirm the shadow JSONL landed in state/.
    const jsonlPath = path.join(projectRoot, '.orchestray', 'state', 'scorer-shadow.jsonl');
    assert.ok(fs.existsSync(jsonlPath),
      'scorer-shadow.jsonl must be written under non-baseline variant: ' + jsonlPath);
    const content = fs.readFileSync(jsonlPath, 'utf8');
    assert.ok(content.includes('"scorer_name":"skip-down"'),
      'JSONL should contain a skip-down row');
  });

  test('global_kill_switch still disables shadow under non-baseline variant', async (t) => {
    const shadow = require('../../bin/_lib/scorer-shadow');
    const cs     = require('../../bin/_lib/config-schema');

    const projectRoot = makeTmpDir('shadow-telemetry-killed-');
    t.after(() => {
      try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
    });

    const origLoad = cs.loadRetrievalConfig;
    cs.loadRetrievalConfig = function () {
      return {
        scorer_variant:        'composite',
        shadow_scorers:        ['skip-down'],
        top_k:                 10,
        jsonl_max_bytes:       1024 * 1024,
        jsonl_max_generations: 3,
        global_kill_switch:    true, // <-- kill switch ON
      };
    };
    t.after(() => { cs.loadRetrievalConfig = origLoad; });

    shadow.maybeRunShadowScorers({
      query:          'x',
      baselineScored: [],
      candidates:     [],
      inputContext:   { projectRoot, nowMs: Date.now() },
      maxResults:     5,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const jsonlPath = path.join(projectRoot, '.orchestray', 'state', 'scorer-shadow.jsonl');
    assert.ok(!fs.existsSync(jsonlPath),
      'kill switch must suppress the JSONL write');
  });
});

// ---------------------------------------------------------------------------
// E. Config-schema enum coercion (regression guard)
// ---------------------------------------------------------------------------

describe('W8 E: config-schema accepts all 4 enum values', () => {
  test('each valid variant round-trips through loadRetrievalConfig', (t) => {
    const cs = require('../../bin/_lib/config-schema');
    const tmp = makeTmpDir('scorer-variants-cfg-');
    t.after(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    });
    fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });

    for (const variant of ['baseline', 'skip-down', 'local-success', 'composite']) {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ retrieval: { scorer_variant: variant } }),
      );
      const cfg = cs.loadRetrievalConfig(tmp);
      assert.strictEqual(cfg.scorer_variant, variant,
        'variant "' + variant + '" survives round-trip');
    }
  });

  test('unknown variant coerces to baseline', (t) => {
    const cs = require('../../bin/_lib/config-schema');
    const tmp = makeTmpDir('scorer-variants-cfg-');
    t.after(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    });
    fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'config.json'),
      JSON.stringify({ retrieval: { scorer_variant: 'nonsense' } }),
    );

    // Silence stderr warning from loader.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const cfg = cs.loadRetrievalConfig(tmp);
      assert.strictEqual(cfg.scorer_variant, 'baseline');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('default (no config file) = baseline', (t) => {
    const cs = require('../../bin/_lib/config-schema');
    const tmp = makeTmpDir('scorer-variants-cfg-');
    t.after(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    });
    const cfg = cs.loadRetrievalConfig(tmp);
    assert.strictEqual(cfg.scorer_variant, 'baseline');
  });
});
