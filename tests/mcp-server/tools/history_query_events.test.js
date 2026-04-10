#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/history_query_events.js
 *
 * Per v2011c-stage2-plan.md §4, §7, §13; v2011b-architecture.md §3.2.3.
 *
 * Contract under test:
 *   module exports: { definition, handle }
 *
 *   async handle(input, context)
 *     -> { isError, content, structuredContent: { events, total_matching, returned } }
 *
 * Each event has a `ref` field pointing at its source archive URI.
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  handle,
  definition,
} = require('../../../bin/mcp-server/tools/history_query_events.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-history-query-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  return dir;
}

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

function makeContext(tmp, overrides = {}) {
  return {
    projectRoot: tmp,
    pluginRoot: tmp,
    config: {},
    logger: () => {},
    ...overrides,
  };
}

function writeLiveEvents(tmp, events) {
  const file = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeArchiveEvents(tmp, orchId, events) {
  const dir = path.join(tmp, '.orchestray', 'history', orchId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('history_query_events definition', () => {

  test('exports a tool definition with name "history_query_events"', () => {
    assert.equal(definition.name, 'history_query_events');
    assert.ok(definition.inputSchema);
  });

});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('history_query_events input validation', () => {

  test('rejects limit > 500', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ limit: 1000 }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects limit < 1', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ limit: 0 }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects offset < 0', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ offset: -1 }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects orchestration_ids exceeding maxItems=50', async () => {
    const tmp = makeTmpProject();
    try {
      const tooMany = Array.from({ length: 51 }, (_, i) => 'orch-' + i);
      const result = await withCwd(tmp, () =>
        handle({ orchestration_ids: tooMany }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects event_types containing unknown enum value', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ event_types: ['agent_start', 'not_a_real_event'] }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe('history_query_events behavior', () => {

  test('returns empty events when audit and history are missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-history-query-empty-'));
    try {
      // Only create .orchestray/ so project root walk succeeds.
      fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
      const result = await withCwd(tmp, () =>
        handle({}, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.events, []);
      assert.equal(result.structuredContent.total_matching, 0);
      assert.equal(result.structuredContent.returned, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by since/until', async () => {
    const tmp = makeTmpProject();
    try {
      writeLiveEvents(tmp, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-2', timestamp: '2026-04-05T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-3', timestamp: '2026-04-10T00:00:00Z' },
      ]);
      const result = await withCwd(tmp, () =>
        handle(
          { since: '2026-04-04T00:00:00Z', until: '2026-04-06T00:00:00Z' },
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.events.length, 1);
      assert.equal(result.structuredContent.events[0].orchestration_id, 'orch-2');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by event_types', async () => {
    const tmp = makeTmpProject();
    try {
      writeLiveEvents(tmp, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'task_completed', orchestration_id: 'orch-1', timestamp: '2026-04-01T00:01:00Z' },
        { type: 'agent_stop', orchestration_id: 'orch-1', timestamp: '2026-04-01T00:02:00Z' },
      ]);
      const result = await withCwd(tmp, () =>
        handle({ event_types: ['task_completed'] }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.events.length, 1);
      assert.equal(result.structuredContent.events[0].type, 'task_completed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by orchestration_ids', async () => {
    const tmp = makeTmpProject();
    try {
      writeLiveEvents(tmp, [
        { type: 'agent_start', orchestration_id: 'orch-a', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-b', timestamp: '2026-04-01T00:01:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-c', timestamp: '2026-04-01T00:02:00Z' },
      ]);
      const result = await withCwd(tmp, () =>
        handle({ orchestration_ids: ['orch-b'] }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.events.length, 1);
      assert.equal(result.structuredContent.events[0].orchestration_id, 'orch-b');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by agent_role', async () => {
    const tmp = makeTmpProject();
    try {
      writeLiveEvents(tmp, [
        { type: 'agent_start', orchestration_id: 'orch-1', agent_role: 'developer', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-1', agent_role: 'reviewer', timestamp: '2026-04-01T00:01:00Z' },
      ]);
      const result = await withCwd(tmp, () =>
        handle({ agent_role: 'developer' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.events.length, 1);
      assert.equal(result.structuredContent.events[0].agent_role, 'developer');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects limit and offset pagination', async () => {
    const tmp = makeTmpProject();
    try {
      const evts = [];
      for (let i = 0; i < 10; i++) {
        evts.push({
          type: 'agent_start',
          orchestration_id: 'orch-' + i,
          timestamp: '2026-04-01T00:0' + i + ':00Z',
        });
      }
      writeLiveEvents(tmp, evts);
      const result = await withCwd(tmp, () =>
        handle({ limit: 3, offset: 2 }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.events.length, 3);
      assert.equal(result.structuredContent.returned, 3);
      assert.equal(result.structuredContent.total_matching, 10);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('populates ref field on each event', async () => {
    const tmp = makeTmpProject();
    try {
      writeLiveEvents(tmp, [
        { type: 'agent_start', orchestration_id: 'orch-live', timestamp: '2026-04-10T10:00:00Z' },
      ]);
      writeArchiveEvents(tmp, 'orch-archived', [
        { type: 'orchestration_start', orchestration_id: 'orch-archived', timestamp: '2026-04-01T00:00:00Z' },
      ]);
      const result = await withCwd(tmp, () =>
        handle({}, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      for (const ev of result.structuredContent.events) {
        assert.equal(typeof ev.ref, 'string');
        assert.ok(ev.ref.startsWith('orchestray:history://'));
      }
      // At least one live-source event and one archive-source event.
      const refs = result.structuredContent.events.map((e) => e.ref);
      assert.ok(refs.includes('orchestray:history://audit/live'));
      assert.ok(refs.includes('orchestray:history://orch/orch-archived'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
