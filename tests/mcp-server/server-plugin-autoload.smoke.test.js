#!/usr/bin/env node
'use strict';

/**
 * server-plugin-autoload.smoke.test.js
 *
 * Regression for the discovered→loaded gap closed by the MCP server's startup
 * scan→load chain. Before that fix, scan() ran on boot but nothing called
 * load(), so consented plugins were stuck in `discovered` and their tools
 * never appeared in tools/list.
 *
 * T1 — A pre-approved fake plugin reaches `ready` after server boot and its
 *      namespaced tool is visible in tools/list.
 *
 * Runner: node --test tests/mcp-server/server-plugin-autoload.smoke.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(PLUGIN_ROOT, 'bin', 'mcp-server', 'server.js');
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'fake-plugin');
const PROTOCOL_VERSION = '2024-11-05';
const TIMEOUT = 15000;

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-autoload-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  // Drop fake-plugin into a scan path the server will discover.
  const pluginsDir = path.join(dir, '.orchestray', 'plugins');
  const pluginDir  = path.join(pluginsDir, 'fake-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'server.js'),
    fs.readFileSync(path.join(FIXTURE_ROOT, 'server.js'), 'utf8'),
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(pluginDir, 'orchestray-plugin.json'),
    fs.readFileSync(path.join(FIXTURE_ROOT, 'orchestray-plugin.json'), 'utf8'),
    { mode: 0o644 }
  );
  // Bypass consent for the test — production uses W-SEC-4/7 fingerprint binding.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({
      plugin_loader: {
        enabled: true,
        discovery: { enabled: true, scan_paths: [pluginsDir] },
        consent:   { require_explicit_grant: false },
      },
    }),
  );
  return dir;
}

function spawnServer(tmp) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: tmp,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ORCHESTRAY_PLUGIN_ROOT: PLUGIN_ROOT,
      // Isolate consent file from the user's real ~/.orchestray.
      HOME: tmp,
    },
  });
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch (_e) { return; }
    if (msg.id === undefined || msg.id === null) return;
    if (typeof msg.method === 'string' && msg.result === undefined && msg.error === undefined) return;
    const e = pending.get(msg.id);
    if (e) { pending.delete(msg.id); e.resolve(msg); }
  });
  function send(req) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...req }) + '\n');
    });
  }
  async function close() {
    try { rl.close(); } catch (_e) { /* swallow */ }
    if (!child.killed) child.kill('SIGTERM');
    try { await once(child, 'exit'); } catch (_e) { /* swallow */ }
  }
  return { send, close, stderrText: () => Buffer.concat(stderrChunks).toString('utf8') };
}

async function initialize(client) {
  const r = await client.send({
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'autoload-smoke', version: '0.0.0' } },
  });
  if (r.error) throw new Error('initialize failed: ' + JSON.stringify(r.error));
}

async function pollToolsList(client, predicate, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = await client.send({ method: 'tools/list', params: {} });
    if (r && r.result && Array.isArray(r.result.tools) && predicate(r.result.tools)) {
      return r.result.tools;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
}

describe('Server-level plugin autoload — discovered→ready chain wired into MCP boot', () => {
  test('approved plugin tools appear in tools/list after server boot', { timeout: TIMEOUT }, async () => {
    const tmp = makeTmpProject();
    const client = spawnServer(tmp);
    try {
      await initialize(client);
      // Plugin handshake is async; tools/list reflects the overlay only after load() completes.
      const tools = await pollToolsList(
        client,
        (list) => list.some((t) => t.name === 'plugin_fake-plugin_echo'),
        10000
      );
      assert.ok(tools, 'fake-plugin tool never appeared in tools/list — autoload chain broken. stderr:\n' + client.stderrText());
    } finally {
      await client.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
