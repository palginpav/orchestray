#!/usr/bin/env node
'use strict';

/**
 * kill-switch-behaviour.test.js — v2.3.21.
 *
 * Parity (kill-switch-parity.test.js) proves a documented switch is *read*.
 * That is not the same as proving it *works*: the non-PM gate read a switch
 * spelled `..._GATE_DISABLED` while every document — and the operator — used
 * `..._BLOCK_DISABLED`. Parity alone would have called that healthy.
 *
 * So each hard-blocking gate is exercised end to end: construct the blocking
 * condition, observe exit 2, set the documented switch, observe the block is
 * gone. Every probe runs against a throwaway project root — running these hooks
 * from the repo root captures fixtures and trips hook-fixture-parity.test.js.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/_lib/__tests__/kill-switch-behaviour.test.js
 */

const { describe, test, before, after } = require('node:test');
const assert       = require('node:assert/strict');
const fs           = require('node:fs');
const os           = require('node:os');
const path         = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const GATE = path.join(REPO, 'bin', 'gate-agent-spawn.js');

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-behaviour-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'),  { recursive: true });
});

after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

/** Run the spawn gate against the throwaway root with `extraEnv` applied. */
function runGate(payload, extraEnv = {}) {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    cwd:   root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR:      root,
      ORCHESTRAY_PROJECT_ROOT: root,
      ...extraEnv,
    },
  });
}

describe('non-PM Agent() block: documented switch actually escapes it', () => {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Agent',
    agent_type:      'developer',
    session_id:      'ks-behaviour-session',
    tool_input:      { subagent_type: 'developer', model: 'sonnet' },
  };

  test('blocks a non-PM caller with exit 2', () => {
    const r = runGate(payload);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /non_pm_agent_declares_agent_tool/);
  });

  test('ORCHESTRAY_NON_PM_AGENT_GATE_DISABLED=1 removes the block', () => {
    const r = runGate(payload, { ORCHESTRAY_NON_PM_AGENT_GATE_DISABLED: '1' });
    assert.notEqual(r.status, 2, `switch did not lift the block\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /non_pm_agent_declares_agent_tool/);
  });

  // The name event-schemas.md carried until this change. It must stay inert:
  // if it ever worked, the doc fix would have been the wrong repair.
  test('the previously-documented ORCHESTRAY_NON_PM_AGENT_BLOCK_DISABLED does nothing', () => {
    const r = runGate(payload, { ORCHESTRAY_NON_PM_AGENT_BLOCK_DISABLED: '1' });
    assert.equal(r.status, 2, 'a switch by this name should not exist');
  });
});

describe('custom-agents spawn gate: its own block message is now truthful', () => {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name:       'Agent',
    agent_type:      'pm',
    session_id:      'ks-behaviour-session',
    tool_input:      { subagent_type: 'no-such-specialist', model: 'sonnet' },
  };

  test('blocks an unknown subagent_type with exit 2', () => {
    const r = runGate(payload);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /unknown subagent_type/);
  });

  test('ORCHESTRAY_DISABLE_CUSTOM_AGENTS=1 removes the block', () => {
    const r = runGate(payload, { ORCHESTRAY_DISABLE_CUSTOM_AGENTS: '1' });
    assert.notEqual(r.status, 2, `switch did not lift the block\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /unknown subagent_type/);
  });

  test('the block is still enforced for operators who set nothing', () => {
    const r = runGate(payload, { ORCHESTRAY_DISABLE_CUSTOM_AGENTS: '0' });
    assert.equal(r.status, 2, 'gate weakened for operators who did not opt out');
  });
});

describe('MCP checkpoint gate: env twin of the config kill switch', () => {
  test('the env switch suppresses the gate exactly as the config flag does', () => {
    const orchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mcp-'));
    fs.mkdirSync(path.join(orchRoot, '.orchestray', 'state'), { recursive: true });
    fs.mkdirSync(path.join(orchRoot, '.orchestray', 'audit'),  { recursive: true });
    fs.writeFileSync(
      path.join(orchRoot, '.orchestray', 'state', 'orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-20260101T000000Z-ks', phase: 'decomposition' })
    );

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name:       'Agent',
      agent_type:      'pm',
      session_id:      'ks-behaviour-session',
      tool_input:      { subagent_type: 'developer', model: 'sonnet' },
    };
    const run = (extraEnv) => spawnSync(process.execPath, [GATE], {
      input: JSON.stringify(payload), cwd: orchRoot, encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: orchRoot, ORCHESTRAY_PROJECT_ROOT: orchRoot, ...extraEnv },
    });

    // Whatever the baseline does, the switch must never make it stricter, and
    // must leave no mcp_checkpoint_missing block behind.
    const withSwitch = run({ ORCHESTRAY_MCP_CHECKPOINT_GATE_DISABLED: '1' });
    assert.notEqual(withSwitch.status, 2,
      `checkpoint gate still blocked with the switch set\n${withSwitch.stderr}`);
    assert.doesNotMatch(withSwitch.stderr, /pre-decomposition MCP checkpoints missing/i);

    fs.rmSync(orchRoot, { recursive: true, force: true });
  });
});

describe('non-blocking switches take effect', () => {
  // Drives the real stat_failed invalidation path: parse once to prime the
  // cache, then make statSync throw so the parser emits from its degraded branch.
  const emitProbe =
    "const w=require(" + JSON.stringify(path.join(REPO, 'bin/_lib/audit-event-writer.js')) + ");" +
    "let wrote=false; w.writeEvent=()=>{wrote=true;return true;};" +
    "const p=require(" + JSON.stringify(path.join(REPO, 'bin/_lib/event-schemas-parser.js')) + ");" +
    "p.parseEventSchemasFromFile();" +
    "const fs=require('node:fs'); fs.statSync=()=>{const e=new Error('probe'); e.code='ENOENT'; throw e;};" +
    "p.parseEventSchemasFromFile();" +
    "process.stdout.write(String(wrote));";

  test('the invalidation emit fires by default', () => {
    const on = spawnSync(process.execPath, ['-e', emitProbe], {
      encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env },
    });
    assert.equal(on.stdout.trim(), 'true', `probe never reached the emit: ${on.stderr}`);
  });

  test('ORCHESTRAY_SCHEMA_CACHE_EMIT_DISABLED=1 suppresses the invalidation emit', () => {
    const off = spawnSync(process.execPath, ['-e', emitProbe], {
      encoding: 'utf8', cwd: os.tmpdir(),
      env: { ...process.env, ORCHESTRAY_SCHEMA_CACHE_EMIT_DISABLED: '1' },
    });
    assert.equal(off.stdout.trim(), 'false', `emit not suppressed: ${off.stderr}`);
  });

  test('ORCHESTRAY_MCP_AUDIT_CWD_RESOLUTION_FALLBACK_DISABLED=1 disables the cwd walk', () => {
    const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cwd-'));
    fs.mkdirSync(path.join(nested, '.orchestray'), { recursive: true });
    fs.mkdirSync(path.join(nested, 'sub'), { recursive: true });

    const probe =
      "const {getProjectRoot}=require(" +
      JSON.stringify(path.join(REPO, 'bin/mcp-server/lib/paths.js')) + ");" +
      "try{process.stdout.write('ROOT:'+getProjectRoot());}" +
      "catch(e){process.stdout.write('THREW');}";
    const baseEnv = { ...process.env };
    delete baseEnv.CLAUDE_PROJECT_DIR;
    delete baseEnv.ORCHESTRAY_PROJECT_ROOT;

    const walkOn = spawnSync(process.execPath, ['-e', probe],
      { encoding: 'utf8', cwd: path.join(nested, 'sub'), env: baseEnv });
    assert.match(walkOn.stdout, /^ROOT:/, `cwd walk should resolve by default: ${walkOn.stdout}`);

    const walkOff = spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8', cwd: path.join(nested, 'sub'),
      env: { ...baseEnv, ORCHESTRAY_MCP_AUDIT_CWD_RESOLUTION_FALLBACK_DISABLED: '1' },
    });
    assert.notEqual(walkOff.stdout, walkOn.stdout, 'switch did not disable the cwd walk');

    fs.rmSync(nested, { recursive: true, force: true });
  });
});
