#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for W-REG-2: layered tool-registry wired into server.js.
 *
 * T1 — tools/list returns the same set of tool names as the original TOOL_TABLE.
 * T2 — tools/call for kb_search returns a successful (non-error) response.
 * T3 — capabilities.tools.listChanged === true after W-REG-2 flip.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(PLUGIN_ROOT, 'bin', 'mcp-server', 'server.js');
const PROTOCOL_VERSION = '2024-11-05';

// The canonical TOOL_TABLE keys — used as the expected set for T1.
// Sourced from server.js at write-time; any addition to TOOL_TABLE must be
// reflected here (the test intentionally pins to the known set).
const EXPECTED_TOOL_NAMES = [
  'ask_user',
  'cost_budget_check',
  'cost_budget_reserve',
  'curator_tombstone',
  'history_find_similar_tasks',
  'history_query_events',
  'kb_search',
  'kb_write',
  'metrics_query',
  'pattern_deprecate',
  'pattern_find',
  'pattern_read',
  'pattern_record_application',
  'pattern_record_skip_reason',
  'routing_lookup',
  'schema_get',
  'spawn_agent',
  'specialist_save',
].sort();

// ---------------------------------------------------------------------------
// Subprocess helpers (minimal version of integration.test.js helpers)
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reg-wire-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  return dir;
}

function spawnServer(tmp) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: tmp,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORCHESTRAY_PLUGIN_ROOT: PLUGIN_ROOT },
  });

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch (_e) { return; }
    if (msg.id === undefined || msg.id === null) return;
    if (typeof msg.method === 'string' && msg.result === undefined && msg.error === undefined) return;
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry.resolve(msg); }
  });

  function sendAndReceive(req) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...req }) + '\n');
    });
  }

  async function close() {
    try { rl.close(); } catch (_e) { /* swallow */ }
    if (!child.killed) child.kill('SIGTERM');
    try { await once(child, 'exit'); } catch (_e) { /* swallow */ }
  }

  function stderrText() { return Buffer.concat(stderrChunks).toString('utf8'); }

  return { sendAndReceive, close, stderrText };
}

async function initialize(client) {
  const resp = await client.sendAndReceive({
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'smoke-test', version: '0.0.0' } },
  });
  if (resp.error) throw new Error('initialize failed: ' + JSON.stringify(resp.error));
  return resp.result;
}

async function withServer(body) {
  const tmp = makeTmpProject();
  const client = spawnServer(tmp);
  try {
    return await body(tmp, client);
  } finally {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const TIMEOUT = 10000;

// ---------------------------------------------------------------------------
// T1 — tools/list returns the same set of names as TOOL_TABLE
// ---------------------------------------------------------------------------

describe('T1 — tools/list matches TOOL_TABLE', () => {
  test('tools/list returns exactly the TOOL_TABLE tool names (no additions, no removals)',
    { timeout: TIMEOUT },
    async () => {
      await withServer(async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
        assert.equal(resp.error, undefined, 'tools/list must not error');
        assert.ok(resp.result && Array.isArray(resp.result.tools), 'result.tools must be an array');

        const actualNames = resp.result.tools.map((t) => t.name).sort();
        assert.deepEqual(
          actualNames,
          EXPECTED_TOOL_NAMES,
          'registry-routed tools/list must return the same names as the original TOOL_TABLE'
        );
      });
    }
  );
});

// ---------------------------------------------------------------------------
// T2 — tools/call for kb_search returns a successful response
// ---------------------------------------------------------------------------

describe('T2 — tools/call routes through registry', () => {
  test('tools/call kb_search returns a non-error result',
    { timeout: TIMEOUT },
    async () => {
      await withServer(async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({
          method: 'tools/call',
          params: {
            name: 'kb_search',
            arguments: { query: 'smoke test probe' },
          },
        });
        assert.equal(resp.error, undefined, 'tools/call must not produce a JSON-RPC error');
        assert.ok(resp.result, 'tools/call must return a result');
        // kb_search returns toolSuccess({matches:[]}) when the kb dir is empty — that is
        // a valid (non-error) tool result. isError must be false or absent.
        assert.notEqual(resp.result.isError, true,
          'kb_search on empty kb must return isError !== true');
      });
    }
  );
});

// ---------------------------------------------------------------------------
// T3 — capabilities.tools.listChanged === true
// ---------------------------------------------------------------------------

describe('T3 — listChanged capability', () => {
  test('initialize result carries capabilities.tools.listChanged === true',
    { timeout: TIMEOUT },
    async () => {
      await withServer(async (_tmp, client) => {
        const result = await initialize(client);
        assert.ok(result.capabilities, 'capabilities must be present');
        assert.ok(result.capabilities.tools, 'capabilities.tools must be present');
        assert.equal(
          result.capabilities.tools.listChanged,
          true,
          'capabilities.tools.listChanged must be true after W-REG-2 flip'
        );
      });
    }
  );
});
