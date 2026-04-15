#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/tools/routing_lookup.js
 *
 * Coverage (≥6 tests, F10/F22 regression):
 *   1. filter by task_id — returns matching entries
 *   2. filter by agent_type — returns matching entries
 *   3. filter by orchestration_id — returns matching entries
 *   4. F10 regression — 600 entries capped at 500, truncated=true, total=600
 *   5. F22 regression — no filters → result includes _note, still bounded at 500
 *   6. malformed JSON lines are skipped, valid lines returned
 *   7. empty routing.jsonl returns empty matches
 *   8. combined filter (orchestration_id + agent_type) returns only exact matches
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handle, definition } = require('../../../bin/mcp-server/tools/routing_lookup');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-routing-lookup-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function makeContext(root) {
  return { projectRoot: root };
}

/**
 * Write routing entries to routing.jsonl in the given tmp project.
 * @param {string} tmp - project root
 * @param {object[]} entries
 */
function writeRoutingEntries(tmp, entries) {
  const routingPath = path.join(tmp, '.orchestray', 'state', 'routing.jsonl');
  fs.writeFileSync(routingPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function makeEntry(overrides = {}) {
  return Object.assign(
    {
      timestamp: '2026-04-15T00:00:00Z',
      orchestration_id: 'orch-001',
      task_id: 'task-1',
      agent_type: 'developer',
      model: 'sonnet',
      effort: 'medium',
      description: 'Implement feature X',
      rationale: 'Standard implementation task',
      complexity_score: 5,
      decided_by: 'pm',
      decided_at: '2026-04-15T00:00:00Z',
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// Test 1: filter by task_id
// ---------------------------------------------------------------------------

describe('filter by task_id', () => {
  test('returns only entries matching the given task_id', async () => {
    const tmp = makeTmpProject();
    writeRoutingEntries(tmp, [
      makeEntry({ task_id: 'task-1', agent_type: 'developer' }),
      makeEntry({ task_id: 'task-2', agent_type: 'reviewer' }),
      makeEntry({ task_id: 'task-1', agent_type: 'tester' }),
    ]);

    const result = await handle({ task_id: 'task-1' }, makeContext(tmp));

    assert.equal(result.isError, false, 'must not be an error');
    const body = result.structuredContent;
    assert.equal(body.matches.length, 2, 'must return 2 matches for task-1');
    assert.ok(body.matches.every(m => m.task_id === 'task-1'), 'all matches must have task_id=task-1');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 2: filter by agent_type
// ---------------------------------------------------------------------------

describe('filter by agent_type', () => {
  test('returns only entries matching the given agent_type', async () => {
    const tmp = makeTmpProject();
    writeRoutingEntries(tmp, [
      makeEntry({ agent_type: 'developer', task_id: 'task-1' }),
      makeEntry({ agent_type: 'reviewer', task_id: 'task-2' }),
      makeEntry({ agent_type: 'developer', task_id: 'task-3' }),
    ]);

    const result = await handle({ agent_type: 'developer' }, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.matches.length, 2, 'must return 2 developer entries');
    assert.ok(body.matches.every(m => m.agent_type === 'developer'));

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 3: filter by orchestration_id
// ---------------------------------------------------------------------------

describe('filter by orchestration_id', () => {
  test('returns only entries matching the given orchestration_id', async () => {
    const tmp = makeTmpProject();
    writeRoutingEntries(tmp, [
      makeEntry({ orchestration_id: 'orch-A', task_id: 'task-1' }),
      makeEntry({ orchestration_id: 'orch-B', task_id: 'task-2' }),
      makeEntry({ orchestration_id: 'orch-A', task_id: 'task-3' }),
    ]);

    const result = await handle({ orchestration_id: 'orch-A' }, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.matches.length, 2);
    assert.ok(body.matches.every(m => m.orchestration_id === 'orch-A'));

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 4: F10 regression — 600 entries capped at 500
// ---------------------------------------------------------------------------

describe('F10: 500-entry cap', () => {
  test('600 entries returns matches.length=500, total=600, truncated=true', async () => {
    const tmp = makeTmpProject();

    const entries = [];
    for (let i = 0; i < 600; i++) {
      entries.push(makeEntry({ task_id: 'task-' + i, orchestration_id: 'orch-cap' }));
    }
    writeRoutingEntries(tmp, entries);

    const result = await handle({ orchestration_id: 'orch-cap' }, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.matches.length, 500, 'matches must be capped at 500');
    assert.equal(body.total, 600, 'total must reflect all 600 matches');
    assert.equal(body.truncated, true, 'truncated must be true');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 5: F22 regression — no filters → _note present, bounded at 500
// ---------------------------------------------------------------------------

describe('F22: no-filter warning note', () => {
  test('returns _note when no filters supplied', async () => {
    const tmp = makeTmpProject();
    writeRoutingEntries(tmp, [
      makeEntry({ orchestration_id: 'orch-X', task_id: 'task-1' }),
      makeEntry({ orchestration_id: 'orch-Y', task_id: 'task-2' }),
    ]);

    const result = await handle({}, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.ok(typeof body._note === 'string', '_note must be present when no filters given');
    assert.ok(
      body._note.includes('no filter') || body._note.includes('bounded'),
      '_note must mention filtering or bounding, got: ' + body._note
    );
    // Still bounded
    assert.ok(body.matches.length <= 500, 'matches must be bounded at 500');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no _note when at least one filter is supplied', async () => {
    const tmp = makeTmpProject();
    writeRoutingEntries(tmp, [
      makeEntry({ orchestration_id: 'orch-001', task_id: 'task-1' }),
    ]);

    const result = await handle({ orchestration_id: 'orch-001' }, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.ok(!body._note, '_note must NOT be present when a filter is supplied');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 6: malformed JSON lines are skipped
// ---------------------------------------------------------------------------

describe('malformed JSON lines are skipped', () => {
  test('skips invalid lines and returns valid entries', async () => {
    const tmp = makeTmpProject();
    const routingPath = path.join(tmp, '.orchestray', 'state', 'routing.jsonl');
    const lines = [
      JSON.stringify(makeEntry({ task_id: 'task-valid-1' })),
      'NOT VALID JSON {{{',
      '',
      JSON.stringify(makeEntry({ task_id: 'task-valid-2' })),
      '{ "broken":',
    ];
    fs.writeFileSync(routingPath, lines.join('\n') + '\n', 'utf8');

    const result = await handle({}, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.matches.length, 2, 'must return only the 2 valid entries');
    const taskIds = body.matches.map(m => m.task_id);
    assert.ok(taskIds.includes('task-valid-1'));
    assert.ok(taskIds.includes('task-valid-2'));

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 7: empty routing.jsonl returns empty matches
// ---------------------------------------------------------------------------

describe('empty routing.jsonl', () => {
  test('returns matches=[], total=0, truncated=false when file is empty', async () => {
    const tmp = makeTmpProject();
    const routingPath = path.join(tmp, '.orchestray', 'state', 'routing.jsonl');
    fs.writeFileSync(routingPath, '', 'utf8');

    const result = await handle({}, makeContext(tmp));

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.deepEqual(body.matches, []);
    assert.equal(body.total, 0);
    assert.equal(body.truncated, false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 8: combined filter
// ---------------------------------------------------------------------------

describe('combined filter (orchestration_id + agent_type)', () => {
  test('returns only entries matching both filters', async () => {
    const tmp = makeTmpProject();
    writeRoutingEntries(tmp, [
      makeEntry({ orchestration_id: 'orch-001', agent_type: 'developer', task_id: 'task-1' }),
      makeEntry({ orchestration_id: 'orch-001', agent_type: 'reviewer', task_id: 'task-2' }),
      makeEntry({ orchestration_id: 'orch-002', agent_type: 'developer', task_id: 'task-3' }),
    ]);

    const result = await handle(
      { orchestration_id: 'orch-001', agent_type: 'developer' },
      makeContext(tmp)
    );

    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.matches.length, 1, 'must match only orch-001 + developer');
    assert.equal(body.matches[0].task_id, 'task-1');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
