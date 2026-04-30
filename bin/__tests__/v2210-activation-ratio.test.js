#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.10 N1 — emit-event-activation-ratio.js
 *
 * Test 1: synthetic per-orch archive — 60 declared non-optional types, 18 fired
 *         → emits row with ratio=0.30, denominator=60, numerator=18, dark_count=42.
 * Test 2: ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED=1 → 0 emits.
 * Test 3: missing per-orch archive → 0 emits, no crash.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'emit-event-activation-ratio.js');
const { run, tallyOrchFires } = require(SCRIPT);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal project directory with:
 *   - shadow JSON containing `total` non-optional declared types
 *   - per-orch archive at `.orchestray/history/<orchId>/events.jsonl`
 *     containing `fired` distinct event types (one line each)
 *
 * @param {object} opts
 * @param {number}  opts.total      - declared non-optional type count
 * @param {number}  opts.fired      - how many distinct types appear in archive
 * @param {string}  opts.orchId     - orchestration_id
 * @param {boolean} [opts.noArchive] - if true, skip writing archive
 */
function makeProject({ total, fired, orchId, noArchive = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-ratio-'));

  // --- shadow ---
  const shadowDir = path.join(tmp, 'agents', 'pm-reference');
  fs.mkdirSync(shadowDir, { recursive: true });

  const shadow = { _meta: { version: 1, generated_at: new Date().toISOString() } };
  for (let i = 0; i < total; i++) {
    shadow[`evt_type_${i}`] = { v: 1, r: 1, o: 0 };
  }
  // Add a few optional types that should NOT count toward denominator.
  for (let i = 0; i < 5; i++) {
    shadow[`optional_type_${i}`] = { v: 1, r: 1, o: 0, f: 1 };
  }
  fs.writeFileSync(path.join(shadowDir, 'event-schemas.shadow.json'), JSON.stringify(shadow));

  // --- current-orchestration marker (needed by writeEvent autofill) ---
  const auditDir = path.join(tmp, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
  );

  // --- events.jsonl (live log for writeEvent to append into) ---
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '');

  if (!noArchive) {
    // --- per-orch archive ---
    const histDir = path.join(tmp, '.orchestray', 'history', orchId);
    fs.mkdirSync(histDir, { recursive: true });

    const lines = [];
    for (let i = 0; i < fired; i++) {
      // Each fired type appears exactly once.
      lines.push(JSON.stringify({
        type: `evt_type_${i}`,
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
      }));
    }
    fs.writeFileSync(path.join(histDir, 'events.jsonl'), lines.join('\n') + '\n');
  }

  return { tmp, auditDir };
}

/**
 * Read all emitted event_activation_ratio rows from the audit events.jsonl.
 */
function readRatioEvents(auditDir) {
  const eventsPath = path.join(auditDir, 'events.jsonl');
  let text;
  try { text = fs.readFileSync(eventsPath, 'utf8'); }
  catch (_e) { return []; }

  const results = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // v2.2.15: filter by obj.type ONLY (audit_event_autofilled rows include
      // event_type:'event_activation_ratio' but type:'audit_event_autofilled').
      if (obj.type === 'event_activation_ratio') {
        results.push(obj);
      }
    } catch (_e) { /* skip */ }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2210-activation-ratio', () => {

  test('Test 1: 60 declared, 18 fired → ratio=0.30, denom=60, num=18, dark=42', () => {
    const orchId = 'orch-test-ratio-t1';
    const { tmp, auditDir } = makeProject({ total: 60, fired: 18, orchId });

    const emitted = run({ cwd: tmp, orchId });
    assert.strictEqual(emitted, 1, 'should emit 1 row');

    const rows = readRatioEvents(auditDir);
    assert.strictEqual(rows.length, 1, 'exactly 1 event_activation_ratio row');

    const row = rows[0];
    assert.strictEqual(row.numerator, 18, 'numerator');
    assert.strictEqual(row.denominator, 60, 'denominator');
    assert.strictEqual(row.ratio, 0.3, 'ratio == 0.30');
    assert.strictEqual(row.dark_count, 42, 'dark_count');
    assert.strictEqual(row.window_label, 'per-orch', 'window_label');
    assert.strictEqual(row.orchestration_id, orchId, 'orchestration_id');

    // Cleanup.
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('Test 2: kill switch → 0 emits', () => {
    const orchId = 'orch-test-ratio-t2';
    const { tmp, auditDir } = makeProject({ total: 60, fired: 18, orchId });

    const original = process.env.ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED;
    process.env.ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED = '1';
    try {
      const emitted = run({ cwd: tmp, orchId });
      assert.strictEqual(emitted, 0, 'should emit 0 rows when kill switch set');

      const rows = readRatioEvents(auditDir);
      assert.strictEqual(rows.length, 0, 'no event_activation_ratio rows');
    } finally {
      if (original === undefined) {
        delete process.env.ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED;
      } else {
        process.env.ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED = original;
      }
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('Test 3: missing archive → 0 emits, no crash', () => {
    const orchId = 'orch-test-ratio-t3';
    const { tmp, auditDir } = makeProject({ total: 60, fired: 18, orchId, noArchive: true });

    let emitted;
    assert.doesNotThrow(() => {
      emitted = run({ cwd: tmp, orchId });
    }, 'must not throw on missing archive');

    assert.strictEqual(emitted, 0, 'should emit 0 rows when archive missing');

    const rows = readRatioEvents(auditDir);
    assert.strictEqual(rows.length, 0, 'no event_activation_ratio rows');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

});
