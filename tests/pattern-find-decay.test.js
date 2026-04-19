'use strict';

/**
 * Tests for W9 (LL2): time-based confidence decay in pattern_find.
 *
 * Verifies that pattern_find returns `decayed_confidence` and `age_days`
 * alongside the unchanged `confidence` field, using exponential decay:
 *
 *   decayed_confidence = confidence * 0.5 ^ (age_days / half_life)
 *
 * Reference timestamp: last_applied (ISO 8601) if set; otherwise file mtime.
 * Half-life precedence: per-pattern fm.decay_half_life_days → category override
 * in config → global default (90 days).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle } = require('../bin/mcp-server/tools/pattern_find.js');

// Disable shared-tier federation for all decay tests.
// getSharedPatternsDir() reads ORCHESTRAY_TEST_SHARED_DIR and bypasses the
// enabled check. Pointing it at a nonexistent path ensures the readdirSync
// in handle() gets ENOENT and skips the shared tier entirely.
let _prevSharedDir;
before(() => {
	_prevSharedDir = process.env.ORCHESTRAY_TEST_SHARED_DIR;
	process.env.ORCHESTRAY_TEST_SHARED_DIR = path.join(
		os.tmpdir(), 'orchestray-decay-no-shared-' + process.pid
	);
});
after(() => {
	if (_prevSharedDir === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
	else process.env.ORCHESTRAY_TEST_SHARED_DIR = _prevSharedDir;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-decay-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

function makeContext(tmp, configObj) {
  if (configObj) {
    const configDir = path.join(tmp, '.orchestray');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(configObj)
    );
  }
  return {
    projectRoot: tmp,
    pluginRoot: tmp,
    config: {},
    logger: () => {},
  };
}

/**
 * Write a pattern file and optionally backdate its mtime.
 * Returns the absolute filepath so callers can mutate mtime further.
 */
function writePattern(tmp, slug, fmFields, body) {
  const fmLines = Object.entries(fmFields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = '---\n' + fmLines + '\n---\n\n' + (body || `# Pattern: ${slug}\n`);
  const fp = path.join(tmp, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(fp, content);
  return fp;
}

/** Backdate the mtime of a file to N days ago. */
function backdateMtime(filepath, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86400000);
  fs.utimesSync(filepath, t, t);
}

/**
 * Run pattern_find and return the first (and only expected) match.
 * task_summary is made broad so everything scores non-zero.
 */
async function findFirst(tmp, ctx) {
  const result = await handle(
    { task_summary: 'test pattern decay orchestration', max_results: 10, min_confidence: 0 },
    ctx
  );
  assert.ok(!result.isError, 'expected no error, got: ' + JSON.stringify(result));
  const sc = result.structuredContent;
  assert.ok(sc && sc.matches && sc.matches.length > 0, 'expected at least one match');
  return sc.matches[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern_find decay — W9 LL2', () => {

  test('last_applied 0 days ago → decayed_confidence ≈ confidence', async () => {
    const tmp = makeTmpProject();
    const now = new Date().toISOString();
    writePattern(tmp, 'fresh-pattern', {
      name: 'fresh-pattern',
      category: 'decomposition',
      confidence: 0.8,
      times_applied: 1,
      last_applied: now,
    });

    const ctx = makeContext(tmp);
    const match = await findFirst(tmp, ctx);

    assert.ok('decayed_confidence' in match, 'match must have decayed_confidence');
    assert.ok('age_days' in match, 'match must have age_days');
    assert.equal(match.confidence, 0.8, 'raw confidence must be unchanged');
    assert.equal(match.age_days, 0, 'age_days should be 0 for just-applied pattern');
    // With age_days=0: 0.8 * 0.5^0 = 0.8; allow rounding to ±0.001
    assert.ok(
      Math.abs(match.decayed_confidence - 0.8) <= 0.001,
      `expected decayed ≈ 0.8, got ${match.decayed_confidence}`
    );
  });

  test('last_applied 90 days ago (= default half-life) → decayed_confidence ≈ confidence * 0.5', async () => {
    const tmp = makeTmpProject();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    writePattern(tmp, 'half-life-pattern', {
      name: 'half-life-pattern',
      category: 'decomposition',
      confidence: 0.8,
      times_applied: 1,
      last_applied: ninetyDaysAgo,
    });

    const ctx = makeContext(tmp);
    const match = await findFirst(tmp, ctx);

    assert.equal(match.confidence, 0.8, 'raw confidence must be unchanged');
    // 0.8 * 0.5^(90/90) = 0.8 * 0.5 = 0.4; allow ±0.005 for rounding
    assert.ok(
      Math.abs(match.decayed_confidence - 0.4) <= 0.005,
      `expected decayed ≈ 0.4, got ${match.decayed_confidence}`
    );
  });

  test('last_applied 180 days ago → decayed_confidence ≈ confidence * 0.25', async () => {
    const tmp = makeTmpProject();
    const oneEightyDaysAgo = new Date(Date.now() - 180 * 86400000).toISOString();
    writePattern(tmp, 'old-pattern', {
      name: 'old-pattern',
      category: 'anti-pattern',
      confidence: 0.6,
      times_applied: 2,
      last_applied: oneEightyDaysAgo,
    });

    const ctx = makeContext(tmp);
    const match = await findFirst(tmp, ctx);

    assert.equal(match.confidence, 0.6, 'raw confidence must be unchanged');
    // 0.6 * 0.5^(180/90) = 0.6 * 0.25 = 0.15; allow ±0.005
    assert.ok(
      Math.abs(match.decayed_confidence - 0.15) <= 0.005,
      `expected decayed ≈ 0.15, got ${match.decayed_confidence}`
    );
  });

  test('no last_applied → decay uses file mtime (backdate mtime to 90 days ago)', async () => {
    const tmp = makeTmpProject();
    // Write with last_applied: null (the normal default for new patterns)
    const fp = writePattern(tmp, 'mtime-fallback', {
      name: 'mtime-fallback',
      category: 'routing',
      confidence: 1.0,
      times_applied: 0,
      last_applied: 'null',
    });
    // Backdate the file mtime to 90 days ago
    backdateMtime(fp, 90);

    const ctx = makeContext(tmp);
    const match = await findFirst(tmp, ctx);

    assert.equal(match.confidence, 1.0, 'raw confidence must be unchanged');
    // file mtime is 90 days old → 1.0 * 0.5^1 = 0.5; allow ±0.01 (mtime resolution)
    assert.ok(
      Math.abs(match.decayed_confidence - 0.5) <= 0.01,
      `expected decayed ≈ 0.5 (mtime fallback), got ${match.decayed_confidence}`
    );
    // age_days should be approximately 90
    assert.ok(
      match.age_days >= 89 && match.age_days <= 91,
      `expected age_days ≈ 90, got ${match.age_days}`
    );
  });

  test('config override pattern_decay.default_half_life_days: 30 → 30-day-old pattern decays to 0.5×', async () => {
    const tmp = makeTmpProject();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    writePattern(tmp, 'short-halflife', {
      name: 'short-halflife',
      category: 'decomposition',
      confidence: 0.9,
      times_applied: 1,
      last_applied: thirtyDaysAgo,
    });

    // Override default half-life to 30 days
    const ctx = makeContext(tmp, {
      pattern_decay: { default_half_life_days: 30 },
    });
    const match = await findFirst(tmp, ctx);

    assert.equal(match.confidence, 0.9, 'raw confidence must be unchanged');
    // 0.9 * 0.5^(30/30) = 0.9 * 0.5 = 0.45; allow ±0.005
    assert.ok(
      Math.abs(match.decayed_confidence - 0.45) <= 0.005,
      `expected decayed ≈ 0.45, got ${match.decayed_confidence}`
    );
  });

  test('category override anti-pattern:180, 90 days old → decays to ≈ 0.707×', async () => {
    const tmp = makeTmpProject();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    writePattern(tmp, 'anti-pattern-long', {
      name: 'anti-pattern-long',
      category: 'anti-pattern',
      confidence: 0.6,
      times_applied: 0,
      last_applied: ninetyDaysAgo,
    });

    // Category override: anti-pattern gets 180-day half-life
    const ctx = makeContext(tmp, {
      pattern_decay: {
        default_half_life_days: 90,
        category_overrides: { 'anti-pattern': 180 },
      },
    });
    const match = await findFirst(tmp, ctx);

    assert.equal(match.confidence, 0.6, 'raw confidence must be unchanged');
    // 0.6 * 0.5^(90/180) = 0.6 * 0.5^0.5 = 0.6 * 0.7071 ≈ 0.424; allow ±0.005
    const expected = 0.6 * Math.pow(0.5, 90 / 180);
    assert.ok(
      Math.abs(match.decayed_confidence - expected) <= 0.005,
      `expected decayed ≈ ${expected.toFixed(3)}, got ${match.decayed_confidence}`
    );
  });

  test('raw confidence field is unchanged in output when decayed_confidence differs', async () => {
    const tmp = makeTmpProject();
    const twoHundredDaysAgo = new Date(Date.now() - 200 * 86400000).toISOString();
    writePattern(tmp, 'stale-pattern', {
      name: 'stale-pattern',
      category: 'specialization',
      confidence: 0.75,
      times_applied: 3,
      last_applied: twoHundredDaysAgo,
    });

    const ctx = makeContext(tmp);
    const match = await findFirst(tmp, ctx);

    // Confirm both fields exist and raw is preserved
    assert.equal(match.confidence, 0.75, 'raw confidence must not be modified');
    assert.ok('decayed_confidence' in match, 'decayed_confidence must be present');
    assert.ok('age_days' in match, 'age_days must be present');
    // decayed must be strictly less than raw for a 200-day-old pattern
    assert.ok(
      match.decayed_confidence < match.confidence,
      `decayed (${match.decayed_confidence}) must be < raw (${match.confidence})`
    );
    // age_days must be integer
    assert.equal(Math.floor(match.age_days), match.age_days, 'age_days must be an integer');
  });

});
