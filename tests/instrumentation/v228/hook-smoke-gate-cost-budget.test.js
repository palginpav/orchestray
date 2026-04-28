'use strict';

/**
 * Smoke tests for bin/gate-cost-budget.js
 *
 * Hook event: PreToolUse:Agent|Explore|Task
 *
 * Validates:
 *   1. Enforcement disabled (default) → exit 0 immediately
 *   2. Non-Agent tool (Bash) → exit 0 (skip allowlist)
 *   3. Unknown tool → exit 0 (defers to gate-agent-spawn)
 *   4. Malformed JSON on stdin → exit 0, fail-open
 *   5. Enforcement enabled + no caps configured → exit 0
 *   6. Enforcement enabled + caps configured + no breach → exit 0
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/gate-cost-budget.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-gcb-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function writeConfig(dir, cfg) {
  const configDir = path.join(dir, '.orchestray');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg));
}

function writeOrchFile(dir, orchId) {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId || 'orch-gcb-test' })
  );
}

function invoke(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  10000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// ---------------------------------------------------------------------------
// Test 1: Enforcement disabled (default) → exit 0
// ---------------------------------------------------------------------------
test('gate-cost-budget: enforcement disabled (default config) exits 0 immediately', (t) => {
  const dir = makeTmpDir(t);
  // No config.json at all — enforcement defaults to disabled
  writeOrchFile(dir);

  const payload = {
    tool_name: 'Agent',
    cwd:       dir,
    tool_input: { subagent_type: 'developer', model: 'sonnet' },
  };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'enforcement disabled must exit 0');
});

// ---------------------------------------------------------------------------
// Test 2: Non-Agent tool (Bash) → exit 0
// ---------------------------------------------------------------------------
test('gate-cost-budget: Bash tool exits 0 (skip allowlist)', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, { cost_budget_enforcement: { enabled: true, hard_block: true } });
  writeOrchFile(dir);

  const payload = {
    tool_name:  'Bash',
    cwd:        dir,
    tool_input: { command: 'ls' },
  };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'Bash tool must exit 0 (skipped by allowlist)');
});

// ---------------------------------------------------------------------------
// Test 3: Unknown tool name → exit 0 (defers to gate-agent-spawn)
// ---------------------------------------------------------------------------
test('gate-cost-budget: unknown tool name exits 0 (defers to gate-agent-spawn)', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, { cost_budget_enforcement: { enabled: true, hard_block: true } });
  writeOrchFile(dir);

  const payload = {
    tool_name:  'UnknownTool',
    cwd:        dir,
    tool_input: { foo: 'bar' },
  };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'unknown tool must exit 0');
});

// ---------------------------------------------------------------------------
// Test 4: Malformed JSON on stdin → exit 0, fail-open
// ---------------------------------------------------------------------------
test('gate-cost-budget: malformed JSON on stdin exits 0 (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    '{ invalid json',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
});

// ---------------------------------------------------------------------------
// Test 5: Enforcement enabled + no caps configured → exit 0
// ---------------------------------------------------------------------------
test('gate-cost-budget: enforcement enabled but no caps configured exits 0', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, {
    cost_budget_enforcement: { enabled: true, hard_block: false },
    // No max_cost_usd, daily_cost_limit_usd, weekly_cost_limit_usd
  });
  writeOrchFile(dir);

  const payload = {
    tool_name: 'Agent',
    cwd:       dir,
    tool_input: { subagent_type: 'architect', model: 'opus' },
  };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'no caps configured must exit 0');
});

// ---------------------------------------------------------------------------
// Test 6: Enforcement enabled + caps configured + no breach → exit 0
// ---------------------------------------------------------------------------
test('gate-cost-budget: enforcement enabled with high cap and zero accumulated cost exits 0', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, {
    cost_budget_enforcement: { enabled: true, hard_block: true },
    cost_budget_check: {
      max_cost_usd:   1000,  // Very high cap — won't be breached
    },
  });
  writeOrchFile(dir, 'orch-gcb-006');

  const payload = {
    tool_name: 'Agent',
    cwd:       dir,
    tool_input: { subagent_type: 'reviewer', model: 'sonnet', effort: 'medium' },
  };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'no breach must exit 0 even with hard_block enabled');
});

// ---------------------------------------------------------------------------
// Test 7: Task tool → also handled (same as Agent per matcher)
// ---------------------------------------------------------------------------
test('gate-cost-budget: Task tool exits 0 with enforcement disabled', (t) => {
  const dir = makeTmpDir(t);

  const payload = {
    tool_name: 'Task',
    cwd:       dir,
    tool_input: { description: 'run tests' },
  };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'Task tool must exit 0');
});
