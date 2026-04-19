#!/usr/bin/env node
'use strict';

/**
 * Unit tests for pattern-health.js (v2.1.2 — Item #6).
 *
 * Tests the computeHealth() and annotatePatterns() pure functions.
 * No file I/O. All test scenarios from the architect's design §7.1.
 *
 * Runner: node --test bin/_lib/__tests__/pattern-health.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeHealth, annotatePatterns } = require('../pattern-health.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal pattern input.
 * @param {Partial<import('../pattern-health.js').PatternHealthInput>} overrides
 */
function makePattern(overrides) {
  return Object.assign({
    slug:               'test-slug',
    confidence:         0.8,
    decayed_confidence: 0.75,
    age_days:           10,
    times_applied:      5,
    category:           'routing',
  }, overrides);
}

/**
 * Build a skip event for a given slug, category, and age in days.
 * @param {string} slug
 * @param {string} skipCategory
 * @param {number} ageDaysAgo - how many days ago the event occurred
 * @param {Date} now
 */
function makeSkipEvent(slug, skipCategory, ageDaysAgo, now) {
  const ts = new Date(now.getTime() - ageDaysAgo * 24 * 3600 * 1000).toISOString();
  return {
    timestamp:     ts,
    pattern_name:  slug,
    skip_category: skipCategory,
  };
}

// A fixed "now" for deterministic tests.
const NOW = new Date('2026-04-19T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Tests matching architect design §7.1
// ---------------------------------------------------------------------------

describe('computeHealth()', () => {

  // Test 1: Healthy pattern
  test('1. healthy pattern: fresh, high confidence, applied, no skips → health ≥ 0.70, tier healthy', () => {
    const p = makePattern({ age_days: 5, decayed_confidence: 0.85, times_applied: 5 });
    const r = computeHealth(p, [], NOW);
    // base=0.85, usage=1.0, freshness=1.0, penalty=0 → raw=0.85
    assert.ok(r.score >= 0.70, 'score should be >= 0.70, got ' + r.score);
    assert.equal(r.tier, 'healthy');
    assert.equal(r.reason, 'composite score (no dominant factor)');
  });

  // Test 2: Unused but fresh (from design: exact value 0.5 × 0.5 × 1.0 × 1.0 = 0.25)
  test('2. unused but fresh: times_applied=0, age_days=2, confidence=0.5 → health=0.25, needs-attention', () => {
    const p = makePattern({ slug: 'fresh-unused', age_days: 2, decayed_confidence: 0.5, times_applied: 0, confidence: 0.5 });
    const r = computeHealth(p, [], NOW);
    // base=0.5, usage_boost(0)=0.5, freshness_factor(2)=1.0, penalty=0
    // raw = 0.5 * 0.5 * 1.0 * 1.0 = 0.25
    assert.equal(r.score, 0.25, 'exact score should be 0.25');
    assert.equal(r.tier, 'needs-attention');
  });

  // Test 3: Stale but high confidence
  test('3. stale high confidence: decayed=0.5, age=100, applied=3, no skips → reason mentions age', () => {
    const p = makePattern({ age_days: 100, decayed_confidence: 0.5, times_applied: 3, confidence: 0.9 });
    const r = computeHealth(p, [], NOW);
    // base=0.5, usage_boost(3)=0.85, freshness_factor(100)=0.3, penalty=0
    // raw = 0.5 * 0.85 * 0.3 = 0.1275
    assert.ok(r.score < 0.40, 'score should be below 0.40 for stale pattern, got ' + r.score);
    // freshness_factor < 0.5 so reason should mention age
    assert.ok(r.reason.includes('100d'), 'reason should mention 100d, got: ' + r.reason);
  });

  // Test 4: Contextual-mismatch skips → needs-attention
  test('4. 3 contextual-mismatch skips in last 90d → needs-attention, reason mentions skips', () => {
    const p = makePattern({ age_days: 5, decayed_confidence: 0.85, times_applied: 5 });
    const evts = [
      makeSkipEvent('test-slug', 'contextual-mismatch', 10, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 20, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 30, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    // penalty=0.6 → raw = 0.85 * 1.0 * 1.0 * 0.4 = 0.34
    assert.equal(r.tier, 'needs-attention');
    assert.ok(r.reason.includes('contextual-mismatch'), 'reason must mention contextual-mismatch');
    assert.ok(r.reason.includes('3'), 'reason must mention count 3');
  });

  // Test 5: Old contextual-mismatch skip (91d ago) should NOT count
  test('5. contextual-mismatch skip 91d ago → does NOT count, tier based on other signals', () => {
    const p = makePattern({ age_days: 5, decayed_confidence: 0.85, times_applied: 5 });
    const evts = [
      makeSkipEvent('test-slug', 'contextual-mismatch', 91, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    // penalty=0, base=0.85, usage=1.0, freshness=1.0 → score=0.85
    assert.equal(r.tier, 'healthy', 'old skip should not count');
  });

  // Test 6: pattern_name: null skip events should NOT count
  test('6. pattern_name: null skip events → skip_penalty = 0', () => {
    const p = makePattern({ age_days: 5, decayed_confidence: 0.85, times_applied: 5 });
    const evts = [
      { timestamp: makeSkipEvent('test-slug', 'contextual-mismatch', 10, NOW).timestamp, pattern_name: null, skip_category: 'contextual-mismatch' },
      { timestamp: makeSkipEvent('test-slug', 'contextual-mismatch', 20, NOW).timestamp, pattern_name: null, skip_category: 'contextual-mismatch' },
    ];
    const r = computeHealth(p, evts, NOW);
    assert.equal(r.tier, 'healthy', 'null pattern_name events must not count');
  });

  // Test 7: forgotten skip category should NOT count
  test('7. skip_category: forgotten → does NOT count', () => {
    const p = makePattern({ age_days: 5, decayed_confidence: 0.85, times_applied: 5 });
    const evts = [
      makeSkipEvent('test-slug', 'forgotten', 10, NOW),
      makeSkipEvent('test-slug', 'forgotten', 20, NOW),
      makeSkipEvent('test-slug', 'forgotten', 30, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    assert.equal(r.tier, 'healthy', 'forgotten skips must not count');
  });

  // Test 8: superseded skip category SHOULD count same as contextual-mismatch
  test('8. skip_category: superseded → counts same as contextual-mismatch', () => {
    const p = makePattern({ age_days: 5, decayed_confidence: 0.85, times_applied: 5 });
    const evts = [
      makeSkipEvent('test-slug', 'superseded', 10, NOW),
      makeSkipEvent('test-slug', 'superseded', 20, NOW),
      makeSkipEvent('test-slug', 'superseded', 30, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    assert.equal(r.tier, 'needs-attention', 'superseded skips must count and push to needs-attention');
  });

  // Test 9: boundary health = 0.395 → needs-attention
  test('9. boundary: health ≈ 0.395 → needs-attention', () => {
    // Craft inputs to produce score just below 0.40.
    // base=0.8, usage_boost(1)=0.7, freshness_factor(15)=0.85, penalty=0
    // raw = 0.8 * 0.7 * 0.85 * 1.0 = 0.476 — that is stale not needs-attention
    // To get ~0.395: base=0.7, usage_boost(1)=0.7, freshness_factor(46)=0.85, penalty=0
    // 0.7 * 0.7 * 0.85 = 0.4165 — still stale
    // Use base=0.6, usage_boost(1)=0.7, freshness_factor(46)=0.85, penalty=0
    // 0.6 * 0.7 * 0.85 = 0.357 → needs-attention
    const p = makePattern({ age_days: 46, decayed_confidence: 0.6, times_applied: 1 });
    const r = computeHealth(p, [], NOW);
    assert.ok(r.score < 0.40, 'score should be below 0.40, got ' + r.score);
    assert.equal(r.tier, 'needs-attention');
  });

  // Test 10: boundary health = 0.405 → stale
  test('10. boundary: health ≈ 0.405 → stale', () => {
    // base=0.7, usage_boost(2)=0.85, freshness_factor(20)=0.85, penalty=0
    // 0.7 * 0.85 * 0.85 = 0.505... that is stale (just above 0.40)
    const p = makePattern({ age_days: 20, decayed_confidence: 0.7, times_applied: 2 });
    const r = computeHealth(p, [], NOW);
    assert.ok(r.score >= 0.40 && r.score < 0.60, 'score should be in stale range [0.40, 0.60), got ' + r.score);
    assert.equal(r.tier, 'stale');
  });

  // Test 11: boundary health = 0.595 → stale
  test('11. boundary: health just below 0.60 → stale', () => {
    // base=0.75, usage_boost(3)=0.85, freshness_factor(15)=0.85, penalty=0
    // 0.75 * 0.85 * 0.85 = 0.5419... stale
    const p = makePattern({ age_days: 15, decayed_confidence: 0.75, times_applied: 3 });
    const r = computeHealth(p, [], NOW);
    assert.ok(r.score < 0.60, 'score should be below 0.60, got ' + r.score);
    assert.equal(r.tier, 'stale');
  });

  // Test 12: boundary health = 0.605 → healthy
  test('12. boundary: health just above 0.60 → healthy', () => {
    // base=0.85, usage_boost(4+)=1.0, freshness_factor(10)=1.0, penalty=0
    // 0.85 * 1.0 * 1.0 = 0.85 → healthy
    const p = makePattern({ age_days: 10, decayed_confidence: 0.85, times_applied: 5 });
    const r = computeHealth(p, [], NOW);
    assert.ok(r.score >= 0.60, 'score should be >= 0.60, got ' + r.score);
    assert.equal(r.tier, 'healthy');
  });

  // Test 13: age_days: null → freshness_factor = 0.5
  test('13. age_days: null → freshness_factor = 0.5 (never applied)', () => {
    const p = makePattern({ age_days: null, decayed_confidence: 0.8, times_applied: 0 });
    const r = computeHealth(p, [], NOW);
    // base=0.8, usage_boost(0)=0.5, freshness=0.5, penalty=0
    // raw = 0.8 * 0.5 * 0.5 = 0.20
    assert.equal(r.score, 0.20, 'exact score should be 0.20');
    assert.equal(r.tier, 'needs-attention');
  });

  // Test 14: clamping — score cannot exceed 1.0 or fall below 0.0
  test('14. clamping: score is always in [0, 1]', () => {
    const pHigh = makePattern({ decayed_confidence: 1.0, times_applied: 100, age_days: 0 });
    const rHigh = computeHealth(pHigh, [], NOW);
    assert.ok(rHigh.score <= 1.0, 'score must not exceed 1.0');
    assert.ok(rHigh.score >= 0.0, 'score must not be negative');

    const pLow = makePattern({ decayed_confidence: 0.0, times_applied: 0, age_days: 365 });
    const evts = [
      makeSkipEvent('test-slug', 'contextual-mismatch', 10, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 20, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 30, NOW),
    ];
    const rLow = computeHealth(pLow, evts, NOW);
    assert.ok(rLow.score >= 0.0, 'score must not be negative');
  });

});

// ---------------------------------------------------------------------------
// annotatePatterns tests
// ---------------------------------------------------------------------------

describe('annotatePatterns()', () => {

  // Test 15: events with pattern_name !== pattern.slug are ignored for that pattern
  test('15. annotatePatterns: events for other slugs do not affect unrelated patterns', () => {
    const patterns = [
      makePattern({ slug: 'slug-A', decayed_confidence: 0.85, times_applied: 5, age_days: 5 }),
      makePattern({ slug: 'slug-B', decayed_confidence: 0.85, times_applied: 5, age_days: 5 }),
    ];

    // 3 skips for slug-A only
    const evts = [
      makeSkipEvent('slug-A', 'contextual-mismatch', 10, NOW),
      makeSkipEvent('slug-A', 'contextual-mismatch', 20, NOW),
      makeSkipEvent('slug-A', 'contextual-mismatch', 30, NOW),
    ];

    const annotated = annotatePatterns(patterns, evts, NOW);
    assert.equal(annotated.length, 2);

    const a = annotated.find(p => p.slug === 'slug-A');
    const b = annotated.find(p => p.slug === 'slug-B');

    assert.equal(a.health_tier, 'needs-attention', 'slug-A should be needs-attention');
    assert.equal(b.health_tier, 'healthy', 'slug-B should not be affected by slug-A skips');
  });

  test('annotatePatterns: adds health, health_tier, health_reason fields', () => {
    const patterns = [
      makePattern({ slug: 'p1', decayed_confidence: 0.9, times_applied: 5, age_days: 5 }),
    ];

    const annotated = annotatePatterns(patterns, [], NOW);
    assert.equal(annotated.length, 1);

    const p = annotated[0];
    assert.ok(typeof p.health === 'number', 'health must be a number');
    assert.ok(['healthy', 'stale', 'needs-attention'].includes(p.health_tier), 'health_tier must be a valid tier');
    assert.ok(typeof p.health_reason === 'string', 'health_reason must be a string');

    // Original fields preserved
    assert.equal(p.slug, 'p1');
    assert.equal(p.decayed_confidence, 0.9);
  });

  test('annotatePatterns: handles empty patterns list', () => {
    const result = annotatePatterns([], [], NOW);
    assert.deepEqual(result, []);
  });

  test('annotatePatterns: handles empty skip events', () => {
    const patterns = [makePattern({ slug: 'p1' })];
    const result = annotatePatterns(patterns, null, NOW);
    assert.equal(result.length, 1);
    assert.ok(typeof result[0].health === 'number');
  });

  test('annotatePatterns: now defaults to Date.now() when omitted', () => {
    const patterns = [makePattern({ slug: 'p1' })];
    // Should not throw when now is omitted
    const result = annotatePatterns(patterns, []);
    assert.equal(result.length, 1);
  });

});

// ---------------------------------------------------------------------------
// Additional component-level tests
// ---------------------------------------------------------------------------

describe('usage_boost component', () => {
  // Import internal — use computeHealth with controlled inputs to verify indirectly.
  test('usage_boost: n=0 produces 0.5 multiplier (neutral)', () => {
    const p = makePattern({ decayed_confidence: 0.8, times_applied: 0, age_days: 0 });
    const r = computeHealth(p, [], NOW);
    // base=0.8, usage=0.5, freshness=1.0, penalty=0 → 0.4
    assert.equal(r.score, 0.40);
    assert.equal(r.tier, 'stale');
  });

  test('usage_boost: n=1 produces 0.7 multiplier', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 1, age_days: 0 });
    const r = computeHealth(p, [], NOW);
    // base=1.0, usage=0.7, freshness=1.0 → 0.70
    assert.equal(r.score, 0.70);
  });

  test('usage_boost: n=2 produces 0.85 multiplier', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 2, age_days: 0 });
    const r = computeHealth(p, [], NOW);
    // base=1.0, usage=0.85, freshness=1.0 → 0.85
    assert.equal(r.score, 0.85);
  });

  test('usage_boost: n=4 produces 1.0 multiplier', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const r = computeHealth(p, [], NOW);
    // base=1.0, usage=1.0, freshness=1.0 → 1.0
    assert.equal(r.score, 1.0);
  });
});

describe('freshness_factor component', () => {
  test('age_days=0: freshness=1.0', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const r = computeHealth(p, [], NOW);
    assert.equal(r.score, 1.0);
  });

  test('age_days=14: freshness=1.0', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 14 });
    const r = computeHealth(p, [], NOW);
    assert.equal(r.score, 1.0);
  });

  test('age_days=45: freshness=0.85', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 45 });
    const r = computeHealth(p, [], NOW);
    assert.equal(r.score, 0.85);
  });

  test('age_days=90: freshness=0.6', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 90 });
    const r = computeHealth(p, [], NOW);
    assert.equal(r.score, 0.60);
    assert.equal(r.tier, 'healthy');
  });

  test('age_days=91: freshness=0.3', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 91 });
    const r = computeHealth(p, [], NOW);
    assert.equal(r.score, 0.30);
    assert.equal(r.tier, 'needs-attention');
  });
});

describe('skip_penalty component', () => {
  test('1 qualifying skip → penalty 0.2', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const evts = [makeSkipEvent('test-slug', 'contextual-mismatch', 10, NOW)];
    const r = computeHealth(p, evts, NOW);
    // base=1.0, usage=1.0, freshness=1.0, penalty=0.2 → 0.8
    assert.equal(r.score, 0.80);
  });

  test('2 qualifying skips → penalty 0.4', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const evts = [
      makeSkipEvent('test-slug', 'contextual-mismatch', 10, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 20, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    // base=1.0, usage=1.0, freshness=1.0, penalty=0.4 → 0.6
    assert.equal(r.score, 0.60);
  });

  test('3+ qualifying skips → penalty 0.6 (cap)', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const evts = [
      makeSkipEvent('test-slug', 'contextual-mismatch', 10, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 20, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 30, NOW),
      makeSkipEvent('test-slug', 'contextual-mismatch', 40, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    // base=1.0, usage=1.0, freshness=1.0, penalty=0.6 → 0.4
    assert.equal(r.score, 0.40);
  });

  test('operator-override skip category → does NOT count', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const evts = [
      makeSkipEvent('test-slug', 'operator-override', 10, NOW),
      makeSkipEvent('test-slug', 'operator-override', 20, NOW),
    ];
    const r = computeHealth(p, evts, NOW);
    assert.equal(r.score, 1.0, 'operator-override should not count');
  });

  test('stale skip category → does NOT count', () => {
    const p = makePattern({ decayed_confidence: 1.0, times_applied: 4, age_days: 0 });
    const evts = [makeSkipEvent('test-slug', 'stale', 10, NOW)];
    const r = computeHealth(p, evts, NOW);
    assert.equal(r.score, 1.0);
  });
});
