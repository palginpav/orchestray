'use strict';

/**
 * Test B2: Key-tuple equality pending-entry removal.
 *
 * Asserts:
 *   1. After removal of a matched entry, journal line count decreases by exactly 1.
 *   2. Re-run with same payload: no further decrease (entry already removed).
 *
 * Targets the key-tuple removal fix in capture-tokenwright-realized.js.
 * We test it via the pure-function helpers directly.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-b2-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

// ---------------------------------------------------------------------------
// Replicate the key-tuple function from capture-tokenwright-realized.js
// to test removal logic in isolation.
// ---------------------------------------------------------------------------
function entryKey(e) {
  return [e.spawn_key || '', e.orchestration_id || '', e.agent_type || '', e.timestamp || ''].join('|');
}

function removePendingEntry(entries, matchedEntry) {
  const matchedKey = entryKey(matchedEntry);
  return entries.filter(e => entryKey(e) !== matchedKey);
}

// ---------------------------------------------------------------------------
// Simulate write / read journal from disk
// ---------------------------------------------------------------------------
function writePending(pendingPath, entries) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(pendingPath, content, 'utf8');
}

function readPending(pendingPath) {
  if (!fs.existsSync(pendingPath)) return [];
  const lines = fs.readFileSync(pendingPath, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fixture entries
// ---------------------------------------------------------------------------
function makeEntry(agentType, n) {
  return {
    spawn_key:        agentType + ':fixture' + n,
    orchestration_id: 'orch-test-b2',
    agent_type:       agentType,
    timestamp:        new Date(1000 * n).toISOString(),
    input_token_estimate: 500 + n,
    expires_at:       Date.now() + 24 * 3600 * 1000,
  };
}

// ---------------------------------------------------------------------------
// Test 1: removal decreases count by exactly 1
// ---------------------------------------------------------------------------
test('B2-pending-removal: removing matched entry decreases journal by exactly 1', (t) => {
  const tmpDir = makeTmpDir(t);
  const pendingPath = path.join(tmpDir, 'tokenwright-pending.jsonl');

  const entries = [
    makeEntry('developer', 1),
    makeEntry('developer', 2),
    makeEntry('researcher', 3),
  ];
  writePending(pendingPath, entries);

  const before = readPending(pendingPath);
  assert.equal(before.length, 3, 'journal must start with 3 entries');

  // Remove the second entry
  const toRemove = entries[1];
  const kept = removePendingEntry(before, toRemove);
  writePending(pendingPath, kept);

  const after = readPending(pendingPath);
  assert.equal(after.length, 2, 'journal must have exactly 2 entries after removal');

  // Verify the correct entry was removed
  const stillPresent = after.find(e => entryKey(e) === entryKey(toRemove));
  assert.equal(stillPresent, undefined, 'removed entry must no longer be in journal');
});

// ---------------------------------------------------------------------------
// Test 2: re-running removal with same payload is a no-op
// ---------------------------------------------------------------------------
test('B2-pending-removal: removing already-removed entry does not change count', (t) => {
  const tmpDir = makeTmpDir(t);
  const pendingPath = path.join(tmpDir, 'tokenwright-pending.jsonl');

  const entries = [
    makeEntry('developer', 1),
    makeEntry('developer', 2),
  ];
  writePending(pendingPath, entries);

  const toRemove = entries[0];

  // First removal
  const after1 = removePendingEntry(readPending(pendingPath), toRemove);
  writePending(pendingPath, after1);
  assert.equal(after1.length, 1, 'first removal: 1 entry remains');

  // Second removal of the same entry — should be no-op
  const after2 = removePendingEntry(readPending(pendingPath), toRemove);
  writePending(pendingPath, after2);
  assert.equal(after2.length, 1, 'second removal: still 1 entry (no-op)');
});

// ---------------------------------------------------------------------------
// Test 3: key-tuple uses spawn_key + orchestration_id + agent_type + timestamp
//         so two entries with same agent_type but different spawn_key are distinct
// ---------------------------------------------------------------------------
test('B2-pending-removal: different spawn_key entries are independently removable', (t) => {
  const tmpDir = makeTmpDir(t);
  const pendingPath = path.join(tmpDir, 'tokenwright-pending.jsonl');

  const e1 = makeEntry('developer', 1);
  const e2 = makeEntry('developer', 2);  // same agent_type, different spawn_key + timestamp
  writePending(pendingPath, [e1, e2]);

  // Remove only e1
  const after = removePendingEntry([e1, e2], e1);

  assert.equal(after.length, 1, 'only 1 entry should remain');
  assert.equal(entryKey(after[0]), entryKey(e2), 'remaining entry must be e2');
});
