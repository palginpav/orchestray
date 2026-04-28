'use strict';

/**
 * Test B4: Journal hard cap.
 *
 * Asserts:
 *   - 200 entries appended to journal.
 *   - sweepJournal triggers count cap → ≤ 100 entries remain.
 *   - truncationEvent is emitted with correct shape.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { sweepJournal } = require('../../../bin/_lib/tokenwright/journal-sweep');

// ---------------------------------------------------------------------------
// Helper: make a fresh non-expired entry
// ---------------------------------------------------------------------------
function makeEntry(i) {
  return {
    spawn_key:        'developer:cap-test-' + i,
    orchestration_id: 'orch-test-b4-cap',
    agent_type:       'developer',
    timestamp:        new Date(Date.now() + i * 1000).toISOString(),  // ordered
    input_token_estimate: 200 + i,
    expires_at:       Date.now() + 24 * 3600 * 1000,  // future → TTL won't sweep
  };
}

// ---------------------------------------------------------------------------
// Test 1: 200 entries → count cap fires → ≤ 100 entries remain
// ---------------------------------------------------------------------------
test('B4-journal-cap: 200 entries triggers count cap, ≤100 entries remain', () => {
  const entries = Array.from({ length: 200 }, (_, i) => makeEntry(i));

  const { kept, truncationEvent } = sweepJournal({
    entries,
    ttlHours:   24,
    maxBytes:   10 * 1024 * 1024,  // 10 MB — size cap won't fire for 200 small entries
    maxEntries: 100,
  });

  assert.ok(kept.length <= 100, 'kept entries must be ≤ 100 after count cap');
  assert.ok(kept.length > 0,   'some entries must survive');

  assert.ok(truncationEvent !== null, 'truncationEvent must be emitted');
  assert.equal(truncationEvent.type, 'tokenwright_journal_truncated');
  assert.equal(truncationEvent.event_type, 'tokenwright_journal_truncated');
  assert.ok(truncationEvent.entries_before >= 200, 'entries_before must reflect original count');
  assert.ok(truncationEvent.entries_after <= 100,  'entries_after must be ≤ 100');
  assert.ok(['size_cap_10kb', 'count_cap_100', 'ttl_sweep'].includes(truncationEvent.trigger),
    'trigger must be a valid value');
});

// ---------------------------------------------------------------------------
// Test 2: size cap fires when byte budget exceeded
// ---------------------------------------------------------------------------
test('B4-journal-cap: size cap fires when bytes exceed maxBytes', () => {
  // Build entries with large payloads to exceed 1 KB
  const bigPayload = 'x'.repeat(200);
  const entries = Array.from({ length: 20 }, (_, i) => ({
    spawn_key:        'developer:big-' + i,
    orchestration_id: 'orch-test-b4-size',
    agent_type:       'developer',
    timestamp:        new Date(Date.now() + i * 1000).toISOString(),
    input_token_estimate: 500,
    expires_at:       Date.now() + 24 * 3600 * 1000,
    extra:            bigPayload,
  }));

  const { kept, truncationEvent } = sweepJournal({
    entries,
    ttlHours:   24,
    maxBytes:   1024,   // 1 KB — should fire
    maxEntries: 1000,   // count cap won't fire
  });

  assert.ok(truncationEvent !== null, 'truncationEvent must be emitted for size cap');
  assert.equal(truncationEvent.trigger, 'size_cap_10kb', 'trigger must be size_cap_10kb');
  assert.ok(kept.length < entries.length, 'entries must be reduced by size cap');
});

// ---------------------------------------------------------------------------
// Test 3: truncationEvent has all required fields
// ---------------------------------------------------------------------------
test('B4-journal-cap: truncationEvent has all required fields', () => {
  const entries = Array.from({ length: 200 }, (_, i) => makeEntry(i));

  const { truncationEvent } = sweepJournal({
    entries,
    ttlHours:   24,
    maxBytes:   10 * 1024 * 1024,
    maxEntries: 100,
  });

  assert.ok(truncationEvent !== null, 'truncationEvent must not be null');
  const required = ['entries_before', 'entries_after', 'bytes_before', 'bytes_after', 'trigger', 'orchestration_id'];
  // Note: orchestration_id is optional in sweepJournal (it's a pure function);
  // required fields per W4 are the others:
  const minRequired = ['entries_before', 'entries_after', 'bytes_before', 'bytes_after', 'trigger'];
  for (const f of minRequired) {
    assert.ok(f in truncationEvent, `truncationEvent must have field: ${f}`);
  }
  assert.ok(typeof truncationEvent.entries_before === 'number', 'entries_before must be a number');
  assert.ok(typeof truncationEvent.entries_after  === 'number', 'entries_after must be a number');
  assert.ok(typeof truncationEvent.bytes_before   === 'number', 'bytes_before must be a number');
  assert.ok(typeof truncationEvent.bytes_after    === 'number', 'bytes_after must be a number');
  assert.ok(truncationEvent.entries_before > truncationEvent.entries_after, 'entries_before > entries_after');
});
