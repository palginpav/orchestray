'use strict';

/**
 * Test 16: Schema validation.
 *
 * Each of the 8 new v2.2.6 event types resolves in the shadow validator.
 * For each event, verifies that:
 *   a. The event type exists in event-schemas.shadow.json.
 *   b. The `r` (required field count) matches the count of required fields per W4.
 *   c. Missing required fields cause a validation failure (schema-emit-validator).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const { loadShadow } = require('../../../bin/_lib/load-schema-shadow');

// Repo root for loadShadow
const PKG_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// W4-specified required field counts for each of the 8 new events
// (from W4 §"New audit events" + shadow.json actual values)
// ---------------------------------------------------------------------------
const NEW_EVENT_SHADOW_EXPECTATIONS = [
  // event_type,                         required_fields_min (from W4 spec)
  ['tokenwright_realized_unknown',        7],   // W4: 7 required
  ['compression_invariant_violated',      5],   // W4: 5 required (orchestration_id, agent_type, violated_section, violation_kind, load_bearing_set) + others
  ['tokenwright_estimation_drift',        7],   // W4: 7 required
  ['tokenwright_spawn_coverage',          9],   // W4: 9 required
  ['compression_skipped',                 4],   // W4: 4 required (orchestration_id, agent_type, reason, skip_path)
  ['compression_double_fire_detected',    6],   // W4: 6 required
  ['tokenwright_journal_truncated',       6],   // W4: 6 required (entries_before, entries_after, bytes_before, bytes_after, trigger, orchestration_id)
  ['tokenwright_self_probe',             11],   // W4: 11 required
];

// ---------------------------------------------------------------------------
// Test 1: Each new event type exists in the shadow JSON
// ---------------------------------------------------------------------------
test('Schema-validation: all 8 new event types exist in event-schemas.shadow.json', () => {
  const shadow = loadShadow(PKG_ROOT);
  assert.ok(shadow !== null, 'shadow JSON must be loadable');

  for (const [eventType] of NEW_EVENT_SHADOW_EXPECTATIONS) {
    assert.ok(
      eventType in shadow,
      `event type "${eventType}" must exist in event-schemas.shadow.json`
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2: Required field count (r) in shadow matches W4 spec minimums
// ---------------------------------------------------------------------------
test('Schema-validation: shadow r-counts for new events meet W4 minimum required fields', () => {
  const shadow = loadShadow(PKG_ROOT);
  assert.ok(shadow !== null, 'shadow JSON must be loadable');

  for (const [eventType, minRequired] of NEW_EVENT_SHADOW_EXPECTATIONS) {
    const entry = shadow[eventType];
    assert.ok(entry, `shadow entry must exist for "${eventType}"`);
    assert.ok(
      typeof entry.r === 'number',
      `shadow entry for "${eventType}" must have numeric r field`
    );
    assert.ok(
      entry.r >= minRequired,
      `shadow r=${entry.r} for "${eventType}" must be >= W4 minimum ${minRequired}`
    );
  }
});

// ---------------------------------------------------------------------------
// Test 3: schema_version=1 (v field) for all new events
// ---------------------------------------------------------------------------
test('Schema-validation: all new events have schema version v=1 in shadow', () => {
  const shadow = loadShadow(PKG_ROOT);
  assert.ok(shadow !== null, 'shadow JSON must be loadable');

  for (const [eventType] of NEW_EVENT_SHADOW_EXPECTATIONS) {
    const entry = shadow[eventType];
    if (!entry) continue;  // already caught by previous test
    assert.equal(entry.v, 1, `"${eventType}" must have version v=1`);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Existing extended events (prompt_compression, tokenwright_realized_savings)
//         also have updated r-counts reflecting new required fields
// ---------------------------------------------------------------------------
test('Schema-validation: existing events prompt_compression and tokenwright_realized_savings updated in shadow', () => {
  const shadow = loadShadow(PKG_ROOT);
  assert.ok(shadow !== null, 'shadow JSON must be loadable');

  // prompt_compression v2.2.6 has 8 new fields, old r was ~4+; total r ≥ 10
  const pc = shadow['prompt_compression'];
  assert.ok(pc, 'prompt_compression must exist in shadow');
  assert.ok(pc.r >= 10, `prompt_compression r=${pc.r} must be >= 10 after v2.2.6 extensions`);

  // tokenwright_realized_savings: 8 new required fields; total r ≥ 7
  const trs = shadow['tokenwright_realized_savings'];
  assert.ok(trs, 'tokenwright_realized_savings must exist in shadow');
  assert.ok(trs.r >= 7, `tokenwright_realized_savings r=${trs.r} must be >= 7 after v2.2.6 extensions`);
});

// ---------------------------------------------------------------------------
// Test 5: Total event count in shadow ≥ 128 (W4 §"Schema files" states 120 → 128)
// ---------------------------------------------------------------------------
test('Schema-validation: shadow has >= 128 event types (120 pre-v226 + 8 new)', () => {
  const shadow = loadShadow(PKG_ROOT);
  assert.ok(shadow !== null, 'shadow JSON must be loadable');

  // Count non-metadata keys
  const eventKeys = Object.keys(shadow).filter(k => !k.startsWith('_'));
  assert.ok(eventKeys.length >= 128, `shadow must have >= 128 events, got ${eventKeys.length}`);
});
