#!/usr/bin/env node
'use strict';

/**
 * v2.2.3 Phase 2 W4 — tier2_index_lookup caller_context flag.
 *
 * Asserts:
 *   - resolveCallerContext('real_agent_spawn') -> 'real_agent_spawn'
 *   - resolveCallerContext('test_fixture') -> 'test_fixture'
 *   - resolveCallerContext(undefined) -> 'unknown' (no test markers)
 *   - resolveCallerContext(undefined) -> 'test_fixture' when NODE_TEST_CONTEXT set
 *   - getChunk(slug, {callerContext:'real_agent_spawn'}) carries the value through
 *   - getChunk(slug) defaults to 'test_fixture' under node:test (env marker)
 *   - schemaGet.handle(...) audits tier2_index_lookup with caller_context:'mcp_tool_call'
 *
 * Why: post-v2.2.0 telemetry showed 94 tier2_index_lookup events, ALL with
 * found:false and event_type strings that look like fuzz/attack inputs. The
 * caller_context field separates real callers from test fixtures so rollups
 * stop conflating them.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const tier2Index = require(path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js'));
const { buildIndex, getChunk, resolveCallerContext, CALLER_CONTEXT_VALUES } = tier2Index;
const schemaGet = require(path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools', 'schema_get.js'));

const SCHEMAS_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const SHADOW_PATH  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');

function makeTmpClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p2-w4-caller-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMAS_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  if (fs.existsSync(SHADOW_PATH)) {
    fs.copyFileSync(SHADOW_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'));
  }
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  buildIndex({ cwd: dir });
  return dir;
}

function readEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

describe('v2.2.3 P2 W4 — caller_context taxonomy', () => {
  test('CALLER_CONTEXT_VALUES enum contains the expected five values', () => {
    assert.deepEqual(
      [...CALLER_CONTEXT_VALUES].sort(),
      ['cli_invocation', 'mcp_tool_call', 'real_agent_spawn', 'test_fixture', 'unknown']
    );
  });

  test('resolveCallerContext: explicit valid value passes through', () => {
    for (const v of CALLER_CONTEXT_VALUES) {
      assert.equal(resolveCallerContext(v), v, 'explicit ' + v + ' must pass through');
    }
  });

  test('resolveCallerContext: explicit invalid value falls through to detection', () => {
    // Bogus explicit value must NOT be accepted; fallthrough then env-detection.
    // Under node:test, NODE_TEST_CONTEXT is set, so the fallthrough hits
    // 'test_fixture' rather than 'unknown'. The point: invalid input is rejected.
    const r = resolveCallerContext('arbitrary_garbage');
    assert.notEqual(r, 'arbitrary_garbage', 'invalid explicit value must not pass through');
    assert.ok(CALLER_CONTEXT_VALUES.includes(r), 'fallback must be a valid enum value');
  });

  test('resolveCallerContext: NODE_TEST_CONTEXT marker returns test_fixture', () => {
    // node:test sets NODE_TEST_CONTEXT for this very process — assert directly.
    assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: node:test sets NODE_TEST_CONTEXT');
    assert.equal(resolveCallerContext(), 'test_fixture');
    assert.equal(resolveCallerContext(undefined), 'test_fixture');
  });

  test('resolveCallerContext: returns unknown when no markers and no explicit', () => {
    // Stash and clear ALL test-env markers, then call. Restore afterward.
    const stash = {};
    const markers = [
      'NODE_TEST_CONTEXT', 'ORCHESTRAY_TEST_SHARED_DIR', 'NODE_TEST',
      'JEST_WORKER_ID', 'npm_lifecycle_event',
    ];
    for (const k of markers) {
      stash[k] = process.env[k];
      delete process.env[k];
    }
    try {
      assert.equal(resolveCallerContext(), 'unknown');
      assert.equal(resolveCallerContext(undefined), 'unknown');
      assert.equal(resolveCallerContext(null), 'unknown');
    } finally {
      for (const k of markers) {
        if (stash[k] === undefined) delete process.env[k];
        else process.env[k] = stash[k];
      }
    }
  });
});

describe('v2.2.3 P2 W4 — getChunk plumbs caller_context onto results', () => {
  test('explicit callerContext: real_agent_spawn lands on the result', () => {
    const cwd = makeTmpClone();
    const r = getChunk('tier2_load', { cwd, callerContext: 'real_agent_spawn' });
    assert.equal(r.found, true);
    assert.equal(r.caller_context, 'real_agent_spawn');
  });

  test('explicit callerContext: test_fixture lands on the result', () => {
    const cwd = makeTmpClone();
    const r = getChunk('tier2_load', { cwd, callerContext: 'test_fixture' });
    assert.equal(r.found, true);
    assert.equal(r.caller_context, 'test_fixture');
  });

  test('explicit callerContext: cli_invocation lands on the result', () => {
    const cwd = makeTmpClone();
    const r = getChunk('tier2_load', { cwd, callerContext: 'cli_invocation' });
    assert.equal(r.caller_context, 'cli_invocation');
  });

  test('default under node:test (NODE_TEST_CONTEXT set): caller_context = test_fixture', () => {
    const cwd = makeTmpClone();
    const r = getChunk('tier2_load', { cwd });
    assert.equal(r.found, true);
    assert.equal(r.caller_context, 'test_fixture',
      'no explicit callerContext + NODE_TEST_CONTEXT must default to test_fixture');
  });

  test('miss path also carries caller_context', () => {
    const cwd = makeTmpClone();
    const r = getChunk('definitely_not_a_real_slug', { cwd, callerContext: 'real_agent_spawn' });
    assert.equal(r.found, false);
    assert.equal(r.error, 'event_type_unknown');
    assert.equal(r.caller_context, 'real_agent_spawn',
      'miss must carry caller_context so rollups can attribute the miss to the right caller');
  });

  test('invalid event_type path also carries caller_context', () => {
    const cwd = makeTmpClone();
    // Bad-case slug: regex rejects, but we still want caller_context stamped
    // so the audit row is not orphaned.
    const r = getChunk('BadCase', { cwd, callerContext: 'test_fixture' });
    assert.equal(r.found, false);
    assert.equal(r.error, 'invalid_event_type');
    assert.equal(r.caller_context, 'test_fixture');
  });

  test('unmigrated caller (no callerContext, no env markers) -> caller_context = unknown', () => {
    const cwd = makeTmpClone();
    const stash = {};
    const markers = [
      'NODE_TEST_CONTEXT', 'ORCHESTRAY_TEST_SHARED_DIR', 'NODE_TEST',
      'JEST_WORKER_ID', 'npm_lifecycle_event',
    ];
    for (const k of markers) {
      stash[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const r = getChunk('tier2_load', { cwd });
      assert.equal(r.caller_context, 'unknown',
        'no explicit caller + no test markers must surface as unknown — easy to find and migrate');
    } finally {
      for (const k of markers) {
        if (stash[k] === undefined) delete process.env[k];
        else process.env[k] = stash[k];
      }
    }
  });
});

describe('v2.2.3 P2 W4 — schema_get MCP tool stamps caller_context on telemetry', () => {
  test('audit row carries caller_context: mcp_tool_call (hit)', async () => {
    const cwd = makeTmpClone();
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      await schemaGet.handle({ event_type: 'tier2_load' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    const events = readEvents(cwd);
    const lookup = events.find(e => e.type === 'tier2_index_lookup');
    assert.ok(lookup, 'tier2_index_lookup event must be emitted');
    assert.equal(lookup.caller_context, 'mcp_tool_call',
      'MCP tool path always stamps caller_context = mcp_tool_call, even under NODE_TEST_CONTEXT');
    assert.equal(lookup.found, true);
  });

  test('audit row carries caller_context: mcp_tool_call (miss)', async () => {
    const cwd = makeTmpClone();
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      await schemaGet.handle({ event_type: 'definitely_not_a_real_slug' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    const events = readEvents(cwd);
    const lookup = events.find(e => e.type === 'tier2_index_lookup');
    assert.ok(lookup, 'tier2_index_lookup event must be emitted on miss');
    assert.equal(lookup.found, false);
    assert.equal(lookup.caller_context, 'mcp_tool_call',
      'miss path also stamps mcp_tool_call — the caller is the MCP tool regardless of outcome');
  });

  test('audit row carries caller_context even on fuzz/attack input', async () => {
    const cwd = makeTmpClone();
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      // BadCase + path-traversal: input-schema rejects before getChunk runs.
      // tier2_index_lookup is NOT emitted on input-validation rejection (the
      // schema_get verb's 67-70 gate returns toolError early). What we assert:
      // *if* the verb proceeds (slug-shape OK but not in index), the event is
      // stamped with mcp_tool_call. Use a known-shape-valid but unknown slug.
      await schemaGet.handle({ event_type: 'unknown_fuzz_slug' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    const events = readEvents(cwd);
    const lookup = events.find(e => e.type === 'tier2_index_lookup');
    assert.ok(lookup);
    assert.equal(lookup.caller_context, 'mcp_tool_call');
  });
});
