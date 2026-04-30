#!/usr/bin/env node
'use strict';

/**
 * v2214-G17-mcp-tool-call-emit.test.js
 *
 * G-17 (v2.2.14): Assert that `mcp_tool_call` events emit when MCP tool
 * handlers are invoked, and that kill-switch suppresses them.
 *
 * Background: shadow stats show `mcp_tool_call` at {r:13, o:0} — declared and
 * referenced 13 times but observed-zero in production (W2 finding D3).
 * This test exercises the actual instrumentation code to determine whether
 * the emit works end-to-end or is dead code in some paths.
 *
 * Two emission layers are tested:
 *
 *   Entry-phase (mcp-handler-entry.js):
 *     `emitHandlerEntry('tool_name', context)` is called at the start of each
 *     handler. Emits `{ type: 'mcp_tool_call', phase: 'entry', tool, ... }`.
 *     Uses `context.projectRoot` for file isolation in tests.
 *     Kill switch: ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1
 *
 *   Exit-phase (server.js dispatchRequest):
 *     `writeAuditEvent(buildAuditEvent(...))` fires after handler completion
 *     for all non-ask_user tools. Emits `{ type: 'mcp_tool_call', tool,
 *     outcome, duration_ms, form_fields_count }` (no `phase` field).
 *     Kill switch: isToolEnabled() returning false (config.mcp_server.enabled=false
 *     or config.mcp_server.tools[toolName].enabled=false).
 *     Uses paths.getAuditEventsPath() → process.cwd() for root resolution.
 *
 * Test matrix:
 *
 *   T1. metrics_query.handle() direct invocation → entry-phase mcp_tool_call emits
 *       with phase:"entry", tool:"metrics_query", orchestration_id.
 *   T2. pattern_find.handle() direct invocation → entry-phase mcp_tool_call emits
 *       with phase:"entry", tool:"pattern_find".
 *   T3. buildAuditEvent + writeAuditEvent (mirrors server.js exit path) →
 *       exit-phase mcp_tool_call emits with tool, outcome, duration_ms; no phase field.
 *   T4. Kill switch ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1 →
 *       entry-phase event does NOT emit (negative case).
 *   T5. Both phases together: handler invocation + manual exit-phase call →
 *       two distinct mcp_tool_call rows in events.jsonl.
 *   T6. No current-orchestration.json → event still written;
 *       orchestration_id is null, "unknown", or undefined.
 *
 * Runner:
 *   timeout 60 node --require ./tests/helpers/setup.js --test \
 *     bin/__tests__/v2214-G17-mcp-tool-call-emit.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const METRICS_QUERY_PATH   = path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools', 'metrics_query.js');
const PATTERN_FIND_PATH    = path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools', 'pattern_find.js');
const AUDIT_LIB_PATH       = path.join(REPO_ROOT, 'bin', 'mcp-server', 'lib', 'audit.js');
const HANDLER_ENTRY_PATH   = path.join(REPO_ROOT, 'bin', '_lib', 'mcp-handler-entry.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp dir with the minimal .orchestray layout needed for
 * audit-event writes.
 */
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g17-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

/**
 * Write a current-orchestration.json marker into the given tmpDir.
 */
function writeOrchMarker(tmpDir, orchId) {
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
}

/**
 * Read all lines from events.jsonl in tmpDir. Returns [] if file absent.
 */
function readEvents(tmpDir) {
  const evPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(evPath)) return [];
  const raw = fs.readFileSync(evPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => {
    try { return JSON.parse(line); } catch (_e) { return null; }
  }).filter(Boolean);
}

/**
 * Build a minimal tool context pointing at tmpDir as projectRoot.
 */
function makeContext(tmpDir) {
  return { projectRoot: tmpDir };
}

/**
 * Clear require.cache for a module and all modules in _lib/mcp-handler-entry
 * chain to ensure env-var changes are picked up.
 */
function clearCache(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

function clearHandlerEntryCache() {
  clearCache(HANDLER_ENTRY_PATH);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tmpDir;
let origCwd;
let origEnv;

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir  = makeTmpDir();
  origCwd = process.cwd();
  origEnv = { ...process.env };
  // Ensure kill switches are off before each test.
  delete process.env.ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED;
  delete process.env.ORCHESTRAY_METRICS_DISABLED;
  // Clear the handler-entry module from cache so each test gets a fresh copy
  // with a clean env-var read.
  clearHandlerEntryCache();
});

afterEach(() => {
  // Restore cwd if a test changed it.
  try { process.chdir(origCwd); } catch (_e) { /* ignore */ }
  // Restore env.
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
  }
  Object.assign(process.env, origEnv);
  // Clean up temp dir.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  // Clear handler-entry cache after test.
  clearHandlerEntryCache();
});

// ---------------------------------------------------------------------------
// T1 — metrics_query.handle() direct invocation emits entry-phase event
// ---------------------------------------------------------------------------

describe('G-17 mcp_tool_call emission — positive cases', () => {
  test('T1: metrics_query.handle() emits entry-phase mcp_tool_call with correct fields', async () => {
    writeOrchMarker(tmpDir, 'orch-g17-t1');
    const context = makeContext(tmpDir);

    // Load metrics_query fresh (module-level emitHandlerEntry import must see
    // the un-disabled env var; tool module can stay cached across calls here
    // since we only care about the handler-entry module's env read).
    const metricsQuery = require(METRICS_QUERY_PATH);

    // Invoke with a valid minimal input. metrics files don't exist → empty result.
    const result = await metricsQuery.handle(
      { window: 'all', group_by: 'none', metric: 'count' },
      context
    );

    // Handler must succeed (not an error result).
    assert.ok(result, 'handle() must return a result object');
    assert.strictEqual(result.isError, false, 'metrics_query handle must not return an error for valid input');

    // Assert the entry-phase event was written.
    const events = readEvents(tmpDir);
    const entryEvents = events.filter(e => e.type === 'mcp_tool_call' && e.phase === 'entry');

    assert.ok(entryEvents.length >= 1, `expected at least 1 mcp_tool_call[phase=entry] event; got ${entryEvents.length}. All events: ${JSON.stringify(events)}`);

    const evt = entryEvents[0];
    assert.strictEqual(evt.tool, 'metrics_query', 'event.tool must be "metrics_query"');
    assert.strictEqual(evt.orchestration_id, 'orch-g17-t1', 'event.orchestration_id must match marker');
    assert.ok('timestamp' in evt, 'event must have a timestamp field');
  });

  // -------------------------------------------------------------------------
  // T2 — pattern_find.handle() emits entry-phase event
  // -------------------------------------------------------------------------

  test('T2: pattern_find.handle() emits entry-phase mcp_tool_call with tool:"pattern_find"', async () => {
    writeOrchMarker(tmpDir, 'orch-g17-t2');
    const context = makeContext(tmpDir);

    // pattern_find reads patterns from projectRoot; .orchestray/patterns/ is empty → returns [].
    const patternFind = require(PATTERN_FIND_PATH);

    const result = await patternFind.handle(
      { task_summary: 'test task for G-17', limit: 3 },
      context
    );

    assert.ok(result, 'pattern_find.handle() must return a result');
    // pattern_find may return error or success with empty patterns — both are acceptable.
    // What matters is the entry-phase audit event.

    const events = readEvents(tmpDir);
    const entryEvents = events.filter(e => e.type === 'mcp_tool_call' && e.phase === 'entry');

    assert.ok(entryEvents.length >= 1, `expected at least 1 mcp_tool_call[phase=entry] from pattern_find; got ${entryEvents.length}. All events: ${JSON.stringify(events)}`);

    const evt = entryEvents.find(e => e.tool === 'pattern_find');
    assert.ok(evt, 'entry event must have tool:"pattern_find"');
    assert.strictEqual(evt.orchestration_id, 'orch-g17-t2', 'event.orchestration_id must match marker');
  });

  // -------------------------------------------------------------------------
  // T3 — Exit-phase: buildAuditEvent + writeAuditEvent (server.js exit path)
  // -------------------------------------------------------------------------

  test('T3: buildAuditEvent + writeAuditEvent emit exit-phase mcp_tool_call row', () => {
    writeOrchMarker(tmpDir, 'orch-g17-t3');

    // The server.js exit path uses paths.getAuditEventsPath() which resolves
    // from process.cwd(). We chdir to tmpDir so the path resolves to our sandbox.
    process.chdir(tmpDir);

    // Load audit lib fresh so getProjectRoot() uses our new cwd.
    clearCache(AUDIT_LIB_PATH);
    const { buildAuditEvent, writeAuditEvent } = require(AUDIT_LIB_PATH);

    const event = buildAuditEvent({
      tool: 'metrics_query',
      outcome: 'answered',
      duration_ms: 42,
      form_fields_count: 0,
    });

    // Verify the event shape from buildAuditEvent before writing.
    assert.strictEqual(event.type, 'mcp_tool_call', 'buildAuditEvent must produce type:"mcp_tool_call"');
    assert.strictEqual(event.tool, 'metrics_query', 'buildAuditEvent must carry tool name');
    assert.strictEqual(event.outcome, 'answered', 'buildAuditEvent must carry outcome');
    assert.strictEqual(typeof event.duration_ms, 'number', 'buildAuditEvent must carry duration_ms');
    assert.strictEqual(event.form_fields_count, 0, 'buildAuditEvent must carry form_fields_count');
    assert.ok(!('phase' in event), 'exit-phase event must NOT have a phase field');

    // Write it (mirrors server.js dispatch line 457).
    writeAuditEvent(event);

    // Verify it landed in events.jsonl.
    const events = readEvents(tmpDir);
    const exitEvents = events.filter(e => e.type === 'mcp_tool_call' && !e.phase);

    assert.ok(exitEvents.length >= 1, `expected at least 1 exit-phase mcp_tool_call; got ${exitEvents.length}. All events: ${JSON.stringify(events)}`);
    const written = exitEvents[0];
    assert.strictEqual(written.tool, 'metrics_query');
    assert.strictEqual(written.outcome, 'answered');
    assert.strictEqual(written.orchestration_id, 'orch-g17-t3', 'written event must carry orchestration_id from marker');
  });

  // -------------------------------------------------------------------------
  // T5 — Both phases together produce two mcp_tool_call rows
  // -------------------------------------------------------------------------

  test('T5: both entry-phase and exit-phase emit produces two distinct mcp_tool_call rows', async () => {
    writeOrchMarker(tmpDir, 'orch-g17-t5');

    // chdir for exit-phase audit path.
    process.chdir(tmpDir);

    // Ensure fresh modules for both layers.
    clearHandlerEntryCache();
    clearCache(AUDIT_LIB_PATH);

    const context = makeContext(tmpDir);
    const metricsQuery = require(METRICS_QUERY_PATH);

    // Step 1: invoke handler (triggers entry-phase emit inside handle()).
    await metricsQuery.handle(
      { window: 'all', group_by: 'none', metric: 'count' },
      context
    );

    // Step 2: simulate server.js exit-phase emit.
    const { buildAuditEvent, writeAuditEvent } = require(AUDIT_LIB_PATH);
    writeAuditEvent(buildAuditEvent({
      tool: 'metrics_query',
      outcome: 'answered',
      duration_ms: 10,
      form_fields_count: 0,
    }));

    const events = readEvents(tmpDir);
    const allToolCallEvents = events.filter(e => e.type === 'mcp_tool_call');

    assert.ok(allToolCallEvents.length >= 2,
      `expected at least 2 mcp_tool_call events (entry + exit); got ${allToolCallEvents.length}. All events: ${JSON.stringify(events)}`);

    const entryPhase = allToolCallEvents.filter(e => e.phase === 'entry');
    const exitPhase  = allToolCallEvents.filter(e => !e.phase);

    assert.ok(entryPhase.length >= 1, 'must have at least 1 entry-phase mcp_tool_call');
    assert.ok(exitPhase.length  >= 1, 'must have at least 1 exit-phase mcp_tool_call');

    // Both events must reference the same orchestration.
    assert.strictEqual(entryPhase[0].orchestration_id, 'orch-g17-t5');
    assert.strictEqual(exitPhase[0].orchestration_id,  'orch-g17-t5');
  });

  // -------------------------------------------------------------------------
  // T6 — No orchestration marker: events still written, orchId absent/unknown
  // -------------------------------------------------------------------------

  test('T6: no current-orchestration.json → entry-phase event still writes; orchestration_id is absent or unknown', async () => {
    // Deliberately do NOT write current-orchestration.json.
    const context = makeContext(tmpDir);

    // Reload to avoid double-fire guard pollution from other tests.
    clearHandlerEntryCache();
    const metricsQuery = require(METRICS_QUERY_PATH);

    await metricsQuery.handle(
      { window: 'all', group_by: 'none', metric: 'count' },
      context
    );

    const events = readEvents(tmpDir);
    const entryEvents = events.filter(e => e.type === 'mcp_tool_call' && e.phase === 'entry');

    assert.ok(entryEvents.length >= 1, `expected entry-phase event even without orch marker; got ${entryEvents.length}`);

    const orchId = entryEvents[0].orchestration_id;
    const isAbsent = orchId === null || orchId === 'unknown' || orchId === undefined;
    assert.ok(isAbsent,
      `orchestration_id should be null/unknown/undefined without marker; got: ${JSON.stringify(orchId)}`);
    assert.strictEqual(entryEvents[0].tool, 'metrics_query');
  });
});

// ---------------------------------------------------------------------------
// T4 — Kill switch: entry-phase suppressed by env var
// ---------------------------------------------------------------------------

describe('G-17 mcp_tool_call emission — kill-switch negative case', () => {
  test('T4: ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1 → entry-phase mcp_tool_call does NOT emit', async () => {
    writeOrchMarker(tmpDir, 'orch-g17-t4');
    process.env.ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED = '1';

    // Must reload handler-entry module AFTER setting env var so the kill-switch
    // check in _isDisabled() sees the flag (it reads process.env at call time,
    // but the module-level function closure captures process.env reference — safe).
    clearHandlerEntryCache();

    const context = makeContext(tmpDir);
    const metricsQuery = require(METRICS_QUERY_PATH);

    await metricsQuery.handle(
      { window: 'all', group_by: 'none', metric: 'count' },
      context
    );

    const events = readEvents(tmpDir);
    const entryEvents = events.filter(e => e.type === 'mcp_tool_call' && e.phase === 'entry');

    assert.strictEqual(entryEvents.length, 0,
      `kill switch must suppress entry-phase events; got ${entryEvents.length}. All events: ${JSON.stringify(events)}`);
  });
});
