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

/** Run the hook script with the given event payload on stdin.
 *  Optional `env` overrides allow tests to opt into B-7.4 hard-block (default
 *  behavior in v2.2.9) or out of it via `ORCHESTRAY_STRICT_MODEL_REQUIRED=0`. */
function run(payload, { env } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, env || {}),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/** v2.2.9 B-7.4: default is hard-block on missing model. R-DX1 auto-resolve
 *  tests must opt out via ORCHESTRAY_STRICT_MODEL_REQUIRED=0. */
function runAutoResolve(payload) {
  return run(payload, { env: { ORCHESTRAY_STRICT_MODEL_REQUIRED: '0' } });
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

  // Updated for 2.1.11 (R-DX1): Task is in AGENT_DISPATCH_ALLOWLIST — it is gated.
  // Missing model auto-resolves to sonnet (exit 0) instead of hard-blocking (exit 2).
  test('Task tool_name inside orchestration without model auto-resolves (R-DX1)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({ tool_name: 'Task', cwd: dir, tool_input: {} });
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
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
  // Updated for 2.1.11 (R-DX1): missing model no longer hard-blocks; auto-resolve applies.
  test('missing tool_name but tool_input.tool="Agent" — auto-resolves model (R-DX1)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({
      cwd: dir,
      tool_input: { tool: 'Agent' /* no model — auto-resolved via R-DX1 */ },
    });
    // R-DX1: auto-resolve to global_default_sonnet → exit 0.
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
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

  // Updated for 2.1.11 (R-DX1): missing model auto-resolves to sonnet (exit 0).
  test('Explore inside orchestration with no model auto-resolves (R-DX1)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({ tool_name: 'Explore', cwd: dir, tool_input: {} });
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
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
    // Include pattern_record_application to satisfy the §22c post-decomp gate
    // (routing.jsonl exists → second-spawn window → §22c hook-warn fires without it).
    writeCheckpointRows(dir, 'orch-test-001', [
      'pattern_find', 'kb_search', 'history_find_similar_tasks', 'pattern_record_application',
    ]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0, 'All 3 required tools present — gate must allow');
    assert.equal(stderr, '');
  });

  test('D2 step 6: pattern_find present, kb_search missing → warn-mode: exits 0 with advisory naming kb_search', () => {
    // v2.0.23 §22b warn-mode: gate emits advisory but ALLOWS spawn (no exit 2).
    // pattern_record_application also included to satisfy §22c post-decomp gate
    // (routing.jsonl exists → second-spawn window is active).
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);
    writeCheckpointRows(dir, 'orch-test-001', [
      'pattern_find', 'history_find_similar_tasks', 'pattern_record_application',
      // kb_search intentionally omitted — §22b advisory fires for it
    ]);
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0, 'Warn-mode: missing kb_search must NOT block spawn (exit 0)');
    assert.match(stderr, /kb_search/, 'Advisory must name the missing tool kb_search');
    assert.match(stderr, /v2\.0\.23/, 'Advisory must reference v2.0.23');
  });

  test('D6 step 3 case A: mcp-checkpoint.jsonl absent → fail-open (exit 0)', () => {
    // File does not exist — upgrade window. Gate must not block.
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry()]);
    // No mcp-checkpoint.jsonl written — file absent.
    // Write a pattern_record_application event to events.jsonl to satisfy the §22c
    // post-decomp gate (routing.jsonl exists → second-spawn window active).
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({ type: 'pattern_record_skip_reason', orchestration_id: 'orch-test-001' }) + '\n'
    );
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

    // Write checkpoint rows for a DIFFERENT orchestration_id only.
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

    // Satisfy §22c post-decomp gate via events.jsonl (routing.jsonl exists →
    // second-spawn window is active). The gate also checks events.jsonl for a
    // pattern_record_skip_reason event to clear the advisory condition.
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({
        type: 'pattern_record_skip_reason',
        orchestration_id: 'orch-test-001',
        timestamp: now,
      }) + '\n'
    );

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

    // D2 (v2.0.16): routing.jsonl exists → §22c second-spawn gate activates.
    // Satisfy §22c so the test focuses on the mcp-checkpoint corruption fail-open path.
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({ type: 'pattern_record_skip_reason', orchestration_id: 'orch-test-001', timestamp: new Date().toISOString() }) + '\n'
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

  // Updated for 2.1.11 (R-DX1): missing model auto-resolves to sonnet (exit 0).
  // Use ORCHESTRAY_STRICT_MODEL_REQUIRED=1 to restore the old blocking behavior.
  test('missing model parameter auto-resolves to sonnet (R-DX1)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {},
    });
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
  });

  test('null model auto-resolves to sonnet (R-DX1)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: null },
    });
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
  });

  test('empty string model auto-resolves to sonnet (R-DX1)', () => {
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: '' },
    });
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
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

  // Updated for 2.1.11 (R-DX1): missing tool_input → model=undefined → auto-resolve.
  test('missing tool_input when inside orchestration auto-resolves to sonnet (R-DX1)', () => {
    // The script does: const toolInput = event.tool_input || {};
    // then const model = toolInput.model; => undefined => R-DX1 auto-resolve → sonnet.
    const dir = makeDir({ withOrch: true });
    const { status, stderr } = runAutoResolve({ tool_name: 'Agent', cwd: dir });
    // R-DX1: auto-resolve to global_default_sonnet → exit 0.
    assert.equal(status, 0);
    assert.match(stderr, /defaulting to "sonnet"/);
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
    //         phase='pre-decomposition' (correct per the BUG-B fix),
    //         PLUS a pattern_record_application row to satisfy the §22c
    //         post-decomp gate (routing.jsonl exists → second-spawn window).
    const requiredTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const checkpointRowsList = requiredTools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: tool === 'pattern_find' ? 2 : null,
    }));
    checkpointRowsList.push(JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      tool: 'pattern_record_application',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: null,
    }));
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), checkpointRowsList.join('\n') + '\n');

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
    }));
    // Satisfy the §22c Stage B post-decomp gate (D2 v2.0.16: default is hook-strict).
    // routing.jsonl exists → second-spawn window is active. Add pattern_record_application
    // so the gate passes and the BUG-C phase-filter defense-in-depth is the only thing
    // being tested here.
    checkpointRows.push(JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-CURRENT',
      tool: 'pattern_record_application',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: null,
    }));
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), checkpointRows.join('\n') + '\n');

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

    // Satisfy §22c post-decomp gate (routing.jsonl exists → second-spawn window active).
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({ type: 'pattern_record_skip_reason', orchestration_id: 'orch-CURRENT', timestamp: now }) + '\n'
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'Build the feature',
      },
    });

    // v2.0.23 §22b warn-mode: gate emits info notice but ALLOWS spawn (no exit 2).
    assert.equal(status, 0,
      'G8-T3: warn-mode — gate must allow spawn even when a required tool is genuinely absent');
    // The BUG-D phase-mismatch info notice fires for the poisoned tools
    assert.match(stderr, /inconsistent/i,
      'G8-T3: BUG-D phase-mismatch info notice must fire when rows exist with wrong phase');
    // The message names the tools that were phase-poisoned (not pattern_find which is absent)
    assert.match(stderr, /kb_search|history_find_similar_tasks/,
      'G8-T3: phase-mismatch info notice must name the poisoned tools');
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

  /**
   * Write a pattern_record_skip_reason event to events.jsonl for the given orchId.
   * This satisfies the §22c post-decomp gate (routing.jsonl exists → second-spawn
   * window) without adding checkpoint rows that would trigger the pre-decomp gate.
   */
  function writePostDecompSatisfied(dir, orchId) {
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');
    const ev = JSON.stringify({
      type: 'pattern_record_skip_reason',
      orchestration_id: orchId,
      timestamp: new Date().toISOString(),
    }) + '\n';
    if (fs.existsSync(eventsPath)) {
      fs.appendFileSync(eventsPath, ev);
    } else {
      fs.writeFileSync(eventsPath, ev);
    }
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
    // Satisfy §22c post-decomp gate: routing.jsonl exists → second-spawn window active.
    writePostDecompSatisfied(dir, 'orch-test-001');
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
    // Satisfy §22c post-decomp gate.
    writePostDecompSatisfied(dir, 'orch-test-001');
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

  test('no matching entry — different agent_type — D7 auto-seeds + exits 0 with warning', () => {
    // D7 (v2.0.16): when no routing entry is found, auto_seed_on_miss=true (default)
    // causes the gate to emit a stderr warning, synthesize an entry, and exit 0.
    const dir = makeDir({ withOrch: true });
    // Only a developer entry exists
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    // Satisfy §22c post-decomp gate (D2: hook-strict default; routing.jsonl exists → second-spawn window).
    writePostDecompSatisfied(dir, 'orch-test-001');
    // Spawn as reviewer — no routing entry for reviewer → D7 auto-seeds
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'reviewer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0, 'D7: auto-seed on miss must exit 0 (warn + allow)');
    assert.match(stderr, /auto-seeding/i, 'D7: auto-seed warning must appear in stderr');
  });

  test('no matching entry — different description — D7 auto-seeds + exits 0 with warning', () => {
    // D7 (v2.0.16): auto-seed on routing miss (default behavior).
    const dir = makeDir({ withOrch: true });
    writeRoutingFile(dir, [routingEntry({ agent_type: 'developer', description: 'Fix auth', model: 'sonnet' })]);
    // Satisfy §22c post-decomp gate.
    writePostDecompSatisfied(dir, 'orch-test-001');
    // Different description — no match → D7 auto-seeds
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Refactor logging' },
    });
    assert.equal(status, 0, 'D7: auto-seed on miss must exit 0 (warn + allow)');
    assert.match(stderr, /auto-seeding/i, 'D7: auto-seed warning must appear in stderr');
  });

  test('description substring match — prefix match allows spawn — exits 0', () => {
    const dir = makeDir({ withOrch: true });
    // Entry has long description stored
    writeRoutingFile(dir, [routingEntry({
      agent_type: 'developer',
      description: 'Fix authentication module in auth/handler.js',
      model: 'sonnet',
    })]);
    // Satisfy §22c post-decomp gate.
    writePostDecompSatisfied(dir, 'orch-test-001');
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
    // Satisfy §22c post-decomp gate (D2 v2.0.16: hook-strict default). routing.jsonl
    // exists → second-spawn window active. pattern_record_skip_reason written to events.
    writePostDecompSatisfied(dir, 'orch-test-001');
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

    // v2.0.23 §22b warn-mode: gate emits advisory but ALLOWS spawn (no exit 2).
    assert.equal(status, 0, 'W3-T1: warn-mode — gate must exit 0 on genuine absence');

    // Event must be written (for observability; warn_mode: true)
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
    assert.equal(missing_ev.warn_mode, true,
      'W3-T1: warn_mode must be true (v2.0.23 advisory-only enforcement)');
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

    // v2.0.23 §22b warn-mode: gate emits info notice but ALLOWS spawn (no exit 2).
    assert.equal(status, 0, 'W3-T2: warn-mode — gate must exit 0 on phase-mismatch + genuine absence');
    // BUG-D phase-mismatch info notice must fire
    assert.match(stderr, /inconsistent/i,
      'W3-T2: BUG-D phase-mismatch info notice must appear in stderr');

    // Event must be written (for observability; warn_mode: true)
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
    assert.equal(missing_ev.warn_mode, true,
      'W3-T2: warn_mode must be true (v2.0.23 advisory-only enforcement)');
  });

});

// ---------------------------------------------------------------------------
// v2023-W3: §22b warn-mode — once-per-orchestration advisory
// ---------------------------------------------------------------------------
// Verifies v2.0.23 warn-mode semantics:
//   - Gate-miss emits exactly one stderr warning and allows the spawn (exit 0)
//   - Second spawn in the same orchestration does NOT re-emit
//   - A new orchestration emits its own first warning
//   - Spawn is NEVER blocked (exit 0 in all cases)

describe('v2023-W3: §22b warn-mode — once-per-orchestration advisory', () => {

  /** Write routing.jsonl so routing validation passes. */
  function writeRoutingFile22b(dir, orchId) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      orchestration_id: orchId,
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Fix auth',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
    });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), entry + '\n');
  }

  /** Write mcp-checkpoint.jsonl with just pattern_find (kb_search absent → gate miss). */
  function writePartialCheckpoint(dir, orchId) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const row = JSON.stringify({
      timestamp: new Date().toISOString(),
      orchestration_id: orchId,
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: null,
    });
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), row + '\n');
  }

  /** Write a minimal config enforcing all three tools via 'hook'. */
  function writeEnforceAllConfig(dir) {
    const orchDir = path.join(dir, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(
      path.join(orchDir, 'config.json'),
      JSON.stringify({
        mcp_enforcement: {
          global_kill_switch: false,
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
        },
      })
    );
  }

  /** Write current-orchestration.json for the given orchId. */
  function writeOrch(dir, orchId) {
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );
  }

  /**
   * Satisfy the §22c post-decomp gate by writing a pattern_record_skip_reason event.
   * Required when routing.jsonl is present (second-spawn window active) and the test
   * is not explicitly testing §22c behavior.
   */
  function satisfyPostDecompGate(dir, orchId) {
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');
    const existing = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : '';
    fs.writeFileSync(
      eventsPath,
      existing + JSON.stringify({
        type: 'pattern_record_skip_reason',
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
      }) + '\n'
    );
  }

  test('22b-T1: gate miss emits advisory and exits 0 (spawn allowed)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-22b-t1-'));
    cleanup.push(dir);
    const orchId = 'orch-22b-t1';

    writeOrch(dir, orchId);
    writeEnforceAllConfig(dir);
    writeRoutingFile22b(dir, orchId);
    writePartialCheckpoint(dir, orchId);
    satisfyPostDecompGate(dir, orchId);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });

    assert.equal(status, 0, '22b-T1: gate miss must allow spawn (exit 0)');
    assert.match(stderr, /v2\.0\.23/, '22b-T1: info notice must reference v2.0.23');
    assert.match(stderr, /info:/, '22b-T1: info-level notice must be present in stderr');
  });

  test('22b-T2: second spawn in same orchestration does NOT re-emit warning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-22b-t2-'));
    cleanup.push(dir);
    const orchId = 'orch-22b-t2';

    writeOrch(dir, orchId);
    writeEnforceAllConfig(dir);
    writeRoutingFile22b(dir, orchId);
    writePartialCheckpoint(dir, orchId);
    // Satisfy §22c post-decomp gate (routing.jsonl exists → second-spawn window active).
    satisfyPostDecompGate(dir, orchId);

    // First spawn — should emit advisory
    const first = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(first.status, 0, '22b-T2: first spawn must be allowed');
    assert.match(first.stderr, /v2\.0\.23/, '22b-T2: first spawn must emit advisory');

    // Second spawn — same orchestration, sentinel file exists → no re-warn
    const second = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(second.status, 0, '22b-T2: second spawn must also be allowed');
    // stderr should NOT contain the v2.0.23 advisory again
    assert.ok(
      !second.stderr.includes('v2.0.23'),
      '22b-T2: second spawn in same orch must NOT re-emit the v2.0.23 advisory'
    );
  });

  test('22b-T3: new orchestration emits its own first warning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-22b-t3-'));
    cleanup.push(dir);
    const orchId1 = 'orch-22b-t3-first';
    const orchId2 = 'orch-22b-t3-second';

    // Setup and run first orchestration
    writeOrch(dir, orchId1);
    writeEnforceAllConfig(dir);
    writeRoutingFile22b(dir, orchId1);
    writePartialCheckpoint(dir, orchId1);
    // Satisfy §22c post-decomp gate (routing.jsonl exists → second-spawn window active).
    satisfyPostDecompGate(dir, orchId1);

    const first = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(first.status, 0, '22b-T3: first orch spawn must be allowed');
    assert.match(first.stderr, /v2\.0\.23/, '22b-T3: first orch must emit advisory');

    // Switch to a new orchestration
    writeOrch(dir, orchId2);
    // Add routing and checkpoint rows for the new orch
    const stateDir = path.join(dir, '.orchestray', 'state');
    const existingRouting = fs.readFileSync(path.join(stateDir, 'routing.jsonl'), 'utf8');
    const newRoutingEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      orchestration_id: orchId2,
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Fix auth',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
    });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), existingRouting + newRoutingEntry + '\n');

    // Add a partial checkpoint row for the new orch
    const existingCheckpoint = fs.readFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), 'utf8');
    const newCheckpointRow = JSON.stringify({
      timestamp: new Date().toISOString(),
      orchestration_id: orchId2,
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: null,
    });
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), existingCheckpoint + newCheckpointRow + '\n');
    // Satisfy §22c for the new orch too.
    satisfyPostDecompGate(dir, orchId2);

    // Second orchestration should emit its own advisory (sentinel is per-orch-id)
    const second = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(second.status, 0, '22b-T3: second orch spawn must be allowed');
    assert.match(second.stderr, /v2\.0\.23/, '22b-T3: second orch must emit its own advisory');
  });

  test('22b-T5: dual-gate path — §22b warns on first spawn, §22c hard-blocks on second spawn', () => {
    // F-TEST-1: Exercises the operator-confusion scenario flagged by W3/W4.
    // Setup: pattern_record_application: 'hook-strict' (matches DEFAULT_MCP_ENFORCEMENT).
    // First spawn: routing.jsonl absent → §22c first-spawn carve-out skips §22c.
    //              §22b fires (kb_search missing) → emits info notice + exits 0.
    // Second spawn: routing.jsonl now present → §22c activates.
    //               pattern_record_application not called → §22c exits 2.
    //               §22b warning NOT re-emitted (sentinel holds).
    //               mcp_checkpoint_missing event emitted EXACTLY ONCE for the orch.

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-22b-t5-'));
    cleanup.push(dir);
    const orchId = 'orch-22b-t5';

    // Write orchestration identity
    writeOrch(dir, orchId);

    // Config: enforce all 3 pre-decomp tools + pattern_record_application: hook-strict
    const orchDir = path.join(dir, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(
      path.join(orchDir, 'config.json'),
      JSON.stringify({
        mcp_enforcement: {
          global_kill_switch: false,
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook-strict',
        },
      })
    );

    // Partial checkpoint: pattern_find only — kb_search absent → §22b fires
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'mcp-checkpoint.jsonl'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orchestration_id: orchId,
        tool: 'pattern_find',
        outcome: 'answered',
        phase: 'pre-decomposition',
        result_count: null,
      }) + '\n'
    );

    // No routing.jsonl yet → first spawn window (§22c carve-out applies)

    // ── First spawn ──────────────────────────────────────────────────────────
    const first = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Decompose task' },
    });

    assert.equal(first.status, 0, '22b-T5: first spawn must be allowed (§22b is warn-only)');
    assert.match(first.stderr, /info:/,
      '22b-T5: first spawn must emit §22b info notice');
    assert.match(first.stderr, /v2\.0\.23/,
      '22b-T5: first spawn notice must reference v2.0.23');
    assert.match(first.stderr, /will not repeat/,
      '22b-T5: first spawn notice must include one-shot cadence signal');

    // Verify mcp_checkpoint_missing event was emitted once
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    const eventsAfterFirst = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      : [];
    const missingEventsAfterFirst = eventsAfterFirst.filter(
      e => e.type === 'mcp_checkpoint_missing' && e.orchestration_id === orchId
    );
    assert.equal(missingEventsAfterFirst.length, 1,
      '22b-T5: mcp_checkpoint_missing event must be emitted exactly once after first spawn');

    // Simulate PM decomposing: write routing.jsonl → §22c activates on next spawn
    writeRoutingFile22b(dir, orchId);

    // ── Second spawn ─────────────────────────────────────────────────────────
    // pattern_record_application NOT called → §22c must hard-block
    const second = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Execute task' },
    });

    assert.equal(second.status, 2, '22b-T5: second spawn must be blocked by §22c (exit 2)');
    assert.match(second.stderr, /§22c|hook-strict|pattern_record_application/,
      '22b-T5: §22c block message must appear in stderr');
    assert.ok(
      !second.stderr.includes('will not repeat'),
      '22b-T5: §22b info notice must NOT be re-emitted on second spawn (sentinel holds)'
    );
    assert.ok(
      !second.stderr.includes('[orchestray v2.0.23] info:'),
      '22b-T5: §22b info prefix must NOT appear on second spawn'
    );

    // mcp_checkpoint_missing event count must still be exactly 1 (not incremented on second spawn)
    const eventsAfterSecond = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      : [];
    const missingEventsAfterSecond = eventsAfterSecond.filter(
      e => e.type === 'mcp_checkpoint_missing' && e.orchestration_id === orchId && e.warn_mode === true
    );
    assert.equal(missingEventsAfterSecond.length, 1,
      '22b-T5: mcp_checkpoint_missing event (warn_mode:true) must not be re-emitted on second spawn');
  });

  test('22b-T4: spawn is allowed even when gate fires (no exit 2 in warn-mode)', () => {
    // Belt-and-suspenders: explicitly verify that warn-mode never blocks.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-22b-t4-'));
    cleanup.push(dir);
    const orchId = 'orch-22b-t4';

    writeOrch(dir, orchId);
    writeEnforceAllConfig(dir);
    writeRoutingFile22b(dir, orchId);
    // Write partial checkpoint (pattern_find only — kb_search + history absent)
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'mcp-checkpoint.jsonl'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orchestration_id: orchId,
        tool: 'pattern_find',
        outcome: 'answered',
        phase: 'pre-decomposition',
        result_count: null,
      }) + '\n'
    );
    // Satisfy §22c post-decomp gate (routing.jsonl exists → second-spawn window active).
    satisfyPostDecompGate(dir, orchId);

    const { status } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'developer', model: 'sonnet', description: 'Fix auth' },
    });
    assert.equal(status, 0, '22b-T4: warn-mode must never exit 2 regardless of missing tools');
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

  /** Write mcp-checkpoint.jsonl with all 3 required pre-decomp tools plus
   *  a pattern_record_application row to satisfy the §22c Stage B post-decomp
   *  gate (D2 v2.0.16 default: hook-strict). W4 tests always write routing.jsonl
   *  first, so the gate treats every spawn as a second-spawn-window spawn.
   */
  function writeFullCheckpoint(dir, orchId) {
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = new Date().toISOString();
    const tools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const rows = tools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: orchId,
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: null,
    }));
    // Satisfy §22c post-decomp gate: routing.jsonl exists → second-spawn window.
    rows.push(JSON.stringify({
      timestamp: now,
      orchestration_id: orchId,
      tool: 'pattern_record_application',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: null,
    }));
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), rows.join('\n') + '\n');
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
      stderr.includes('Drift detected') || stderr.includes('task_id='),
      'W4: a warning about drift detection or task_id match must be emitted to stderr'
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
    // No drift warning expected when descriptions match.
    assert.ok(!stderr.includes('Drift detected'),
      'W4: no drift warning when descriptions are identical');
  });

  test('W4-T3: task_id present but no routing entry for that task_id — falls back to description match', () => {
    // W4 fallback: task_id provided but produces no match → fall back to
    // (agent_type, description) match. If that also fails → D7 auto-seed kicks in.
    //
    // D7 (v2.0.16): when auto_seed_on_miss=true (default), a routing miss on both
    // task_id and description tiers triggers auto-seeding: gate emits a stderr warning,
    // synthesizes a routing entry, and exits 0 instead of blocking. This replaces the
    // pre-D7 exit 2 block for the "both tiers miss" case.
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

    // D7 auto-seed: both tiers fail → gate auto-seeds + exits 0 with warning.
    assert.equal(status, 0,
      'W4+D7: task_id miss + description miss → D7 auto-seeds → gate exits 0');
    // D7 must emit a warning mentioning auto-seeding or the task_id miss.
    assert.ok(
      stderr.includes('auto-seeding') || stderr.includes('task_id') || stderr.includes('no routing entry'),
      'W4+D7: stderr must mention auto-seeding or task_id miss'
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
      stderr.includes('Drift detected') || stderr.includes('task_id='),
      'W4b: description-drift warning expected; got: ' + JSON.stringify(stderr)
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
