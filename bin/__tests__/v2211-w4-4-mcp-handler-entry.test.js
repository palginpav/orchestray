#!/usr/bin/env node
'use strict';

/**
 * v2211-w4-4-mcp-handler-entry.test.js
 *
 * W4-4 (v2.2.11): Tests for the MCP handler-entry instrumentation helper
 * `bin/_lib/mcp-handler-entry.js`.
 *
 * Test matrix (≥4 required by W4-4 spec):
 *
 *  T1. Synthetic invocation of an instrumented tool → exactly 1 `mcp_tool_call`
 *      event emitted with `phase: "entry"`.
 *  T2. Double-fire guard: calling emitHandlerEntry twice with the same context
 *      reference → still only 1 event.
 *  T3. Kill switch SET (ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1)
 *      → 0 events emitted.
 *  T4. Missing orchestration_id (no current-orchestration.json) → helper
 *      handles gracefully; event still written with orchestration_id null or "unknown".
 *  T5. event `tool` field matches the name passed to emitHandlerEntry.
 *  T6. Instrumented tool file (kb_search) has the emitHandlerEntry call at the
 *      start of its handle function (static require check).
 *  T7. All 17 tool files import `emitHandlerEntry` (regression guard).
 *
 * Runner: node --test bin/__tests__/v2211-w4-4-mcp-handler-entry.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HELPER_PATH = path.join(REPO_ROOT, 'bin', '_lib', 'mcp-handler-entry.js');
const TOOLS_DIR   = path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w44-'));
}

function writeCurrentOrchFile(cwd, orchId) {
  const auditDir = path.join(cwd, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
}

/**
 * Read emitted events from the audit log in a tmpDir.
 */
function readEmittedEvents(cwd) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    try { return JSON.parse(line); } catch (_e) { return null; }
  }).filter(Boolean);
}

/**
 * Build a minimal tool context pointing at tmpDir as projectRoot.
 */
function makeContext(cwd) {
  return { projectRoot: cwd };
}

// ---------------------------------------------------------------------------
// Module-cache isolation: reload helper fresh per test to avoid cross-test
// state pollution from module-level variables.
// ---------------------------------------------------------------------------

function loadHelper() {
  // Clear require cache for the helper so each test starts fresh.
  delete require.cache[require.resolve(HELPER_PATH)];
  return require(HELPER_PATH);
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = makeTmpDir();
  // Ensure kill switch is off before each test.
  delete process.env.ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED;
});

// ---------------------------------------------------------------------------
// T1 — Synthetic invocation emits exactly 1 mcp_tool_call with phase:entry
// ---------------------------------------------------------------------------

describe('W4-4 MCP handler-entry instrumentation', () => {
  test('T1: emitHandlerEntry emits 1 mcp_tool_call event with phase:entry', () => {
    writeCurrentOrchFile(tmpDir, 'orch-test-w44-01');

    const { emitHandlerEntry } = loadHelper();
    const context = makeContext(tmpDir);
    emitHandlerEntry('kb_search', context);

    const events = readEmittedEvents(tmpDir);
    const entryEvents = events.filter((e) => e.type === 'mcp_tool_call' && e.phase === 'entry');
    assert.strictEqual(entryEvents.length, 1, 'exactly 1 mcp_tool_call[phase=entry] event expected');
    assert.strictEqual(entryEvents[0].tool, 'kb_search', 'event.tool should match tool name');
    assert.strictEqual(entryEvents[0].orchestration_id, 'orch-test-w44-01', 'event should carry orchestration_id');
  });

  // -------------------------------------------------------------------------
  // T2 — Double-fire guard prevents second event on same context
  // -------------------------------------------------------------------------

  test('T2: calling emitHandlerEntry twice with the same context emits only 1 event', () => {
    writeCurrentOrchFile(tmpDir, 'orch-test-w44-02');

    const { emitHandlerEntry } = loadHelper();
    const context = makeContext(tmpDir);

    emitHandlerEntry('pattern_find', context);
    emitHandlerEntry('pattern_find', context); // second call — should be suppressed

    const events = readEmittedEvents(tmpDir);
    const entryEvents = events.filter((e) => e.type === 'mcp_tool_call' && e.phase === 'entry');
    assert.strictEqual(entryEvents.length, 1, 'double-fire guard must suppress the second emit');
  });

  // -------------------------------------------------------------------------
  // T3 — Kill switch disables all entry emits
  // -------------------------------------------------------------------------

  test('T3: ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1 → 0 events', () => {
    writeCurrentOrchFile(tmpDir, 'orch-test-w44-03');
    process.env.ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED = '1';

    const { emitHandlerEntry } = loadHelper();
    const context = makeContext(tmpDir);
    emitHandlerEntry('history_query_events', context);

    const events = readEmittedEvents(tmpDir);
    const entryEvents = events.filter((e) => e.type === 'mcp_tool_call' && e.phase === 'entry');
    assert.strictEqual(entryEvents.length, 0, 'kill switch must suppress all handler-entry emits');
  });

  // -------------------------------------------------------------------------
  // T4 — Missing orchestration_id handled gracefully
  // -------------------------------------------------------------------------

  test('T4: no current-orchestration.json → helper does not throw; event is still written', () => {
    // Deliberately NOT calling writeCurrentOrchFile — no orchestration marker.
    // Create the audit dir so events.jsonl can be written.
    fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });

    const { emitHandlerEntry } = loadHelper();
    const context = makeContext(tmpDir);

    // Must not throw.
    assert.doesNotThrow(() => {
      emitHandlerEntry('metrics_query', context);
    });

    const events = readEmittedEvents(tmpDir);
    const entryEvents = events.filter((e) => e.type === 'mcp_tool_call' && e.phase === 'entry');
    // An event should still be written; orchestration_id may be null or "unknown".
    assert.strictEqual(entryEvents.length, 1, 'event must still be written without orchestration_id');
    assert.strictEqual(entryEvents[0].tool, 'metrics_query', 'event.tool should still be set');
    // orchestration_id must be either null, "unknown", or undefined — NOT a real id.
    const orchId = entryEvents[0].orchestration_id;
    const isAbsent = orchId === null || orchId === 'unknown' || orchId === undefined;
    assert.ok(isAbsent, `orchestration_id should be absent/unknown when no marker; got: ${orchId}`);
  });

  // -------------------------------------------------------------------------
  // T5 — event.tool field matches the toolName argument
  // -------------------------------------------------------------------------

  test('T5: event.tool matches the toolName passed to emitHandlerEntry', () => {
    writeCurrentOrchFile(tmpDir, 'orch-test-w44-05');

    const { emitHandlerEntry } = loadHelper();
    const context = makeContext(tmpDir);
    emitHandlerEntry('routing_lookup', context);

    const events = readEmittedEvents(tmpDir);
    const entryEvent = events.find((e) => e.type === 'mcp_tool_call' && e.phase === 'entry');
    assert.ok(entryEvent, 'entry event must be present');
    assert.strictEqual(entryEvent.tool, 'routing_lookup');
  });

  // -------------------------------------------------------------------------
  // T6 — kb_search.js contains emitHandlerEntry at handler start (static check)
  // -------------------------------------------------------------------------

  test('T6: kb_search.js imports and calls emitHandlerEntry', () => {
    const kbSearchSrc = fs.readFileSync(path.join(TOOLS_DIR, 'kb_search.js'), 'utf8');
    assert.ok(
      kbSearchSrc.includes("require('../../_lib/mcp-handler-entry')"),
      'kb_search.js must require mcp-handler-entry'
    );
    assert.ok(
      kbSearchSrc.includes("emitHandlerEntry('kb_search', context)"),
      'kb_search.js must call emitHandlerEntry at handler entry'
    );
  });

  // -------------------------------------------------------------------------
  // T7 — all 17 tool files import emitHandlerEntry (regression guard)
  // -------------------------------------------------------------------------

  test('T7: all tool files (excluding _synonyms.js and history_query_events) import emitHandlerEntry', () => {
    // history_query_events.js intentionally excluded — instrumenting that tool
    // creates a feedback loop where the entry-time mcp_tool_call event becomes
    // part of the events the tool queries.
    const EXCLUDED = new Set(['history_query_events.js']);
    const toolFiles = fs.readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('.js') && !f.startsWith('_') && !EXCLUDED.has(f));

    const missing = [];
    for (const file of toolFiles) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8');
      if (!src.includes('mcp-handler-entry')) {
        missing.push(file);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `The following tool files do not import mcp-handler-entry: ${missing.join(', ')}`
    );
  });
});
