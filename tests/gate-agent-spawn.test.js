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

  // Updated for 2.0.12: Task is now in AGENT_DISPATCH_ALLOWLIST — it is gated,
  // not fast-exited. Inside an orchestration without a model → exit 2.
  test('Task tool_name inside orchestration without model exits 2 (now gated)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Task', cwd: dir, tool_input: {} });
    assert.equal(status, 2);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

  test('Task tool_name inside orchestration with model="haiku" exits 0', () => {
    // Task is in AGENT_DISPATCH_ALLOWLIST — with a valid model it is allowed.
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({
      tool_name: 'Task',
      cwd: dir,
      tool_input: { model: 'haiku' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  // Updated for 2.0.12: empty string is not in either allowlist.
  // unknown_tool_policy default is "block" → exit 2 naming the unknown tool.
  test('missing tool_name field exits 2 — unknown tool name blocked by default policy', () => {
    // event.tool_name is undefined, tool_input.tool also absent → toolName=''
    // '' is not in AGENT_DISPATCH_ALLOWLIST or SKIP_ALLOWLIST → unknown_tool_policy=block → exit 2
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ cwd: dir, tool_input: { model: 'sonnet' } });
    assert.equal(status, 2);
    assert.match(stderr, /unknown tool name ''/);
  });

  // Updated for 2.0.12: empty string is not in either allowlist → exit 2.
  test('empty string tool_name exits 2 — unknown empty tool name blocked', () => {
    // In 2.0.11, '' fell through via !== 'Agent'. In 2.0.12, '' is unknown → block.
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: '', cwd: dir });
    assert.equal(status, 2);
    assert.match(stderr, /unknown tool name ''/);
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
// D3 Fix 2 — Explore/Task in explicit dispatch allowlist
// ---------------------------------------------------------------------------

describe('D3 Fix 2 — Explore dispatch allowlist', () => {

  test('Explore inside orchestration with no model exits 2', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Explore', cwd: dir, tool_input: {} });
    assert.equal(status, 2);
    assert.match(stderr, /missing required 'model' parameter/i);
  });

  test('Explore inside orchestration with model="haiku" and routing entry exits 0', () => {
    const dir = makeDir({ withOrch: true });
    // No routing.jsonl — falls through to model-validity only; haiku is valid
    const { status, stderr } = run({
      tool_name: 'Explore',
      cwd: dir,
      tool_input: { model: 'haiku' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('Explore outside orchestration with no model exits 0 — pre-orch window, no gating', () => {
    // current-orchestration.json absent → gate no-ops → exit 0
    const dir = makeDir({ withOrch: false });
    const { status, stderr } = run({ tool_name: 'Explore', cwd: dir, tool_input: {} });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('unknown "Spawn" tool_name exits 2 fail-closed with diagnostic naming Spawn', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = run({ tool_name: 'Spawn', cwd: dir });
    assert.equal(status, 2);
    assert.match(stderr, /unknown tool name 'Spawn'/);
  });

  test('D3 Fix 2 skip-allowlist — Bash, Read, Edit, Glob, Grep, Write all exit 0', () => {
    // Table test: all skip-allowlist tools must exit 0 immediately (no gating)
    const skipTools = ['Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Write'];
    for (const toolName of skipTools) {
      const dir = makeDir({ withOrch: true });
      const { status, stderr } = run({ tool_name: toolName, cwd: dir });
      assert.equal(status, 0, `${toolName} must exit 0 (skip-allowlist)`);
      assert.equal(stderr, '', `${toolName} must not emit stderr`);
    }
  });

});

// ---------------------------------------------------------------------------
// D5 — config flags: per-tool prompt override, global_kill_switch, unknown_tool_policy
// ---------------------------------------------------------------------------

describe('D5 — config flags', () => {

  /** Write .orchestray/config.json with the given mcp_enforcement block. */
  function writeMcpConfig(dir, mcpEnforcement) {
    const configDir = path.join(dir, '.orchestray');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ mcp_enforcement: mcpEnforcement })
    );
  }

  /** Write mcp-checkpoint.jsonl with the given tool rows for an orchestration. */
  function writeCheckpointRows(dir, orchId, tools) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = new Date().toISOString();
    const lines = tools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: orchId,
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), lines);
  }

  test('per-tool prompt override: mcp_enforcement.kb_search="prompt" skips kb_search requirement', () => {
    // pattern_find present, kb_search missing BUT set to "prompt" → gate must allow
    const dir = makeDir({ withOrch: true });
    writeMcpConfig(dir, {
      pattern_find: 'hook',
      kb_search: 'prompt',          // prompt-only — gate skips this requirement
      history_find_similar_tasks: 'hook',
      unknown_tool_policy: 'block',
      global_kill_switch: false,
    });
    // Write checkpoint rows for only pattern_find and history_find_similar_tasks
    writeCheckpointRows(dir, 'orch-test-001', ['pattern_find', 'history_find_similar_tasks']);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });
    assert.equal(status, 0,
      'kb_search set to "prompt" must not be required by the gate');
    assert.ok(!stderr.includes('kb_search'),
      'kb_search must not appear in diagnostic when set to "prompt"');
  });

  test('global_kill_switch=true short-circuits 2.0.12 MCP check; routing.jsonl validation still runs', () => {
    // Kill switch bypasses the new MCP checkpoint gate but existing routing
    // checks still apply. With no routing.jsonl, model-validity check runs.
    const dir = makeDir({ withOrch: true });
    writeMcpConfig(dir, {
      global_kill_switch: true,
      kill_switch_reason: 'test: kill-switch short-circuit coverage',
    });
    // No checkpoint rows at all — but kill switch is on, so no MCP gate
    // Agent call with valid model but no routing.jsonl → falls through to allow
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });
    assert.equal(status, 0,
      'global_kill_switch=true must skip MCP checkpoint verification');
    assert.equal(stderr, '');
  });

  test('unknown_tool_policy="warn": unknown "Spawn" exits 0 with stderr warning', () => {
    const dir = makeDir({ withOrch: true });
    writeMcpConfig(dir, {
      unknown_tool_policy: 'warn',
      global_kill_switch: false,
    });
    const { status, stderr } = run({ tool_name: 'Spawn', cwd: dir });
    assert.equal(status, 0, 'warn policy must allow unknown tools (exit 0)');
    assert.match(stderr, /unknown tool name 'Spawn'/,
      'warn policy must still emit a stderr diagnostic');
  });

});

// ---------------------------------------------------------------------------
// D2 step 6 — MCP checkpoint gate: missing required tools
// ---------------------------------------------------------------------------

describe('D2 step 6 — MCP checkpoint gate', () => {

  /** Write routing.jsonl so routing validation passes. */
  function writeRoutingFile(dir, entries) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), lines);
  }

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
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
      ...overrides,
    };
  }

  function writeCheckpointRows(dir, orchId, tools) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = new Date().toISOString();
    const lines = tools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: orchId,
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), lines);
  }

  test('D2 step 6: all 3 required tools present → gate exits 0', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);
    writeCheckpointRows(dir, 'orch-test-001', [
      'pattern_find', 'kb_search', 'history_find_similar_tasks',
    ]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0, 'All 3 required tools present — gate must allow');
    assert.equal(stderr, '');
  });

  test('D2 step 6: pattern_find present, kb_search missing → gate exits 2 naming kb_search', () => {
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);
    writeCheckpointRows(dir, 'orch-test-001', [
      'pattern_find', 'history_find_similar_tasks',
      // kb_search intentionally omitted
    ]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 2, 'Missing kb_search must block spawn');
    assert.match(stderr, /kb_search/, 'Diagnostic must name the missing tool kb_search');
  });

  test('D6 step 3 case A: mcp-checkpoint.jsonl absent → fail-open (exit 0)', () => {
    // File does not exist — upgrade window. Gate must not block.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);
    // No mcp-checkpoint.jsonl written — file absent
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0, 'File absent → fail-open');
    assert.equal(stderr, '');
  });

  test('C3 file exists zero rows for orchestration fails open', () => {
    // FINDING C3: file present but contains rows for a DIFFERENT orchestration.
    // The gate must fail-open when zero rows match current orchestration_id.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);

    // Write checkpoint rows for a DIFFERENT orchestration_id
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = new Date().toISOString();
    const foreignRows = ['pattern_find', 'kb_search', 'history_find_similar_tasks'].map(
      tool => JSON.stringify({
        timestamp: now,
        orchestration_id: 'orch-OTHER-999',  // different orch — not this one
        tool,
        outcome: 'answered',
        phase: 'pre-decomposition',
        result_count: null,
      })
    ).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), foreignRows);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0,
      'C3: file present but zero rows for current orch → fail-open');
    assert.equal(stderr, '');
  });

  test('D6 step 3 corrupted mcp-checkpoint.jsonl → warn + allow (exit 0)', () => {
    // Malformed JSON in ledger — gate must fail-open, matching routing.jsonl pattern
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);

    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'mcp-checkpoint.jsonl'),
      '{{{CORRUPTED JSON}}}\nnot valid at all\n'
    );

    const { status } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0,
      'Corrupted checkpoint file must fail-open (exit 0)');
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
// G8 — BUG-B+C regression: repeated-orchestration gate pass-through
// Ensures the gate does not false-block when routing.jsonl contains entries
// from a prior orchestration. Missing test class that would have caught the
// BUG-B + BUG-C showstopper during the 2.0.12 review.
// ---------------------------------------------------------------------------

describe('G8 — BUG-B+C regression: repeated-orchestration gate pass-through', () => {

  test('G8-T1: gate exits 0 when routing.jsonl has prior-orch entries AND current-orch has correct checkpoint rows', () => {
    // Scenario that triggered the P0 showstopper in orch-1775913040:
    //   1. routing.jsonl has entries for orch-PREVIOUS (a completed prior orch)
    //      AND orch-CURRENT (current orch's routing decision from decomposition).
    //   2. mcp-checkpoint.jsonl has three rows for orch-CURRENT with
    //      phase='pre-decomposition' (correct per the BUG-B fix).
    //   3. current-orchestration.json identifies the session as orch-CURRENT.
    //   4. Spawn a developer agent — gate must exit 0.
    //
    // Pre-fix (BUG-B): the file-existence check on routing.jsonl found the
    // prior-orch entries and wrote phase='post-decomposition' on the checkpoint
    // rows. BUG-C then filtered out those rows → exit 2 (false block).
    // Post-fix: phase is 'pre-decomposition' (correct) → gate passes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-g8-'));
    cleanup.push(dir);

    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Step 1: current orchestration is orch-CURRENT
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-CURRENT' })
    );

    // Step 2: routing.jsonl has entries for orch-PREVIOUS and orch-CURRENT
    const now = new Date().toISOString();
    const routingEntries = [
      {
        timestamp: '2026-04-10T10:00:00.000Z',
        orchestration_id: 'orch-PREVIOUS',
        task_id: 'task-1',
        agent_type: 'developer',
        description: 'Previous task',
        model: 'sonnet',
        effort: 'medium',
        complexity_score: 4,
        score_breakdown: {},
        decided_by: 'pm',
        decided_at: 'decomposition',
      },
      {
        timestamp: now,
        orchestration_id: 'orch-CURRENT',
        task_id: 'task-1',
        agent_type: 'developer',
        description: 'Build the feature',
        model: 'sonnet',
        effort: 'medium',
        complexity_score: 4,
        score_breakdown: {},
        decided_by: 'pm',
        decided_at: 'decomposition',
      },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      routingEntries.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    // Step 3: mcp-checkpoint.jsonl has three rows for orch-CURRENT with
    //         phase='pre-decomposition' (correct per the BUG-B fix)
    const requiredTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const checkpointRows = requiredTools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: tool === 'pattern_find' ? 2 : null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), checkpointRows);

    // Step 4: spawn developer agent — gate must exit 0
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'Build the feature',
      },
    });

    assert.equal(status, 0,
      'G8-T1: gate must exit 0 when prior-orch routing rows exist and current-orch has correct checkpoint rows');
    assert.equal(stderr, '',
      'G8-T1: no stderr expected when all requirements are satisfied');
  });

  test('G8-T2: gate exits 0 when checkpoint rows have phase="pre-decomposition" regardless of routing.jsonl prior entries', () => {
    // Defense-in-depth for BUG-C fix (phaseFilter=null): even if checkpoint rows
    // carried wrong phase (e.g., post-decomposition due to pre-fix BUG-B), the gate
    // must still pass because phaseFilter=null ignores the phase field entirely.
    // This test deliberately writes phase='post-decomposition' rows and verifies
    // the gate exits 0 (phase is not an enforcement field).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-g8b-'));
    cleanup.push(dir);

    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-CURRENT' })
    );

    const now = new Date().toISOString();
    const routingEntry = JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Build the feature',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
    });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), routingEntry + '\n');

    // Deliberately write checkpoint rows with phase='post-decomposition'
    // (the BUG-B poisoned state). The gate must NOT block on this.
    const requiredTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const checkpointRows = requiredTools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      tool,
      outcome: 'answered',
      phase: 'post-decomposition',   // deliberately wrong phase — gate must ignore
      result_count: null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), checkpointRows);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'Build the feature',
      },
    });

    assert.equal(status, 0,
      'G8-T2: gate must exit 0 when checkpoint rows exist for all required tools regardless of phase value (BUG-C-2.0.13 defense-in-depth)');
  });

  test('G8-T3: BUG-D diagnostic path — phase-mismatch message emitted when rows exist but with wrong phase AND a tool is genuinely absent', () => {
    // This test exercises the BUG-D defensive diagnostic path (belt-and-braces
    // safety net). Under normal operation post-BUG-B-fix, this path is unreachable
    // because phase derivation is now orch-scoped. However, the diagnostic is
    // preserved to cover any future phase-poisoning scenario.
    //
    // Scenario: kb_search and history_find_similar_tasks are present but with
    // phase='post-decomposition' (poisoned rows). pattern_find is genuinely absent.
    //
    // The null-filter (phaseFilter=null) finds pattern_find as the only missing tool.
    // The strict-filter (phaseFilter='pre-decomposition') finds all three missing
    // (kb_search and history_find_similar_tasks are filtered out by phase).
    // phaseMismatchTools = tools in strict-missing but NOT in null-missing
    //                     = [kb_search, history_find_similar_tasks]
    //
    // Because phaseMismatchTools.length > 0, the BUG-D phase-mismatch diagnostic
    // fires (mentioning the poisoned tools), and gate exits 2.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-g8c-'));
    cleanup.push(dir);

    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-CURRENT' })
    );

    const now = new Date().toISOString();
    const routingEntry = JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Build the feature',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
    });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), routingEntry + '\n');

    // Write kb_search + history_find_similar_tasks with phase='post-decomposition'
    // (poisoned). pattern_find is genuinely absent.
    const checkpointRows = ['kb_search', 'history_find_similar_tasks'].map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      tool,
      outcome: 'answered',
      phase: 'post-decomposition',   // poisoned phase — BUG-D diagnostic path
      result_count: null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), checkpointRows);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'Build the feature',
      },
    });

    // Gate must block (exit 2) because pattern_find is genuinely absent
    assert.equal(status, 2,
      'G8-T3: gate must block when a required tool is genuinely absent');
    // The BUG-D phase-mismatch diagnostic fires for the poisoned tools
    assert.match(stderr, /phase mismatch/i,
      'G8-T3: BUG-D phase-mismatch diagnostic must fire when rows exist with wrong phase');
    // The message names the tools that were phase-poisoned (not pattern_find which is absent)
    assert.match(stderr, /kb_search|history_find_similar_tasks/,
      'G8-T3: phase-mismatch diagnostic must name the poisoned tools');
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

// ---------------------------------------------------------------------------
// 2013-W3: mcp_checkpoint_missing audit event emission
// ---------------------------------------------------------------------------
// Verifies that gate-agent-spawn.js emits a machine-readable mcp_checkpoint_missing
// event to events.jsonl on every block path, with correct shape and phase_mismatch
// field. Test 3 (atomicAppendJsonl stub) is skipped per the XS-effort caveat in
// the task brief (the gate runs as a child process; stubbing internals would require
// NODE_PATH overrides or a test-harness shim — too invasive for an XS task).

describe('2013-W3: mcp_checkpoint_missing event emission', () => {

  /** Write mcp-checkpoint.jsonl with the given rows. */
  function writeCheckpointRows(dir, rows) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), lines);
  }

  /** Write the MCP enforcement config that enables all three tools as 'hook'. */
  function writeMcpConfig(dir, mcpEnforcement) {
    const configDir = path.join(dir, '.orchestray');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ mcp_enforcement: mcpEnforcement })
    );
  }

  /** Read and parse events.jsonl from the given tmpdir. Returns array of event objects. */
  function readEvents(dir) {
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  }

  /** Build a minimal checkpoint row. */
  function cpRow(orchId, tool, phase) {
    return {
      timestamp: new Date().toISOString(),
      orchestration_id: orchId,
      tool,
      outcome: 'answered',
      phase: phase || 'pre-decomposition',
      result_count: null,
    };
  }

  test('W3-T1: genuine-absence block emits mcp_checkpoint_missing with phase_mismatch=false', () => {
    // All three required tools are simply absent — null-filter finds them all missing.
    // phaseMismatchTools will be empty (no rows at all for these tools).
    // Expected: event emitted with missing_tools listing the absent tools,
    //           phase_mismatch: false, gate exits 2.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-w3t1-'));
    cleanup.push(dir);

    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-W3-T1' })
    );

    // Enforce all three tools via hook
    writeMcpConfig(dir, {
      pattern_find: 'hook',
      kb_search: 'hook',
      history_find_similar_tasks: 'hook',
      global_kill_switch: false,
    });

    // Write only pattern_find — kb_search and history_find_similar_tasks are absent
    writeCheckpointRows(dir, [
      cpRow('orch-W3-T1', 'pattern_find', 'pre-decomposition'),
    ]);

    const { status } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });

    // Gate must block
    assert.equal(status, 2, 'W3-T1: gate must exit 2 on genuine absence');

    // Event must be written
    const events = readEvents(dir);
    const missing_ev = events.find(e => e.type === 'mcp_checkpoint_missing');
    assert.ok(missing_ev, 'W3-T1: mcp_checkpoint_missing event must be emitted to events.jsonl');
    assert.equal(missing_ev.orchestration_id, 'orch-W3-T1',
      'W3-T1: event orchestration_id must match current orch');
    assert.ok(Array.isArray(missing_ev.missing_tools),
      'W3-T1: missing_tools must be an array');
    assert.ok(missing_ev.missing_tools.includes('kb_search'),
      'W3-T1: missing_tools must include kb_search');
    assert.ok(missing_ev.missing_tools.includes('history_find_similar_tasks'),
      'W3-T1: missing_tools must include history_find_similar_tasks');
    assert.equal(missing_ev.phase_mismatch, false,
      'W3-T1: phase_mismatch must be false when tools are genuinely absent (no poisoned rows)');
    assert.equal(missing_ev.source, 'hook',
      'W3-T1: source must be "hook"');
    assert.ok(typeof missing_ev.timestamp === 'string' && missing_ev.timestamp.length > 0,
      'W3-T1: timestamp must be a non-empty string');
  });

  test('W3-T2: phase-mismatch block (BUG-D path) emits mcp_checkpoint_missing with phase_mismatch=true', () => {
    // Scenario: kb_search + history_find_similar_tasks rows exist but with
    // phase='post-decomposition' (poisoned). pattern_find is genuinely absent.
    // null-filter finds pattern_find missing (the only true absence).
    // strict-filter finds all three missing (poisoned rows filtered out).
    // phaseMismatchTools = [kb_search, history_find_similar_tasks] (in strict but not null).
    // Gate takes the BUG-D phase-mismatch diagnostic path and exits 2.
    // Expected: event emitted with phase_mismatch: true.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-w3t2-'));
    cleanup.push(dir);

    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-W3-T2' })
    );

    writeMcpConfig(dir, {
      pattern_find: 'hook',
      kb_search: 'hook',
      history_find_similar_tasks: 'hook',
      global_kill_switch: false,
    });

    // kb_search + history_find_similar_tasks present but phase-poisoned.
    // pattern_find genuinely absent.
    writeCheckpointRows(dir, [
      cpRow('orch-W3-T2', 'kb_search', 'post-decomposition'),
      cpRow('orch-W3-T2', 'history_find_similar_tasks', 'post-decomposition'),
    ]);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });

    // Gate must block (pattern_find genuinely absent triggers exit 2)
    assert.equal(status, 2, 'W3-T2: gate must exit 2 on phase-mismatch + genuine absence');
    // BUG-D diagnostic message must fire
    assert.match(stderr, /phase mismatch/i,
      'W3-T2: BUG-D phase-mismatch diagnostic must appear in stderr');

    // Event must be written
    const events = readEvents(dir);
    const missing_ev = events.find(e => e.type === 'mcp_checkpoint_missing');
    assert.ok(missing_ev, 'W3-T2: mcp_checkpoint_missing event must be emitted to events.jsonl');
    assert.equal(missing_ev.orchestration_id, 'orch-W3-T2',
      'W3-T2: event orchestration_id must match current orch');
    assert.equal(missing_ev.phase_mismatch, true,
      'W3-T2: phase_mismatch must be true when poisoned rows trigger BUG-D path');
    // missing_tools reflects null-filter result: only pattern_find is absent
    assert.ok(Array.isArray(missing_ev.missing_tools),
      'W3-T2: missing_tools must be an array');
    assert.ok(missing_ev.missing_tools.includes('pattern_find'),
      'W3-T2: missing_tools must include pattern_find (the genuinely absent tool)');
    assert.equal(missing_ev.source, 'hook',
      'W3-T2: source must be "hook"');
  });

});

// ---------------------------------------------------------------------------
// 2013-W4: AGENT_DISPATCH_ALLOWLIST + SKIP_ALLOWLIST drift guard
// ---------------------------------------------------------------------------
// Known-good manifest as of Claude Code 2.1.59 (the version 2.0.13 targets).
// If this test fails, Claude Code has likely added or removed a built-in
// tool name. DO NOT blindly update this manifest — instead:
//   1. Verify the new Claude Code version's tool inventory (release notes or
//      by inspecting a real PreToolUse payload).
//   2. Decide whether each new name is an agent-dispatch tool (goes in
//      AGENT_DISPATCH_ALLOWLIST, subject to routing + MCP checkpoint gate)
//      or a non-dispatch tool (goes in SKIP_ALLOWLIST, bypasses the gate).
//   3. Update the constant in bin/gate-agent-spawn.js.
//   4. Update this manifest to match.
//   5. Update CLAUDE.md's dispatch-name list if one exists.
//   All three updates must land in the same PR for consistency.

describe('2013-W4: AGENT_DISPATCH_ALLOWLIST + SKIP_ALLOWLIST drift guard', () => {
  const KNOWN_GOOD_DISPATCH_ALLOWLIST = ['Agent', 'Explore', 'Task'];
  const KNOWN_GOOD_SKIP_ALLOWLIST = [
    'Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Write',
    'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
  ];

  // Read the constants from the gate script. Since the constants are declared
  // inside process.stdin.on('end', ...), we cannot directly require() them.
  // Instead, read the source file as text and parse out the Set definitions.
  const gateSource = fs.readFileSync(
    path.resolve(__dirname, '../bin/gate-agent-spawn.js'),
    'utf8'
  );

  test('AGENT_DISPATCH_ALLOWLIST exactly matches the known-good manifest', () => {
    const match = gateSource.match(
      /const AGENT_DISPATCH_ALLOWLIST = new Set\(\[([^\]]+)\]\)/
    );
    assert.ok(match !== null, 'AGENT_DISPATCH_ALLOWLIST constant not found in source');
    const actual = match[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    assert.deepEqual(actual.sort(), [...KNOWN_GOOD_DISPATCH_ALLOWLIST].sort());
  });

  test('SKIP_ALLOWLIST exactly matches the known-good manifest', () => {
    // Use [\s\S]+? to match across newlines (the Set literal spans multiple lines).
    const match = gateSource.match(
      /const SKIP_ALLOWLIST = new Set\(\[([\s\S]+?)\]\)/
    );
    assert.ok(match !== null, 'SKIP_ALLOWLIST constant not found in source');
    const actual = match[1]
      .split(/[,\n]/)
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    assert.deepEqual(actual.sort(), [...KNOWN_GOOD_SKIP_ALLOWLIST].sort());
  });

  test('no overlap between AGENT_DISPATCH_ALLOWLIST and SKIP_ALLOWLIST', () => {
    const dispatch = new Set(KNOWN_GOOD_DISPATCH_ALLOWLIST);
    const skip = new Set(KNOWN_GOOD_SKIP_ALLOWLIST);
    for (const name of dispatch) {
      assert.equal(skip.has(name), false, `'${name}' appears in both allowlists`);
    }
  });
});

// ---------------------------------------------------------------------------
// W4 — task_id-based routing match (DEV-3 W4 behavior)
// ---------------------------------------------------------------------------

describe('W4 — task_id-based routing match', () => {

  /** Write routing.jsonl with the given entries. */
  function writeRoutingFile(dir, entries) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), lines);
  }

  /** Write mcp-checkpoint.jsonl with all 3 required tools. */
  function writeFullCheckpoint(dir, orchId) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = new Date().toISOString();
    const tools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const lines = tools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: orchId,
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), lines);
  }

  /** Build a minimal routing entry with task_id. */
  function routingEntryW4(overrides = {}) {
    return {
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-test-001',
      task_id: 'task-w4-1',
      agent_type: 'developer',
      description: 'Original description text',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
      ...overrides,
    };
  }

  test('W4-T1: task_id+agent_type match with drifted description — should allow + emit stderr warning', () => {
    // W4 primary match: (task_id, agent_type) match succeeds even if description drifted.
    // When descriptions differ, a warning is emitted to stderr but the spawn is ALLOWED.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntryW4()]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'task-w4-1',
        description: 'Completely different description due to drift',
      },
    });

    assert.equal(status, 0,
      'W4: task_id+agent_type match must allow spawn even with drifted description');
    assert.ok(
      stderr.includes('description drift') || stderr.includes('task_id'),
      'W4: a warning about description drift or task_id match must be emitted to stderr'
    );
  });

  test('W4-T2: task_id+agent_type match with IDENTICAL description — should allow silently (no warning)', () => {
    // When task_id matches AND descriptions are identical, no warning should be emitted.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntryW4()]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'task-w4-1',
        description: 'Original description text',  // exact match
      },
    });

    assert.equal(status, 0, 'W4: exact task_id+desc match must allow spawn');
    // No description-drift warning expected when descriptions match.
    assert.ok(!stderr.includes('description drift'),
      'W4: no drift warning when descriptions are identical');
  });

  test('W4-T3: task_id present but no routing entry for that task_id — falls back to description match', () => {
    // W4 fallback: task_id provided but produces no match → fall back to
    // (agent_type, description) match. If that also fails → block.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntryW4({ task_id: 'task-OTHER' })]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'task-w4-MISSING',     // this task_id has no routing entry
        description: 'Some unmatched description',  // description also won't match
      },
    });

    // Both tiers fail → gate blocks.
    assert.equal(status, 2,
      'W4: task_id miss + description miss → gate must block');
    // The fallback warning about task_id miss should be in stderr.
    assert.ok(
      stderr.includes('task_id') || stderr.includes('no routing entry'),
      'W4: stderr must mention task_id miss or no routing entry'
    );
  });

  test('W4-T4: task_id present but no routing entry → falls back to description match that succeeds → allows', () => {
    // W4 fallback path that SUCCEEDS: task_id misses but description match works.
    const dir = makeDir({ withOrch: true });
    // Routing entry has task_id='task-OTHER' (won't match) but description matches spawn.
    writeRoutingFile(dir, [routingEntryW4({
      task_id: 'task-OTHER',
      description: 'Fix auth',
    })]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        task_id: 'task-w4-MISSING',  // task_id miss → fall back
        description: 'Fix auth',     // description match → fallback succeeds
      },
    });

    assert.equal(status, 0,
      'W4: task_id miss + description match → fallback succeeds → allow');
    // Fallback warning (task_id found no match) must appear in stderr.
    assert.ok(
      stderr.includes('task_id') || stderr.includes('description key'),
      'W4: stderr must warn about falling back from task_id to description key'
    );
  });

  test('W4b-T1: task_id absent but description has TASK-ID prefix — extract and match via task_id path', () => {
    // W4b (v2.0.15 preflight): Claude Code drops unknown toolInput fields so
    // toolInput.task_id is typically null. The gate now extracts task_id from
    // the leading `TASK-ID ` token of the description when it matches the
    // convention — this makes the W4 path activate in practice.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntryW4({
      task_id: 'DEV-1',
      description: 'DEV-1 bin/mcp-server fixes',  // routing desc
    })]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        // task_id intentionally absent
        description: 'DEV-1 mcp-server fixes',  // drifted from routing desc — but shares DEV-1 prefix
      },
    });

    assert.equal(status, 0,
      'W4b: leading TASK-ID prefix in description must activate task_id match path');
    assert.ok(
      stderr.includes('description drift') || stderr.includes('task_id=DEV-1'),
      'W4b: description-drift warning (or task_id=DEV-1 mention) expected; got: ' + JSON.stringify(stderr)
    );
  });

  test('W4b-T2: description without TASK-ID prefix does not spuriously extract task_id', () => {
    // Sanity check: descriptions that do not match the TASK-ID convention
    // must NOT have a task_id extracted (avoid false-positive matches).
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntryW4({ description: 'Fix auth' })]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'Fix auth',  // no TASK-ID prefix
      },
    });

    assert.equal(status, 0, 'W4b: existing fallback path still works');
    assert.ok(!stderr.includes('task_id='),
      'W4b: no spurious task_id diagnostic when description has no TASK-ID prefix');
  });

  test('W4-T5: spawn with missing task_id on toolInput — fallback path behaves as before (description match)', () => {
    // W4 original behavior preserved: when task_id is absent from toolInput,
    // the gate uses the existing (agent_type, description) match unchanged.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntryW4({ description: 'Fix auth' })]);
    writeFullCheckpoint(dir, 'orch-test-001');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        // task_id intentionally absent
        description: 'Fix auth',
      },
    });

    assert.equal(status, 0,
      'W4: absent task_id falls back to description match (original behavior preserved)');
    // No task_id-related warnings when task_id is simply absent.
    assert.ok(!stderr.includes('task_id='),
      'W4: no task_id diagnostic when task_id absent from toolInput');
  });

});
