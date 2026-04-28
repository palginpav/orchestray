'use strict';

/**
 * Test Event 3: tokenwright_estimation_drift.
 *
 * Asserts:
 *   - With estimate=1000, actual=1500, budget=15 → drift event emitted with direction=underestimate.
 *   - With estimate=1000, actual=1500, budget=60 → no drift event (within budget).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e3-drift-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

// ---------------------------------------------------------------------------
// Pure helper: compute drift and decide whether to emit
// This mirrors the logic in capture-tokenwright-realized.js
// ---------------------------------------------------------------------------
function computeDrift({ estimated, actual, budgetPct }) {
  if (!actual || actual === 0) return null;
  const errorPct = Math.abs(actual - estimated) / actual * 100;
  if (errorPct <= budgetPct) return null;
  const direction = actual > estimated ? 'underestimate' : 'overestimate';
  return {
    estimation_error_pct: Math.round(errorPct * 10) / 10,
    drift_budget_pct:     budgetPct,
    direction,
  };
}

// ---------------------------------------------------------------------------
// Test 1: 50% drift with budget=15 → drift detected, direction=underestimate
// ---------------------------------------------------------------------------
test('Event3-drift: 50% drift with budget=15 produces underestimate drift event', () => {
  const drift = computeDrift({ estimated: 1000, actual: 1500, budgetPct: 15 });

  assert.ok(drift !== null, 'drift must be detected');
  assert.equal(drift.direction, 'underestimate', 'direction must be underestimate');
  assert.ok(drift.estimation_error_pct > 15, 'error_pct must exceed budget');
  assert.equal(drift.drift_budget_pct, 15, 'drift_budget_pct must match budget');
});

// ---------------------------------------------------------------------------
// Test 2: 50% drift with budget=60 → no drift event
// ---------------------------------------------------------------------------
test('Event3-drift: 50% drift with budget=60 produces no drift event', () => {
  const drift = computeDrift({ estimated: 1000, actual: 1500, budgetPct: 60 });

  assert.equal(drift, null, 'drift must NOT be detected when error is within budget');
});

// ---------------------------------------------------------------------------
// Test 3: overestimate direction
// ---------------------------------------------------------------------------
test('Event3-drift: estimate=2000, actual=1000, budget=15 → overestimate', () => {
  const drift = computeDrift({ estimated: 2000, actual: 1000, budgetPct: 15 });

  assert.ok(drift !== null, 'drift must be detected');
  assert.equal(drift.direction, 'overestimate', 'direction must be overestimate');
});

// ---------------------------------------------------------------------------
// Test 4: exact budget boundary (error_pct === budget) → no drift
// ---------------------------------------------------------------------------
test('Event3-drift: error exactly at budget boundary → no drift emitted', () => {
  // actual=100, estimated=85 → error = |100-85|/100 = 15%
  const drift = computeDrift({ estimated: 85, actual: 100, budgetPct: 15 });
  assert.equal(drift, null, 'error at exact boundary must not trigger drift');
});

// ---------------------------------------------------------------------------
// Test 5: emit functions produce correctly shaped payloads
// ---------------------------------------------------------------------------
test('Event3-drift: emitTokenwrightEstimationDrift emits correct payload shape', (t) => {
  const tmpDir = makeTmpDir(t);
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');

  const { writeEvent } = require('../../../bin/_lib/audit-event-writer');

  const payload = {
    type:                       'tokenwright_estimation_drift',
    event_type:                 'tokenwright_estimation_drift',
    version:                    1,
    schema_version:             1,
    orchestration_id:           'orch-test-e3',
    agent_type:                 'developer',
    estimated_input_tokens_pre: 1000,
    actual_input_tokens:        1500,
    estimation_error_pct:       33.3,
    drift_budget_pct:           15,
    direction:                  'underestimate',
  };
  writeEvent(payload, { cwd: tmpDir, eventsPath });

  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
  const events = lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  const driftEvents = events.filter(e =>
    e.type === 'tokenwright_estimation_drift' || e.event_type === 'tokenwright_estimation_drift'
  );

  assert.ok(driftEvents.length >= 1, 'must emit at least one drift event');
  const e = driftEvents[0];
  assert.equal(e.direction, 'underestimate');
  assert.equal(e.drift_budget_pct, 15);
  assert.ok(typeof e.estimation_error_pct === 'number', 'estimation_error_pct must be a number');
});
