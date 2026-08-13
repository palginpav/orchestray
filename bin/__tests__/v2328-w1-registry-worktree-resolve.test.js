#!/usr/bin/env node
'use strict';

/**
 * v2328-w1-registry-worktree-resolve.test.js
 *
 * `.orchestray/kb/decisions/v2328-scope-locked.md` §W1 (re-scoped 2026-08-12).
 *
 * The hook lifecycle for a worktree-isolated agent fires at three different
 * cwds:
 *   PreToolUse    (registered, carries model) — cwd = main tree (worktree
 *                 does not exist yet)
 *   SubagentStart (running)                   — cwd = the worktree
 *   SubagentStop  (completed, metrics)         — cwd = the worktree
 *
 * Before this fix, `running`/`completed` landed in the WORKTREE's own
 * `.orchestray/state/agent-registry.jsonl`, split from the `registered` row
 * in the main tree's registry — so the agent_id lookup collect-agent-metrics.js
 * does at SubagentStop never found a match, and the row fell back to
 * model_used=unknown_team_member / cost_confidence=estimated.
 *
 * This test constructs a REAL `git worktree`, drives the three hooks as
 * subprocesses exactly as Claude Code fires them (mirroring
 * v2326-agent-lifecycle.test.js's proven harness), and asserts the full
 * lifecycle resolves in the MAIN registry with a measured cost.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REGISTER_SCRIPT = path.resolve(__dirname, '../register-agent-spawn.js');
const METRICS_SCRIPT = path.resolve(__dirname, '../collect-agent-metrics.js');
const { registryPath } = require('../_lib/agent-registry');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function gitOpts(cwd, homeDir) {
  return { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1', HOME: homeDir }) };
}

/** Build a real main repo + one linked worktree under <main>/.claude/worktrees/<name>. */
function makeMainWithWorktree(worktreeName) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2328-w1-'));
  cleanup.push(base);
  const mainDir = path.join(base, 'main');
  fs.mkdirSync(mainDir, { recursive: true });

  const opts = gitOpts(mainDir, base);
  execSync('git init -b main', opts);
  execSync('git config user.email test@local', opts);
  execSync('git config user.name test', opts);
  fs.writeFileSync(path.join(mainDir, 'README.md'), 'hello');
  execSync('git add -A', opts);
  execSync('git commit -m init', opts);

  const worktreesParent = path.join(mainDir, '.claude', 'worktrees');
  fs.mkdirSync(worktreesParent, { recursive: true });
  const wtPath = path.join(worktreesParent, worktreeName);
  execSync(`git worktree add -b wt-${worktreeName} "${wtPath}"`, opts);

  return { mainDir, homeDir: base, wtPath };
}

function writeOrchestrationId(cwd, id) {
  const auditDir = path.join(cwd, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

function run(script, subcommand, payload) {
  const args = subcommand ? [script, subcommand] : [script];
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: process.env,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function preSpawn(cwd, toolInput) {
  return run(REGISTER_SCRIPT, 'pre-spawn', {
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'tu-' + Math.random().toString(36).slice(2),
    tool_input: toolInput,
    session_id: 'sess-w1',
  });
}

function startAgent(cwd, agentId, agentType) {
  return run(REGISTER_SCRIPT, 'start', {
    cwd,
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
    session_id: 'sess-w1',
  });
}

function stopAgent(cwd, agentId, agentType) {
  return run(METRICS_SCRIPT, null, {
    cwd,
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: agentType,
    session_id: 'sess-w1',
    last_assistant_message: 'Task complete.',
    usage: { input_tokens: 1200, output_tokens: 600 },
  });
}

function readRegistryRows(cwd) {
  const p = registryPath(cwd);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function readEventsJsonl(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('v2328 W1 — worktree-isolated agent lifecycle resolves in the MAIN registry', () => {

  test('registered (main cwd) -> running/completed (worktree cwd) all land in the main registry', () => {
    const { mainDir, wtPath } = makeMainWithWorktree('agent-w1a');
    writeOrchestrationId(mainDir, 'orch-w1a');

    const agentId = 'a-worktree-lifecycle-agent';

    // PreToolUse fires BEFORE the worktree exists — cwd is the main tree.
    const r1 = preSpawn(mainDir, { model: 'claude-sonnet-5', subagent_type: 'developer', description: 'DEV-1 build the thing' });
    assert.equal(r1.status, 0);

    // SubagentStart / SubagentStop fire with cwd already switched to the worktree.
    const r2 = startAgent(wtPath, agentId, 'developer');
    assert.equal(r2.status, 0);
    const r3 = stopAgent(wtPath, agentId, 'developer');
    assert.equal(r3.status, 0);

    // Acceptance 2: the full lifecycle resolves in the MAIN registry.
    const mainRows = readRegistryRows(mainDir).filter((r) => r.agent_id === agentId || r.event === 'registered');
    const events = mainRows.map((r) => r.event);
    assert.ok(events.includes('registered'), 'main registry missing registered row: ' + JSON.stringify(mainRows));
    assert.ok(events.includes('running'), 'main registry missing running row: ' + JSON.stringify(mainRows));
    assert.ok(events.includes('completed'), 'main registry missing completed row: ' + JSON.stringify(mainRows));

    // The worktree must NOT accumulate its own split registry file.
    const wtRegistryPath = registryPath(wtPath);
    assert.equal(fs.existsSync(wtRegistryPath), false, 'the worktree must not get its own agent-registry.jsonl; found: ' + wtRegistryPath);

    // Metrics/events also resolve model_used with cost_confidence measured —
    // NOT unknown_team_member/estimated, the exact defect this fix closes.
    const mainEvents = readEventsJsonl(mainDir);
    const agentStop = mainEvents.find((e) => e.type === 'agent_stop' && e.agent_id === agentId);
    assert.ok(agentStop, 'agent_stop event missing from main events.jsonl');
    assert.equal(agentStop.model_used, 'claude-sonnet-5', 'model must resolve to the real model, not unknown_team_member');
    assert.equal(agentStop.model_source, 'registry');
    assert.equal(agentStop.cost_confidence, 'measured', 'cost must be measured, not the estimated floor');
    assert.equal(agentStop.lifecycle_registered, true);

    // The worktree's own events.jsonl must not have been written either.
    assert.equal(fs.existsSync(path.join(wtPath, '.orchestray', 'audit', 'events.jsonl')), false);
  });

  test('control: a non-worktree (plain tmpdir, no git) agent keeps resolving exactly as before', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2328-w1-nonworktree-'));
    cleanup.push(dir);
    writeOrchestrationId(dir, 'orch-w1-control');

    const agentId = 'a-non-worktree-agent';
    preSpawn(dir, { model: 'claude-opus-5', subagent_type: 'reviewer' });
    startAgent(dir, agentId, 'reviewer');
    const { status } = stopAgent(dir, agentId, 'reviewer');
    assert.equal(status, 0);

    const rows = readRegistryRows(dir);
    const completedRow = rows.find((r) => r.agent_id === agentId && r.event === 'completed');
    assert.ok(completedRow, 'non-worktree agent must still resolve in its own (single) registry');

    const events = readEventsJsonl(dir);
    const agentStop = events.find((e) => e.type === 'agent_stop' && e.agent_id === agentId);
    assert.equal(agentStop.model_used, 'claude-opus-5');
    assert.equal(agentStop.cost_confidence, 'measured');
  });

});
