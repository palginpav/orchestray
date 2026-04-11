#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/gate-agent-spawn.js
 *
 * PreToolUse:Agent hook — blocks unrouted Agent() spawns inside orchestrations.
 * Fails open on all unexpected errors.
 *
 * Strategy:
 *  - Drive the script via spawnSync with stdin piped
 *  - Isolate orchestration state per test with fresh tmpdirs
 *  - Pass tmpdir via event.cwd so the script resolves .orchestray/audit/
 *    from the isolated dir, not the real project dir
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/gate-agent-spawn.js');

/** Shared list of tmpdirs to clean up after each test. */
const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir.
 * Optionally write a current-orchestration.json inside it.
 */
function makeDir({ withOrch = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-test-'));
  cleanup.push(dir);
  if (withOrch) {
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-test-001' })
    );
  }
  return dir;
}

/** Run the hook script with the given event payload on stdin. */
function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Tool filtering — non-Agent tools must always exit 0 immediately
// ---------------------------------------------------------------------------

describe('tool filtering', () => {

  test('Bash tool_name exits 0 without inspecting orchestration', () => {
    // No tmpdir needed — tool filtering happens before the orchestration check
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Bash', cwd: dir });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('Read tool_name exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Read', cwd: dir });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('Edit tool_name exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Edit', cwd: dir });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('Task tool_name exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Task', cwd: dir });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('missing tool_name field exits 0 (fail-open)', () => {
    // event.tool_name is undefined — the script falls back to tool_input.tool,
    // which is also absent, so toolName resolves to '' → not 'Agent' → exit 0
    const dir = makeDir({ withOrch: true });
    const { status } = run({ cwd: dir, tool_input: { model: 'sonnet' } });
    assert.equal(status, 0);
  });

  test('empty string tool_name exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status } = run({ tool_name: '', cwd: dir });
    assert.equal(status, 0);
  });

  // Fallback branch — gate-agent-spawn.js:34 resolves toolName from
  // `event.tool_name` OR `event.tool_input.tool` as a secondary source. The
  // primary tests above hit the `tool_name` path; these cover the fallback
  // explicitly so it doesn't silently bit-rot.
  test('missing tool_name but tool_input.tool="Agent" — fallback branch gates correctly', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      cwd: dir,
      tool_input: { tool: 'Agent' /* no model — should be blocked */ },
    });
    assert.equal(status, 2);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

  test('missing tool_name but tool_input.tool="Bash" — fallback branch exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      cwd: dir,
      tool_input: { tool: 'Bash' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('tool_name takes precedence over tool_input.tool when both present', () => {
    // tool_name="Bash" wins — short-circuits to exit 0 even though
    // tool_input.tool="Agent" would otherwise trigger the gate.
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Bash',
      cwd: dir,
      tool_input: { tool: 'Agent' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

});

// ---------------------------------------------------------------------------
// Outside orchestration — Agent tool but no current-orchestration.json
// ---------------------------------------------------------------------------

describe('outside orchestration', () => {

  test('Agent tool with no current-orchestration.json exits 0', () => {
    // Clean dir with no .orchestray/audit/ at all
    const dir = makeDir({ withOrch: false });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {},
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

});

// ---------------------------------------------------------------------------
// Inside orchestration — block paths
// ---------------------------------------------------------------------------

describe('inside orchestration — block paths', () => {

  test('missing model parameter exits 2 with descriptive message', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {},
    });
    assert.equal(status, 2);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

  test('null model exits 2', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: null },
    });
    assert.equal(status, 2);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

  test('empty string model exits 2', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: '' },
    });
    assert.equal(status, 2);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

  test('model="inherit" exits 2 with "forbidden" message', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'inherit' },
    });
    assert.equal(status, 2);
    assert.match(stderr, /forbidden/i);
  });

  test('unrecognized model string exits 2 with descriptive message', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'gpt-4' },
    });
    assert.equal(status, 2);
    // Should reference the unrecognized model and hint at valid tiers
    assert.match(stderr, /gpt-4/);
    assert.match(stderr, /haiku|sonnet|opus/i);
  });

});

// ---------------------------------------------------------------------------
// Inside orchestration — allow paths
// ---------------------------------------------------------------------------

describe('inside orchestration — allow paths', () => {

  test('model="sonnet" exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('model="opus" exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'opus' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('model="haiku" exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'haiku' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('full model id "claude-opus-4-6" exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'claude-opus-4-6' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('full model id "claude-sonnet-4-6" exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'claude-sonnet-4-6' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('model="SONNET" (uppercase) exits 0 — matching is case-insensitive', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'SONNET' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('model="CLAUDE-HAIKU-3" exits 0', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'CLAUDE-HAIKU-3' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

});

// ---------------------------------------------------------------------------
// Failure modes — must fail open (exit 0) so hooks never block work
// ---------------------------------------------------------------------------

describe('failure modes — fail open', () => {

  test('malformed JSON on stdin exits 0 (fail-open)', () => {
    const { status } = run('{{not json}}');
    assert.equal(status, 0);
  });

  test('empty stdin exits 0 (fail-open)', () => {
    const { status } = run('');
    assert.equal(status, 0);
  });

  test('missing tool_input when inside orchestration exits 0 or 2 — script treats missing input as missing model', () => {
    // The script does: const toolInput = event.tool_input || {};
    // then const model = toolInput.model; => undefined => exits 2
    // This is the documented expected behavior: inside orch with no tool_input
    // is treated the same as missing model.
    const dir = makeDir({ withOrch: true });
    const { status } = run({ tool_name: 'Agent', cwd: dir });
    // Script exits 2 because model is undefined. Document this behavior.
    assert.equal(status, 2);
  });

});

// ---------------------------------------------------------------------------
// routing.jsonl validation
// ---------------------------------------------------------------------------

describe('routing.jsonl validation', () => {

  /** Write a routing.jsonl file with the given entries into the tmpdir. */
  function writeRoutingFile(dir, entries) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), lines);
  }

  /** Build a minimal routing entry. */
  function routingEntry(overrides = {}) {
    return {
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-test-001',
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Fix auth',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: { file_count: 1, cross_cutting: 1, description: 1, keywords: 1 },
      decided_by: 'pm',
      decided_at: 'decomposition',
      ...overrides,
    };
  }

  test('happy path — routing entry exists, model matches — exits 0', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('happy path — full model id matches short tier in routing entry — exits 0', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    // Pass full model ID — should normalize to 'sonnet' and match
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'claude-sonnet-4-6', description: 'Fix auth' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('mismatch — routing says sonnet, Agent() called with opus — exits 2', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'opus', description: 'Fix auth' },
    });
    assert.equal(status, 2);
    assert.match(stderr, /model routing mismatch/i);
    assert.match(stderr, /sonnet/);
    assert.match(stderr, /opus/);
  });

  test('mismatch — routing says haiku, Agent() called with sonnet — exits 2', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'haiku' })]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 2);
    assert.match(stderr, /model routing mismatch/i);
  });

  test('no matching entry — different agent_type — exits 2', () => {
    const dir = makeDir({ withOrch: true });
    // Only a developer entry exists
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    // Spawn as reviewer — no routing entry for reviewer
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'reviewer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 2);
    assert.match(stderr, /no routing entry/i);
  });

  test('no matching entry — different description — exits 2', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    // Different description — no match
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Refactor logging' },
    });
    assert.equal(status, 2);
    assert.match(stderr, /no routing entry/i);
  });

  test('description substring match — prefix match allows spawn — exits 0', () => {
    const dir = makeDir({ withOrch: true });
    // Entry has long description stored
    writeRoutingFile(dir, [routingEntry({
      agent_type: 'developer',
      description: 'Fix authentication module in auth/handler.js',
      model: 'sonnet',
    })]);
    // Spawn uses shorter prefix — should match
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix authentication module' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('most recent entry wins when two entries for same (agent_type, description) with different models', () => {
    const dir = makeDir({ withOrch: true });
    // First (older) entry says sonnet, second (newer) re-plan entry says opus
    writeRoutingFile(dir, [
      routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet', timestamp: '2026-04-11T10:00:00.000Z' }),
      routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'opus',   timestamp: '2026-04-11T11:00:00.000Z' }),
    ]);
    // Most recent says opus — passing opus should succeed
    const { status: statusOpus } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'opus', description: 'Fix auth' },
    });
    assert.equal(statusOpus, 0);

    // Passing the old model (sonnet) should now fail
    const { status: statusSonnet, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(statusSonnet, 2);
    assert.match(stderr, /model routing mismatch/i);
  });

  test('missing routing.jsonl file — falls through to existing checks only — exits 0 with valid model', () => {
    // No routing.jsonl exists — pre-decomposition or non-orchestration spawn
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('malformed routing.jsonl — all garbage lines skipped, hook blocks spawn (no entry)', () => {
    // Design contract: readRoutingEntries silently skips malformed JSON
    // lines and returns []. findRoutingEntry on [] returns null. The hook
    // then blocks the spawn with "no routing entry". This is the CORRECT
    // behavior — a corrupted routing file must not silently permit
    // unrouted spawns, and must not crash the hook. The outer try/catch
    // around findRoutingEntry exists to handle unexpected exceptions
    // (permission errors, etc.) and is NOT exercised by malformed JSON.
    //
    // Recovery for operators: delete the corrupted routing.jsonl to fall
    // back to model-validity-only checking (the existence check will
    // return false and the hook falls through).
    const dir = makeDir({ withOrch: true });
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), '{{{garbage content}}}\nnot json at all\n');

    const { status } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    // Hook must exit cleanly (not crash) — and blocks (exit 2, no entry).
    assert.notEqual(status, null, 'hook must exit cleanly, not crash');
    assert.equal(status, 2, 'all-garbage routing.jsonl skips every line; findRoutingEntry returns null; hook blocks');
  });

});
