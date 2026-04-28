'use strict';

/**
 * Test verify_fix_coverage_report probe (v2.2.8 Item 2).
 *
 * Item 2 smoke: stages events.jsonl with 3 agent_start(developer) and
 * 1 verify_fix_start for the same orch_id. Asserts:
 *   - tasks_total: 3
 *   - tasks_with_verify_fix: 1
 *   - ratio: ~0.333 (rounds to 0.333)
 *   - alert: "below_threshold"
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { runVerifyFixCoverageProbe } = require('../../../bin/_lib/verify-fix-coverage');

const ORCH_ID = 'orch-test-vf228';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vf228-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function appendEvent(eventsPath, evt) {
  fs.appendFileSync(eventsPath, JSON.stringify(evt) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Item 2 smoke: 3 agent_start + 1 verify_fix_start → ratio 0.333, below_threshold
// ---------------------------------------------------------------------------

test('Item 2 smoke — 3 agent_starts 1 verify_fix_start → ratio 0.333 below_threshold', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  // 3 developer agent_start events with distinct task_ids
  for (let i = 1; i <= 3; i++) {
    appendEvent(eventsPath, {
      type:             'agent_start',
      orchestration_id: ORCH_ID,
      agent_type:       'developer',
      task_id:          `task-${i}`,
      timestamp:        new Date().toISOString(),
    });
  }

  // 1 verify_fix_start for task-1 only
  appendEvent(eventsPath, {
    type:             'verify_fix_start',
    orchestration_id: ORCH_ID,
    task_id:          'task-1',
    timestamp:        new Date().toISOString(),
  });

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });

  assert.equal(result.type, 'verify_fix_coverage_report');
  assert.equal(result.version, 1);
  assert.equal(result.orchestration_id, ORCH_ID);
  assert.equal(result.tasks_total, 3);
  assert.equal(result.tasks_with_verify_fix, 1);
  // ratio = 1/3 = 0.333
  assert.ok(Math.abs(result.ratio - 0.333) < 0.001, `ratio should be ~0.333, got ${result.ratio}`);
  assert.equal(result.alert, 'below_threshold');
  assert.deepEqual(result.distinct_agents, ['developer']);
});

// ---------------------------------------------------------------------------
// zero_coverage: 2 tasks, 0 verify_fix_start
// ---------------------------------------------------------------------------

test('zero_coverage — 2 tasks, 0 verify_fix_start', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  for (let i = 1; i <= 2; i++) {
    appendEvent(eventsPath, {
      type:             'agent_start',
      orchestration_id: ORCH_ID,
      agent_type:       'developer',
      task_id:          `task-${i}`,
      timestamp:        new Date().toISOString(),
    });
  }

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  assert.equal(result.tasks_total, 2);
  assert.equal(result.tasks_with_verify_fix, 0);
  assert.equal(result.ratio, 0);
  assert.equal(result.alert, 'zero_coverage');
});

// ---------------------------------------------------------------------------
// n/a_single_task: only 1 developer task
// ---------------------------------------------------------------------------

test('n/a_single_task — only 1 developer task', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  appendEvent(eventsPath, {
    type:             'agent_start',
    orchestration_id: ORCH_ID,
    agent_type:       'developer',
    task_id:          'task-1',
    timestamp:        new Date().toISOString(),
  });

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  assert.equal(result.tasks_total, 1);
  assert.equal(result.alert, 'n/a_single_task');
});

// ---------------------------------------------------------------------------
// ok: ratio >= 0.5 (3 tasks, 2 verify_fix)
// ---------------------------------------------------------------------------

test('ok — ratio >= 0.5 (3 tasks, 2 verify_fix_start)', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  for (let i = 1; i <= 3; i++) {
    appendEvent(eventsPath, {
      type:             'agent_start',
      orchestration_id: ORCH_ID,
      agent_type:       'developer',
      task_id:          `task-${i}`,
      timestamp:        new Date().toISOString(),
    });
  }
  for (let i = 1; i <= 2; i++) {
    appendEvent(eventsPath, {
      type:             'verify_fix_start',
      orchestration_id: ORCH_ID,
      task_id:          `task-${i}`,
      timestamp:        new Date().toISOString(),
    });
  }

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  assert.equal(result.tasks_total, 3);
  assert.equal(result.tasks_with_verify_fix, 2);
  assert.equal(result.alert, 'ok');
});

// ---------------------------------------------------------------------------
// Filters non-developer agents (e.g. reviewer)
// ---------------------------------------------------------------------------

test('reviewer agent_start not counted in tasks_total', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  appendEvent(eventsPath, {
    type:             'agent_start',
    orchestration_id: ORCH_ID,
    agent_type:       'reviewer',
    task_id:          'task-r1',
    timestamp:        new Date().toISOString(),
  });
  appendEvent(eventsPath, {
    type:             'agent_start',
    orchestration_id: ORCH_ID,
    agent_type:       'developer',
    task_id:          'task-d1',
    timestamp:        new Date().toISOString(),
  });

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  // Only the developer counts
  assert.equal(result.tasks_total, 1);
  assert.equal(result.alert, 'n/a_single_task');
  assert.deepEqual(result.distinct_agents, ['developer']);
});

// ---------------------------------------------------------------------------
// refactorer is counted in DEVELOPER_AGENT_TYPES
// ---------------------------------------------------------------------------

test('refactorer counts in tasks_total', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  for (let i = 1; i <= 2; i++) {
    appendEvent(eventsPath, {
      type:             'agent_start',
      orchestration_id: ORCH_ID,
      agent_type:       'refactorer',
      task_id:          `task-${i}`,
      timestamp:        new Date().toISOString(),
    });
  }

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  assert.equal(result.tasks_total, 2);
  assert.equal(result.alert, 'zero_coverage');
  assert.deepEqual(result.distinct_agents, ['refactorer']);
});

// ---------------------------------------------------------------------------
// Empty events.jsonl — zero-value payload
// ---------------------------------------------------------------------------

test('empty events.jsonl — zero payload, n/a_single_task', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsPath, '', 'utf8');

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  assert.equal(result.tasks_total, 0);
  assert.equal(result.ratio, 0);
  assert.equal(result.alert, 'n/a_single_task');
});

// ---------------------------------------------------------------------------
// Different orch_id events not counted
// ---------------------------------------------------------------------------

test('events from different orch_id ignored', (t) => {
  const dir = makeTmpDir(t);
  const eventsPath = path.join(dir, 'events.jsonl');

  appendEvent(eventsPath, {
    type:             'agent_start',
    orchestration_id: 'orch-OTHER',
    agent_type:       'developer',
    task_id:          'task-x',
    timestamp:        new Date().toISOString(),
  });

  const result = runVerifyFixCoverageProbe({ orchestrationId: ORCH_ID, eventsPath });
  assert.equal(result.tasks_total, 0);
  assert.equal(result.alert, 'n/a_single_task');
});
