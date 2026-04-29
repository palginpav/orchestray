#!/usr/bin/env node
'use strict';

/**
 * v2210-pre-decomp-gate-hardblock.test.js — M2 (v2.2.10).
 *
 * Tests for §22b hard-block promotion in bin/gate-agent-spawn.js.
 *
 * Coverage:
 *   1. Missing checkpoints (no WARN_ONLY, no PREFETCH_DISABLED) → exit 2, stderr names missing tools, warn event emitted.
 *   2. All 3 checkpoints present → exit 0, no mcp_checkpoint_missing event.
 *   3. ORCHESTRAY_PRE_DECOMP_GATE_WARN_ONLY=1 + missing checkpoints → exit 0, warn event emitted.
 *   4. ORCHESTRAY_MCP_PREFETCH_DISABLED=1 + missing checkpoints → exit 0, warn event emitted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js');
const NODE      = process.execPath;

const ORCH_ID = 'orch-test-v2210-hardblock';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-gate-hardblock-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: ORCH_ID }),
    'utf8'
  );

  // Touch events.jsonl so audit writer can append.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'events.jsonl'),
    '',
    'utf8'
  );

  // Write minimal .orchestray/config.json with all 3 tools set to "hook"
  // (matches production defaults — explicit here so tests don't depend on
  // config-schema defaults surviving refactors).
  fs.mkdirSync(path.join(root, '.orchestray'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({
      mcp_enforcement: {
        global_kill_switch: false,
        pattern_find: 'hook',
        kb_search: 'hook',
        history_find_similar_tasks: 'hook',
      },
    }),
    'utf8'
  );

  return root;
}

/**
 * Write checkpoint rows for the orchestration to the ledger.
 * Pass an array of tool names to mark as present.
 */
function writeCheckpoints(root, tools) {
  const ledger = path.join(root, '.orchestray', 'state', 'mcp-checkpoint.jsonl');
  const lines = tools.map(tool =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      orchestration_id: ORCH_ID,
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: 1,
      fields_used: true,
    })
  );
  fs.writeFileSync(ledger, lines.join('\n') + '\n', 'utf8');
}

function buildPayload(root) {
  return JSON.stringify({
    cwd: root,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'developer',
      // Valid model so routing check passes.
      model: 'claude-sonnet-4-6',
      prompt: 'test task',
    },
  });
}

function runGate(root, envOverrides) {
  const env = Object.assign({}, process.env, {
    ORCHESTRAY_PROJECT_ROOT: root,
    // Clear escape hatches unless overridden.
    ORCHESTRAY_PRE_DECOMP_GATE_WARN_ONLY: '',
    ORCHESTRAY_MCP_PREFETCH_DISABLED: '',
  }, envOverrides || {});

  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: buildPayload(root),
    env,
    encoding: 'utf8',
    timeout: 15000,
    cwd: root,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readEvents(root) {
  const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2210 M2 — §22b hard-block', () => {

  test('T1: missing checkpoints → exit 2, stderr names missing tools, warn event emitted', () => {
    const root = makeRoot();
    // Write ledger with ONE dummy row so file exists but tools are all absent.
    // (Gate requires file to exist AND rows for orchId > 0 to apply enforcement.)
    // Write a single row for an UNRELATED tool to satisfy both conditions.
    const ledger = path.join(root, '.orchestray', 'state', 'mcp-checkpoint.jsonl');
    fs.writeFileSync(
      ledger,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orchestration_id: ORCH_ID,
        tool: 'pattern_record_application',
        outcome: 'answered',
        phase: 'pre-decomposition',
        result_count: null,
        fields_used: false,
      }) + '\n',
      'utf8'
    );

    const { status, stderr } = runGate(root);

    assert.equal(status, 2, 'should exit 2 when checkpoints missing (hard-block mode)');

    // stderr must name the missing tools
    const missingTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    for (const tool of missingTools) {
      assert.ok(
        stderr.includes(tool),
        `stderr should mention missing tool "${tool}"; got: ${stderr}`
      );
    }

    // Audit event must be emitted
    const events = readEvents(root);
    const missing = events.filter(e => e.type === 'mcp_checkpoint_missing');
    assert.ok(missing.length >= 1, 'should emit mcp_checkpoint_missing event');
    assert.equal(missing[0].warn_mode, false, 'warn_mode should be false in hard-block');
  });

  test('T2: all 3 checkpoints present → exit 0, no mcp_checkpoint_missing event', () => {
    const root = makeRoot();
    writeCheckpoints(root, ['pattern_find', 'kb_search', 'history_find_similar_tasks']);

    const { status } = runGate(root);

    assert.equal(status, 0, 'should exit 0 when all checkpoints present');

    const events = readEvents(root);
    const missing = events.filter(e => e.type === 'mcp_checkpoint_missing');
    assert.equal(missing.length, 0, 'should not emit mcp_checkpoint_missing when tools present');
  });

  test('T3: ORCHESTRAY_PRE_DECOMP_GATE_WARN_ONLY=1 + missing checkpoints → exit 0, warn event emitted', () => {
    const root = makeRoot();
    // Same setup as T1: file exists, one row present, but required tools absent.
    const ledger = path.join(root, '.orchestray', 'state', 'mcp-checkpoint.jsonl');
    fs.writeFileSync(
      ledger,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orchestration_id: ORCH_ID,
        tool: 'pattern_record_application',
        outcome: 'answered',
        phase: 'pre-decomposition',
        result_count: null,
        fields_used: false,
      }) + '\n',
      'utf8'
    );

    const { status } = runGate(root, { ORCHESTRAY_PRE_DECOMP_GATE_WARN_ONLY: '1' });

    assert.equal(status, 0, 'should exit 0 in warn-only mode even with missing checkpoints');

    const events = readEvents(root);
    const missing = events.filter(e => e.type === 'mcp_checkpoint_missing');
    assert.ok(missing.length >= 1, 'should still emit mcp_checkpoint_missing event in warn-only mode');
    assert.equal(missing[0].warn_mode, true, 'warn_mode should be true');
  });

  test('T4: ORCHESTRAY_MCP_PREFETCH_DISABLED=1 + missing checkpoints → exit 0, warn event emitted', () => {
    const root = makeRoot();
    // Same setup: required tools absent.
    const ledger = path.join(root, '.orchestray', 'state', 'mcp-checkpoint.jsonl');
    fs.writeFileSync(
      ledger,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orchestration_id: ORCH_ID,
        tool: 'pattern_record_application',
        outcome: 'answered',
        phase: 'pre-decomposition',
        result_count: null,
        fields_used: false,
      }) + '\n',
      'utf8'
    );

    const { status } = runGate(root, { ORCHESTRAY_MCP_PREFETCH_DISABLED: '1' });

    assert.equal(status, 0, 'should exit 0 when ORCHESTRAY_MCP_PREFETCH_DISABLED=1');

    const events = readEvents(root);
    const missing = events.filter(e => e.type === 'mcp_checkpoint_missing');
    assert.ok(missing.length >= 1, 'should still emit mcp_checkpoint_missing event');
    assert.equal(missing[0].warn_mode, true, 'warn_mode should be true when prefetch disabled');
  });

});
