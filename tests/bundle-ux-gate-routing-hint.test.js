#!/usr/bin/env node
'use strict';

/**
 * Tests for Bundle UX Fix B in bin/gate-agent-spawn.js (v2.1.8)
 *
 * Fix B: the missing-model rejection branch now looks up routing.jsonl for
 * the task's routed model and injects a concrete "Re-spawn with model=X"
 * hint into both stderr and hookSpecificOutput.permissionDecisionReason.
 *
 * Test strategy: spawn gate-agent-spawn.js as a child process, isolate each
 * test in a fresh tmpdir, set up routing.jsonl as needed.
 *
 * Acceptance criteria covered:
 *   Spec §36 — routing entry present → stderr contains Re-spawn with model="{routed}"
 *   Spec §37 — routing.jsonl absent → generic "Re-spawn with model set explicitly." message
 *
 * Tests 9–12 from the Bundle UX test plan:
 *   9.  Missing model + matching routing entry → stderr hint + hookSpecificOutput + exit 2
 *  10.  Missing model + no matching routing entry → generic message + exit 2
 *  11.  Missing model + routing.jsonl read throws → fail-open, generic message, exit 2
 *  12.  Task-id extraction regex  ^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\s  works as expected
 *
 * Integration smoke test:
 *  13.  End-to-end: bootstrap a full .orchestray dir, invoke remind-model-before-spawn.js
 *       as a subprocess, assert valid additionalContext JSON and sentinel written.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Both scripts live in the installed location (not the repo's bin/), consistent
// with how Claude Code loads hooks from ~/.claude/orchestray/bin/.
const GATE_SCRIPT   = path.resolve(os.homedir(), '.claude/orchestray/bin/gate-agent-spawn.js');
const REMIND_SCRIPT = path.resolve(os.homedir(), '.claude/orchestray/bin/remind-model-before-spawn.js');

// ---------------------------------------------------------------------------
// Shared cleanup
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated tmpdir with .orchestray/audit/current-orchestration.json
 * and optionally .orchestray/state/routing.jsonl.
 *
 * @param {{ orchId: string, routingRows?: object[] }} opts
 */
function makeDir({ orchId, routingRows = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-uxgate-test-'));
  cleanup.push(dir);

  // Always write current-orchestration.json so the gate sees an active orch.
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );

  if (routingRows !== null) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lines = routingRows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), lines);
  }

  return dir;
}

/**
 * Run gate-agent-spawn.js with a given event payload.
 * Disable MCP enforcement kill-switch so only routing checks run.
 */
function runGate(payload) {
  // Write a config that disables all 2.0.12 MCP checkpoints so tests focus
  // only on the missing-model branch without needing checkpoint fixtures.
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [GATE_SCRIPT], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, {
      ORCHESTRAY_TEST_SHARED_DIR: path.join(os.tmpdir(), 'orchestray-test-no-shared-' + process.pid),
    }),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Build a gate event payload that simulates a missing-model Agent() call.
 *
 * @param {string} dir           - tmpdir path (used as event.cwd)
 * @param {string} description   - Agent description (used for task_id extraction)
 * @param {string} agentType     - subagent_type value
 */
function missingModelPayload(dir, description, agentType) {
  return {
    tool_name: 'Agent',
    cwd: dir,
    tool_input: {
      subagent_type: agentType,
      description,
      // model intentionally absent
    },
  };
}

/** Build a routing entry for the given orchestration. */
function makeRoutingEntry(orchId, taskId, agentType, model) {
  return {
    timestamp: new Date().toISOString(),
    orchestration_id: orchId,
    task_id: taskId,
    agent_type: agentType,
    model,
    effort: 'medium',
    description: taskId + ' do the thing',
  };
}

/**
 * Write an mcp_enforcement config that sets global_kill_switch=true so the
 * MCP checkpoint gate is bypassed and tests can focus on the model-missing branch.
 * kill_switch_reason is required by config-schema validation (non-empty string).
 */
function writeMcpKillSwitch(dir) {
  const configDir = path.join(dir, '.orchestray');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      mcp_enforcement: {
        global_kill_switch: true,
        kill_switch_reason: 'test isolation — bypass MCP checkpoint gate',
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Test 9: missing model + matching routing entry → hint in stderr + hookSpecificOutput + exit 2
// ---------------------------------------------------------------------------

describe('Fix B — routing entry present: concrete model hint', () => {

  test('missing model + matching routing entry → stderr contains Re-spawn with model="sonnet"', () => {
    const orchId = 'orch-ux-fix-b-001';
    const taskId  = 'DEV-1';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, taskId, 'developer', 'sonnet')],
    });
    writeMcpKillSwitch(dir);

    // Description starts with task_id — triggers the regex extraction branch.
    const { stderr, status } = runGate(missingModelPayload(dir, taskId + ' implement auth module', 'developer'));
    assert.equal(status, 2, 'gate must exit 2 when model is missing');
    assert.match(
      stderr,
      /Re-spawn with model="sonnet"/,
      'stderr must contain Re-spawn hint with the routed model from routing.jsonl'
    );
    assert.match(
      stderr,
      /Routing entry says model="sonnet"/,
      'stderr must contain the Routing entry says preamble'
    );
  });

  test('missing model + matching routing entry for opus agent → hint contains model="opus"', () => {
    const orchId = 'orch-ux-fix-b-002';
    const taskId  = 'ARCH-5';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, taskId, 'architect', 'opus')],
    });
    writeMcpKillSwitch(dir);

    const { stderr, status } = runGate(missingModelPayload(dir, taskId + ' design the system', 'architect'));
    assert.equal(status, 2);
    assert.match(stderr, /Re-spawn with model="opus"/, 'hint must reference opus for an architect task');
  });

  test('missing model + matching routing entry → hookSpecificOutput JSON on stdout contains routed model', () => {
    const orchId = 'orch-ux-fix-b-003';
    const taskId  = 'REV-2';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, taskId, 'reviewer', 'haiku')],
    });
    writeMcpKillSwitch(dir);

    const { stdout, status } = runGate(missingModelPayload(dir, taskId + ' review the diff', 'reviewer'));
    assert.equal(status, 2);

    // stdout may contain more than one JSON blob (anti-pattern gate also emits).
    // Find the one with permissionDecision.
    const jsonBlobs = stdout.trim().split('\n').filter(l => l.trim());
    let permDenial = null;
    for (const blob of jsonBlobs) {
      try {
        const parsed = JSON.parse(blob);
        if (parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny') {
          permDenial = parsed;
          break;
        }
      } catch (_e) {}
    }
    assert.ok(permDenial !== null, 'stdout must contain a hookSpecificOutput with permissionDecision=deny');
    assert.equal(permDenial.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(
      permDenial.hookSpecificOutput.permissionDecisionReason,
      /Re-spawn with model="haiku"/,
      'permissionDecisionReason must contain the routing hint'
    );
  });

  test('missing model + matching routing entry for task with hyphenated ID → hint is correct', () => {
    // Verifies the regex handles IDs like "TASK-1" and "W11-ABC" properly.
    const orchId = 'orch-ux-fix-b-004';
    const taskId  = 'W11-REVIEW';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, taskId, 'reviewer', 'sonnet')],
    });
    writeMcpKillSwitch(dir);

    const { stderr, status } = runGate(missingModelPayload(dir, taskId + ' audit security', 'reviewer'));
    assert.equal(status, 2);
    assert.match(stderr, /Re-spawn with model="sonnet"/, 'must handle hyphenated task IDs');
  });

});

// ---------------------------------------------------------------------------
// Test 10: missing model + no matching routing entry → generic message + exit 2
// ---------------------------------------------------------------------------

describe('Fix B — no matching routing entry: generic fallback message', () => {

  test('routing.jsonl absent (pre-routing) → generic "Re-spawn with model set explicitly." message + exit 2', () => {
    // Spec §37: no routing.jsonl → generic fallback.
    const orchId = 'orch-ux-fix-b-noroutingfile';
    const dir = makeDir({ orchId }); // no routingRows → no routing.jsonl
    writeMcpKillSwitch(dir);

    const { stderr, status } = runGate(missingModelPayload(dir, 'DEV-1 do something', 'developer'));
    assert.equal(status, 2);
    assert.match(
      stderr,
      /Re-spawn with model set explicitly\./,
      'must fall back to generic message when routing.jsonl is absent'
    );
    // Must NOT contain the routed-model hint since there is no entry.
    assert.ok(
      !stderr.includes('Routing entry says model='),
      'must not emit a routing-entry hint when routing.jsonl is absent'
    );
  });

  test('routing.jsonl present but no entry for (orchestration_id, task_id, agent_type) → generic message + exit 2', () => {
    const orchId = 'orch-ux-fix-b-nomatch';
    const dir = makeDir({
      orchId,
      routingRows: [
        makeRoutingEntry('orch-DIFFERENT', 'DEV-1', 'developer', 'sonnet'), // wrong orch
      ],
    });
    writeMcpKillSwitch(dir);

    const { stderr, status } = runGate(missingModelPayload(dir, 'DEV-1 implement feature', 'developer'));
    assert.equal(status, 2);
    assert.match(
      stderr,
      /Re-spawn with model set explicitly\./,
      'must fall back to generic message when no routing entry matches'
    );
  });

  test('routing.jsonl has entry for different agent_type → falls back to generic message', () => {
    // Same task_id but different agent_type: no match expected.
    const orchId = 'orch-ux-fix-b-wrongtype';
    const taskId  = 'DEV-9';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, taskId, 'reviewer', 'sonnet')], // reviewer, not developer
    });
    writeMcpKillSwitch(dir);

    const { stderr, status } = runGate(missingModelPayload(dir, taskId + ' build feature', 'developer'));
    assert.equal(status, 2);
    assert.match(
      stderr,
      /Re-spawn with model set explicitly\./,
      'must fall back when agent_type does not match the routing entry'
    );
  });

  test('description has no leading task-id token → generic message (task_id undetectable)', () => {
    // Description does not start with an uppercase task ID pattern.
    const orchId = 'orch-ux-fix-b-nodesc';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, 'DEV-1', 'developer', 'sonnet')],
    });
    writeMcpKillSwitch(dir);

    const { stderr, status } = runGate(missingModelPayload(dir, 'implement the authentication module', 'developer'));
    assert.equal(status, 2);
    assert.match(
      stderr,
      /Re-spawn with model set explicitly\./,
      'must fall back when no task_id can be extracted from description'
    );
  });

});

// ---------------------------------------------------------------------------
// Test 11: routing.jsonl read throws → fail-open, generic message, exit 2, no stack trace
// ---------------------------------------------------------------------------

describe('Fix B — routing.jsonl read error: fail-open', () => {

  test('routing.jsonl is a directory (unreadable as file) → generic message, exit 2, no stack trace in stderr', () => {
    // Make the routing.jsonl path a directory so readFileSync throws EISDIR.
    const orchId = 'orch-ux-fix-b-eisdir';
    const dir = makeDir({ orchId });
    writeMcpKillSwitch(dir);

    // Create routing.jsonl as a DIRECTORY to force a read error.
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    fs.mkdirSync(routingPath, { recursive: true });

    const { stderr, status } = runGate(missingModelPayload(dir, 'DEV-1 do the work', 'developer'));
    assert.equal(status, 2, 'must still exit 2 (deny) when routing read fails');
    assert.match(
      stderr,
      /Re-spawn with model set explicitly\./,
      'must fall back to generic message when routing.jsonl cannot be read'
    );
    // No stack trace in stderr.
    assert.ok(
      !stderr.includes('at Object.<anonymous>') &&
      !stderr.includes('TypeError:') &&
      !stderr.includes('EISDIR'),
      'must not emit a stack trace or raw error to stderr on read failure'
    );
    // Must contain the original missing-model message.
    assert.match(
      stderr,
      /missing required 'model' parameter/i,
      'base missing-model message must still appear'
    );
  });

  test('routing.jsonl contains only malformed JSON → generic message, exit 2, no crash', () => {
    const orchId = 'orch-ux-fix-b-malformed';
    const dir = makeDir({ orchId });
    writeMcpKillSwitch(dir);

    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), '{{{garbage\n\nbad\n');

    const { stderr, status } = runGate(missingModelPayload(dir, 'DEV-1 do work', 'developer'));
    assert.equal(status, 2);
    assert.match(stderr, /Re-spawn with model set explicitly\./);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

});

// ---------------------------------------------------------------------------
// Test 12: task-id extraction regex — verify the regex matches the spec
// ---------------------------------------------------------------------------

describe('Fix B — task-id extraction regex', () => {

  // The regex is: /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\s/
  // We test it by providing descriptions that should and should not extract a task_id,
  // and verify whether Fix B finds a routing entry (if one is present).

  test('description "DEV-1 ..." extracts task_id=DEV-1 and matches routing entry', () => {
    const orchId = 'orch-regex-001';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, 'DEV-1', 'developer', 'haiku')],
    });
    writeMcpKillSwitch(dir);

    const { stderr } = runGate(missingModelPayload(dir, 'DEV-1 build the feature', 'developer'));
    assert.match(stderr, /Re-spawn with model="haiku"/,
      'DEV-1 prefix must extract task_id and find the routing entry');
  });

  test('description "A1 ..." extracts task_id=A1 and matches routing entry', () => {
    const orchId = 'orch-regex-002';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, 'A1', 'developer', 'sonnet')],
    });
    writeMcpKillSwitch(dir);

    const { stderr } = runGate(missingModelPayload(dir, 'A1 build the feature', 'developer'));
    assert.match(stderr, /Re-spawn with model="sonnet"/,
      'A1 prefix must extract task_id and find the routing entry');
  });

  test('description "TASK-99-ALPHA ..." extracts task_id=TASK-99-ALPHA', () => {
    const orchId = 'orch-regex-003';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, 'TASK-99-ALPHA', 'developer', 'opus')],
    });
    writeMcpKillSwitch(dir);

    const { stderr } = runGate(missingModelPayload(dir, 'TASK-99-ALPHA implement something', 'developer'));
    assert.match(stderr, /Re-spawn with model="opus"/,
      'multi-segment task ID like TASK-99-ALPHA must be extracted correctly');
  });

  test('description "implement auth module" (lowercase start) → no task_id extracted → generic message', () => {
    const orchId = 'orch-regex-004';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, 'DEV-1', 'developer', 'sonnet')],
    });
    writeMcpKillSwitch(dir);

    const { stderr } = runGate(missingModelPayload(dir, 'implement auth module', 'developer'));
    assert.match(stderr, /Re-spawn with model set explicitly\./,
      'lowercase description start must not extract a task_id → generic fallback');
  });

  test('description "dev-1 ..." (lowercase task id) → no task_id extracted → generic message', () => {
    // The regex requires uppercase leading character.
    const orchId = 'orch-regex-005';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, 'DEV-1', 'developer', 'sonnet')],
    });
    writeMcpKillSwitch(dir);

    const { stderr } = runGate(missingModelPayload(dir, 'dev-1 build the feature', 'developer'));
    assert.match(stderr, /Re-spawn with model set explicitly\./,
      'lowercase task_id prefix must not match the regex → generic fallback');
  });

});

// ---------------------------------------------------------------------------
// Test 13: Integration smoke test — end-to-end remind-model-before-spawn.js
// ---------------------------------------------------------------------------

describe('Integration smoke — remind-model-before-spawn end-to-end', () => {

  /**
   * Bootstrap a complete .orchestray directory structure and invoke the
   * remind-model-before-spawn.js hook as a subprocess.
   *
   * Asserts:
   *   - exit 0
   *   - stdout is valid JSON with additionalContext
   *   - additionalContext references the routed model and agent type
   *   - model-reminder-shown sentinel is written to disk
   */
  test('full bootstrap: routing populated, no sentinels → emits valid additionalContext JSON and writes sentinel', () => {
    const orchId = 'orch-e2e-smoke-001';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
    cleanup.push(dir);

    // Bootstrap .orchestray/audit/current-orchestration.json
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );

    // Bootstrap .orchestray/state/routing.jsonl with two entries
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const routingRows = [
      {
        timestamp: '2026-04-20T09:00:00.000Z',
        orchestration_id: orchId,
        task_id: 'DEV-1',
        agent_type: 'developer',
        model: 'sonnet',
        effort: 'medium',
        maxTurns: 30,
        description: 'DEV-1 implement the feature',
      },
      {
        timestamp: '2026-04-20T09:00:01.000Z',
        orchestration_id: orchId,
        task_id: 'REV-1',
        agent_type: 'reviewer',
        model: 'haiku',
        effort: 'low',
        maxTurns: 20,
        description: 'REV-1 review the diff',
      },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      routingRows.map(r => JSON.stringify(r)).join('\n') + '\n'
    );

    // Invoke the hook as a subprocess
    const payload = {
      cwd: dir,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Please orchestrate the implementation',
    };
    const result = spawnSync(process.execPath, [REMIND_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      env: Object.assign({}, process.env, {
        ORCHESTRAY_TEST_SHARED_DIR: path.join(os.tmpdir(), 'orchestray-test-no-shared-' + process.pid),
      }),
    });

    assert.equal(result.status, 0, 'hook must exit 0');

    // Stdout must be valid JSON
    const stdout = (result.stdout || '').trim();
    assert.ok(stdout.length > 0, 'hook must emit JSON on stdout');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail('stdout is not valid JSON: ' + stdout);
    }

    // Must have hookSpecificOutput.additionalContext
    assert.ok(
      parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string',
      'must have hookSpecificOutput.additionalContext'
    );
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.length > 0, 'additionalContext must be non-empty');

    // The first routing entry (by timestamp) is DEV-1/developer/sonnet.
    // additionalContext should reference sonnet (the routed model).
    assert.match(ctx, /model="sonnet"/, 'additionalContext must reference the routed model');
    assert.match(ctx, /developer/, 'additionalContext must reference the agent type');

    // sentinel must have been written
    const sentinelPath = path.join(stateDir, 'model-reminder-shown', orchId);
    assert.ok(
      fs.existsSync(sentinelPath),
      'model-reminder-shown sentinel must be written at ' + sentinelPath
    );

    // Second invocation must NOT emit reminder (idempotence)
    const result2 = spawnSync(process.execPath, [REMIND_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      env: Object.assign({}, process.env, {
        ORCHESTRAY_TEST_SHARED_DIR: path.join(os.tmpdir(), 'orchestray-test-no-shared-' + process.pid),
      }),
    });
    assert.equal(result2.status, 0);
    assert.equal((result2.stdout || '').trim(), '', 'second invocation must emit no stdout (sentinel guards idempotence)');
  });

});
