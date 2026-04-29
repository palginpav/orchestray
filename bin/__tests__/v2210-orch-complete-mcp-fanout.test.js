#!/usr/bin/env node
'use strict';

/**
 * v2.2.10 M3 — orch-complete MCP fanout tests.
 *
 * Tests:
 *   1. No archetype usage → 2 mcp_tool_call rows (metrics_query + routing_lookup).
 *   2. archetype_cache_advisory_served with pm_decision=accepted → 3 mcp_tool_call rows.
 *   3. ORCHESTRAY_ORCH_COMPLETE_MCP_FANOUT_DISABLED=1 → 0 fanout emits.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-fanout-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

function eventsPath(root) {
  return path.join(root, '.orchestray', 'audit', 'events.jsonl');
}

function readEvents(root) {
  try {
    return fs.readFileSync(eventsPath(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function fanoutEvents(root) {
  return readEvents(root).filter(
    e => e.source === 'orch-complete-fanout' && e.type === 'mcp_tool_call',
  );
}

/**
 * Write a minimal orch_complete event so hasOrchComplete() passes,
 * then write a valid current-orchestration.json.
 */
function scaffoldOrch(root, orchId) {
  // current-orchestration.json
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
  );
  // events.jsonl with the orchestration_complete row
  fs.writeFileSync(
    eventsPath(root),
    JSON.stringify({ type: 'orchestration_complete', orchestration_id: orchId }) + '\n',
  );
}

/**
 * Append an archetype_cache_advisory_served row to events.jsonl.
 */
function appendArchetypeEvent(root, orchId, pmDecision, archetypeId) {
  const row = JSON.stringify({
    type:             'archetype_cache_advisory_served',
    orchestration_id: orchId,
    archetype_id:     archetypeId,
    pm_decision:      pmDecision,
  });
  fs.appendFileSync(eventsPath(root), row + '\n');
}

/**
 * Create a minimal pattern file so pattern_record_application doesn't error.
 */
function createPatternFile(root, slug) {
  const content = [
    '---',
    'slug: ' + slug,
    'times_applied: 5',
    'last_applied: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# Pattern body',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.orchestray', 'patterns', slug + '.md'), content);
}

// ---------------------------------------------------------------------------
// Load the module under test with a patched cwd resolver.
// We monkey-patch the private module cache each test to supply a custom cwd.
// ---------------------------------------------------------------------------

/**
 * Exercise the `runMcpFanout` function by calling it directly after requiring
 * it via a small extraction shim.  Because `runMcpFanout` is not exported we
 * run the full hook via `require` + re-require with cache busting, feeding a
 * synthetic cwd by patching `_lib/orchestration-state` in the require cache.
 *
 * Simpler approach: we re-export `runMcpFanout` from `audit-on-orch-complete`
 * for testing by checking NODE_ENV.  But the module doesn't do that, so we
 * invoke the logic directly through the exported helpers test-surface we can
 * reach: we require the module's dependencies and replicate the fanout path.
 *
 * Cleanest: we extract `findAppliedArchetypeId` and `runMcpFanout` logic into
 * testable units.  Since the task says ONLY modify audit-on-orch-complete.js
 * and add the test, we drive the test by running the full script via spawnSync
 * with a mock cwd that we provision.
 */

const { spawnSync } = require('node:child_process');

/**
 * Run audit-on-orch-complete.js as a child process with a synthetic stdin
 * payload referencing our tmp dir.  Returns exit code.
 */
function runHook(tmpRoot, env = {}) {
  const scriptPath = path.join(REPO_ROOT, 'bin', 'audit-on-orch-complete.js');
  const payload    = JSON.stringify({ cwd: tmpRoot });
  const result = spawnSync(process.execPath, [scriptPath], {
    input:   payload,
    timeout: 30000,
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
  });
  return result;
}

/**
 * Write a fake orch-complete-trigger.json that has NOT been fired for orchId,
 * so the deduplication guard allows the run.
 */
function clearTriggerState(root) {
  const p = path.join(root, '.orchestray', 'state', 'orch-complete-trigger.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.10 M3 — orch-complete MCP fanout', () => {

  let tmpRoot;
  let origEnv;

  beforeEach(() => {
    tmpRoot  = makeTmpRoot();
    origEnv  = Object.assign({}, process.env);
  });

  afterEach(() => {
    // Restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);

    // Clean up tmp dir
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  });

  // -------------------------------------------------------------------------
  // Test 1: no archetype usage → 2 fanout events (metrics_query + routing_lookup)
  // -------------------------------------------------------------------------
  test('Test 1: no archetype usage emits metrics_query and routing_lookup only', () => {
    const orchId = 'orch-test-no-archetype-001';
    scaffoldOrch(tmpRoot, orchId);
    clearTriggerState(tmpRoot);

    const result = runHook(tmpRoot);

    // Hook must exit 0 (fail-open)
    assert.strictEqual(result.status, 0, 'hook exit code should be 0');

    const emitted = fanoutEvents(tmpRoot);
    const tools   = emitted.map(e => e.tool);

    assert.ok(
      tools.includes('metrics_query'),
      'metrics_query mcp_tool_call should be emitted',
    );
    assert.ok(
      tools.includes('routing_lookup'),
      'routing_lookup mcp_tool_call should be emitted',
    );
    assert.strictEqual(
      tools.filter(t => t === 'pattern_record_application').length,
      0,
      'pattern_record_application should NOT be emitted when no archetype advisory was served',
    );
    assert.strictEqual(
      emitted.length,
      2,
      'exactly 2 fanout mcp_tool_call events expected',
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: archetype advisory served with pm_decision=accepted → 3 events
  // -------------------------------------------------------------------------
  test('Test 2: archetype advisory (accepted) emits all 3 fanout events', () => {
    const orchId     = 'orch-test-archetype-accepted-002';
    const archetypeId = 'test-archetype-slug-ok';
    scaffoldOrch(tmpRoot, orchId);
    appendArchetypeEvent(tmpRoot, orchId, 'accepted', archetypeId);
    createPatternFile(tmpRoot, archetypeId);
    clearTriggerState(tmpRoot);

    const result = runHook(tmpRoot);

    assert.strictEqual(result.status, 0, 'hook exit code should be 0');

    const emitted = fanoutEvents(tmpRoot);
    const tools   = emitted.map(e => e.tool);

    assert.ok(tools.includes('metrics_query'),              'metrics_query should be emitted');
    assert.ok(tools.includes('routing_lookup'),             'routing_lookup should be emitted');
    assert.ok(tools.includes('pattern_record_application'), 'pattern_record_application should be emitted');
    assert.strictEqual(emitted.length, 3, 'exactly 3 fanout mcp_tool_call events expected');

    // All events must have the correct source tag.
    for (const evt of emitted) {
      assert.strictEqual(evt.source, 'orch-complete-fanout', 'source tag must be orch-complete-fanout');
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: kill switch ORCHESTRAY_ORCH_COMPLETE_MCP_FANOUT_DISABLED=1 → 0 fanout emits
  // -------------------------------------------------------------------------
  test('Test 3: ORCHESTRAY_ORCH_COMPLETE_MCP_FANOUT_DISABLED=1 suppresses all fanout', () => {
    const orchId = 'orch-test-killswitch-003';
    scaffoldOrch(tmpRoot, orchId);
    clearTriggerState(tmpRoot);

    const result = runHook(tmpRoot, {
      ORCHESTRAY_ORCH_COMPLETE_MCP_FANOUT_DISABLED: '1',
    });

    assert.strictEqual(result.status, 0, 'hook exit code should be 0 even with kill switch');

    const emitted = fanoutEvents(tmpRoot);
    assert.strictEqual(
      emitted.length,
      0,
      'no fanout events should be emitted when kill switch is set',
    );
  });

});
