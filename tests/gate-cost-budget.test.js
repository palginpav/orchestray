#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/gate-cost-budget.js
 *
 * PreToolUse:Agent hook — H1 cost-budget enforcement gate (v2.0.16 W5).
 *
 * Strategy:
 *  - Drive the script via spawnSync with stdin piped
 *  - Isolate state per test with fresh tmpdirs
 *  - Pass tmpdir via event.cwd so the script resolves .orchestray/ from there
 *
 * Coverage:
 *   A — disabled config (default): no-op, exit 0
 *   B — enabled + hard_block=false + breach: stderr warn, exit 0
 *   C — enabled + hard_block=true + breach: exit 2
 *   D — enabled + no caps configured: no-op, exit 0
 *   E — non-Agent tools: skip allowlist, exit 0
 *   F — unknown tools: exit 0 (defer to gate-agent-spawn)
 *   G — missing cost_budget_check tool (graceful): fail-open, exit 0
 *   H — enabled + no breach: exit 0
 *   I — malformed JSON on stdin: fail-open, exit 0
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/gate-cost-budget.js');

/** Shared cleanup list for tmpdirs. */
const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir.
 */
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cost-budget-test-'));
  cleanup.push(dir);
  return dir;
}

/**
 * Write .orchestray/config.json with the given content.
 */
function writeConfig(dir, config) {
  const configDir = path.join(dir, '.orchestray');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
}

/**
 * Write current-orchestration.json to identify the active orchestration.
 */
function writeOrchFile(dir, orchId) {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
}

/**
 * Run the gate script with the given event payload on stdin.
 */
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

/**
 * Build a minimal valid Agent spawn event.
 */
function agentEvent(dir, model = 'sonnet', overrides = {}) {
  return {
    tool_name: 'Agent',
    cwd: dir,
    tool_input: { model, ...overrides },
  };
}

// ---------------------------------------------------------------------------
// A: disabled config (default) — no-op
// ---------------------------------------------------------------------------

describe('A: disabled config (default) — no-op', () => {

  // v2.2.3 P3-W3: default flipped to enabled:true, but with no caps configured
  // the gate is a no-op (safe-by-default), so this test still asserts exit 0.
  test('no config file → exit 0 (defaults: enabled=true but no caps → no breach possible)', () => {
    const dir = makeDir();
    const { status, stderr } = run(agentEvent(dir));
    assert.equal(status, 0, 'No config → no caps → exit 0');
    assert.equal(stderr, '');
  });

  test('config has cost_budget_enforcement.enabled=false → exit 0', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: false, hard_block: false },
      max_cost_usd: 0.01,
    });
    writeOrchFile(dir, 'orch-a-001');
    const { status, stderr } = run(agentEvent(dir));
    assert.equal(status, 0, 'Disabled enforcement → exit 0 even with a low cap');
    assert.equal(stderr, '');
  });

});

// ---------------------------------------------------------------------------
// B: enabled + hard_block=false + breach → warn + exit 0
// ---------------------------------------------------------------------------

describe('B: enabled + hard_block=false + breach → warn exit 0', () => {

  test('sonnet spawn against $0.001 cap → stderr warn, exit 0', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: false },
      max_cost_usd: 0.001,
    });
    writeOrchFile(dir, 'orch-b-001');

    const { status, stderr } = run(agentEvent(dir, 'sonnet'));
    assert.equal(status, 0,
      'hard_block=false → must allow spawn despite breach (exit 0)');
    assert.ok(stderr.includes('[orchestray] gate-cost-budget:'),
      'stderr must contain the gate-cost-budget prefix; got: ' + stderr);
    assert.ok(
      stderr.toLowerCase().includes('breach') || stderr.toLowerCase().includes('exceed'),
      'stderr must mention breach or exceed; got: ' + stderr
    );
    assert.ok(
      stderr.includes('hard_block=false') || stderr.includes('ALLOWED'),
      'stderr must confirm spawn is ALLOWED; got: ' + stderr
    );
  });

  test('daily_cost_limit_usd breach → stderr warn, exit 0', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: false },
      daily_cost_limit_usd: 0.001,
    });
    writeOrchFile(dir, 'orch-b-002');

    const { status, stderr } = run(agentEvent(dir, 'opus'));
    assert.equal(status, 0, 'Daily cap breach with hard_block=false → exit 0');
    assert.ok(stderr.includes('[orchestray] gate-cost-budget:'),
      'stderr must contain gate-cost-budget prefix; got: ' + stderr);
  });

  test('weekly_cost_limit_usd breach → stderr warn, exit 0', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: false },
      weekly_cost_limit_usd: 0.001,
    });
    writeOrchFile(dir, 'orch-b-003');

    const { status, stderr } = run(agentEvent(dir, 'haiku'));
    assert.equal(status, 0, 'Weekly cap breach with hard_block=false → exit 0');
    assert.ok(stderr.includes('[orchestray] gate-cost-budget:'),
      'stderr must contain gate-cost-budget prefix; got: ' + stderr);
  });

});

// ---------------------------------------------------------------------------
// C: enabled + hard_block=true + breach → exit 2
// ---------------------------------------------------------------------------

describe('C: enabled + hard_block=true + breach → exit 2', () => {

  test('sonnet spawn against $0.001 cap with hard_block=true → exit 2', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      max_cost_usd: 0.001,
    });
    writeOrchFile(dir, 'orch-c-001');

    const { status, stderr } = run(agentEvent(dir, 'sonnet'));
    assert.equal(status, 2,
      'hard_block=true + breach → spawn must be blocked (exit 2)');
    assert.ok(stderr.includes('[orchestray] gate-cost-budget:'),
      'stderr must contain gate-cost-budget prefix; got: ' + stderr);
    assert.ok(
      stderr.includes('hard_block=true') || stderr.includes('BLOCKED'),
      'stderr must confirm spawn is BLOCKED; got: ' + stderr
    );
  });

  test('opus spawn against $0.001 cap with hard_block=true → exit 2', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      max_cost_usd: 0.001,
    });
    writeOrchFile(dir, 'orch-c-002');

    const { status } = run(agentEvent(dir, 'opus'));
    assert.equal(status, 2,
      'Opus is most expensive tier; must block on tiny cap');
  });

  test('hard_block=true + no breach (very high cap) → exit 0', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      max_cost_usd: 9999,
    });
    writeOrchFile(dir, 'orch-c-003');

    const { status, stderr } = run(agentEvent(dir, 'sonnet'));
    assert.equal(status, 0, 'No breach → exit 0 even with hard_block=true');
    assert.equal(stderr, '', 'No stderr when no breach');
  });

});

// ---------------------------------------------------------------------------
// D: enabled + no caps configured → no-op, exit 0
// ---------------------------------------------------------------------------

describe('D: enabled but no caps configured → no-op', () => {

  test('enabled=true but no max/daily/weekly cap → exit 0', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      // deliberately no cost cap keys
    });
    writeOrchFile(dir, 'orch-d-001');

    const { status, stderr } = run(agentEvent(dir, 'sonnet'));
    assert.equal(status, 0,
      'No caps configured → nothing to enforce; exit 0');
    assert.equal(stderr, '', 'No stderr when no caps are set');
  });

});

// ---------------------------------------------------------------------------
// E: non-Agent tools — skip allowlist
// ---------------------------------------------------------------------------

describe('E: non-Agent tools — skip allowlist', () => {

  test('Bash tool exits 0 without inspecting config', () => {
    const dir = makeDir();
    // Write a config that would block Agent spawns — but Bash must be skipped.
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      max_cost_usd: 0.001,
    });
    const { status, stderr } = run({ tool_name: 'Bash', cwd: dir, tool_input: {} });
    assert.equal(status, 0, 'Bash is in SKIP_ALLOWLIST → exit 0');
    assert.equal(stderr, '');
  });

  test('Read tool exits 0', () => {
    const dir = makeDir();
    const { status, stderr } = run({ tool_name: 'Read', cwd: dir, tool_input: {} });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('Write tool exits 0', () => {
    const dir = makeDir();
    const { status, stderr } = run({ tool_name: 'Write', cwd: dir, tool_input: {} });
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('Explore tool is in AGENT_DISPATCH_ALLOWLIST and gated', () => {
    // Explore is an agent-dispatch tool — gated if enforcement is enabled.
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: false },
      max_cost_usd: 0.001,
    });
    writeOrchFile(dir, 'orch-e-explore-001');
    const { status, stderr } = run({
      tool_name: 'Explore',
      cwd: dir,
      tool_input: { model: 'haiku' },
    });
    // Explore with haiku against a $0.001 cap → breach → warn + exit 0 (hard_block=false).
    assert.equal(status, 0, 'Explore with hard_block=false → exit 0 on breach');
    assert.ok(
      stderr.includes('[orchestray] gate-cost-budget:'),
      'Explore must be gated; got: ' + stderr
    );
  });

});

// ---------------------------------------------------------------------------
// F: unknown tools → exit 0 (defer to gate-agent-spawn)
// ---------------------------------------------------------------------------

describe('F: unknown tools — deferred to gate-agent-spawn', () => {

  test('unknown tool_name exits 0 regardless of enforcement config', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      max_cost_usd: 0.001,
    });
    const { status, stderr } = run({
      tool_name: 'SomeUnknownTool',
      cwd: dir,
      tool_input: {},
    });
    assert.equal(status, 0,
      'Unknown tool must exit 0 — let gate-agent-spawn handle it');
    assert.equal(stderr, '');
  });

});

// ---------------------------------------------------------------------------
// G: fail-open discipline — malformed config or missing tool
// ---------------------------------------------------------------------------

describe('G: fail-open discipline', () => {

  test('malformed JSON on stdin → fail-open, exit 0', () => {
    const { status } = run('{{not json}}');
    assert.equal(status, 0, 'Malformed stdin → fail-open (exit 0)');
  });

  test('empty stdin → fail-open, exit 0', () => {
    const { status } = run('');
    assert.equal(status, 0, 'Empty stdin → fail-open (exit 0)');
  });

  test('malformed config.json → fail-open, exit 0', () => {
    const dir = makeDir();
    const configDir = path.join(dir, '.orchestray');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), '{{{not valid json}}}');

    const { status, stderr } = run(agentEvent(dir, 'sonnet'));
    assert.equal(status, 0, 'Malformed config → fail-open (exit 0)');
    // No blocking stderr expected — may emit a diagnostic but must not block.
    assert.ok(!stderr.includes('BLOCKED'), 'Must not block on malformed config; got: ' + stderr);
  });

  test('config.json missing → defaults active, no caps → exit 0', () => {
    const dir = makeDir();
    // No config file at all — loadCostBudgetEnforcementConfig returns defaults.
    // v2.2.3 P3-W3: defaults are now enabled=true, but with no max/daily/weekly
    // caps in config the gate has nothing to enforce → exit 0 (safe-by-default).
    const { status } = run(agentEvent(dir, 'opus'));
    assert.equal(status, 0, 'Missing config → defaults → no caps → exit 0');
  });

});

// ---------------------------------------------------------------------------
// H: within-budget spawns — exit 0 with no stderr
// ---------------------------------------------------------------------------

describe('H: within-budget spawns', () => {

  test('haiku spawn against generous cap → exit 0, no stderr', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: true },
      max_cost_usd: 1000,
    });
    writeOrchFile(dir, 'orch-h-001');

    const { status, stderr } = run(agentEvent(dir, 'haiku'));
    assert.equal(status, 0, 'Within-budget haiku spawn → exit 0');
    assert.equal(stderr, '', 'No stderr when cap is not breached');
  });

  test('sonnet spawn against generous cap → exit 0, no stderr', () => {
    const dir = makeDir();
    writeConfig(dir, {
      cost_budget_enforcement: { enabled: true, hard_block: false },
      max_cost_usd: 9999,
    });
    writeOrchFile(dir, 'orch-h-002');

    const { status, stderr } = run(agentEvent(dir, 'sonnet'));
    assert.equal(status, 0, 'Within-budget sonnet spawn → exit 0');
    assert.equal(stderr, '', 'No stderr when cap is not breached');
  });

});

// ---------------------------------------------------------------------------
// I: §22c hook-strict Stage B coverage
// (gate-cost-budget does not enforce §22c — that is gate-agent-spawn's role)
// ---------------------------------------------------------------------------

// NOTE: gate-cost-budget.js is a cost-only gate. §22c pattern_record enforcement
// is gate-agent-spawn.js's responsibility. The tests above cover all paths within
// gate-cost-budget.js's own scope. Stage B (hook-strict) tests for the §22c gate
// live in tests/gate-agent-spawn.test.js.
