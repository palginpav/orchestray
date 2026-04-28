#!/usr/bin/env node
'use strict';

/**
 * v229-group-boundary-gate.test.js — B-5.3 / W1 F-PM-13 unit tests.
 *
 * Verifies bin/gate-agent-spawn.js refuses any Agent() spawn whose target
 * task_id resolves to a group strictly LATER than the orchestration's
 * `current_group`. Default-on; kill switch
 * ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED=1 reverts to permissive but still
 * emits group_boundary_violation for observability.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js');
const NODE       = process.execPath;

// Pull helper exports for unit-level tests.
const {
  computeGroupBoundaryViolation,
  parseTaskGraphGroups,
  compareGroupOrder,
} = require(HOOK_PATH);

function makeRoot(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b5-3-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // Seed orchestration marker (gate runs only inside an orchestration).
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-b5-3' }),
    'utf8'
  );
  if (opts.orchMd !== null) {
    fs.writeFileSync(
      path.join(root, '.orchestray', 'state', 'orchestration.md'),
      opts.orchMd != null ? opts.orchMd
        : '# Orchestration State\n\n- **orchestration_id**: orch-test-b5-3\n- **current_group**: A1\n',
      'utf8'
    );
  }
  if (opts.taskGraph !== null && opts.taskGraph !== undefined) {
    fs.writeFileSync(
      path.join(root, '.orchestray', 'state', 'task-graph.md'),
      opts.taskGraph,
      'utf8'
    );
  }
  return root;
}

const SAMPLE_GRAPH =
  '# Task Graph\n\n' +
  '### Group A1\n' +
  '- F1 — developer ...\n' +
  '- F2 — developer ...\n\n' +
  '### Group A2\n' +
  '- F3 — developer ...\n\n' +
  '### Group B\n' +
  '- B-5.1 — developer ...\n' +
  '- B-5.2 — developer ...\n' +
  '- B-5.3 — developer ...\n\n' +
  '### Group C\n' +
  '- B-2.1 — developer ...\n';

function runGate(root, payload, envOverrides) {
  const env = Object.assign({}, process.env, envOverrides || {}, {
    ORCHESTRAY_PROJECT_ROOT: root,
  });
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
    cwd: root,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readEvents(root) {
  const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

describe('v229 B-5.3 — group-boundary helpers', () => {
  test('parseTaskGraphGroups parses heading-delimited blocks', () => {
    const m = parseTaskGraphGroups(SAMPLE_GRAPH);
    assert.equal(m.get('F1'), 'A1');
    assert.equal(m.get('F2'), 'A1');
    assert.equal(m.get('F3'), 'A2');
    assert.equal(m.get('B-5.1'), 'B');
    assert.equal(m.get('B-5.3'), 'B');
    assert.equal(m.get('B-2.1'), 'C');
  });

  test('parseTaskGraphGroups parses inline [group: X] markers', () => {
    const inline =
      '- F1 [group: A1] — developer\n' +
      '- F2 [group: A1] — developer\n' +
      '- B-5.1 [group: B] — developer\n';
    const m = parseTaskGraphGroups(inline);
    assert.equal(m.get('F1'), 'A1');
    assert.equal(m.get('B-5.1'), 'B');
  });

  test('compareGroupOrder: A1 < A2 < B < C', () => {
    assert.ok(compareGroupOrder('A1', 'A2') < 0);
    assert.ok(compareGroupOrder('A2', 'B')  < 0);
    assert.ok(compareGroupOrder('B',  'C')  < 0);
    assert.equal(compareGroupOrder('A1', 'A1'), 0);
    assert.ok(compareGroupOrder('B', 'A1') > 0);
  });

  test('computeGroupBoundaryViolation: spawn for future-group task → violation', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const violation = computeGroupBoundaryViolation(root, {
      subagent_type: 'developer',
      task_id: 'B-5.3',
    });
    assert.ok(violation, 'violation detected');
    assert.equal(violation.violation, true);
    assert.equal(violation.spawn_target, 'B-5.3');
    assert.equal(violation.current_group, 'A1');
    assert.equal(violation.target_group, 'B');
    assert.equal(violation.agent_role, 'developer');
  });

  test('computeGroupBoundaryViolation: spawn for current-group task → null', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const violation = computeGroupBoundaryViolation(root, {
      subagent_type: 'developer',
      task_id: 'F1',
    });
    assert.equal(violation, null);
  });

  test('computeGroupBoundaryViolation: missing task-graph.md → null (fail-open)', () => {
    const root = makeRoot({ taskGraph: null });
    const violation = computeGroupBoundaryViolation(root, {
      subagent_type: 'developer',
      task_id: 'B-5.3',
    });
    assert.equal(violation, null);
  });

  test('computeGroupBoundaryViolation: unknown task in graph → null (fail-open)', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const violation = computeGroupBoundaryViolation(root, {
      subagent_type: 'developer',
      task_id: 'Z-99',
    });
    assert.equal(violation, null);
  });

  test('computeGroupBoundaryViolation: task_id in description regex extraction', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const violation = computeGroupBoundaryViolation(root, {
      subagent_type: 'developer',
      description: 'B-5.3 — group boundary work',
    });
    assert.ok(violation);
    assert.equal(violation.spawn_target, 'B-5.3');
  });
});

describe('v229 B-5.3 — gate-agent-spawn integration', () => {
  test('future-group spawn → exit 2 + group_boundary_violation event', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const payload = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'B-5.3',
        description: 'Future-group task',
        prompt: 'do future work',
      },
      cwd: root,
    };
    const r = runGate(root, payload);
    assert.equal(r.status, 2, 'gate blocks future-group spawn; stderr=' + r.stderr);
    const events = readEvents(root);
    const violations = events.filter(e => e.type === 'group_boundary_violation');
    assert.equal(violations.length, 1, 'exactly one violation emitted');
    assert.equal(violations[0].spawn_target, 'B-5.3');
    assert.equal(violations[0].current_group, 'A1');
    assert.equal(violations[0].target_group, 'B');
    assert.equal(violations[0].agent_role, 'developer');
    assert.equal(violations[0].kill_switch_active, false);
    // stderr/deny message includes a usable hint.
    assert.match(r.stderr, /group-boundary violation/i);
  });

  test('current-group spawn → exit 0, no violation event', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const payload = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'F1',
        description: 'Current-group task',
        prompt: 'do A1 work',
      },
      cwd: root,
    };
    const r = runGate(root, payload);
    // Exit code 0 expected (gate permissive).
    assert.equal(r.status, 0, 'current-group spawn allowed; stderr=' + r.stderr);
    const events = readEvents(root);
    const violations = events.filter(e => e.type === 'group_boundary_violation');
    assert.equal(violations.length, 0, 'no violation event');
  });

  test('missing task-graph.md → exit 0 (fail-open), no violation event', () => {
    const root = makeRoot({ taskGraph: null });
    const payload = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'B-5.3',
        description: 'Future-group task',
        prompt: 'do future work',
      },
      cwd: root,
    };
    const r = runGate(root, payload);
    assert.equal(r.status, 0, 'missing graph → fail-open; stderr=' + r.stderr);
    const events = readEvents(root);
    const violations = events.filter(e => e.type === 'group_boundary_violation');
    assert.equal(violations.length, 0, 'no violation when no graph to check');
  });

  test('kill switch ON + future-group spawn → exit 0 BUT violation event still emitted', () => {
    const root = makeRoot({ taskGraph: SAMPLE_GRAPH });
    const payload = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'B-5.3',
        description: 'Future-group task',
        prompt: 'do future work',
      },
      cwd: root,
    };
    const r = runGate(root, payload, {
      ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
    });
    assert.equal(r.status, 0, 'kill switch makes gate permissive');
    const events = readEvents(root);
    const violations = events.filter(e => e.type === 'group_boundary_violation');
    assert.equal(violations.length, 1, 'violation STILL observable when kill switch is ON');
    assert.equal(violations[0].kill_switch_active, true);
  });
});
