#!/usr/bin/env node
'use strict';

/**
 * v2212-w1b-recordmiss-split.test.js — W-MISS-SPLIT fix verification.
 *
 * Asserts the W1b patch to `bin/_lib/audit-event-writer.js`:
 *   1. Known type with bad shape → `schema_shape_violation` fires once,
 *      `schema_shadow_validation_block` fires, recordMiss NOT incremented.
 *   2. Same known type with bad shape again in same process → rate-limit
 *      suppresses the second `schema_shape_violation`.
 *   3. Different known type with bad shape → `schema_shape_violation` fires
 *      (rate-limit is per-type, not global).
 *   4. Unknown type → recordMiss IS called + `schema_unknown_type_warn` fires.
 *
 * Tests 1–3 execute within a single child process so the module-level
 * `_shapeViolationWarnedTypes` Map persists across calls. Each test reads the
 * same shared events.jsonl (accumulated from a single 3-call child run).
 * Test 4 uses its own isolated child process.
 */

const { test, describe, before } = require('node:test');
const assert                     = require('node:assert/strict');
const { spawnSync }              = require('node:child_process');
const path                       = require('node:path');
const fs                         = require('node:fs');
const os                         = require('node:os');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const GATEWAY     = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');
const MISSES_FILE = 'schema-shadow-misses.jsonl';

function makeTmpRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-w1b-test-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  const shadowSrc = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
  if (fs.existsSync(shadowSrc)) {
    fs.copyFileSync(shadowSrc, path.join(pmRefDir, 'event-schemas.shadow.json'));
  }
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  return tmpDir;
}

function readEventsJsonl(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readMissesJsonl(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', MISSES_FILE);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function runHarness(harness, timeout) {
  return spawnSync(process.execPath, ['-e', harness], {
    encoding: 'utf8',
    timeout:  timeout || 20000,
  });
}

// ---------------------------------------------------------------------------
// Shared fixture for tests 1–3: a single child process emits 3 events so
// the module-level _shapeViolationWarnedTypes Map persists across all calls.
//
//   Call A: tier2_load (bad shape) — first emit of this type
//   Call B: tier2_load (bad shape) — second emit (rate-limit fires)
//   Call C: routing_outcome (bad shape) — different type, own rate-limit slot
// ---------------------------------------------------------------------------

let sharedTmpDir = null;
let sharedEvents = null;
let sharedMisses = null;

describe('W-MISS-SPLIT (v2.2.12 W1b) — recordMiss split and schema_shape_violation', () => {

  before(() => {
    sharedTmpDir = makeTmpRepo();
    const opts   = JSON.stringify({ cwd: sharedTmpDir });
    const harness = `
      const { writeEvent } = require(${JSON.stringify(GATEWAY)});
      const opts = ${opts};
      // A: tier2_load first time — known type, bad shape (missing required fields)
      writeEvent({ version: 1, type: 'tier2_load' }, opts);
      // B: tier2_load second time — rate-limit should suppress schema_shape_violation
      writeEvent({ version: 1, type: 'tier2_load' }, opts);
      // C: routing_outcome — different known type, bad shape; gets its own limit slot
      writeEvent({ version: 1, type: 'routing_outcome' }, opts);
    `;
    runHarness(harness);
    sharedEvents = readEventsJsonl(sharedTmpDir);
    sharedMisses = readMissesJsonl(sharedTmpDir);
  });

  // -------------------------------------------------------------------------
  // Test 1: known type bad shape → schema_shape_violation fires once,
  //         schema_shadow_validation_block fires, recordMiss NOT called.
  // -------------------------------------------------------------------------
  test('1: known type + bad shape → schema_shape_violation fires; schema_shadow_validation_block fires; recordMiss NOT incremented', () => {
    const shapeViolations = sharedEvents.filter((e) => e.type === 'schema_shape_violation');
    const surrogates      = sharedEvents.filter((e) => e.type === 'schema_shadow_validation_block');

    // schema_shape_violation fires for tier2_load (call A)
    const svTier2 = shapeViolations.filter((e) => e.event_type === 'tier2_load');
    assert.equal(svTier2.length, 1,
      'schema_shape_violation for tier2_load must fire exactly once; got: ' + svTier2.length);
    assert.equal(svTier2[0].rate_limited, false,
      'first schema_shape_violation must have rate_limited: false');

    // schema_shadow_validation_block fires (backward-compat surrogate)
    const surTier2 = surrogates.filter((e) => e.blocked_event_type === 'tier2_load');
    assert.ok(surTier2.length >= 1,
      'schema_shadow_validation_block must fire for tier2_load; got: ' + surTier2.length);

    // recordMiss NOT called — misses log must be empty
    assert.equal(sharedMisses.length, 0,
      'recordMiss must NOT be called for shape violations; misses log has ' + sharedMisses.length + ' entries');
  });

  // -------------------------------------------------------------------------
  // Test 2: same known type, bad shape again → schema_shape_violation does NOT
  //         fire a second time (per-type rate-limit).
  // -------------------------------------------------------------------------
  test('2: same type + bad shape again → schema_shape_violation rate-limited (not fired again)', () => {
    const svTier2 = sharedEvents.filter(
      (e) => e.type === 'schema_shape_violation' && e.event_type === 'tier2_load'
    );
    // Despite calls A and B both failing validation for tier2_load, only one
    // schema_shape_violation must appear.
    assert.equal(svTier2.length, 1,
      'schema_shape_violation for tier2_load fires only once even after 2 calls; got: ' + svTier2.length);

    // But schema_shadow_validation_block still fires for EACH call (backward-compat)
    const surTier2 = sharedEvents.filter(
      (e) => e.type === 'schema_shadow_validation_block' && e.blocked_event_type === 'tier2_load'
    );
    assert.equal(surTier2.length, 2,
      'schema_shadow_validation_block fires for each bad-shape call (2 for tier2_load); got: ' + surTier2.length);
  });

  // -------------------------------------------------------------------------
  // Test 3: different known type with bad shape → schema_shape_violation fires
  //         (rate-limit is per-type, not global).
  // -------------------------------------------------------------------------
  test('3: different known type + bad shape → schema_shape_violation fires (per-type limit)', () => {
    const svRouting = sharedEvents.filter(
      (e) => e.type === 'schema_shape_violation' && e.event_type === 'routing_outcome'
    );
    assert.equal(svRouting.length, 1,
      'schema_shape_violation for routing_outcome (different type) must fire exactly once; got: ' + svRouting.length);
    assert.equal(svRouting[0].rate_limited, false,
      'routing_outcome schema_shape_violation must have rate_limited: false');

    // Also confirm misses log still empty (shape violations never call recordMiss)
    assert.equal(sharedMisses.length, 0,
      'recordMiss must NOT have been called for routing_outcome shape violation either');
  });

  // -------------------------------------------------------------------------
  // Test 4: unknown type → recordMiss IS called + schema_unknown_type_warn fires.
  //         Uses its own isolated child process.
  // -------------------------------------------------------------------------
  test('4: unknown type → recordMiss IS called + schema_unknown_type_warn fires', () => {
    const tmpDir = makeTmpRepo();
    try {
      const opts    = JSON.stringify({ cwd: tmpDir });
      const harness = `
        const { writeEvent } = require(${JSON.stringify(GATEWAY)});
        const opts = ${opts};
        writeEvent({ version: 1, type: 'totally_unknown_type_w1b_test_xyz' }, opts);
      `;
      runHarness(harness);

      const events = readEventsJsonl(tmpDir);
      const misses = readMissesJsonl(tmpDir);

      // schema_unknown_type_warn must fire
      const advisories = events.filter((e) => e.type === 'schema_unknown_type_warn');
      assert.equal(advisories.length, 1,
        'schema_unknown_type_warn must fire for unknown type; got: ' + advisories.length);
      assert.equal(advisories[0].unknown_event_type, 'totally_unknown_type_w1b_test_xyz',
        'unknown_event_type field must match the submitted type');

      // recordMiss IS called — misses log must have at least one entry
      assert.ok(misses.length >= 1,
        'recordMiss must be called for unknown types; misses log is empty');
      const missTypes = misses.map((m) => m.event_type);
      assert.ok(missTypes.includes('totally_unknown_type_w1b_test_xyz'),
        'misses log must include the unknown event type; got: ' + JSON.stringify(missTypes));

      // schema_shape_violation must NOT fire (unknown type ≠ shape violation)
      const shapeViolations = events.filter((e) => e.type === 'schema_shape_violation');
      assert.equal(shapeViolations.length, 0,
        'schema_shape_violation must NOT fire for unknown type; got: ' + shapeViolations.length);

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // Cleanup shared fixture too (here is a convenient point since test 4 is last)
      if (sharedTmpDir) {
        try { fs.rmSync(sharedTmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        sharedTmpDir = null;
      }
    }
  });

});
