#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/state-gc.js — TTL-based prune of state-file accumulators.
 *
 * Acceptance criteria (from rubric):
 *   - runOnce() prunes 16-day-old fixtures to last-7-days only
 *   - Kill switch ORCHESTRAY_STATE_GC_DISABLED=1 → no GC (returns { skipped: true })
 *
 * v2.2.21 W4-T18: state-gc acceptance tests.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const {
  safeReadJson,
  runOnce,
  _pruneJsonlByTtl,
  _pruneJsonlAndRotations,
  _parseTimestamp,
  DEFAULT_TTL_MS,
} = require('../bin/_lib/state-gc');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const root     = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-gc-test-'));
  const stateDir = path.join(root, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(
    filePath,
    records.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );
}

function readJsonlLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// _parseTimestamp
// ---------------------------------------------------------------------------

describe('_parseTimestamp', () => {
  test('parses a valid ISO timestamp', () => {
    const ms = _parseTimestamp('2026-04-15T18:12:01.001Z');
    assert.ok(ms > 0, 'should return ms > 0');
  });

  test('returns null for null input', () => {
    assert.equal(_parseTimestamp(null), null);
  });

  test('returns null for undefined input', () => {
    assert.equal(_parseTimestamp(undefined), null);
  });

  test('returns null for invalid date string', () => {
    assert.equal(_parseTimestamp('not-a-date'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(_parseTimestamp(''), null);
  });
});

// ---------------------------------------------------------------------------
// _pruneJsonlByTtl
// ---------------------------------------------------------------------------

describe('_pruneJsonlByTtl', () => {
  test('drops entries older than cutoff, keeps recent ones', () => {
    const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-prune-test-'));
    const filePath = path.join(dir, 'test.jsonl');

    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago

    const records = [
      { ts: daysAgoIso(16), data: 'old-1' },      // 16 days old → DROP
      { ts: daysAgoIso(10), data: 'old-2' },      // 10 days old → DROP
      { ts: daysAgoIso(6),  data: 'recent-1' },   // 6 days old  → KEEP
      { timestamp: daysAgoIso(1), data: 'recent-2' }, // 1 day old → KEEP (different field)
      { stop_timestamp: daysAgoIso(20), data: 'old-3' }, // 20 days → DROP
      { data: 'no-timestamp' },                    // no timestamp → KEEP (fail-open)
    ];

    writeJsonl(filePath, records);

    const result = _pruneJsonlByTtl(filePath, cutoffMs);

    assert.equal(result.dropped, 3, 'should drop 3 old entries');
    assert.equal(result.kept,    3, 'should keep 3 recent/no-ts entries');

    const remaining = readJsonlLines(filePath);
    assert.equal(remaining.length, 3);
    assert.ok(remaining.some(r => r.data === 'recent-1'), 'recent-1 must survive');
    assert.ok(remaining.some(r => r.data === 'recent-2'), 'recent-2 must survive');
    assert.ok(remaining.some(r => r.data === 'no-timestamp'), 'no-timestamp entry must survive');
    assert.ok(!remaining.some(r => r.data === 'old-1'), 'old-1 must be dropped');
    assert.ok(!remaining.some(r => r.data === 'old-2'), 'old-2 must be dropped');
    assert.ok(!remaining.some(r => r.data === 'old-3'), 'old-3 must be dropped');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns { kept:0, dropped:0 } when file does not exist', () => {
    const result = _pruneJsonlByTtl('/tmp/does-not-exist-gc-test.jsonl', Date.now());
    assert.deepEqual(result, { kept: 0, dropped: 0 });
  });

  test('keeps all lines when none are older than cutoff', () => {
    const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-prune-test-'));
    const filePath = path.join(dir, 'recent.jsonl');

    writeJsonl(filePath, [
      { ts: daysAgoIso(1), data: 'x' },
      { ts: daysAgoIso(2), data: 'y' },
    ]);

    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const result = _pruneJsonlByTtl(filePath, cutoffMs);

    assert.equal(result.dropped, 0);
    assert.equal(result.kept, 2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('idempotent: calling twice yields same result', () => {
    const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-prune-test-'));
    const filePath = path.join(dir, 'idempotent.jsonl');

    writeJsonl(filePath, [
      { ts: daysAgoIso(16), data: 'old' },
      { ts: daysAgoIso(3),  data: 'new' },
    ]);

    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const r1 = _pruneJsonlByTtl(filePath, cutoffMs);
    const r2 = _pruneJsonlByTtl(filePath, cutoffMs);

    assert.equal(r1.dropped, 1, 'first run drops old entry');
    assert.equal(r2.dropped, 0, 'second run drops nothing (already pruned)');
    assert.equal(r2.kept,    1, 'second run keeps the remaining entry');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runOnce
// ---------------------------------------------------------------------------

describe('runOnce', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.ORCHESTRAY_STATE_GC_DISABLED;
    delete process.env.ORCHESTRAY_STATE_GC_DISABLED;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ORCHESTRAY_STATE_GC_DISABLED;
    } else {
      process.env.ORCHESTRAY_STATE_GC_DISABLED = savedEnv;
    }
  });

  test('prunes 16-day-old routing-pending.jsonl fixtures to last-7-days only', () => {
    const { root, stateDir } = makeTmpProject();
    const filePath = path.join(stateDir, 'routing-pending.jsonl');

    writeJsonl(filePath, [
      { ts: daysAgoIso(16), orchestration_id: 'orch-old-1', result: 'error' },
      { ts: daysAgoIso(14), orchestration_id: 'orch-old-2', result: 'error' },
      { ts: daysAgoIso(8),  orchestration_id: 'orch-old-3', result: 'error' },
      { ts: daysAgoIso(5),  orchestration_id: 'orch-new-1', result: 'ok'    },
      { ts: daysAgoIso(1),  orchestration_id: 'orch-new-2', result: 'ok'    },
    ]);

    const result = runOnce(root, { ttlMs: DEFAULT_TTL_MS });

    assert.ok(!result.skipped, 'should not be skipped');
    const summary = result.results['routing-pending.jsonl'];
    assert.ok(summary, 'should have summary for routing-pending.jsonl');
    assert.equal(summary.dropped, 3, 'should drop 3 entries older than 7 days');
    assert.equal(summary.kept,    2, 'should keep 2 entries within 7 days');

    const remaining = readJsonlLines(filePath);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.every(r => ['orch-new-1', 'orch-new-2'].includes(r.orchestration_id)));

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('prunes stop-hook.jsonl entries older than 7 days', () => {
    const { root, stateDir } = makeTmpProject();
    const filePath = path.join(stateDir, 'stop-hook.jsonl');

    writeJsonl(filePath, [
      { ts: daysAgoIso(20), outcome: 'no_transcript' },
      { ts: daysAgoIso(10), outcome: 'no_transcript' },
      { ts: daysAgoIso(3),  outcome: 'processed'     },
    ]);

    runOnce(root, { ttlMs: DEFAULT_TTL_MS });

    const remaining = readJsonlLines(filePath);
    assert.equal(remaining.length, 1, 'only the recent entry should survive');
    assert.equal(remaining[0].outcome, 'processed');

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('prunes degraded.jsonl including rotated generations', () => {
    const { root, stateDir } = makeTmpProject();
    const activeFile = path.join(stateDir, 'degraded.jsonl');
    const gen1File   = path.join(stateDir, 'degraded.1.jsonl');

    // Active: mix of old and new.
    writeJsonl(activeFile, [
      { ts: daysAgoIso(15), kind: 'agent_registry_stale' },
      { ts: daysAgoIso(2),  kind: 'agent_registry_stale' },
    ]);

    // Generation 1: all old (as F-08 shows: rotated files full of old entries).
    writeJsonl(gen1File, [
      { ts: daysAgoIso(30), kind: 'hook_merge_noop' },
      { ts: daysAgoIso(25), kind: 'hook_merge_noop' },
    ]);

    runOnce(root, { ttlMs: DEFAULT_TTL_MS });

    const activeRemaining = readJsonlLines(activeFile);
    assert.equal(activeRemaining.length, 1, 'active file: old entry dropped');

    const gen1Remaining = readJsonlLines(gen1File);
    assert.equal(gen1Remaining.length, 0, 'gen1: all old entries dropped');

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('ORCHESTRAY_STATE_GC_DISABLED=1 returns { skipped: true } without touching files', () => {
    process.env.ORCHESTRAY_STATE_GC_DISABLED = '1';

    const { root, stateDir } = makeTmpProject();
    const filePath = path.join(stateDir, 'routing-pending.jsonl');

    writeJsonl(filePath, [
      { ts: daysAgoIso(20), orchestration_id: 'orch-old', result: 'error' },
    ]);

    const originalContent = fs.readFileSync(filePath, 'utf8');
    const result = runOnce(root);

    assert.equal(result.skipped, true, 'should return skipped:true');
    const afterContent = fs.readFileSync(filePath, 'utf8');
    assert.equal(afterContent, originalContent, 'file must be untouched when kill switch is set');

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('runOnce is idempotent: calling twice yields same file content', () => {
    const { root, stateDir } = makeTmpProject();
    const filePath = path.join(stateDir, 'routing-pending.jsonl');

    writeJsonl(filePath, [
      { ts: daysAgoIso(16), result: 'error' },
      { ts: daysAgoIso(3),  result: 'ok'    },
    ]);

    runOnce(root, { ttlMs: DEFAULT_TTL_MS });
    const afterFirst = fs.readFileSync(filePath, 'utf8');

    runOnce(root, { ttlMs: DEFAULT_TTL_MS });
    const afterSecond = fs.readFileSync(filePath, 'utf8');

    assert.equal(afterFirst, afterSecond, 'second runOnce must produce identical output');

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('missing state files are handled gracefully (no crash)', () => {
    const { root } = makeTmpProject();
    // stateDir has no files at all.
    assert.doesNotThrow(() => runOnce(root, { ttlMs: DEFAULT_TTL_MS }));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// safeReadJson
// ---------------------------------------------------------------------------

describe('safeReadJson', () => {
  test('returns parsed object for valid JSON', () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-safe-read-'));
    const file = path.join(dir, 'valid.json');
    fs.writeFileSync(file, JSON.stringify({ key: 'value' }));

    const result = safeReadJson(file, {});
    assert.deepEqual(result, { key: 'value' });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns defaultValue and truncates to default on SyntaxError', () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-safe-read-'));
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{corrupted json !!!');

    const defaultValue = {};
    const result = safeReadJson(file, defaultValue);

    assert.deepEqual(result, defaultValue, 'should return defaultValue on corruption');

    // File should have been truncated to the default.
    const afterContent = fs.readFileSync(file, 'utf8').trim();
    assert.equal(afterContent, JSON.stringify(defaultValue), 'file must be truncated to defaultValue');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns defaultValue [] for corrupt array file and truncates to []', () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-safe-read-'));
    const file = path.join(dir, 'corrupt-arr.json');
    fs.writeFileSync(file, '[bad json...');

    const result = safeReadJson(file, []);

    assert.deepEqual(result, [], 'should return [] as defaultValue');
    const afterContent = fs.readFileSync(file, 'utf8').trim();
    assert.equal(afterContent, '[]', 'file must be truncated to []');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns defaultValue for missing file without throwing', () => {
    const result = safeReadJson('/tmp/does-not-exist-safe-read-test.json', { default: true });
    assert.deepEqual(result, { default: true });
  });

  test('second read after self-heal returns the healed defaultValue', () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-safe-read-'));
    const file = path.join(dir, 'recover.json');
    fs.writeFileSync(file, '{bad}');

    // First read: corrupt → heals to {}.
    safeReadJson(file, {});

    // Second read: healed file should parse cleanly.
    const second = safeReadJson(file, { fallback: true });
    assert.deepEqual(second, {}, 'second read must return the healed content');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
