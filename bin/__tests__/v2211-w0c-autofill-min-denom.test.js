#!/usr/bin/env node
'use strict';

/**
 * v2211-w0c-autofill-min-denom.test.js -- W0c (v2.2.11).
 *
 * Verifies the B3 min-denominator guard is wired into the production happy
 * path (emitAutofillTelemetry callsite in writeEvent).
 *
 * Before W0c, _trackAutofillThreshold was dead code — only reachable via
 * _testHooks.trackThreshold. These tests drive writeEvent directly to confirm
 * the production path now increments the counter.
 *
 * Tests:
 *   1. total_count=1, autofill_count=1 (100%): NO emit (below min-denominator).
 *   2. total_count=19, autofill_count=5 (~26%): NO emit (below min-denominator).
 *   3. total_count=20, autofill_count=4 (20%): NO emit (at threshold, not above).
 *   4. total_count=20, autofill_count=5 (25%): emit fires once; orchestration_id attributed.
 *   5. total_count=100, autofill_count=21 (21%): emit fires once.
 *   6. Kill switch ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED=1: cases 4+5 -> NO emit.
 *   7. Regression: existing autofill paths are not broken.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

const GATEWAY = path.resolve(__dirname, '..', '_lib', 'audit-event-writer.js');

// ---------------------------------------------------------------------------
// Minimal synthetic event-schemas.md
// ---------------------------------------------------------------------------
// Single type: test_evt_fill
//   - All events use this type so they share one denominator key in
//     _trackAutofillThreshold (keyed by orchId + '::' + eventType).
//   - When sent with timestamp+orchId pre-set: autofilledFields is empty
//     → wasAutofilled=false (conformant observation).
//   - When sent without timestamp+orchId: withAutofill adds them
//     → autofilledFields is non-empty → wasAutofilled=true.
const SYNTHETIC_SCHEMA = `# Event Schemas (minimal fixture for W0c tests)

### \`test_evt_fill\` event

Test event for W0c min-denominator guard.

\`\`\`json
{
  "type": "test_evt_fill",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx"
}
\`\`\`
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal tmp repo with:
 *   - synthetic event-schemas.md
 *   - current-orchestration.json pointing at orchId
 *   - empty events.jsonl
 */
function makeTmpRepo(orchId) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w0c-mindenom-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.writeFileSync(path.join(pmRefDir, 'event-schemas.md'), SYNTHETIC_SCHEMA, 'utf8');

  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  // Write current-orchestration.json so peekOrchestrationId returns orchId.
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );

  // Pre-create events.jsonl (avoids first-write races in atomicAppend).
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');

  return tmpDir;
}

/**
 * Force-reload audit-event-writer and its recursive deps so module-level
 * state (Maps, Sets, booleans) is fresh for each test.
 */
function freshWriter() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('audit-event-writer') ||
      key.includes('schema-emit-validator') ||
      key.includes('load-schema-shadow') ||
      key.includes('peek-orchestration-id')
    ) {
      delete require.cache[key];
    }
  }
  return require(GATEWAY);
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(function (l) { return JSON.parse(l); });
}

function thresholdEmits(events) {
  return events.filter(function (e) {
    return e.type === 'audit_event_autofill_threshold_exceeded';
  });
}

/**
 * Write `count` events through the production writeEvent path.
 * All events use the same type ('test_evt_fill') so they share the same
 * denominator key in _trackAutofillThreshold.
 *
 * @param {object}  writer       - freshWriter() result
 * @param {boolean} wasAutofill  - if true, omit timestamp+orchId so withAutofill fires
 * @param {number}  count
 * @param {string}  cwd          - tmp repo root
 * @param {string}  orchId       - used when wasAutofill=false to supply the field
 */
function sendEvents(writer, wasAutofill, count, cwd, orchId) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

  for (var i = 0; i < count; i++) {
    const payload = { type: 'test_evt_fill', version: 1 };
    if (!wasAutofill) {
      // Pre-supply timestamp + orchestration_id — withAutofill leaves them
      // unchanged, so autofilledFields will be empty for these events.
      payload.timestamp        = new Date().toISOString();
      payload.orchestration_id = orchId;
    }
    // When wasAutofill=true: omit both → withAutofill adds them →
    // autofilledFields is non-empty → _trackAutofillThreshold sees wasAutofilled=true.
    writer.writeEvent(payload, { cwd, eventsPath });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W0c: B3 min-denominator guard — production happy path (v2.2.11)', function () {

  let savedEnv;

  beforeEach(function () {
    savedEnv = {
      ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED: process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED,
      ORCHESTRAY_AUTOFILL_THRESHOLD:          process.env.ORCHESTRAY_AUTOFILL_THRESHOLD,
      ORCHESTRAY_DISABLE_SCHEMA_SHADOW:       process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW,
    };
    delete process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED;
    delete process.env.ORCHESTRAY_AUTOFILL_THRESHOLD;
    delete process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW;
  });

  afterEach(function () {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: total_count=1, autofill_count=1 (100%) — below min-denominator
  // -------------------------------------------------------------------------
  test('Test 1: 1/1 (100%) does NOT emit — below min-denominator of 20', function () {
    const orchId = 'orch-w0c-t1';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();

    // 1 autofilled event (omit timestamp+orchId → autofill fires).
    sendEvents(writer, true, 1, tmpDir, orchId);

    const events = readEvents(tmpDir);
    const exceeded = thresholdEmits(events);
    assert.equal(exceeded.length, 0,
      'total_count=1 must not emit — below AUTOFILL_MIN_OBSERVATIONS=20');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 2: total_count=19, autofill_count=5 (~26%) — below min-denominator
  // -------------------------------------------------------------------------
  test('Test 2: 5/19 (~26%) does NOT emit — below min-denominator of 20', function () {
    const orchId = 'orch-w0c-t2';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();

    // 14 conformant + 5 autofilled = 19 total (same type, shared denominator key).
    sendEvents(writer, false, 14, tmpDir, orchId);
    sendEvents(writer, true,  5,  tmpDir, orchId);

    const events = readEvents(tmpDir);
    const exceeded = thresholdEmits(events);
    assert.equal(exceeded.length, 0,
      'total_count=19 must not emit — still below AUTOFILL_MIN_OBSERVATIONS=20');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 3: total_count=20, autofill_count=4 (20%) — at threshold, not above
  // -------------------------------------------------------------------------
  test('Test 3: 4/20 (20%) does NOT emit — ratio at threshold but not above', function () {
    const orchId = 'orch-w0c-t3';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();

    // 16 conformant + 4 autofilled = 20 total, ratio = 0.20 (not > 0.20).
    sendEvents(writer, false, 16, tmpDir, orchId);
    sendEvents(writer, true,  4,  tmpDir, orchId);

    const events = readEvents(tmpDir);
    const exceeded = thresholdEmits(events);
    assert.equal(exceeded.length, 0,
      '4/20 = 20% must not emit — threshold check is strict-greater-than 20%');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 4: total_count=20, autofill_count=5 (25%) — emit fires once
  //         + orchestration_id attribution via peekOrchestrationId
  // -------------------------------------------------------------------------
  test('Test 4: 5/20 (25%) emits once with correct orchestration_id', function () {
    const orchId = 'orch-w0c-t4';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();

    // 15 conformant + 5 autofilled = 20 total, ratio = 0.25 > 0.20.
    sendEvents(writer, false, 15, tmpDir, orchId);
    sendEvents(writer, true,  5,  tmpDir, orchId);

    const events = readEvents(tmpDir);
    const exceeded = thresholdEmits(events);
    assert.equal(exceeded.length, 1,
      '5/20 = 25% must emit exactly once');

    const emit = exceeded[0];
    assert.equal(emit.orchestration_id, orchId,
      'threshold emit must carry orchestration_id from peekOrchestrationId');
    assert.ok(emit.total_count >= 20,
      'total_count must be >= 20 (min-denominator met)');
    assert.ok(emit.ratio > 0.20,
      'ratio must exceed the 0.20 threshold');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 5: total_count=100, autofill_count=21 (21%) — emit fires once
  // -------------------------------------------------------------------------
  test('Test 5: 21/100 (21%) emits once', function () {
    const orchId = 'orch-w0c-t5';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();

    // 79 conformant + 21 autofilled = 100 total, ratio = 0.21 > 0.20.
    sendEvents(writer, false, 79, tmpDir, orchId);
    sendEvents(writer, true,  21, tmpDir, orchId);

    const events = readEvents(tmpDir);
    const exceeded = thresholdEmits(events);
    assert.equal(exceeded.length, 1,
      '21/100 = 21% must emit exactly once');
    // Threshold fires at first crossing (total_count >= 20 AND ratio > 20%).
    // With 79 conformant already in, the crossing happens before all 21 autofill
    // events are written, so total_count is between 20 and 100 at fire time.
    assert.ok(exceeded[0].total_count >= 20,
      'total_count must be >= AUTOFILL_MIN_OBSERVATIONS (20) when threshold fires');
    assert.ok(exceeded[0].ratio > 0.20,
      'ratio must exceed the 0.20 threshold at fire time');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 6: Kill switch — cases 4+5 produce 0 emits
  // -------------------------------------------------------------------------
  test('Test 6: ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED=1 suppresses emit for 25% and 21% cases', function () {
    process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = '1';

    // Case 4 scenario (5/20 = 25%).
    const orchId4 = 'orch-w0c-t6a';
    const tmpDir4 = makeTmpRepo(orchId4);
    const writer4 = freshWriter();

    sendEvents(writer4, false, 15, tmpDir4, orchId4);
    sendEvents(writer4, true,  5,  tmpDir4, orchId4);

    const exceeded4 = thresholdEmits(readEvents(tmpDir4));
    assert.equal(exceeded4.length, 0,
      'kill switch must suppress 5/20=25% emit');

    fs.rmSync(tmpDir4, { recursive: true, force: true });

    // Case 5 scenario (21/100 = 21%).
    const orchId5 = 'orch-w0c-t6b';
    const tmpDir5 = makeTmpRepo(orchId5);
    const writer5 = freshWriter();

    sendEvents(writer5, false, 79, tmpDir5, orchId5);
    sendEvents(writer5, true,  21, tmpDir5, orchId5);

    const exceeded5 = thresholdEmits(readEvents(tmpDir5));
    assert.equal(exceeded5.length, 0,
      'kill switch must suppress 21/100=21% emit');

    fs.rmSync(tmpDir5, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 7: Regression — existing autofill telemetry path not broken
  // -------------------------------------------------------------------------
  test('Test 7: audit_event_autofilled telemetry still emits for autofilled events', function () {
    const orchId = 'orch-w0c-t7';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();

    // Send 5 autofilled events. audit_event_autofilled must appear for each.
    sendEvents(writer, true, 5, tmpDir, orchId);

    const events = readEvents(tmpDir);
    const autofilled = events.filter(function (e) {
      return e.type === 'audit_event_autofilled';
    });

    // audit_event_autofilled fires for each event that had fields autofilled.
    // test_evt_fill omits timestamp + orchestration_id, so at least 1 emit per event.
    assert.ok(autofilled.length >= 1,
      'audit_event_autofilled must still emit when fields are autofilled');

    // No threshold emit (only 5 total events, below AUTOFILL_MIN_OBSERVATIONS=20).
    const exceeded = thresholdEmits(events);
    assert.equal(exceeded.length, 0,
      'no threshold emit yet — only 5 events, below min-denominator');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});
