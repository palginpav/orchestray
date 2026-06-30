'use strict';

/**
 * Unit tests for bin/_lib/oversized-input.js
 *
 * TDD spec — written before the implementation.
 * Run: node --test tests/oversized-input-helper.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  estimateTokens,
  planSlices,
  enforceSliceCap,
  buildManifest,
} = require('../bin/_lib/oversized-input');

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  test('string input: uses 4-chars-per-token heuristic', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    assert.equal(estimateTokens('hello world'), 3);
  });

  test('string input: empty string returns 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('string input: exact multiple of 4', () => {
    // "abcd" = 4 chars → ceil(4/4) = 1
    assert.equal(estimateTokens('abcd'), 1);
  });

  test('numeric char count: 400 chars → 100 tokens', () => {
    assert.equal(estimateTokens(400), 100);
  });

  test('numeric char count: ceil applied (non-multiple)', () => {
    // 13 chars → ceil(13/4) = 4
    assert.equal(estimateTokens(13), 4);
  });

  test('numeric char count: 0 returns 0', () => {
    assert.equal(estimateTokens(0), 0);
  });
});

// ---------------------------------------------------------------------------
// planSlices
// ---------------------------------------------------------------------------

describe('planSlices', () => {
  test('exact case: totalChars=18000, sliceChars=6000, maxSlices=64 — 3 slices, not capped', () => {
    const result = planSlices({ totalChars: 18000, sliceChars: 6000, maxSlices: 64 });
    assert.equal(result.naturalCount, 3);
    assert.equal(result.capped, false);
    assert.equal(result.slices.length, 3);
    assert.deepEqual(result.slices[0], { index: 0, start: 0, end: 6000 });
    assert.deepEqual(result.slices[1], { index: 1, start: 6000, end: 12000 });
    assert.deepEqual(result.slices[2], { index: 2, start: 12000, end: 18000 });
  });

  test('boundary: last slice end = totalChars when not a multiple of sliceChars', () => {
    // totalChars=13000, sliceChars=6000 → naturalCount=ceil(13000/6000)=3
    const result = planSlices({ totalChars: 13000, sliceChars: 6000, maxSlices: 64 });
    assert.equal(result.naturalCount, 3);
    assert.equal(result.capped, false);
    assert.equal(result.slices.length, 3);
    assert.deepEqual(result.slices[0], { index: 0, start: 0, end: 6000 });
    assert.deepEqual(result.slices[1], { index: 1, start: 6000, end: 12000 });
    // Last slice ends at totalChars, not at sliceChars boundary
    assert.deepEqual(result.slices[2], { index: 2, start: 12000, end: 13000 });
  });

  test('capped case: naturalCount > maxSlices — capped=true, slices limited to maxSlices', () => {
    // totalChars=400000, sliceChars=6000 → naturalCount=ceil(400000/6000)=67 > maxSlices=64
    const result = planSlices({ totalChars: 400000, sliceChars: 6000, maxSlices: 64 });
    assert.equal(result.naturalCount, 67);
    assert.equal(result.capped, true);
    assert.equal(result.slices.length, 64);
    assert.equal(result.slices[0].index, 0);
    assert.equal(result.slices[63].index, 63);
  });

  test('single slice: totalChars <= sliceChars', () => {
    const result = planSlices({ totalChars: 1000, sliceChars: 6000, maxSlices: 64 });
    assert.equal(result.naturalCount, 1);
    assert.equal(result.capped, false);
    assert.equal(result.slices.length, 1);
    assert.deepEqual(result.slices[0], { index: 0, start: 0, end: 1000 });
  });

  test('capped: first maxSlices slice start/end values are correct', () => {
    const result = planSlices({ totalChars: 70000, sliceChars: 1000, maxSlices: 10 });
    // naturalCount = 70, capped = true, only first 10 slices returned
    assert.equal(result.naturalCount, 70);
    assert.equal(result.capped, true);
    assert.equal(result.slices.length, 10);
    assert.deepEqual(result.slices[9], { index: 9, start: 9000, end: 10000 });
  });
});

// ---------------------------------------------------------------------------
// enforceSliceCap
// ---------------------------------------------------------------------------

describe('enforceSliceCap', () => {
  test('direct mode: naturalCount <= maxSlices', () => {
    const result = enforceSliceCap({ naturalCount: 3, maxSlices: 64, hierarchicalReduce: true });
    assert.equal(result.mode, 'direct');
  });

  test('direct mode: naturalCount exactly equals maxSlices', () => {
    const result = enforceSliceCap({ naturalCount: 64, maxSlices: 64, hierarchicalReduce: true });
    assert.equal(result.mode, 'direct');
  });

  test('hierarchical mode: naturalCount > maxSlices AND hierarchicalReduce=true', () => {
    // naturalCount=100, maxSlices=64 → batches=ceil(100/64)=2
    const result = enforceSliceCap({ naturalCount: 100, maxSlices: 64, hierarchicalReduce: true });
    assert.equal(result.mode, 'hierarchical');
    assert.equal(result.batches, 2);
  });

  test('hierarchical mode: batches math — ceil(naturalCount/maxSlices)', () => {
    // naturalCount=128, maxSlices=64 → batches=ceil(128/64)=2
    const r1 = enforceSliceCap({ naturalCount: 128, maxSlices: 64, hierarchicalReduce: true });
    assert.equal(r1.batches, 2);
    // naturalCount=129, maxSlices=64 → batches=ceil(129/64)=3
    const r2 = enforceSliceCap({ naturalCount: 129, maxSlices: 64, hierarchicalReduce: true });
    assert.equal(r2.batches, 3);
  });

  test('refuse mode: naturalCount > maxSlices AND hierarchicalReduce=false', () => {
    const result = enforceSliceCap({ naturalCount: 100, maxSlices: 64, hierarchicalReduce: false });
    assert.equal(result.mode, 'refuse');
    // reason must mention the cap (max_slices value)
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0,
      'refuse mode must include a reason string');
    assert.ok(result.reason.includes('64'), 'reason must reference the max_slices cap value');
  });

  test('refuse mode: reason is a non-empty string', () => {
    const result = enforceSliceCap({ naturalCount: 200, maxSlices: 32, hierarchicalReduce: false });
    assert.equal(result.mode, 'refuse');
    assert.ok(result.reason.includes('32'), 'reason must reference max_slices=32');
  });
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

describe('buildManifest', () => {
  const FIXED_NOW = '2026-01-15T12:00:00.000Z';

  test('deterministic createdAt when now is provided', () => {
    const result = buildManifest({
      corpusId: 'corpus-abc',
      totalBytes: 1000000,
      totalChars: 800000,
      fileCount: 10,
      sliceChars: 6000,
      maxSlices: 64,
      now: FIXED_NOW,
    });
    assert.equal(result.createdAt, FIXED_NOW);
  });

  test('estTokens uses 4-chars-per-token heuristic', () => {
    // totalChars=800000 → estTokens=ceil(800000/4)=200000
    const result = buildManifest({
      corpusId: 'corpus-abc',
      totalBytes: 1000000,
      totalChars: 800000,
      fileCount: 10,
      sliceChars: 6000,
      maxSlices: 64,
      now: FIXED_NOW,
    });
    assert.equal(result.estTokens, 200000);
  });

  test('manifest shape includes all required fields', () => {
    const result = buildManifest({
      corpusId: 'corpus-xyz',
      totalBytes: 500000,
      totalChars: 400000,
      fileCount: 5,
      sliceChars: 6000,
      maxSlices: 64,
      now: FIXED_NOW,
    });
    assert.equal(result.corpusId, 'corpus-xyz');
    assert.equal(result.totalBytes, 500000);
    assert.equal(result.totalChars, 400000);
    assert.equal(result.fileCount, 5);
    assert.ok(result.slicePlan, 'slicePlan must be present');
    assert.ok('naturalCount' in result.slicePlan, 'slicePlan.naturalCount must be present');
    assert.ok('capped' in result.slicePlan, 'slicePlan.capped must be present');
    assert.ok('mode' in result.slicePlan, 'slicePlan.mode must be present');
    assert.equal(result.createdAt, FIXED_NOW);
  });

  test('slicePlan reflects planSlices and enforceSliceCap', () => {
    // totalChars=18000, sliceChars=6000, maxSlices=64 → naturalCount=3, capped=false, mode=direct
    const result = buildManifest({
      corpusId: 'c1',
      totalBytes: 18000,
      totalChars: 18000,
      fileCount: 1,
      sliceChars: 6000,
      maxSlices: 64,
      now: FIXED_NOW,
    });
    assert.equal(result.slicePlan.naturalCount, 3);
    assert.equal(result.slicePlan.capped, false);
    assert.equal(result.slicePlan.mode, 'direct');
  });

  test('now defaults to current time when omitted (roughly within last second)', () => {
    const before = Date.now();
    const result = buildManifest({
      corpusId: 'c2',
      totalBytes: 100,
      totalChars: 80,
      fileCount: 1,
      sliceChars: 6000,
      maxSlices: 64,
    });
    const after = Date.now();
    const ts = new Date(result.createdAt).getTime();
    assert.ok(ts >= before && ts <= after, 'createdAt should be between before and after');
  });

  test('now accepts a Date object', () => {
    const d = new Date('2026-03-01T00:00:00.000Z');
    const result = buildManifest({
      corpusId: 'c3',
      totalBytes: 100,
      totalChars: 80,
      fileCount: 1,
      sliceChars: 6000,
      maxSlices: 64,
      now: d,
    });
    assert.equal(result.createdAt, '2026-03-01T00:00:00.000Z');
  });

  test('hierarchicalReduce omitted (default) → over-cap corpus uses hierarchical mode', () => {
    // totalChars=400000, sliceChars=6000 → naturalCount=67 > maxSlices=64 → hierarchical
    const result = buildManifest({
      corpusId: 'c4',
      totalBytes: 400000,
      totalChars: 400000,
      fileCount: 1,
      sliceChars: 6000,
      maxSlices: 64,
      now: '2026-01-15T12:00:00.000Z',
    });
    assert.equal(result.slicePlan.mode, 'hierarchical',
      'default hierarchicalReduce (omitted) must produce hierarchical mode for over-cap corpus');
  });

  test('hierarchicalReduce:false → over-cap corpus produces refuse mode', () => {
    // totalChars=400000, sliceChars=6000 → naturalCount=67 > maxSlices=64 → refuse
    const result = buildManifest({
      corpusId: 'c5',
      totalBytes: 400000,
      totalChars: 400000,
      fileCount: 1,
      sliceChars: 6000,
      maxSlices: 64,
      hierarchicalReduce: false,
      now: '2026-01-15T12:00:00.000Z',
    });
    assert.equal(result.slicePlan.mode, 'refuse',
      'hierarchicalReduce:false must produce refuse mode for over-cap corpus');
  });

  test('hierarchicalReduce:true → over-cap corpus produces hierarchical mode', () => {
    // Explicit true same as omitted
    const result = buildManifest({
      corpusId: 'c6',
      totalBytes: 400000,
      totalChars: 400000,
      fileCount: 1,
      sliceChars: 6000,
      maxSlices: 64,
      hierarchicalReduce: true,
      now: '2026-01-15T12:00:00.000Z',
    });
    assert.equal(result.slicePlan.mode, 'hierarchical',
      'hierarchicalReduce:true must produce hierarchical mode for over-cap corpus');
  });
});
