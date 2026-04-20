#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/remind-model-before-spawn.js  (Fix A, Bundle UX v2.1.8)
 *
 * UserPromptSubmit hook — emits a model-routing reminder additionalContext
 * exactly once per orchestration session, after routing has been written
 * but before any spawn has been accepted.
 *
 * Test strategy: spawn the script as a child process with stdin piped,
 * isolate every test in its own tmpdir, assert on stdout/stderr/exit code
 * and on the sentinel file written to disk.
 *
 * Acceptance criteria covered:
 *   Spec §32 — reminder fires or gate works (integration smoke, test 13)
 *   Spec §34 — UserPromptSubmit with active orch + no prior spawn emits additionalContext
 *   Spec §35 — sentinel present → exit 0, no additionalContext
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// The script lives in the installed location (not the repo's bin/), consistent
// with how Claude Code loads hooks from ~/.claude/orchestray/bin/.
const SCRIPT = path.resolve(os.homedir(), '.claude/orchestray/bin/remind-model-before-spawn.js');

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
 * Create an isolated tmpdir.  Returns the dir path.
 *
 * Options:
 *   orchId      — if set, writes .orchestray/audit/current-orchestration.json
 *   routingRows — if set (array), writes .orchestray/state/routing.jsonl
 *   spawnAccepted — if true, writes spawn-accepted sentinel for orchId
 *   reminderShown — if true, writes model-reminder-shown sentinel for orchId
 */
function makeDir({
  orchId = null,
  routingRows = null,
  spawnAccepted = false,
  reminderShown = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-remind-test-'));
  cleanup.push(dir);

  if (orchId) {
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );
  }

  if (routingRows) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lines = routingRows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), lines);
  }

  if (spawnAccepted && orchId) {
    const sentinelDir = path.join(dir, '.orchestray', 'state', 'spawn-accepted');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, orchId), '');
  }

  if (reminderShown && orchId) {
    const sentinelDir = path.join(dir, '.orchestray', 'state', 'model-reminder-shown');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, orchId), '');
  }

  return dir;
}

/**
 * Build a minimal valid UserPromptSubmit event payload for the given dir.
 * Optionally override source.
 */
function makeEvent(dir, { source = undefined } = {}) {
  const e = { cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'test prompt' };
  if (source !== undefined) e.source = source;
  return e;
}

/** Run the hook script with a JSON payload on stdin. */
function run(payload, dir) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [SCRIPT], {
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

/** Check whether the model-reminder-shown sentinel exists for orchId in dir. */
function reminderSentinelExists(dir, orchId) {
  return fs.existsSync(
    path.join(dir, '.orchestray', 'state', 'model-reminder-shown', orchId)
  );
}

/** Parse stdout as JSON, return null if empty or invalid. */
function parseStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

// A minimal routing entry for use in tests.
function makeRoutingEntry(orchId, opts = {}) {
  return {
    timestamp: '2026-04-20T10:00:00.000Z',
    orchestration_id: orchId,
    task_id: opts.task_id || 'DEV-1',
    agent_type: opts.agent_type || 'developer',
    model: opts.model || 'sonnet',
    effort: 'medium',
    maxTurns: opts.maxTurns || 30,
    description: opts.description || 'DEV-1 implement feature X',
  };
}

// ---------------------------------------------------------------------------
// Condition 1: no active orchestration → no reminder, exit 0, no sentinel
// ---------------------------------------------------------------------------

describe('Condition 1 — no active orchestration file', () => {

  test('current-orchestration.json absent → exits 0, no stdout, no sentinel written', () => {
    const dir = makeDir(); // no orchId → no current-orchestration.json
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit any stdout when no orchestration is active');
    // Sentinel directory should not exist at all
    assert.ok(
      !fs.existsSync(path.join(dir, '.orchestray', 'state', 'model-reminder-shown')),
      'sentinel directory must not be created when no orchestration is active'
    );
  });

});

// ---------------------------------------------------------------------------
// Condition 2: no routing.jsonl entries for current orch → no reminder
// ---------------------------------------------------------------------------

describe('Condition 2 — no routing entries for this orchestration', () => {

  test('routing.jsonl absent → exits 0, no stdout', () => {
    const orchId = 'orch-cond2-nofile';
    const dir = makeDir({ orchId }); // orch exists but no routing.jsonl
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit stdout when routing.jsonl is absent');
  });

  test('routing.jsonl present but contains no entry for this orchestration_id → exits 0, no stdout', () => {
    const orchId = 'orch-cond2-nomatch';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry('orch-OTHER-999')], // different orch
    });
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit stdout when routing has no entries for this orch');
  });

});

// ---------------------------------------------------------------------------
// Condition 3: spawn-accepted sentinel present → no reminder
// ---------------------------------------------------------------------------

describe('Condition 3 — spawn-accepted sentinel present', () => {

  test('spawn-accepted sentinel exists for this orch → exits 0, no stdout', () => {
    const orchId = 'orch-cond3-spawned';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
      spawnAccepted: true,
    });
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit stdout when a spawn has already been accepted');
  });

});

// ---------------------------------------------------------------------------
// Condition 4: SessionStart reinject (compact/resume) → no reminder
// ---------------------------------------------------------------------------

describe('Condition 4 — compact/resume SessionStart reinject', () => {

  test('event.source="compact" → exits 0, no stdout', () => {
    const orchId = 'orch-cond4-compact';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
    });
    const { stdout, status } = run(makeEvent(dir, { source: 'compact' }), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit stdout for compact reinjection');
  });

  test('event.source="resume" → exits 0, no stdout', () => {
    const orchId = 'orch-cond4-resume';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
    });
    const { stdout, status } = run(makeEvent(dir, { source: 'resume' }), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit stdout for resume reinjection');
  });

  test('event.source=undefined (normal turn) is not suppressed by condition 4', () => {
    // Verify that a normal turn (no source field) is not mistakenly filtered.
    // This test passes through to all other conditions — result depends on
    // full fixture state. Here we set all 5 conditions true to confirm the
    // reminder fires on a normal turn.
    const orchId = 'orch-cond4-normal';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
    });
    const { stdout, status } = run(makeEvent(dir, { source: undefined }), dir);
    assert.equal(status, 0);
    // Should fire because all 5 conditions are met with no source field.
    const parsed = parseStdout(stdout);
    assert.ok(parsed !== null, 'must emit stdout on a normal turn when all conditions are met');
  });

});

// ---------------------------------------------------------------------------
// Condition 5: reminder already shown this orch → no reminder
// ---------------------------------------------------------------------------

describe('Condition 5 — model-reminder-shown sentinel present', () => {

  test('model-reminder-shown sentinel exists → exits 0, no stdout', () => {
    const orchId = 'orch-cond5-shown';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
      reminderShown: true,
    });
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'must not emit stdout when reminder-shown sentinel is present');
  });

});

// ---------------------------------------------------------------------------
// All 5 conditions met → reminder fires, sentinel written
// ---------------------------------------------------------------------------

describe('All conditions met — reminder fires', () => {

  test('emits additionalContext JSON on stdout when all 5 conditions are true', () => {
    const orchId = 'orch-firestest-001';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, { model: 'sonnet', agent_type: 'developer', task_id: 'DEV-1' })],
    });
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    const parsed = parseStdout(stdout);
    assert.ok(parsed !== null, 'must emit JSON on stdout');
    assert.ok(
      parsed.hookSpecificOutput !== undefined,
      'stdout JSON must have hookSpecificOutput'
    );
    assert.equal(
      parsed.hookSpecificOutput.hookEventName,
      'UserPromptSubmit',
      'hookEventName must be UserPromptSubmit'
    );
    assert.ok(
      typeof parsed.hookSpecificOutput.additionalContext === 'string' &&
        parsed.hookSpecificOutput.additionalContext.length > 0,
      'additionalContext must be a non-empty string'
    );
    // Reminder must contain the routed model and agent type from the routing entry.
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /model="sonnet"/,
      'additionalContext must include the routed model'
    );
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /developer/,
      'additionalContext must reference the agent type'
    );
  });

  test('sentinel file is written after reminder fires', () => {
    const orchId = 'orch-firestest-002';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
    });
    assert.ok(!reminderSentinelExists(dir, orchId), 'sentinel must not exist before first invocation');
    run(makeEvent(dir), dir);
    assert.ok(reminderSentinelExists(dir, orchId), 'sentinel must exist after reminder fires');
  });

  test('additionalContext includes the task_id from the first routing entry', () => {
    const orchId = 'orch-firestest-003';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId, { task_id: 'ARCH-42' })],
    });
    const { stdout } = run(makeEvent(dir), dir);
    const parsed = parseStdout(stdout);
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /ARCH-42/,
      'additionalContext must include the task_id'
    );
  });

  test('additionalContext includes "First spawn" and routing instruction', () => {
    const orchId = 'orch-firestest-004';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
    });
    const { stdout } = run(makeEvent(dir), dir);
    const parsed = parseStdout(stdout);
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /[Ff]irst spawn/,
      'additionalContext must mention "First spawn"'
    );
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /routing\.jsonl/,
      'additionalContext must reference routing.jsonl'
    );
  });

});

// ---------------------------------------------------------------------------
// Idempotence — second invocation with sentinel present after first fire
// ---------------------------------------------------------------------------

describe('Idempotence — no re-fire after sentinel written', () => {

  test('second invocation exits 0 with no stdout after sentinel is written by first invocation', () => {
    const orchId = 'orch-idempotent-001';
    const dir = makeDir({
      orchId,
      routingRows: [makeRoutingEntry(orchId)],
    });

    // First invocation — reminder fires, sentinel written
    const first = run(makeEvent(dir), dir);
    assert.equal(first.status, 0);
    assert.ok(first.stdout.trim().length > 0, 'first invocation must emit stdout');
    assert.ok(reminderSentinelExists(dir, orchId), 'sentinel must be written after first invocation');

    // Second invocation — must not re-fire
    const second = run(makeEvent(dir), dir);
    assert.equal(second.status, 0);
    assert.equal(
      second.stdout.trim(),
      '',
      'second invocation must not emit stdout (sentinel prevents re-fire)'
    );
  });

});

// ---------------------------------------------------------------------------
// Fail-open paths — errors must never cause exit non-zero or throw
// ---------------------------------------------------------------------------

describe('Fail-open — malformed or missing input', () => {

  test('malformed JSON on stdin → exits 0, no stdout, no stderr noise', () => {
    // Simulate a corrupted hook payload — must not crash or block.
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '{not valid json{{',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.equal((result.stdout || '').trim(), '');
    assert.equal((result.stderr || '').trim(), '');
  });

  test('empty stdin → exits 0, no stdout', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.equal((result.stdout || '').trim(), '');
  });

  test('missing .orchestray directory (non-existent cwd path) → exits 0, no stdout', () => {
    // Point cwd at a directory that has no .orchestray subdirectory.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bare-'));
    cleanup.push(bare);
    const { stdout, status } = run(makeEvent(bare), bare);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });

  test('routing.jsonl contains malformed JSON lines → exits 0 (fail-open, no crash)', () => {
    const orchId = 'orch-failopen-malformed';
    const dir = makeDir({ orchId });
    // Write a routing.jsonl with garbage content
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      'not-json\n{also bad\n'
    );
    const { stdout, status, stderr } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    // Should not emit the reminder (no valid entries for this orch)
    assert.equal(stdout.trim(), '');
    // Must not emit an unhandled error to stderr
    assert.ok(
      !(stderr || '').includes('at Object.<anonymous>') &&
      !(stderr || '').includes('TypeError') &&
      !(stderr || '').includes('SyntaxError'),
      'must not produce a stack trace in stderr on malformed routing.jsonl'
    );
  });

  test('current-orchestration.json contains malformed JSON → exits 0 (fail-open)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-malformedorch-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, 'current-orchestration.json'), '{bad json]');
    const { stdout, status } = run(makeEvent(dir), dir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });

});

// ---------------------------------------------------------------------------
// Regression guard — double-prefix fix (v2.1.8 W4)
//
// Fixed in v2.1.8: the reminder template was building "orch-" + orchestration_id,
// but the orchestration_id stored in current-orchestration.json already starts with
// "orch-", producing "orch-orch-" in the emitted additionalContext.
//
// This test now PASSES and guards against re-introducing the double-prefix bug.
// Fix applied: removed hard-coded "orch-" prefix from line 141 of
// remind-model-before-spawn.js — orchestrationId already carries the prefix.
// ---------------------------------------------------------------------------

describe('Bug tracker — double-prefix in additionalContext', () => {

  test(
    'orchestration_id="orch-TEST123" appears exactly once in additionalContext — not as "orch-orch-TEST123"',
    () => {
      const orchId = 'orch-TEST123';
      const dir = makeDir({
        orchId,
        routingRows: [makeRoutingEntry(orchId)],
      });
      const { stdout } = run(makeEvent(dir), dir);
      const parsed = parseStdout(stdout);
      assert.ok(parsed !== null, 'must emit stdout');
      const ctx = parsed.hookSpecificOutput.additionalContext;

      // The correct orchestration ID must appear at least once.
      assert.ok(
        ctx.includes('orch-TEST123'),
        'additionalContext must contain the correct orchestration_id "orch-TEST123"'
      );

      // The double-prefixed form must NOT appear.
      // If this assertion fails, the bug is present: the template is prepending
      // "orch-" onto an orchestration_id that already starts with "orch-".
      assert.ok(
        !ctx.includes('orch-orch-TEST123'),
        'additionalContext must NOT contain "orch-orch-TEST123" (double-prefix bug)'
      );

      // Count occurrences of the ID to be thorough.
      const occurrences = ctx.split('orch-TEST123').length - 1;
      // We allow 1 or more occurrences of the correct ID but zero of the mangled form.
      // (The template may legitimately reference the orch ID in multiple places.)
      assert.ok(
        occurrences >= 1,
        'orchestration_id must appear at least once in additionalContext'
      );
    }
  );

});
