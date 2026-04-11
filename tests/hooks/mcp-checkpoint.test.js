#!/usr/bin/env node
'use strict';

/**
 * Integration tests for the gate + writer round-trip (2.0.12).
 *
 * Tests the interaction between:
 *   bin/record-mcp-checkpoint.js  (writer, PostToolUse hook)
 *   bin/gate-agent-spawn.js       (gate, PreToolUse hook)
 *
 * These tests exercise the end-to-end data flow where the writer fabricates
 * checkpoint rows and then the gate reads them to make spawn decisions.
 * This is the integration complement to the unit tests in:
 *   tests/record-mcp-checkpoint.test.js (writer unit tests)
 *   tests/gate-agent-spawn.test.js       (gate unit tests with pre-written fixtures)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const WRITER = path.resolve(__dirname, '../../bin/record-mcp-checkpoint.js');
const GATE   = path.resolve(__dirname, '../../bin/gate-agent-spawn.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create an isolated tmpdir with full .orchestray layout.
 */
function makeDir({ orchestrationId = 'orch-int-test-001' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-int-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  // Write current-orchestration.json — shared identity anchor
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchestrationId })
  );
  return { dir, auditDir, stateDir };
}

function runWriter(dir, toolName, toolResult) {
  const result = spawnSync(process.execPath, [WRITER], {
    input: JSON.stringify({ tool_name: toolName, cwd: dir, tool_result: toolResult }),
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function runGate(dir, toolInput) {
  const result = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: 'Agent', cwd: dir, tool_input: toolInput }),
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function writeRoutingEntry(dir, orchId, agentType, description, model) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    orchestration_id: orchId,
    task_id: 'task-1',
    agent_type: agentType,
    description,
    model,
    effort: 'medium',
    complexity_score: 4,
    score_breakdown: {},
    decided_by: 'pm',
    decided_at: 'decomposition',
  });
  fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), entry + '\n');
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Round-trip: writer creates rows, gate reads them
// ---------------------------------------------------------------------------

describe('gate + writer round-trip', () => {

  test('writer creates checkpoint rows; gate allows spawn when all 3 required tools are present', () => {
    const orchId = 'orch-int-rtrip-001';
    const { dir, stateDir } = makeDir({ orchestrationId: orchId });

    // Simulate PM calling the 3 required pre-decomposition MCP tools via the writer hook
    const mcpTools = [
      'mcp__orchestray__pattern_find',
      'mcp__orchestray__kb_search',
      'mcp__orchestray__history_find_similar_tasks',
    ];
    for (const toolName of mcpTools) {
      const writerResult = runWriter(dir, toolName, { isError: false });
      assert.equal(writerResult.status, 0,
        `Writer must exit 0 for ${toolName}`);
    }

    // Verify checkpoint ledger was written
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 3, 'Writer must have written 3 checkpoint rows');
    const seenTools = new Set(rows.map(r => r.tool));
    assert.ok(seenTools.has('pattern_find'));
    assert.ok(seenTools.has('kb_search'));
    assert.ok(seenTools.has('history_find_similar_tasks'));

    // Write routing.jsonl (decomposition happened after MCP calls)
    writeRoutingEntry(dir, orchId, 'developer', 'Build the feature', 'sonnet');

    // Gate must allow the first spawn
    const gateResult = runGate(dir, {
      subagent_type: 'developer',
      model: 'sonnet',
      description: 'Build the feature',
    });
    assert.equal(gateResult.status, 0,
      'Gate must allow spawn when all 3 required checkpoints are present');
    assert.equal(gateResult.stderr, '');
  });

  test('writer creates only 2 of 3 rows; gate blocks spawn naming the missing tool', () => {
    const orchId = 'orch-int-rtrip-002';
    const { dir } = makeDir({ orchestrationId: orchId });

    // Only pattern_find and kb_search — history_find_similar_tasks missing
    runWriter(dir, 'mcp__orchestray__pattern_find', { isError: false });
    runWriter(dir, 'mcp__orchestray__kb_search', { isError: false });

    writeRoutingEntry(dir, orchId, 'developer', 'Build feature', 'sonnet');

    const gateResult = runGate(dir, {
      subagent_type: 'developer',
      model: 'sonnet',
      description: 'Build feature',
    });
    assert.equal(gateResult.status, 2,
      'Gate must block spawn when history_find_similar_tasks is missing');
    assert.match(gateResult.stderr, /history_find_similar_tasks/,
      'Diagnostic must name the missing tool');
  });

  test('writer records orchestration_id correctly; gate sees matching rows', () => {
    const orchId = 'orch-int-id-check-001';
    const { dir, stateDir } = makeDir({ orchestrationId: orchId });

    runWriter(dir, 'mcp__orchestray__pattern_find', { isError: false });

    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orchestration_id, orchId,
      'Writer must record the correct orchestration_id from current-orchestration.json');
  });

});
