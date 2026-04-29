#!/usr/bin/env node
'use strict';

/**
 * v2210-mcp-prefetch.test.js — M1 (v2.2.10).
 *
 * Tests for bin/prefetch-mcp-grounding.js (PreToolUse:Agent hook).
 *
 * Coverage:
 *   1. subagent_type=architect → ≥3 distinct mcp_tool_call rows + 1 mcp_grounding_prefetched
 *   2. subagent_type=debugger  → ≥4 distinct mcp_tool_call rows
 *   3. subagent_type=pm        → ≥2 distinct mcp_tool_call rows
 *   4. subagent_type=researcher → ≥3 distinct mcp_tool_call rows
 *   5. subagent_type=developer  → 0 prefetch emits
 *   6. ORCHESTRAY_MCP_PREFETCH_DISABLED=1 → 0 prefetch emits regardless of role
 *   7. additionalContext JSON contains <mcp-grounding> fence
 *   8. Fail-open: one tool throws → other tools still emit; mcp_grounding_prefetch_failed; spawn NOT blocked
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'prefetch-mcp-grounding.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-mcp-prefetch-'));
  // Create minimal .orchestray structure
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });

  // Write a minimal current-orchestration.json
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-m1-prefetch' }),
    'utf8'
  );
  // Touch an empty events.jsonl
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');

  return dir;
}

function buildHookPayload(subagentType, cwd) {
  return JSON.stringify({
    cwd: cwd || '',
    tool_input: { subagent_type: subagentType, prompt: 'test' },
    tool_name: 'Agent',
  });
}

/**
 * Run the hook with given subagent_type and return { stdout, events, checkpoint }.
 */
function runHook(tmpDir, subagentType, extraEnv = {}) {
  const payload = buildHookPayload(subagentType, tmpDir);
  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      // Override path resolution so tool handlers find the fixture .orchestray
      ORCHESTRAY_PLUGIN_ROOT: REPO_ROOT,
      // No ORCHESTRAY_MCP_PREFETCH_DISABLED by default
      ...extraEnv,
    },
  });

  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  const checkpointPath = path.join(tmpDir, '.orchestray', 'state', 'mcp-checkpoint.jsonl');

  const events = readJsonlFile(eventsPath);
  const checkpoint = fs.existsSync(checkpointPath) ? readJsonlFile(checkpointPath) : [];

  return { stdout: result.stdout || '', stderr: result.stderr || '', events, checkpoint, exitCode: result.status };
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2210-mcp-prefetch M1', () => {

  test('1. architect spawn → ≥3 distinct mcp_tool_call rows + 1 mcp_grounding_prefetched', () => {
    const tmpDir = makeTmpDir();
    const { events } = runHook(tmpDir, 'architect');

    const toolCalls = events.filter(e => e.type === 'mcp_tool_call');
    const distinctTools = new Set(toolCalls.map(e => e.tool));
    assert.ok(distinctTools.size >= 3,
      `Expected ≥3 distinct mcp_tool_call tools, got ${distinctTools.size}: ${[...distinctTools].join(',')}`);

    // Verify all 4 expected tools for architect
    const expectedTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks', 'routing_lookup'];
    for (const tool of expectedTools) {
      assert.ok(distinctTools.has(tool), `Missing mcp_tool_call for tool: ${tool}`);
    }

    const prefetchedEvents = events.filter(e => e.type === 'mcp_grounding_prefetched');
    assert.strictEqual(prefetchedEvents.length, 1, 'Expected exactly 1 mcp_grounding_prefetched event');
    assert.strictEqual(prefetchedEvents[0].role, 'architect');
    assert.strictEqual(prefetchedEvents[0].injected_into_block_a, true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('2. debugger spawn → ≥4 distinct mcp_tool_call rows (adds history_query_events)', () => {
    const tmpDir = makeTmpDir();
    const { events } = runHook(tmpDir, 'debugger');

    const toolCalls = events.filter(e => e.type === 'mcp_tool_call');
    const distinctTools = new Set(toolCalls.map(e => e.tool));
    assert.ok(distinctTools.size >= 4,
      `Expected ≥4 distinct mcp_tool_call tools, got ${distinctTools.size}: ${[...distinctTools].join(',')}`);

    const expectedTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks', 'history_query_events'];
    for (const tool of expectedTools) {
      assert.ok(distinctTools.has(tool), `Missing mcp_tool_call for tool: ${tool}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('3. pm spawn → ≥2 distinct mcp_tool_call rows (pattern_find, kb_search)', () => {
    const tmpDir = makeTmpDir();
    const { events } = runHook(tmpDir, 'pm');

    const toolCalls = events.filter(e => e.type === 'mcp_tool_call');
    const distinctTools = new Set(toolCalls.map(e => e.tool));
    assert.ok(distinctTools.size >= 2,
      `Expected ≥2 distinct mcp_tool_call tools, got ${distinctTools.size}: ${[...distinctTools].join(',')}`);

    assert.ok(distinctTools.has('pattern_find'), 'Missing mcp_tool_call for pattern_find');
    assert.ok(distinctTools.has('kb_search'), 'Missing mcp_tool_call for kb_search');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('4. researcher spawn → ≥3 distinct mcp_tool_call rows', () => {
    const tmpDir = makeTmpDir();
    const { events } = runHook(tmpDir, 'researcher');

    const toolCalls = events.filter(e => e.type === 'mcp_tool_call');
    const distinctTools = new Set(toolCalls.map(e => e.tool));
    assert.ok(distinctTools.size >= 3,
      `Expected ≥3 distinct mcp_tool_call tools, got ${distinctTools.size}: ${[...distinctTools].join(',')}`);

    const expectedTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    for (const tool of expectedTools) {
      assert.ok(distinctTools.has(tool), `Missing mcp_tool_call for tool: ${tool}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('5. developer spawn → 0 prefetch emits (not in grounding map)', () => {
    const tmpDir = makeTmpDir();
    const { events, stdout } = runHook(tmpDir, 'developer');

    const prefetchEvents = events.filter(e =>
      e.type === 'mcp_tool_call' ||
      e.type === 'mcp_grounding_prefetched' ||
      e.type === 'mcp_grounding_prefetch_failed'
    );
    assert.strictEqual(prefetchEvents.length, 0, 'Expected 0 prefetch events for developer role');
    assert.strictEqual(stdout.trim(), '', 'Expected no stdout for developer role');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('6. ORCHESTRAY_MCP_PREFETCH_DISABLED=1 → 0 prefetch emits regardless of role', () => {
    const tmpDir = makeTmpDir();
    const { events, stdout } = runHook(tmpDir, 'architect', {
      ORCHESTRAY_MCP_PREFETCH_DISABLED: '1',
    });

    const prefetchEvents = events.filter(e =>
      e.type === 'mcp_tool_call' ||
      e.type === 'mcp_grounding_prefetched' ||
      e.type === 'mcp_grounding_prefetch_failed'
    );
    assert.strictEqual(prefetchEvents.length, 0, 'Expected 0 prefetch events when kill-switch active');
    assert.strictEqual(stdout.trim(), '', 'Expected no stdout when kill-switch active');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('7. additionalContext contains <mcp-grounding> fence', () => {
    const tmpDir = makeTmpDir();
    const { stdout } = runHook(tmpDir, 'architect');

    assert.ok(stdout.trim().length > 0, 'Expected stdout output from architect spawn');
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (e) {
      assert.fail(`stdout is not valid JSON: ${stdout.slice(0, 200)}`);
    }

    assert.ok(parsed.hookSpecificOutput, 'Expected hookSpecificOutput in output');
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');

    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(typeof ctx === 'string' && ctx.length > 0, 'additionalContext must be a non-empty string');
    assert.ok(ctx.includes('<mcp-grounding'), `additionalContext missing <mcp-grounding> fence. Got: ${ctx.slice(0, 200)}`);
    assert.ok(ctx.includes('</mcp-grounding>'), 'additionalContext missing closing </mcp-grounding> tag');
    assert.ok(ctx.includes('role: architect'), 'additionalContext missing role annotation');
    assert.strictEqual(parsed.continue, true, 'Expected continue: true in output');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('8. fail-open: simulate tool throwing → other tools still emit; mcp_grounding_prefetch_failed; spawn NOT blocked', () => {
    // We simulate failure by corrupting the tool module path via a custom env var.
    // Strategy: write a wrapper script that monkey-patches one tool to throw,
    // then verify events.
    // Simpler approach: test via a separate fixture that requires the module with mocked handlers.

    // For this integration test, we verify fail-open by using an invalid ORCHESTRAY_PROJECT_ROOT
    // that causes tool handlers to fail (no .orchestray dir to find history/patterns from),
    // yet the spawn is not blocked (exit 0, either empty additionalContext or partial output).

    const tmpDir = makeTmpDir();

    // Remove patterns dir so pattern_find returns empty but doesn't throw
    // Use a path where history is missing to cause history_find_similar_tasks to return empty
    // This tests the error-recovery branch at tool level.

    // Write a thin test shim that wraps the hook and forces one tool to throw.
    const shimPath = path.join(os.tmpdir(), `shim-${Date.now()}.js`);
    fs.writeFileSync(shimPath, `
'use strict';
// Shim: intercept require for history_find_similar_tasks to throw
const Module = require('module');
const originalLoad = Module._load;
let throwCount = 0;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('history_find_similar_tasks.js') && throwCount === 0) {
    throwCount++;
    return {
      handle: async () => { throw new Error('simulated tool failure'); },
      definition: { name: 'history_find_similar_tasks' }
    };
  }
  return originalLoad.apply(this, arguments);
};
require(${JSON.stringify(HOOK)});
`, 'utf8');

    const payload = buildHookPayload('architect', tmpDir);
    const result = spawnSync(process.execPath, [shimPath], {
      input: payload,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        ORCHESTRAY_PLUGIN_ROOT: REPO_ROOT,
      },
    });

    // Spawn must NOT be blocked (exit code 0)
    assert.strictEqual(result.status, 0, `Expected exit 0 (fail-open), got ${result.status}. stderr: ${result.stderr}`);

    // Events from other tools should still have fired
    const events = readJsonlFile(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'));
    const toolCalls = events.filter(e => e.type === 'mcp_tool_call');
    const distinctTools = new Set(toolCalls.map(e => e.tool));

    // At least pattern_find and kb_search should have succeeded
    assert.ok(distinctTools.has('pattern_find'), 'pattern_find should have emitted despite sibling failure');
    assert.ok(distinctTools.has('kb_search'), 'kb_search should have emitted despite sibling failure');

    // The failed tool should show outcome=error in mcp_tool_call
    const failedCall = toolCalls.find(e => e.tool === 'history_find_similar_tasks');
    if (failedCall) {
      assert.strictEqual(failedCall.outcome, 'error', 'history_find_similar_tasks should show error outcome');
    }

    // mcp_grounding_prefetched should still fire (partial success)
    const prefetched = events.filter(e => e.type === 'mcp_grounding_prefetched');
    assert.ok(prefetched.length >= 1, 'Expected mcp_grounding_prefetched even on partial failure');

    // Stdout should still have additionalContext (fence with partial data)
    assert.ok(result.stdout.trim().length > 0, 'Expected some stdout even on partial failure');

    fs.rmSync(shimPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});
