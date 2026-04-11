#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/_lib/routing-lookup.js
 *
 * Covers appendRoutingEntry, readRoutingEntries, and findRoutingEntry.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  getRoutingFilePath,
  appendRoutingEntry,
  readRoutingEntries,
  findRoutingEntry,
  ROUTING_FILE,
} = require('../../bin/_lib/routing-lookup');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-routing-test-'));
  cleanup.push(dir);
  return dir;
}

/** Build a minimal valid routing entry. */
function makeEntry(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    orchestration_id: 'orch-test-001',
    task_id: 'task-1',
    agent_type: 'developer',
    description: 'Fix auth module',
    model: 'sonnet',
    effort: 'medium',
    complexity_score: 4,
    score_breakdown: { file_count: 1, cross_cutting: 1, description: 1, keywords: 1 },
    decided_by: 'pm',
    decided_at: 'decomposition',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getRoutingFilePath
// ---------------------------------------------------------------------------

describe('getRoutingFilePath', () => {
  test('returns absolute path under cwd', () => {
    const result = getRoutingFilePath('/tmp/myproject');
    assert.equal(result, '/tmp/myproject/' + ROUTING_FILE);
  });
});

// ---------------------------------------------------------------------------
// appendRoutingEntry
// ---------------------------------------------------------------------------

describe('appendRoutingEntry', () => {

  test('appends a valid JSON line — file becomes parseable', () => {
    const cwd = makeTmpDir();
    const entry = makeEntry();
    appendRoutingEntry(cwd, entry);

    const filePath = getRoutingFilePath(cwd);
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.agent_type, 'developer');
    assert.equal(parsed.model, 'sonnet');
  });

  test('creates parent directories if missing', () => {
    const cwd = makeTmpDir();
    // Verify parent dirs do NOT exist yet
    const stateDir = path.join(cwd, '.orchestray', 'state');
    assert.equal(fs.existsSync(stateDir), false);

    appendRoutingEntry(cwd, makeEntry());

    assert.equal(fs.existsSync(stateDir), true);
    assert.equal(fs.existsSync(getRoutingFilePath(cwd)), true);
  });

  test('10 sequential appends all land — each line parses as a separate entry', () => {
    const cwd = makeTmpDir();
    for (let i = 0; i < 10; i++) {
      appendRoutingEntry(cwd, makeEntry({ task_id: 'task-' + i, description: 'Task ' + i }));
    }

    const entries = readRoutingEntries(cwd);
    assert.equal(entries.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.equal(entries[i].task_id, 'task-' + i);
    }
  });

});

// ---------------------------------------------------------------------------
// readRoutingEntries
// ---------------------------------------------------------------------------

describe('readRoutingEntries', () => {

  test('returns empty array if file missing', () => {
    const cwd = makeTmpDir();
    const entries = readRoutingEntries(cwd);
    assert.deepEqual(entries, []);
  });

  test('parses each valid line and returns array', () => {
    const cwd = makeTmpDir();
    appendRoutingEntry(cwd, makeEntry({ task_id: 'task-1', agent_type: 'developer' }));
    appendRoutingEntry(cwd, makeEntry({ task_id: 'task-2', agent_type: 'reviewer' }));

    const entries = readRoutingEntries(cwd);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].task_id, 'task-1');
    assert.equal(entries[1].task_id, 'task-2');
  });

  test('skips malformed lines without throwing — fail-open', () => {
    const cwd = makeTmpDir();
    const filePath = getRoutingFilePath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write two good lines with a garbage line in between
    const good1 = JSON.stringify(makeEntry({ task_id: 'task-1' }));
    const good2 = JSON.stringify(makeEntry({ task_id: 'task-2' }));
    fs.writeFileSync(filePath, good1 + '\n{{{not json}}}\n' + good2 + '\n');

    let entries;
    assert.doesNotThrow(() => {
      entries = readRoutingEntries(cwd);
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].task_id, 'task-1');
    assert.equal(entries[1].task_id, 'task-2');
  });

  test('returns empty array for empty file', () => {
    const cwd = makeTmpDir();
    const filePath = getRoutingFilePath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');

    const entries = readRoutingEntries(cwd);
    assert.deepEqual(entries, []);
  });

});

// ---------------------------------------------------------------------------
// findRoutingEntry
// ---------------------------------------------------------------------------

describe('findRoutingEntry', () => {

  test('happy path — exact match returns the entry', () => {
    const cwd = makeTmpDir();
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: 'Fix auth module' }));

    const result = findRoutingEntry(cwd, 'developer', 'Fix auth module');
    assert.ok(result);
    assert.equal(result.agent_type, 'developer');
    assert.equal(result.description, 'Fix auth module');
  });

  test('returns null when no matching entry', () => {
    const cwd = makeTmpDir();
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: 'Fix auth module' }));

    const result = findRoutingEntry(cwd, 'reviewer', 'Fix auth module');
    assert.equal(result, null);
  });

  test('description prefix match — entry.description.startsWith(lookupDesc)', () => {
    const cwd = makeTmpDir();
    // Entry has long description, lookup uses the first 80 chars (prefix)
    const longDesc = 'Fix authentication module in auth/handler.js and related tests';
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: longDesc }));

    // Lookup uses shorter string that is a prefix of the stored description
    const result = findRoutingEntry(cwd, 'developer', 'Fix authentication module');
    assert.ok(result);
    assert.equal(result.description, longDesc);
  });

  test('description reverse match — lookupDesc starts with entry.description + space', () => {
    const cwd = makeTmpDir();
    // Entry has short description, lookup has longer string starting with it
    // followed by a word boundary (space)
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: 'Fix auth' }));

    // Lookup description starts with stored description + space — matches
    const result = findRoutingEntry(cwd, 'developer', 'Fix auth module in auth/handler.js');
    assert.ok(result);
    assert.equal(result.description, 'Fix auth');
  });

  test('word-boundary match rejects string-prefix collision — "Fix auth" does NOT match "Fix authority"', () => {
    const cwd = makeTmpDir();
    // Stored description is "Fix auth"; lookup is "Fix authority" which
    // shares "Fix auth" as a string prefix but has no space boundary
    // between "auth" and "ority". This MUST NOT match (cross-task
    // contamination guard).
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: 'Fix auth' }));

    const result = findRoutingEntry(cwd, 'developer', 'Fix authority module');
    assert.equal(result, null);
  });

  test('empty stored description never wildcard-matches', () => {
    const cwd = makeTmpDir();
    // An accidentally-blank routing entry must NOT match any spawn.
    // Previously this acted as a wildcard because ''.startsWith('') is true.
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: '' }));

    const result = findRoutingEntry(cwd, 'developer', 'Fix auth module');
    assert.equal(result, null);
  });

  test('most recent entry wins when multiple match (re-plan scenario)', () => {
    const cwd = makeTmpDir();
    // First entry — older timestamp, sonnet
    appendRoutingEntry(cwd, makeEntry({
      agent_type: 'developer',
      description: 'Fix auth module',
      model: 'sonnet',
      timestamp: '2026-04-11T10:00:00.000Z',
    }));
    // Second entry — newer timestamp after re-plan, opus
    appendRoutingEntry(cwd, makeEntry({
      agent_type: 'developer',
      description: 'Fix auth module',
      model: 'opus',
      timestamp: '2026-04-11T11:00:00.000Z',
    }));

    const result = findRoutingEntry(cwd, 'developer', 'Fix auth module');
    assert.ok(result);
    assert.equal(result.model, 'opus');
    assert.equal(result.timestamp, '2026-04-11T11:00:00.000Z');
  });

  test('returns null when file is missing', () => {
    const cwd = makeTmpDir();
    const result = findRoutingEntry(cwd, 'developer', 'Fix auth module');
    assert.equal(result, null);
  });

  test('description truncated to 80 chars for lookup — long description matches', () => {
    const cwd = makeTmpDir();
    const storedDesc = 'Implement the new feature for user authentication with OAuth';
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'architect', description: storedDesc }));

    // Pass a description longer than 80 chars — lookup should truncate to 80
    const longLookup = storedDesc + ' and also add tests for the new integration endpoints that were missing';
    const result = findRoutingEntry(cwd, 'architect', longLookup);
    assert.ok(result);
    assert.equal(result.description, storedDesc);
  });

  test('agent_type mismatch returns null even when description matches', () => {
    const cwd = makeTmpDir();
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: 'Fix auth module' }));

    // Same description but wrong agent type
    const result = findRoutingEntry(cwd, 'architect', 'Fix auth module');
    assert.equal(result, null);
  });

  test('empty file returns null', () => {
    const cwd = makeTmpDir();
    const filePath = getRoutingFilePath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');

    const result = findRoutingEntry(cwd, 'developer', 'Fix auth module');
    assert.equal(result, null);
  });

  test('handles undefined lookup description — returns null (no wildcard match)', () => {
    const cwd = makeTmpDir();
    appendRoutingEntry(cwd, makeEntry({ agent_type: 'developer', description: 'Fix auth module' }));

    // Undefined / empty lookup must NOT wildcard-match any stored entry.
    // The PM is required to pass a real description for routing lookup.
    const result = findRoutingEntry(cwd, 'developer', undefined);
    assert.equal(result, null);
  });

});
