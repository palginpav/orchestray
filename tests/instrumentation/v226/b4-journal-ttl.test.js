'use strict';

/**
 * Test B4: Journal TTL sweep.
 *
 * Asserts:
 *   - 5 entries with expires_at in the past + 3 with expires_at in the future.
 *   - After sweepJournal, exactly 3 entries remain (the future ones).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { sweepJournal } = require('../../../bin/_lib/tokenwright/journal-sweep');

// ---------------------------------------------------------------------------
// Helper: make an entry with a given expires_at offset from now
// ---------------------------------------------------------------------------
function makeEntry(offsetMs, tag) {
  return {
    spawn_key:        'developer:fixture-' + tag,
    orchestration_id: 'orch-test-b4',
    agent_type:       'developer',
    timestamp:        new Date(Date.now() + offsetMs).toISOString(),
    input_token_estimate: 500,
    expires_at:       Date.now() + offsetMs,
  };
}

// ---------------------------------------------------------------------------
// Test 1: 5 past + 3 future → exactly 3 remain after TTL sweep
// ---------------------------------------------------------------------------
test('B4-journal-ttl: sweeps expired entries, keeps future ones', () => {
  const entries = [
    makeEntry(-1000 * 3600 * 2,  'past-1'),  // 2 hours ago
    makeEntry(-1000 * 3600 * 5,  'past-2'),  // 5 hours ago
    makeEntry(-1000 * 3600 * 25, 'past-3'),  // 25 hours ago
    makeEntry(-1000 * 3600 * 30, 'past-4'),  // 30 hours ago
    makeEntry(-1000,             'past-5'),  // 1 second ago
    makeEntry( 1000 * 3600 * 10, 'future-1'), // 10 hours from now
    makeEntry( 1000 * 3600 * 12, 'future-2'), // 12 hours from now
    makeEntry( 1000 * 3600 * 20, 'future-3'), // 20 hours from now
  ];

  const { kept, truncationEvent } = sweepJournal({ entries, ttlHours: 24, maxBytes: 10240, maxEntries: 100 });

  assert.equal(kept.length, 3, 'exactly 3 future entries must survive TTL sweep');

  const keptTags = kept.map(e => e.spawn_key.replace('developer:fixture-', ''));
  assert.ok(keptTags.includes('future-1'), 'future-1 must survive');
  assert.ok(keptTags.includes('future-2'), 'future-2 must survive');
  assert.ok(keptTags.includes('future-3'), 'future-3 must survive');
});

// ---------------------------------------------------------------------------
// Test 2: entries without expires_at are treated as non-expired (backward compat)
// ---------------------------------------------------------------------------
test('B4-journal-ttl: entries without expires_at survive TTL sweep', () => {
  const entries = [
    { spawn_key: 'developer:no-ttl', orchestration_id: 'orch-test', agent_type: 'developer', timestamp: new Date().toISOString() },
    makeEntry(-1000 * 3600 * 48, 'past'),  // very old, has expires_at
  ];

  const { kept } = sweepJournal({ entries, ttlHours: 24, maxBytes: 10240, maxEntries: 100 });

  // no-ttl entry must survive (backward compat), past entry must be removed
  assert.equal(kept.length, 1, 'only no-ttl entry should remain');
  assert.equal(kept[0].spawn_key, 'developer:no-ttl', 'no-ttl entry must be kept');
});

// ---------------------------------------------------------------------------
// Test 3: truncationEvent is null when no sweep triggers fire
// ---------------------------------------------------------------------------
test('B4-journal-ttl: truncationEvent is null when nothing swept', () => {
  const entries = [
    makeEntry(1000 * 3600 * 10, 'a'),
    makeEntry(1000 * 3600 * 11, 'b'),
  ];

  const { truncationEvent } = sweepJournal({ entries, ttlHours: 24, maxBytes: 10240, maxEntries: 100 });

  assert.equal(truncationEvent, null, 'truncationEvent must be null when nothing is swept');
});

// ---------------------------------------------------------------------------
// Test 4: all past → all swept, kept is empty
// ---------------------------------------------------------------------------
test('B4-journal-ttl: all expired entries result in empty journal', () => {
  const entries = [
    makeEntry(-1000 * 3600 * 48, 'old-1'),
    makeEntry(-1000 * 3600 * 72, 'old-2'),
  ];

  const { kept } = sweepJournal({ entries, ttlHours: 24, maxBytes: 10240, maxEntries: 100 });

  assert.equal(kept.length, 0, 'all expired entries must be swept');
});
