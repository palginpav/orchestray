#!/usr/bin/env node
'use strict';

/**
 * v2213-W5-contracts-runpost-audit.test.js
 *
 * W5 (v2.2.13): contracts_runpost_silent_skip audit-only emit.
 *
 * Per W3-review P0-1 reframe: the PostToolUse:Agent registration of
 * validate-task-contracts.js is PRESERVED (it is a load-bearing postcondition
 * gate). W5 only adds observability — when runPost fast-paths out without
 * running runChecks, it emits contracts_runpost_silent_skip so operators can
 * distinguish "post-phase ran a real check" from "post-phase short-circuited."
 *
 * Test matrix:
 *
 *  1. Post-phase: no_task_yaml   → emits contracts_runpost_silent_skip{reason:'no_task_yaml'}
 *  2. Post-phase: task_yaml_read_error → emits contracts_runpost_silent_skip{reason:'task_yaml_read_error'}
 *  3. Post-phase: no_contracts_block  → emits contracts_runpost_silent_skip{reason:'no_contracts_block'}
 *  4. Kill-switch: ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED=1 → no contracts_runpost_silent_skip
 *  5. Pre-phase: no_contracts_block   → does NOT emit contracts_runpost_silent_skip
 *  6. Post-phase: real contracts block → does NOT emit contracts_runpost_silent_skip
 *  7. Regression-guard (P0-1): validate-task-contracts.js is registered at BOTH
 *     PreToolUse:Agent AND PostToolUse:Agent in hooks/hooks.json.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK       = path.join(REPO_ROOT, 'bin', 'validate-task-contracts.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-runpost-'));
  const tasksDir = path.join(tmp, '.orchestray', 'state', 'tasks');
  const auditDir = path.join(tmp, '.orchestray', 'audit');
  const stateDir = path.join(tmp, '.orchestray', 'state');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  if (opts.orchestrationId) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: opts.orchestrationId }),
    );
  }

  if (opts.taskId && opts.taskYaml !== undefined) {
    fs.writeFileSync(
      path.join(tasksDir, opts.taskId + '.yaml'),
      opts.taskYaml,
    );
  }

  if (opts.taskId && opts.taskYamlBinary) {
    // Write a binary/unreadable file to trigger task_yaml_read_error
    fs.writeFileSync(
      path.join(tasksDir, opts.taskId + '.yaml'),
      opts.taskYamlBinary,
    );
  }

  return tmp;
}

function readEvents(tmp) {
  const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Spawn the hook as PostToolUse:Agent with the given env overrides.
 * Returns { status, stderr, events }.
 */
function runPostHook(tmp, taskId, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Clear inherited kill switches unless explicitly set
  const killSwitches = [
    'ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED',
    'ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED',
    'ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED',
    'ORCHESTRAY_CONTRACTS_MISSING_WARN_DISABLED',
  ];
  for (const k of killSwitches) {
    if (!(k in extraEnv)) delete env[k];
  }

  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      hook_type: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { task_id: taskId, subagent_type: 'developer' },
      tool_response: '',
      cwd: tmp,
    }),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return {
    status: res.status,
    stderr: res.stderr || '',
    events: readEvents(tmp),
  };
}

/**
 * Spawn the hook as PreToolUse:Agent with the given env overrides.
 */
function runPreHook(tmp, taskId, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const killSwitches = [
    'ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED',
    'ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED',
    'ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED',
    'ORCHESTRAY_CONTRACTS_MISSING_WARN_DISABLED',
  ];
  for (const k of killSwitches) {
    if (!(k in extraEnv)) delete env[k];
  }

  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { task_id: taskId, subagent_type: 'developer' },
      cwd: tmp,
    }),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return {
    status: res.status,
    stderr: res.stderr || '',
    events: readEvents(tmp),
  };
}

// YAML with a valid contracts block for the "real check" path
const VALID_CONTRACTS_YAML = `id: W-has-contracts
agent: developer
contracts:
  preconditions: []
  postconditions: []
`;

// YAML with no contracts block
const NO_CONTRACTS_YAML = `id: W-no-contracts
agent: developer
`;

// ---------------------------------------------------------------------------
// Test 1: Post-phase — no task YAML file → contracts_runpost_silent_skip{reason:'no_task_yaml'}
// ---------------------------------------------------------------------------
describe('W5 — post-phase no_task_yaml branch', () => {
  test('Test 1: no task YAML → emits contracts_runpost_silent_skip with reason=no_task_yaml', () => {
    const tmp = makeTmpProject({ orchestrationId: 'orch-w5-t1' });
    // Note: no task YAML written — resolveTaskFilePath returns null
    try {
      const { events } = runPostHook(tmp, 'W-missing-task');
      const skipEvents = events.filter(e => e.event_type === 'contracts_runpost_silent_skip');
      assert.ok(skipEvents.length >= 1, 'contracts_runpost_silent_skip must emit when no task YAML');
      assert.equal(skipEvents[0].reason, 'no_task_yaml', 'reason must be no_task_yaml');
      assert.equal(skipEvents[0].schema_version, 1, 'schema_version must be 1');
      assert.ok(typeof skipEvents[0].orchestration_id === 'string', 'orchestration_id must be present');
      assert.ok(typeof skipEvents[0].task_id === 'string', 'task_id must be present');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 1b: Post-phase — no task_id resolvable → contracts_runpost_silent_skip{reason:'no_task_id'}
// (v2.2.13 final-review F-02: 4th silent-skip branch instrumented.)
// ---------------------------------------------------------------------------
describe('W5 — post-phase no_task_id branch (final-review F-02)', () => {
  test('Test 1b: no resolvable task_id → emits contracts_runpost_silent_skip with reason=no_task_id', () => {
    const tmp = makeTmpProject({ orchestrationId: 'orch-w5-t1b' });
    try {
      // Send PostToolUse payload with NO task_id field — resolveTaskId returns null
      const res = spawnSync('node', [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          hook_type: 'PostToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: 'developer' }, // no task_id, no description
          tool_response: '',
          cwd: tmp,
        }),
        cwd: tmp,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED: '' },
      });
      assert.ok(res.status === 0 || res.status === null, 'hook must exit 0 (fail-open)');
      const events = readEvents(tmp);
      const skipEvents = events.filter(e =>
        e.event_type === 'contracts_runpost_silent_skip' && e.reason === 'no_task_id'
      );
      assert.equal(skipEvents.length, 1, 'exactly 1 contracts_runpost_silent_skip{reason:no_task_id}');
      assert.equal(skipEvents[0].schema_version, 1);
      assert.equal(skipEvents[0].task_id, 'unknown');
      assert.ok(typeof skipEvents[0].orchestration_id === 'string');
    } finally {
      cleanup(tmp);
    }
  });

  test('Test 1b-kill: ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED=1 suppresses no_task_id emit', () => {
    const tmp = makeTmpProject({ orchestrationId: 'orch-w5-t1b-kill' });
    try {
      const res = spawnSync('node', [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          hook_type: 'PostToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: 'developer' },
          tool_response: '',
          cwd: tmp,
        }),
        cwd: tmp,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED: '1' },
      });
      assert.ok(res.status === 0 || res.status === null);
      const events = readEvents(tmp);
      const skipEvents = events.filter(e =>
        e.event_type === 'contracts_runpost_silent_skip' && e.reason === 'no_task_id'
      );
      assert.equal(skipEvents.length, 0, 'kill switch must suppress no_task_id emit');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Post-phase — task_yaml_read_error → contracts_runpost_silent_skip{reason:'task_yaml_read_error'}
// We trigger this by writing a valid YAML, loading it once (to prime parse cache),
// then making it unreadable via chmod. We use the module-level emitSkipped
// directly since triggering a real read error via child_process is fragile on
// different OS configs. Instead, we test via the exported emitSkipped directly.
// ---------------------------------------------------------------------------
describe('W5 — post-phase task_yaml_read_error branch (unit)', () => {
  test('Test 2: task_yaml_read_error → emits contracts_runpost_silent_skip', () => {
    const tmp = makeTmpProject({ orchestrationId: 'orch-w5-t2' });
    try {
      // Use the exported emitSkipped directly to verify it emits contracts_runpost_silent_skip
      // when phase='post' and reason='task_yaml_read_error'.
      const { emitSkipped } = require(HOOK);
      emitSkipped(tmp, 'W-task-yaml-error', 'orch-w5-t2', 'task_yaml_read_error', 'post');
      const events = readEvents(tmp);
      const skipEvents = events.filter(e => e.event_type === 'contracts_runpost_silent_skip');
      assert.ok(skipEvents.length >= 1, 'contracts_runpost_silent_skip must emit for task_yaml_read_error');
      assert.equal(skipEvents[0].reason, 'task_yaml_read_error');
      assert.equal(skipEvents[0].schema_version, 1);
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Post-phase — no_contracts_block → contracts_runpost_silent_skip{reason:'no_contracts_block'}
// ---------------------------------------------------------------------------
describe('W5 — post-phase no_contracts_block branch', () => {
  test('Test 3: task YAML with no contracts block → emits contracts_runpost_silent_skip', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-w5-t3',
      taskId: 'W-no-contracts',
      taskYaml: NO_CONTRACTS_YAML,
    });
    try {
      const { events } = runPostHook(tmp, 'W-no-contracts');
      const skipEvents = events.filter(e => e.event_type === 'contracts_runpost_silent_skip');
      assert.ok(skipEvents.length >= 1, 'contracts_runpost_silent_skip must emit when no contracts block');
      assert.equal(skipEvents[0].reason, 'no_contracts_block');
      assert.equal(skipEvents[0].schema_version, 1);
      // Also verify the paired contract_check_skipped still fires (existing behaviour preserved)
      const checkSkipped = events.filter(e => e.type === 'contract_check_skipped');
      assert.ok(checkSkipped.length >= 1, 'contract_check_skipped must ALSO emit (existing behaviour preserved)');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Kill-switch ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED=1 → no emit
// ---------------------------------------------------------------------------
describe('W5 — kill-switch suppresses contracts_runpost_silent_skip', () => {
  test('Test 4: ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED=1 → no contracts_runpost_silent_skip', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-w5-t4',
      taskId: 'W-no-contracts',
      taskYaml: NO_CONTRACTS_YAML,
    });
    try {
      const { events } = runPostHook(tmp, 'W-no-contracts', {
        ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED: '1',
      });
      const skipEvents = events.filter(e => e.event_type === 'contracts_runpost_silent_skip');
      assert.equal(skipEvents.length, 0, 'kill-switch must prevent contracts_runpost_silent_skip emit');
      // contract_check_skipped should still fire (kill-switch only suppresses the new audit emit)
      const checkSkipped = events.filter(e => e.type === 'contract_check_skipped');
      assert.ok(checkSkipped.length >= 1, 'contract_check_skipped must still emit when audit disabled');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: Pre-phase — no_contracts_block → does NOT emit contracts_runpost_silent_skip
// ---------------------------------------------------------------------------
describe('W5 — pre-phase does not emit contracts_runpost_silent_skip', () => {
  test('Test 5: PreToolUse with no contracts block → no contracts_runpost_silent_skip', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-w5-t5',
      taskId: 'W-no-contracts',
      taskYaml: NO_CONTRACTS_YAML,
    });
    try {
      const { events } = runPreHook(tmp, 'W-no-contracts');
      const skipEvents = events.filter(e => e.event_type === 'contracts_runpost_silent_skip');
      assert.equal(skipEvents.length, 0,
        'contracts_runpost_silent_skip must NOT emit on pre-phase (only on post-phase)');
      // contract_check_skipped should still fire on pre-phase
      const checkSkipped = events.filter(e => e.type === 'contract_check_skipped');
      assert.ok(checkSkipped.length >= 1, 'contract_check_skipped must emit on pre-phase');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Post-phase — valid contracts block → real check runs, NO contracts_runpost_silent_skip
// ---------------------------------------------------------------------------
describe('W5 — post-phase real contracts check does not emit contracts_runpost_silent_skip', () => {
  test('Test 6: valid contracts block → contract_check emitted, no contracts_runpost_silent_skip', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-w5-t6',
      taskId: 'W-has-contracts',
      taskYaml: VALID_CONTRACTS_YAML,
    });
    try {
      const { events } = runPostHook(tmp, 'W-has-contracts');
      const skipEvents = events.filter(e => e.event_type === 'contracts_runpost_silent_skip');
      assert.equal(skipEvents.length, 0,
        'contracts_runpost_silent_skip must NOT emit when runChecks actually runs');
      // contract_check should emit (post-phase ran real checks)
      const checkEvents = events.filter(e => e.type === 'contract_check');
      assert.ok(checkEvents.length >= 1, 'contract_check must emit when post-phase runs real checks');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: Regression-guard (P0-1) — validate-task-contracts.js registered at
//         BOTH PreToolUse:Agent AND PostToolUse:Agent in hooks/hooks.json.
//
//         This test is the canonical guard against future regressions that
//         re-delete the PostToolUse:Agent registration. The double-invocation
//         is INTENTIONAL: pre-conditions checked before spawn, post-conditions
//         after. Removing PostToolUse:Agent deletes a working postcondition gate.
// ---------------------------------------------------------------------------
describe('W5 — P0-1 regression-guard: PostToolUse:Agent registration preserved', () => {
  test('Test 7: hooks.json has validate-task-contracts.js at PreToolUse:Agent AND PostToolUse:Agent', () => {
    assert.ok(fs.existsSync(HOOKS_JSON), 'hooks/hooks.json must exist');
    const hooksRaw = fs.readFileSync(HOOKS_JSON, 'utf8');
    const hooks = JSON.parse(hooksRaw);

    // Locate PreToolUse:Agent entries
    const preToolUseEntries = (hooks.hooks && hooks.hooks.PreToolUse) || [];
    const preAgentEntries = preToolUseEntries.filter(
      e => e.matcher === 'Agent' || (e.hooks && e.hooks.some &&
           e.hooks.some(h => (h.command || '').includes('validate-task-contracts')))
    );

    // Find validate-task-contracts.js in PreToolUse (may be nested under matcher)
    const hasPreRegistration = hooksRaw.includes('validate-task-contracts.js') &&
      (() => {
        // Check PreToolUse section references validate-task-contracts
        const preSection = JSON.stringify(preToolUseEntries);
        return preSection.includes('validate-task-contracts');
      })();

    // Locate PostToolUse:Agent entries
    const postToolUseEntries = (hooks.hooks && hooks.hooks.PostToolUse) || [];
    const hasPostRegistration = (() => {
      const postSection = JSON.stringify(postToolUseEntries);
      return postSection.includes('validate-task-contracts');
    })();

    assert.ok(hasPreRegistration,
      'validate-task-contracts.js must be registered in PreToolUse hooks (precondition gate)');
    assert.ok(hasPostRegistration,
      'validate-task-contracts.js must be registered in PostToolUse hooks (postcondition gate) — ' +
      'the double-invocation is INTENTIONAL per W3-review P0-1; deleting this registration ' +
      'removes a working postcondition checker');
  });
});
