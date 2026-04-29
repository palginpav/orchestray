#!/usr/bin/env node
'use strict';

/**
 * v2210-mcp-grounding.test.js — F2 (v2.2.10) MCP grounding hard-block gate.
 *
 * Tests for bin/validate-mcp-grounding.js.
 *
 * Coverage:
 *   1. architect + ≥1 mcp_tool_call row → exit 0; no emit.
 *   2. architect + 0 mcp_tool_call rows → exit 2; 1 agent_mcp_grounding_missing; stderr names architect.
 *   3. developer + 0 mcp_tool_call rows → exit 0 (not in allowlist); no emit.
 *   4. pm + 0 mcp_tool_call rows → exit 2; emit fires.
 *   5. ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED=1 + zero rows → exit 0; no emit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'validate-mcp-grounding.js');
const NODE       = process.execPath;

const ORCH_ID = 'orch-test-v2210-mcp-grounding';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-mcp-grounding-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: ORCH_ID }),
    'utf8'
  );

  // Touch events.jsonl so the hook can append.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'events.jsonl'),
    '',
    'utf8'
  );

  // Minimal config.json to satisfy config loaders.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({}),
    'utf8'
  );

  return root;
}

/**
 * Append mcp_tool_call rows to events.jsonl for the given orchestration.
 */
function writeMcpToolCallRows(root, count) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'mcp_tool_call',
      tool: 'pattern_find',
      orchestration_id: ORCH_ID,
      duration_ms: 10,
      outcome: 'answered',
      form_fields_count: 1,
      source: 'prefetch',
    }));
  }
  if (lines.length > 0) {
    fs.appendFileSync(eventsPath, lines.join('\n') + '\n', 'utf8');
  }
}

/**
 * Read all events.jsonl lines as parsed objects.
 */
function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  try {
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch (_e) {
    return [];
  }
}

/**
 * Build a SubagentStop payload.
 */
function buildPayload(root, agentType, agentId) {
  return JSON.stringify({
    cwd:        root,
    agent_type: agentType,
    agent_id:   agentId || 'agent-test-001',
  });
}

/**
 * Run the hook with the given payload and env overrides.
 */
function runHook(root, agentType, envOverrides, agentId) {
  const env = Object.assign({}, process.env, {
    ORCHESTRAY_PROJECT_ROOT:              root,
    ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED: '',
    // Disable schema-emit validator so new event types don't block in test
    ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD: '1',
  }, envOverrides || {});

  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input:    buildPayload(root, agentType, agentId),
    env,
    encoding: 'utf8',
    timeout:  15000,
    cwd:      root,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2210-mcp-grounding F2 hard-block gate', () => {

  test('Test 1: architect with ≥1 mcp_tool_call row → exit 0, no emit', () => {
    const root = makeRoot();
    writeMcpToolCallRows(root, 2);

    const result = runHook(root, 'architect');

    assert.equal(result.status, 0, 'should exit 0 when mcp_tool_call rows exist');

    // No agent_mcp_grounding_missing event should be emitted
    const events = readEvents(root);
    const blockEvents = events.filter(e => e.type === 'agent_mcp_grounding_missing');
    assert.equal(blockEvents.length, 0, 'should not emit agent_mcp_grounding_missing');
  });

  test('Test 2: architect with 0 mcp_tool_call rows → exit 2, emit fires, stderr names architect', () => {
    const root = makeRoot();
    // No mcp_tool_call rows written

    const result = runHook(root, 'architect', {}, 'agent-arch-001');

    assert.equal(result.status, 2, 'should exit 2 when no mcp_tool_call rows found');

    // One agent_mcp_grounding_missing event emitted
    const events = readEvents(root);
    const blockEvents = events.filter(e => e.type === 'agent_mcp_grounding_missing');
    assert.equal(blockEvents.length, 1, 'should emit exactly 1 agent_mcp_grounding_missing event');

    // stderr should name agent_id and agent_type
    assert.ok(result.stderr.includes('architect'), 'stderr should name the agent_type (architect)');
    assert.ok(result.stderr.includes('agent-arch-001'), 'stderr should name the agent_id');
  });

  test('Test 3: developer with 0 mcp_tool_call rows → exit 0 (not in allowlist), no emit', () => {
    const root = makeRoot();
    // No mcp_tool_call rows

    const result = runHook(root, 'developer');

    assert.equal(result.status, 0, 'developer is not in allowlist; should exit 0');

    // No block event emitted
    const events = readEvents(root);
    const blockEvents = events.filter(e => e.type === 'agent_mcp_grounding_missing');
    assert.equal(blockEvents.length, 0, 'should not emit agent_mcp_grounding_missing for developer');
  });

  test('Test 4: pm with 0 mcp_tool_call rows → exit 2, emit fires', () => {
    const root = makeRoot();
    // No mcp_tool_call rows

    const result = runHook(root, 'pm', {}, 'agent-pm-001');

    assert.equal(result.status, 2, 'pm is in allowlist; should exit 2 with no mcp_tool_call rows');

    const events = readEvents(root);
    const blockEvents = events.filter(e => e.type === 'agent_mcp_grounding_missing');
    assert.equal(blockEvents.length, 1, 'should emit 1 agent_mcp_grounding_missing for pm');
    assert.equal(blockEvents[0].agent_type, 'pm', 'emitted event should have agent_type=pm');
  });

  test('Test 5: ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED=1 + zero rows → exit 0, no emit', () => {
    const root = makeRoot();
    // No mcp_tool_call rows

    const result = runHook(root, 'architect', {
      ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED: '1',
    });

    assert.equal(result.status, 0, 'kill switch should prevent exit 2');

    // No events emitted at all (kill switch is silent)
    const events = readEvents(root);
    const blockEvents = events.filter(e => e.type === 'agent_mcp_grounding_missing');
    assert.equal(blockEvents.length, 0, 'kill switch should suppress emit entirely');
  });

});
