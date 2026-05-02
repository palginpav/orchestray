#!/usr/bin/env node
'use strict';

/**
 * plugin-loader.smoke.test.js — W-LOAD-2 / W-LOAD-3 / W-LOAD-4 / W-LOAD-5
 * integration smoke tests against the real fake-plugin fixture.
 *
 * These tests spawn the actual fixture subprocess
 * (tests/fixtures/fake-plugin/server.js) under the loader and exercise the
 * end-to-end handshake / call / failure paths. Each test uses a fresh
 * loader instance, scratch scan dir, and isolated tool registry to keep
 * runs hermetic.
 *
 * The tests use `requireConsent: false` (Wave 2 stub for W-SEC-4 — see the
 * top-of-file TODO in plugin-loader.js).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { createLoader } = require('../plugin-loader.js');

// Path to the canonical fake-plugin fixture.
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'fake-plugin');

// -- helpers -----------------------------------------------------------------

/**
 * Set up a scratch scan directory and copy (NOT symlink) the fake-plugin
 * fixture into it. Returns { scanDir, pluginDir, cleanup }.
 *
 * Variants accepted via opts:
 *   diverge:       true → server.js sets FAKE_DIVERGE=1 (mismatched tools/list)
 *   slowMs:        N    → server.js delays N ms before responding
 *   floodMb:       N    → server.js writes a single N MB line on tool-call
 *   backlogMb:     N    → server.js writes N × 1 MB lines on tool-call
 *   dumpEnv:       true → server.js returns process.env as result text
 *   exitOnCall:    true → server.js exits on tool-call (mid-call death)
 *   pluginNameOverride: string → override manifest "name" in the copy
 */
function makeScratchPlugin(opts) {
  opts = opts || {};
  const scanDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pl-'));
  const pluginDir = path.join(scanDir, 'fake-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  // Copy server.js verbatim.
  const serverSrc = fs.readFileSync(path.join(FIXTURE_ROOT, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'server.js'), serverSrc, { mode: 0o755 });

  // Manifest may be customized.
  const manifestSrc = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, 'orchestray-plugin.json'), 'utf8')
  );
  if (opts.pluginNameOverride) manifestSrc.name = opts.pluginNameOverride;
  fs.writeFileSync(
    path.join(pluginDir, 'orchestray-plugin.json'),
    JSON.stringify(manifestSrc, null, 2),
    { mode: 0o644 }
  );

  return {
    scanDir,
    pluginDir,
    pluginName: manifestSrc.name,
    cleanup: () => {
      try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    },
  };
}

/** Make a loader bound to a single scratch scan dir. */
function makeLoader(scanDir, extraOpts) {
  const events = [];
  const fakeRegistry = makeFakeRegistry();
  const loader = createLoader(Object.assign({
    discoveryPaths: [scanDir],
    audit: (ev) => events.push(ev),
    requireConsent: false, // Wave 2 stub
    registry: fakeRegistry,
    spawnTimeoutMs: 4_000,
    toolCallTimeoutMs: 4_000,
    // Tests set maxRestartAttempts=0 by default so a single death does NOT
    // schedule a restart timer that survives the test boundary and leaks
    // subprocesses into the next test. Tests that specifically exercise
    // restart can override this.
    maxRestartAttempts: 0,
  }, extraOpts || {}));
  return { loader, events, registry: fakeRegistry };
}

function makeFakeRegistry() {
  const overlay = new Map();
  return {
    _register({ name, definition, handler }) {
      if (overlay.has(name)) throw new Error(`already registered: ${name}`);
      overlay.set(name, { definition, handler });
    },
    _unregister(name) { overlay.delete(name); },
    _isCoreTool() { return false; },
    _overlay: overlay,
  };
}

/** Wait briefly for the loader's child processes to fully exit. */
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 1. Happy path: scan → load → handshake → ready → callTool round trip
// ---------------------------------------------------------------------------

describe('W-LOAD-2/3/4 happy path', () => {
  test('scan + load + tools/call echo round-trip works', async () => {
    const sp = makeScratchPlugin();
    const { loader, events, registry } = makeLoader(sp.scanDir);
    try {
      const discovered = await loader.scan();
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].plugin_name, 'fake-plugin');

      const loadResult = await loader.load('fake-plugin');
      assert.equal(loadResult.state, 'ready', `expected ready, got ${loadResult.state}`);

      // Tool must be registered under the canonical namespaced name.
      assert.ok(registry._overlay.has('plugin_fake-plugin_echo'), 'echo tool not registered');

      // callTool happy path.
      const result = await loader.callTool('plugin_fake-plugin_echo', { text: 'hello' });
      assert.equal(result.isError, undefined, `unexpected error: ${JSON.stringify(result)}`);
      assert.equal(result.content[0].text, 'hello');

      // Audit events.
      const evTypes = events.map(e => e.type);
      assert.ok(evTypes.includes('plugin_discovered'),  'plugin_discovered missing');
      assert.ok(evTypes.includes('plugin_loaded'),      'plugin_loaded missing');
      assert.ok(evTypes.includes('plugin_tool_invoked'),'plugin_tool_invoked missing');
    } finally {
      await loader.shutdown();
      sp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Manifest divergence: tools/list returns a tool name not in the manifest
// ---------------------------------------------------------------------------

describe('W-LOAD-3 manifest divergence', () => {
  test('plugin advertising a tool not in manifest transitions to dead', async () => {
    const sp = makeScratchPlugin();
    const { loader, events } = makeLoader(sp.scanDir, {
      // env hook: scratch override via env in spawn doesn't apply here because
      // env-strip removes most. So we pre-mutate process.env in the parent
      // and rely on FAKE_DIVERGE being added to the allowlist for this test.
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_DIVERGE'],
    });
    process.env.FAKE_DIVERGE = '1';
    try {
      await loader.scan();
      const result = await loader.load('fake-plugin');
      assert.equal(result.state, 'dead', `expected dead, got ${result.state}`);
      const div = events.find(e => e.type === 'plugin_manifest_divergence');
      assert.ok(div, 'plugin_manifest_divergence event missing');
    } finally {
      delete process.env.FAKE_DIVERGE;
      await loader.shutdown();
      sp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Per-call timeout (W-LOAD-4)
// ---------------------------------------------------------------------------

describe('W-LOAD-4 per-call timeout', () => {
  test('callTool rejects with isError after toolCallTimeoutMs', async () => {
    const sp = makeScratchPlugin();
    const { loader } = makeLoader(sp.scanDir, {
      toolCallTimeoutMs: 200,
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_SLEEP_MS'],
    });
    process.env.FAKE_SLEEP_MS = '4000';
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      const result = await loader.callTool('plugin_fake-plugin_echo', { text: 'slow' });
      assert.equal(result.isError, true, `expected timeout error, got ${JSON.stringify(result)}`);
      assert.match(result.content[0].text, /timeout/i);
    } finally {
      delete process.env.FAKE_SLEEP_MS;
      await loader.shutdown();
      sp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Stdout per-line cap (W-LOAD-5 / W-SEC-23)
// ---------------------------------------------------------------------------

describe('W-LOAD-5 stdout caps', () => {
  test('per-line stdout overflow kills plugin with reason=protocol_dos', async () => {
    const sp = makeScratchPlugin();
    const { loader, events } = makeLoader(sp.scanDir, {
      perLineMaxBytes: 256 * 1024,         // 256 KB cap
      totalBacklogMaxBytes: 64 * 1024 * 1024, // 64 MB backlog (so per-line wins)
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_FLOOD_MB'],
      toolCallTimeoutMs: 6_000,
    });
    process.env.FAKE_FLOOD_MB = '2'; // 2 MB single line
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      // The flood happens on tools/call. Issue the call; we expect either an
      // error result or a delayed dead transition.
      await loader.callTool('plugin_fake-plugin_echo', { text: 'flood' }).catch(() => {});
      // Give the killer a moment.
      await delay(300);
      const dead = events.find(e => e.type === 'plugin_dead' && e.reason === 'protocol_dos');
      assert.ok(dead, `expected plugin_dead reason=protocol_dos, events=${JSON.stringify(events.map(e => e.type))}`);
    } finally {
      delete process.env.FAKE_FLOOD_MB;
      await loader.shutdown();
      sp.cleanup();
    }
  });

  test('total backlog overflow kills plugin with reason=protocol_dos', async () => {
    const sp = makeScratchPlugin();
    const { loader, events } = makeLoader(sp.scanDir, {
      perLineMaxBytes: 4 * 1024 * 1024,        // 4 MB per-line (so backlog wins)
      totalBacklogMaxBytes: 4 * 1024 * 1024,    // 4 MB total backlog
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_BACKLOG_MB'],
      toolCallTimeoutMs: 6_000,
    });
    process.env.FAKE_BACKLOG_MB = '8'; // 8 lines × 1 MB each → 8 MB > 4 MB
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      await loader.callTool('plugin_fake-plugin_echo', { text: 'flood' }).catch(() => {});
      await delay(500);
      const dead = events.find(e => e.type === 'plugin_dead' && e.reason === 'protocol_dos');
      assert.ok(dead, `expected plugin_dead reason=protocol_dos, events=${JSON.stringify(events.map(e => e.type))}`);
    } finally {
      delete process.env.FAKE_BACKLOG_MB;
      await loader.shutdown();
      sp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Shutdown kills the process group (W-SEC-17)
// ---------------------------------------------------------------------------

describe('W-SEC-17 shutdown', () => {
  test('shutdown() unloads loaded plugins and parks them at unloaded', async () => {
    const sp = makeScratchPlugin();
    const { loader } = makeLoader(sp.scanDir);
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      assert.equal(loader.getState('fake-plugin'), 'ready');
      await loader.shutdown();
      assert.equal(loader.getState('fake-plugin'), 'unloaded');
    } finally {
      sp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Mid-call death — pending call rejects, plugin transitions to dead
// ---------------------------------------------------------------------------

describe('W-LOAD-1 mid-call death', () => {
  test('plugin exit during a call rejects pending call and transitions dead', async () => {
    const sp = makeScratchPlugin();
    const { loader, events } = makeLoader(sp.scanDir, {
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_EXIT_ON_CALL'],
      // No restart in this test (so subsequent state checks aren't racy).
      maxRestartAttempts: 0,
    });
    process.env.FAKE_EXIT_ON_CALL = '1';
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      const result = await loader.callTool('plugin_fake-plugin_echo', { text: 'die' });
      assert.equal(result.isError, true, `expected error, got ${JSON.stringify(result)}`);
      // Allow the exit handler to run.
      await delay(150);
      const dead = events.find(e => e.type === 'plugin_dead');
      assert.ok(dead, 'plugin_dead event missing');
    } finally {
      delete process.env.FAKE_EXIT_ON_CALL;
      await loader.shutdown();
      sp.cleanup();
    }
  });
});
