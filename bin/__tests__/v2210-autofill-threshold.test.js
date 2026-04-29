#!/usr/bin/env node
'use strict';

/**
 * v2210-autofill-threshold.test.js -- B3 (v2.2.10).
 *
 * Verifies that audit-event-writer.js promotes `audit_event_autofilled`
 * from silent backstop to fail-loud when the per-event-type autofill rate
 * exceeds the configured threshold (default 20%).
 *
 * Tests:
 *   1. 21 autofills + 79 conformant (21%) -- 1 threshold emit + banner file.
 *   2. 19 autofills + 81 conformant (19%) -- 0 threshold emits; no banner.
 *   3. ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED=1 -- 0 emits regardless.
 *   4. Idempotency: second crossing for same event_type in same orch -- no duplicate.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const GATEWAY     = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(orchId) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-autofill-thresh-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  try {
    fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  } catch (_e) {
    fs.writeFileSync(path.join(pmRefDir, 'event-schemas.md'), '# Event Schemas\n', 'utf8');
  }
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
  return tmpDir;
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(function (l) { return JSON.parse(l); });
}

function bannerFiles(tmpDir) {
  const stateDir = path.join(tmpDir, '.orchestray', 'state');
  try {
    return fs.readdirSync(stateDir)
      .filter(function (n) {
        return n.startsWith('quarantine-banner-autofill-') && n.endsWith('.txt');
      });
  } catch (_e) { return []; }
}

/**
 * Force-reload audit-event-writer so module-level state (Maps, Sets, booleans)
 * is fresh for each test.
 */
function freshWriter() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('audit-event-writer') ||
      key.includes('schema-emit-validator') ||
      key.includes('load-schema-shadow')
    ) {
      delete require.cache[key];
    }
  }
  return require(GATEWAY);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('B3 autofill-threshold (v2.2.10)', function () {

  let savedEnv;

  beforeEach(function () {
    savedEnv = {
      ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED: process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED,
      ORCHESTRAY_AUTOFILL_THRESHOLD:          process.env.ORCHESTRAY_AUTOFILL_THRESHOLD,
    };
    delete process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED;
    delete process.env.ORCHESTRAY_AUTOFILL_THRESHOLD;
  });

  afterEach(function () {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: 21/100 rate fires emit + banner
  // -------------------------------------------------------------------------
  test('Test 1: 21/100 autofill rate fires threshold emit and writes banner file', function () {
    const orchId     = 'orch-b3-t1';
    const tmpDir     = makeTmpRepo(orchId);
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');

    const writer    = freshWriter();
    const testHooks = writer._testHooks;
    testHooks.resetForOrch(orchId);

    const eventType = 'agent_stop';

    // Send 79 conformant first, then 21 autofilled.
    // At the end the ratio is 21/100 = 21% > 20%, so threshold fires.
    for (var i = 0; i < 79; i++) {
      testHooks.trackThreshold(eventType, false, orchId, tmpDir, eventsPath);
    }
    for (var j = 0; j < 21; j++) {
      testHooks.trackThreshold(eventType, true, orchId, tmpDir, eventsPath);
    }

    const events         = readEvents(tmpDir);
    const thresholdEmits = events.filter(function (e) {
      return e.type === 'audit_event_autofill_threshold_exceeded';
    });

    // Exactly one emit — fires at first crossing, not after all 100.
    assert.equal(thresholdEmits.length, 1, 'expected exactly 1 threshold emit');
    assert.equal(thresholdEmits[0].event_type, eventType, 'threshold emit must name the event_type');
    // Threshold fires the moment ratio first exceeds 20%. The autofill events
    // are sent after 79 conformant, so at the crossing point total >= 80.
    assert.ok(thresholdEmits[0].autofilled_count >= 1, 'autofilled_count must be >= 1');
    assert.ok(thresholdEmits[0].total_count >= 80, 'total_count must be >= 80');
    assert.ok(thresholdEmits[0].ratio > 0.20, 'ratio must exceed threshold');

    // Banner file written.
    const banners = bannerFiles(tmpDir);
    assert.equal(banners.length, 1, 'expected exactly 1 banner file');
    const content = fs.readFileSync(path.join(tmpDir, '.orchestray', 'state', banners[0]), 'utf8');
    assert.ok(content.includes(eventType), 'banner must mention the event_type');
    assert.ok(content.includes(orchId), 'banner must mention the orch id');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 2: 19/100 rate does NOT fire
  // -------------------------------------------------------------------------
  test('Test 2: 19/100 autofill rate produces 0 threshold emits and no banner', function () {
    const orchId     = 'orch-b3-t2';
    const tmpDir     = makeTmpRepo(orchId);
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');

    const writer    = freshWriter();
    const testHooks = writer._testHooks;
    testHooks.resetForOrch(orchId);

    const eventType = 'agent_start';

    // 81 conformant first, then 19 autofilled = 19/100 = 19% <= 20%: no emit.
    for (var i = 0; i < 81; i++) {
      testHooks.trackThreshold(eventType, false, orchId, tmpDir, eventsPath);
    }
    for (var j = 0; j < 19; j++) {
      testHooks.trackThreshold(eventType, true, orchId, tmpDir, eventsPath);
    }

    const events         = readEvents(tmpDir);
    const thresholdEmits = events.filter(function (e) {
      return e.type === 'audit_event_autofill_threshold_exceeded';
    });
    assert.equal(thresholdEmits.length, 0, 'expected 0 threshold emits at 19%');
    assert.equal(bannerFiles(tmpDir).length, 0, 'expected 0 banner files at 19%');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 3: kill switch suppresses all emits
  // -------------------------------------------------------------------------
  test('Test 3: ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED=1 suppresses all emits', function () {
    process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = '1';

    const orchId     = 'orch-b3-t3';
    const tmpDir     = makeTmpRepo(orchId);
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');

    const writer    = freshWriter();
    const testHooks = writer._testHooks;
    testHooks.resetForOrch(orchId);

    const eventType = 'task_completed';

    // 100% autofill rate -- would definitely fire without the kill switch.
    for (var i = 0; i < 100; i++) {
      testHooks.trackThreshold(eventType, true, orchId, tmpDir, eventsPath);
    }

    const events         = readEvents(tmpDir);
    const thresholdEmits = events.filter(function (e) {
      return e.type === 'audit_event_autofill_threshold_exceeded';
    });
    assert.equal(thresholdEmits.length, 0, 'kill switch must suppress all threshold emits');
    assert.equal(bannerFiles(tmpDir).length, 0, 'kill switch must suppress banner file creation');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 4: idempotency -- no duplicate emit for same event_type + orch
  // -------------------------------------------------------------------------
  test('Test 4: idempotency -- second crossing for same event_type in same orch emits only once', function () {
    const orchId     = 'orch-b3-t4';
    const tmpDir     = makeTmpRepo(orchId);
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');

    const writer    = freshWriter();
    const testHooks = writer._testHooks;
    testHooks.resetForOrch(orchId);

    const eventType = 'agent_stop';

    // First crossing: 21/21 = 100%.
    for (var i = 0; i < 21; i++) {
      testHooks.trackThreshold(eventType, true, orchId, tmpDir, eventsPath);
    }
    // Second wave: 100 more autofilled events.
    for (var j = 0; j < 100; j++) {
      testHooks.trackThreshold(eventType, true, orchId, tmpDir, eventsPath);
    }

    const events         = readEvents(tmpDir);
    const thresholdEmits = events.filter(function (e) {
      return e.type === 'audit_event_autofill_threshold_exceeded';
    });
    assert.equal(thresholdEmits.length, 1, 'idempotency: must emit exactly once per event_type per orch');
    assert.equal(bannerFiles(tmpDir).length, 1, 'idempotency: must write banner exactly once');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});
