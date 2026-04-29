#!/usr/bin/env node
'use strict';

/**
 * Tests for W4-3 — analytics firing-trend dashboard wiring (v2.2.11).
 *
 * The SKILL.md Rollup H logic reads event_activation_ratio rows from
 * .orchestray/audit/events.jsonl and renders a trend table.
 *
 * These tests exercise the helper that parses and summarises those rows.
 *
 * Test 1: 5 valid rows over 5 days → computeFiringTrend returns 5-row trend,
 *         correct avg, correct last-orch snapshot.
 * Test 2: empty events.jsonl → computeFiringTrend returns {rows:[], rowsCount:0}
 *         (no crash; caller renders "no data" message).
 * Test 3: mix of valid + malformed rows → malformed rows skipped; only valid
 *         rows appear in result.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const HELPER = path.resolve(__dirname, '..', 'analytics-firing-trend.js');
const { computeFiringTrend, parseActivationRows } = require(HELPER);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Write a synthetic events.jsonl to a temp file and return the path.
 * Each entry in `rows` is merged with default valid fields.
 */
function makeEventsFile(rows) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w43-trend-'));
  const filePath = path.join(tmp, 'events.jsonl');

  const lines = rows.map(r => JSON.stringify(r));
  fs.writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''));
  return filePath;
}

function isoDay(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Test 1 — 5 valid rows over 5 days → 5-row trend
// ---------------------------------------------------------------------------

describe('computeFiringTrend', () => {
  test('5 valid rows over 5 days produces 5-row trend with correct aggregates', () => {
    const orchIds = [
      'orch-20260424T000000Z',
      'orch-20260425T000000Z',
      'orch-20260426T000000Z',
      'orch-20260427T000000Z',
      'orch-20260428T000000Z',
    ];
    const ratios = [0.27, 0.30, 0.33, 0.35, 0.40];

    const rawRows = orchIds.map((id, i) => ({
      type: 'event_activation_ratio',
      orchestration_id: id,
      timestamp: isoDay(4 - i),  // oldest first
      ratio: ratios[i],
      numerator: Math.round(ratios[i] * 60),
      denominator: 60,
      dark_count: 60 - Math.round(ratios[i] * 60),
    }));

    const eventsFile = makeEventsFile(rawRows);
    const result = computeFiringTrend(eventsFile);

    // Row count
    assert.strictEqual(result.rowsCount, 5, 'should have 5 rows');
    assert.strictEqual(result.rows.length, 5, 'rows array length should be 5');

    // Avg ratio (sum / 5)
    const expectedAvg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    assert.ok(
      Math.abs(result.avgRatio - expectedAvg) < 0.001,
      `avgRatio ${result.avgRatio} should be ~${expectedAvg}`,
    );

    // Last orch should be the most recent (index 4)
    assert.strictEqual(result.lastRow.orchestration_id, orchIds[4]);
    assert.strictEqual(result.lastRow.ratio, ratios[4]);

    // Rows sorted ascending by timestamp — first row is oldest
    assert.strictEqual(result.rows[0].orchestration_id, orchIds[0]);
    assert.strictEqual(result.rows[4].orchestration_id, orchIds[4]);
  });

  // -------------------------------------------------------------------------
  // Test 2 — empty events.jsonl → no crash, rowsCount=0
  // -------------------------------------------------------------------------

  test('empty events.jsonl returns rowsCount 0 without crashing', () => {
    const eventsFile = makeEventsFile([]);
    const result = computeFiringTrend(eventsFile);

    assert.strictEqual(result.rowsCount, 0, 'rowsCount should be 0');
    assert.deepStrictEqual(result.rows, [], 'rows should be empty array');
    assert.strictEqual(result.lastRow, null, 'lastRow should be null');
    assert.strictEqual(result.avgRatio, null, 'avgRatio should be null when no data');
  });

  // -------------------------------------------------------------------------
  // Test 3 — malformed rows skipped, valid rows retained
  // -------------------------------------------------------------------------

  test('malformed event_activation_ratio rows skipped; valid rows retained', () => {
    const validRow = {
      type: 'event_activation_ratio',
      orchestration_id: 'orch-valid-001',
      timestamp: isoDay(1),
      ratio: 0.30,
      numerator: 18,
      denominator: 60,
      dark_count: 42,
    };

    const badRows = [
      // Not JSON — raw string (will be a non-JSON line in the file)
      'this is not json at all',
      // Wrong event type — should be ignored
      JSON.stringify({ type: 'orchestration_start', ratio: 0.5, timestamp: isoDay(2) }),
      // Missing ratio field
      JSON.stringify({ type: 'event_activation_ratio', orchestration_id: 'orch-noratio', timestamp: isoDay(3) }),
      // ratio out of range (> 1)
      JSON.stringify({ type: 'event_activation_ratio', orchestration_id: 'orch-bad-range', timestamp: isoDay(4), ratio: 1.5, numerator: 90, denominator: 60, dark_count: 0 }),
      // ratio is a string (non-numeric)
      JSON.stringify({ type: 'event_activation_ratio', orchestration_id: 'orch-str-ratio', timestamp: isoDay(5), ratio: 'high', numerator: 18, denominator: 60, dark_count: 42 }),
    ];

    // Build file with bad rows interleaved around the one valid row
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w43-malformed-'));
    const filePath = path.join(tmp, 'events.jsonl');
    const lines = [
      badRows[0],
      badRows[1],
      JSON.stringify(validRow),
      badRows[2],
      badRows[3],
      badRows[4],
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = computeFiringTrend(filePath);

    assert.strictEqual(result.rowsCount, 1, 'only 1 valid row should survive');
    assert.strictEqual(result.rows[0].orchestration_id, 'orch-valid-001');
    assert.strictEqual(result.lastRow.ratio, 0.30);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for parseActivationRows (exported for direct testing)
// ---------------------------------------------------------------------------

describe('parseActivationRows', () => {
  test('filters to event_activation_ratio type only using both event and type fields', () => {
    const lines = [
      JSON.stringify({ event: 'event_activation_ratio', ratio: 0.20, timestamp: isoDay(0), numerator: 12, denominator: 60, dark_count: 48 }),
      JSON.stringify({ type:  'event_activation_ratio', ratio: 0.40, timestamp: isoDay(1), numerator: 24, denominator: 60, dark_count: 36 }),
      JSON.stringify({ type:  'other_event',            ratio: 0.99, timestamp: isoDay(2) }),
    ];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w43-parse-'));
    const filePath = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const rows = parseActivationRows(filePath);
    assert.strictEqual(rows.length, 2, 'both event and type field variants should be accepted');
    assert.ok(rows.every(r => typeof r.ratio === 'number'), 'ratio must be numeric');
  });

  test('missing file returns empty array without throwing', () => {
    const missingPath = path.join(os.tmpdir(), 'nonexistent-orch-' + Date.now(), 'events.jsonl');
    const rows = parseActivationRows(missingPath);
    assert.deepStrictEqual(rows, []);
  });
});
