#!/usr/bin/env node
'use strict';

/**
 * v2218-w8-tokenwright-bootstrap.test.js — W8 rolling-median bootstrap acceptance tests.
 *
 * Tests bin/_lib/tokenwright/bootstrap-estimator.js:
 *   1. <3 samples → static fallback 500, no tokenwright_bootstrap_applied event.
 *   2. Median correctness: 5 samples [100,200,300,400,500] → 300; event payload.
 *   3. Per-agent isolation: developer median and researcher median are independent.
 *   4. File missing → 500 + tokenwright_bootstrap_skipped{reason:'metrics_file_missing'}.
 *   5. Even-length: 4 samples [100,200,300,400] → 250; event payload.
 *   6. Kill switch ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED=1 → 500, no event.
 *
 * Runner: node --test bin/__tests__/v2218-w8-tokenwright-bootstrap.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const ESTIMATOR_PATH = path.join(REPO_ROOT, 'bin', '_lib', 'tokenwright', 'bootstrap-estimator');
const SCHEMA_PATH    = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp project root with the required directory structure.
 * Copies event-schemas.md so schema-emit-validator takes the validation path.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-w8-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  if (fs.existsSync(SCHEMA_PATH)) {
    fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  }
  return dir;
}

/**
 * Build a minimal tokenwright_realized_savings JSONL line.
 */
function makeSavingsLine(agentType, actualInputTokens) {
  return JSON.stringify({
    type:                  'tokenwright_realized_savings',
    event_type:            'tokenwright_realized_savings',
    agent_type:            agentType,
    actual_input_tokens:   actualInputTokens,
    estimated_input_tokens_pre: 500,
    technique_tag:         'safe-l1',
    version:               1,
    timestamp:             new Date().toISOString(),
  });
}

/**
 * Write tokenwright_realized_savings rows to events.jsonl.
 */
function writeEvents(dir, lines) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n', 'utf8');
  return eventsPath;
}

/**
 * Read events.jsonl as parsed objects.
 */
function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/**
 * Fresh require of bootstrap-estimator (bypasses module cache so each test
 * starts clean with its own env state).
 */
function freshRequire(dir) {
  // Clear module cache for estimator and its deps so env changes take effect
  Object.keys(require.cache).forEach(k => {
    if (k.includes('bootstrap-estimator') ||
        k.includes('audit-event-writer') ||
        k.includes('schema-emit-validator')) {
      delete require.cache[k];
    }
  });
  return require(ESTIMATOR_PATH);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W8 bootstrap-estimator', () => {
  let tmpDir;
  let origEnv;

  beforeEach(() => {
    tmpDir  = makeRepo();
    origEnv = Object.assign({}, process.env);
    // Point the estimator at the tmp project root
    process.env.ORCHESTRAY_PROJECT_ROOT = tmpDir;
    delete process.env.ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED;
  });

  afterEach(() => {
    // Restore env
    Object.keys(process.env).forEach(k => {
      if (!(k in origEnv)) delete process.env[k];
    });
    Object.assign(process.env, origEnv);
    // Clean up tmp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
  });

  // -------------------------------------------------------------------------
  // Test 1: <3 samples → static fallback, no bootstrap_applied event
  // -------------------------------------------------------------------------
  test('1. fewer than 3 samples → returns STATIC_FALLBACK, no bootstrap_applied event', () => {
    // Write 2 rows for developer
    writeEvents(tmpDir, [
      makeSavingsLine('developer', 100),
      makeSavingsLine('developer', 200),
    ]);

    const { bootstrapEstimate, STATIC_FALLBACK } = freshRequire(tmpDir);
    const result = bootstrapEstimate('developer', { cwd: tmpDir });

    assert.strictEqual(result, STATIC_FALLBACK, 'should return 500');

    // No tokenwright_bootstrap_applied should have been emitted
    const events = readEvents(tmpDir);
    const applied = events.filter(e => e.type === 'tokenwright_bootstrap_applied');
    assert.strictEqual(applied.length, 0, 'no bootstrap_applied event expected');

    // A skipped event should have been emitted
    const skipped = events.filter(e => e.type === 'tokenwright_bootstrap_skipped');
    assert.strictEqual(skipped.length, 1, 'one bootstrap_skipped event expected');
    assert.strictEqual(skipped[0].reason, 'insufficient_samples');
    assert.strictEqual(skipped[0].agent_type, 'developer');
  });

  // -------------------------------------------------------------------------
  // Test 2: 5 samples [100,200,300,400,500] → median 300; event payload
  // -------------------------------------------------------------------------
  test('2. 5 samples → median 300; tokenwright_bootstrap_applied event with correct payload', () => {
    writeEvents(tmpDir, [
      makeSavingsLine('developer', 100),
      makeSavingsLine('developer', 200),
      makeSavingsLine('developer', 300),
      makeSavingsLine('developer', 400),
      makeSavingsLine('developer', 500),
    ]);

    const { bootstrapEstimate, STATIC_FALLBACK } = freshRequire(tmpDir);
    const result = bootstrapEstimate('developer', { cwd: tmpDir });

    assert.strictEqual(result, 300, 'median of [100,200,300,400,500] is 300');

    const events = readEvents(tmpDir);
    const applied = events.filter(e => e.type === 'tokenwright_bootstrap_applied');
    assert.strictEqual(applied.length, 1, 'one bootstrap_applied event expected');

    const evt = applied[0];
    assert.strictEqual(evt.agent_type, 'developer');
    assert.strictEqual(evt.sample_size, 5);
    assert.strictEqual(evt.median_actual_tokens, 300);
    assert.strictEqual(evt.pre_estimate, STATIC_FALLBACK);
    assert.strictEqual(evt.post_estimate, 300);
    assert.ok(evt.ts || evt.timestamp, 'event should have timestamp');
  });

  // -------------------------------------------------------------------------
  // Test 3: per-agent isolation
  // -------------------------------------------------------------------------
  test('3. developer and researcher medians are independent', () => {
    writeEvents(tmpDir, [
      makeSavingsLine('developer',  100),
      makeSavingsLine('researcher', 1000),
      makeSavingsLine('developer',  200),
      makeSavingsLine('researcher', 2000),
      makeSavingsLine('developer',  300),
      makeSavingsLine('researcher', 3000),
      makeSavingsLine('developer',  400),
      makeSavingsLine('researcher', 4000),
      makeSavingsLine('developer',  500),
      makeSavingsLine('researcher', 5000),
    ]);

    const { bootstrapEstimate } = freshRequire(tmpDir);

    const devResult  = bootstrapEstimate('developer',  { cwd: tmpDir });
    const resResult  = bootstrapEstimate('researcher', { cwd: tmpDir });

    assert.strictEqual(devResult, 300,  'developer median = 300');
    assert.strictEqual(resResult, 3000, 'researcher median = 3000');
  });

  // -------------------------------------------------------------------------
  // Test 4: file missing → 500 + tokenwright_bootstrap_skipped{reason:'metrics_file_missing'}
  // -------------------------------------------------------------------------
  test('4. events file missing → STATIC_FALLBACK + bootstrap_skipped with metrics_file_missing', () => {
    // No events file written to tmpDir
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(!fs.existsSync(eventsPath), 'events.jsonl must not exist for this test');

    const { bootstrapEstimate, STATIC_FALLBACK } = freshRequire(tmpDir);
    const result = bootstrapEstimate('developer', { cwd: tmpDir });

    assert.strictEqual(result, STATIC_FALLBACK, 'should return 500');

    // The estimator emits skipped to events.jsonl, which it creates
    const events = readEvents(tmpDir);
    const skipped = events.filter(e => e.type === 'tokenwright_bootstrap_skipped');
    assert.strictEqual(skipped.length, 1, 'one bootstrap_skipped event expected');
    assert.strictEqual(skipped[0].reason, 'metrics_file_missing');
    assert.strictEqual(skipped[0].agent_type, 'developer');
  });

  // -------------------------------------------------------------------------
  // Test 5: even-length median: 4 samples [100,200,300,400] → 250
  // -------------------------------------------------------------------------
  test('5. even-length: 4 samples [100,200,300,400] → median 250; event payload', () => {
    writeEvents(tmpDir, [
      makeSavingsLine('tester', 100),
      makeSavingsLine('tester', 200),
      makeSavingsLine('tester', 300),
      makeSavingsLine('tester', 400),
    ]);

    const { bootstrapEstimate, STATIC_FALLBACK } = freshRequire(tmpDir);
    const result = bootstrapEstimate('tester', { cwd: tmpDir });

    assert.strictEqual(result, 250, 'median of [100,200,300,400] = avg(200,300) = 250');

    const events = readEvents(tmpDir);
    const applied = events.filter(e => e.type === 'tokenwright_bootstrap_applied');
    assert.strictEqual(applied.length, 1);

    const evt = applied[0];
    assert.strictEqual(evt.median_actual_tokens, 250);
    assert.strictEqual(evt.pre_estimate, STATIC_FALLBACK);
    assert.strictEqual(evt.post_estimate, 250);
  });

  // -------------------------------------------------------------------------
  // Test 6: kill switch → 500, no event
  // -------------------------------------------------------------------------
  test('6. ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED=1 → STATIC_FALLBACK, no event', () => {
    // Pre-stage enough samples to normally trigger the bootstrap
    writeEvents(tmpDir, [
      makeSavingsLine('reviewer', 1000),
      makeSavingsLine('reviewer', 2000),
      makeSavingsLine('reviewer', 3000),
      makeSavingsLine('reviewer', 4000),
      makeSavingsLine('reviewer', 5000),
    ]);

    process.env.ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED = '1';

    const { bootstrapEstimate, STATIC_FALLBACK } = freshRequire(tmpDir);
    const result = bootstrapEstimate('reviewer', { cwd: tmpDir });

    assert.strictEqual(result, STATIC_FALLBACK, 'kill switch: must return 500');

    // No events should have been emitted by the bootstrap estimator
    // (events.jsonl existed with 5 savings rows; any new rows = bootstrap fired)
    const events = readEvents(tmpDir);
    const bootstrapEvents = events.filter(
      e => e.type === 'tokenwright_bootstrap_applied' ||
           e.type === 'tokenwright_bootstrap_skipped'
    );
    assert.strictEqual(bootstrapEvents.length, 0, 'kill switch: no bootstrap events');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for computeMedian helper
// ---------------------------------------------------------------------------

describe('computeMedian helper', () => {
  test('odd-length median', () => {
    const { computeMedian } = require(ESTIMATOR_PATH);
    assert.strictEqual(computeMedian([3, 1, 2]), 2);
    assert.strictEqual(computeMedian([5]), 5);
    assert.strictEqual(computeMedian([10, 20, 30, 40, 50]), 30);
  });

  test('even-length median', () => {
    const { computeMedian } = require(ESTIMATOR_PATH);
    assert.strictEqual(computeMedian([1, 2, 3, 4]), 2.5);
    assert.strictEqual(computeMedian([100, 200, 300, 400]), 250);
  });

  test('already sorted input unchanged by sort', () => {
    const { computeMedian } = require(ESTIMATOR_PATH);
    const input = [1, 5, 10];
    assert.strictEqual(computeMedian(input), 5);
    // Original array not mutated
    assert.deepStrictEqual(input, [1, 5, 10]);
  });
});
