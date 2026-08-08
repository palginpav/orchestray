#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/recent-diagnostics.js.
 *
 * Verifies the recency window (rolling N hours from `nowMs`, bounded by a
 * byte-capped tail read of events.jsonl), the diagnostic-suffix filter
 * (_blocked/_failed/_missing/_orphaned/_violation/_gap/_stale/_drift/
 * _detected/_warn), the actionability ranking (tier, then in-window count,
 * then event_type for determinism), and the windowTruncated signal (true
 * only when the tail cap cut off data that was still inside the window).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeRecentDiagnostics,
  isDiagnosticType,
  severityTier,
} = require('../recent-diagnostics');

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-diag-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function eventsPath(dir) {
  return path.join(dir, '.orchestray', 'audit', 'events.jsonl');
}

function writeEvents(dir, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(eventsPath(dir), text);
}

function evt(type, tsIsoOrMsAgo, nowMs) {
  const timestamp = typeof tsIsoOrMsAgo === 'number'
    ? new Date(nowMs - tsIsoOrMsAgo).toISOString()
    : tsIsoOrMsAgo;
  return { type, timestamp };
}

describe('isDiagnosticType / severityTier', () => {
  test('matches all ten diagnostic suffixes', () => {
    const types = [
      'x_warn', 'x_blocked', 'x_failed', 'x_missing', 'x_violation',
      'x_detected', 'x_gap', 'x_orphaned', 'x_stale', 'x_drift',
    ];
    for (const t of types) assert.ok(isDiagnosticType(t), `${t} should match`);
  });

  test('does not match non-diagnostic types', () => {
    assert.ok(!isDiagnosticType('orchestration_start'));
    assert.ok(!isDiagnosticType('task_completed'));
  });

  test('suffix match is anchored to the end of the string', () => {
    // "stale" appears mid-string but the type ends in "_warn" — must tier as warn (3), not stale.
    assert.equal(severityTier('mcp_allowlist_stale_entry_warn'), 3);
  });

  test('tier 1 is blocked/failed, tier 2 is missing/orphaned/violation, tier 3 is gap/stale/drift/detected/warn', () => {
    assert.equal(severityTier('git_destructive_blocked'), 1);
    assert.equal(severityTier('task_validation_failed'), 1);
    assert.equal(severityTier('mcp_checkpoint_missing'), 2);
    assert.equal(severityTier('spawn_drainer_orphaned'), 2);
    assert.equal(severityTier('schema_shape_violation'), 2);
    assert.equal(severityTier('claim_evidence_gap'), 3);
    assert.equal(severityTier('compaction_detected'), 3);
  });
});

describe('computeRecentDiagnostics', () => {
  test('empty when events.jsonl does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-diag-noaudit-'));
    const result = computeRecentDiagnostics(dir, Date.now());
    assert.equal(result.totalMatched, 0);
    assert.deepEqual(result.ranked, []);
    assert.equal(result.windowTruncated, false);
  });

  test('empty when no rows match a diagnostic suffix', () => {
    const dir = mkProject();
    const now = Date.now();
    writeEvents(dir, [evt('orchestration_start', 1000, now), evt('task_completed', 2000, now)]);
    const result = computeRecentDiagnostics(dir, now);
    assert.equal(result.totalMatched, 0);
  });

  test('counts diagnostic-shaped rows within the window', () => {
    const dir = mkProject();
    const now = Date.now();
    writeEvents(dir, [
      evt('git_destructive_blocked', 1000, now),
      evt('git_destructive_blocked', 2000, now),
      evt('schema_shape_violation', 3000, now),
    ]);
    const result = computeRecentDiagnostics(dir, now, { windowHours: 24 });
    assert.equal(result.totalMatched, 3);
    const byType = Object.fromEntries(result.ranked.map((r) => [r.event_type, r.count]));
    assert.equal(byType.git_destructive_blocked, 2);
    assert.equal(byType.schema_shape_violation, 1);
  });

  test('excludes rows older than the window', () => {
    const dir = mkProject();
    const now = Date.now();
    const HOUR = 3600 * 1000;
    writeEvents(dir, [
      evt('git_destructive_blocked', 2 * HOUR, now),       // inside 24h window
      evt('git_destructive_blocked', 30 * HOUR, now),      // outside 24h window
    ]);
    const result = computeRecentDiagnostics(dir, now, { windowHours: 24 });
    assert.equal(result.totalMatched, 1);
  });

  test('ignores malformed lines and rows missing type/timestamp', () => {
    const dir = mkProject();
    const now = Date.now();
    const lines = [
      'not json at all',
      JSON.stringify({ timestamp: new Date(now).toISOString() }), // no type
      JSON.stringify({ type: 'git_destructive_blocked' }),        // no timestamp
      JSON.stringify(evt('git_destructive_blocked', 1000, now)),
    ];
    fs.writeFileSync(eventsPath(dir), lines.join('\n') + '\n');
    const result = computeRecentDiagnostics(dir, now);
    assert.equal(result.totalMatched, 1);
  });

  test('ranks by tier first, then in-window count, then event_type alphabetically', () => {
    const dir = mkProject();
    const now = Date.now();
    const rows = [];
    // tier 2, high volume — must not outrank tier 1 despite the volume.
    for (let i = 0; i < 20; i++) rows.push(evt('schema_shape_violation', 1000, now));
    // tier 1, low volume x2 — event_schemas_full_load_blocked has more hits than git_destructive_blocked.
    rows.push(evt('event_schemas_full_load_blocked', 1000, now));
    rows.push(evt('event_schemas_full_load_blocked', 2000, now));
    rows.push(evt('git_destructive_blocked', 1000, now));
    rows.push(evt('task_validation_failed', 1000, now));
    writeEvents(dir, rows);
    const result = computeRecentDiagnostics(dir, now);
    const order = result.ranked.map((r) => r.event_type);
    assert.deepEqual(order, [
      'event_schemas_full_load_blocked', // tier 1, count 2
      'git_destructive_blocked',         // tier 1, count 1, alphabetically before task_validation_failed
      'task_validation_failed',          // tier 1, count 1
      'schema_shape_violation',          // tier 2, count 20 — still ranks below every tier-1 type
    ]);
  });

  test('windowTruncated is false when the whole file fits under the tail cap', () => {
    const dir = mkProject();
    const now = Date.now();
    writeEvents(dir, [evt('git_destructive_blocked', 1000, now)]);
    const result = computeRecentDiagnostics(dir, now, { tailCapBytes: 1024 * 1024 });
    assert.equal(result.windowTruncated, false);
  });

  test('windowTruncated is true when the tail cap cuts off data still inside the window', () => {
    const dir = mkProject();
    const now = Date.now();
    const HOUR = 3600 * 1000;
    const rows = [];
    // Pad with old, non-matching filler so the file is bigger than the tiny cap below,
    // and the oldest row read back is still inside the 24h window.
    for (let i = 0; i < 500; i++) rows.push(evt('orchestration_start', 23 * HOUR, now));
    rows.push(evt('git_destructive_blocked', 1000, now));
    writeEvents(dir, rows);
    const result = computeRecentDiagnostics(dir, now, { windowHours: 24, tailCapBytes: 512 });
    assert.equal(result.windowTruncated, true);
  });

  test('accepts a custom windowHours', () => {
    const dir = mkProject();
    const now = Date.now();
    const HOUR = 3600 * 1000;
    writeEvents(dir, [evt('git_destructive_blocked', 5 * HOUR, now)]);
    assert.equal(computeRecentDiagnostics(dir, now, { windowHours: 1 }).totalMatched, 0);
    assert.equal(computeRecentDiagnostics(dir, now, { windowHours: 6 }).totalMatched, 1);
  });
});
