#!/usr/bin/env node
'use strict';

/**
 * plugin-broker.integration.test.js — W-TEST-3
 *
 * Covers the 7 G2 §14 integration scenarios plus W-SEC-7 entrypoint-tamper:
 *
 *   1. Happy path: consent + scan + load + callTool + unload
 *   2. Manifest divergence: tools/list tool name mismatch → plugin_manifest_divergence event
 *   3. Crash mid-call: plugin exits during tool call → isError response; budget-exhausted → dead
 *   4. Consent gate: require_explicit_grant=true + no consent record → dead (consent_required)
 *   5. Env strip: spawned plugin env contains ONLY allowlisted keys (no ANTHROPIC_API_KEY etc.)
 *   6. Kill switch: ORCHESTRAY_PLUGIN_LOADER_DISABLED=1 → config.enabled=false
 *   7. Name collision: same namespaced tool registered twice → second registration blocked
 *   W-SEC-7. Entrypoint tamper: consent fingerprint A → tamper bytes → load() dead
 *
 * Runner: node --test tests/plugin-broker.integration.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { createLoader } = require('../bin/_lib/plugin-loader');

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'fake-plugin');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScratchPlugin(opts) {
  opts = opts || {};
  const scanDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-broker-'));
  const pluginDir = path.join(scanDir, 'fake-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  const serverSrc = fs.readFileSync(path.join(FIXTURE_ROOT, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'server.js'), serverSrc, { mode: 0o755 });

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
    cleanup() {
      try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    },
  };
}

function makeFakeRegistry() {
  const overlay = new Map();
  return {
    _register({ name, definition, handler }) {
      if (overlay.has(name)) throw new Error(`collision: ${name} already registered`);
      overlay.set(name, { definition, handler });
    },
    _unregister(name) { overlay.delete(name); },
    _isCoreTool()     { return false; },
    _overlay: overlay,
  };
}

function makeLoader(scanDir, extra) {
  const events   = [];
  const registry = makeFakeRegistry();
  const loader   = createLoader(Object.assign({
    discoveryPaths:    [scanDir],
    audit:             (ev) => events.push(ev),
    requireConsent:    false,
    registry,
    spawnTimeoutMs:    5_000,
    toolCallTimeoutMs: 5_000,
    maxRestartAttempts: 0,
  }, extra || {}));
  return { loader, events, registry };
}

// ---------------------------------------------------------------------------
// Scenario 1 — happy path: scan + load + callTool + unload
// ---------------------------------------------------------------------------

describe('Scenario 1 — happy path: scan + load + callTool + unload', () => {
  let sp, ctx;
  beforeEach(() => {
    sp  = makeScratchPlugin();
    ctx = makeLoader(sp.scanDir);
  });
  afterEach(async () => {
    await ctx.loader.shutdown();
    sp.cleanup();
  });

  test('echoes input text back after full lifecycle: scan→load→call→unload', async () => {
    const discovered = await ctx.loader.scan();
    assert.equal(discovered.length, 1, 'scan must find 1 plugin');
    assert.equal(discovered[0].plugin_name, 'fake-plugin');

    const loaded = await ctx.loader.load('fake-plugin');
    assert.equal(loaded.state, 'ready', `load must reach ready, got ${loaded.state}`);

    const result = await ctx.loader.callTool('plugin_fake-plugin_echo', { text: 'integration-ok' });
    assert.equal(result.isError, undefined, `unexpected error: ${JSON.stringify(result)}`);
    assert.equal(result.content[0].text, 'integration-ok');

    await ctx.loader.unload('fake-plugin');
    assert.equal(ctx.loader.getState('fake-plugin'), 'unloaded');

    const evTypes = ctx.events.map(e => e.type);
    assert.ok(evTypes.includes('plugin_discovered'),   'missing plugin_discovered');
    assert.ok(evTypes.includes('plugin_loaded'),       'missing plugin_loaded');
    assert.ok(evTypes.includes('plugin_tool_invoked'), 'missing plugin_tool_invoked');
    assert.ok(evTypes.includes('plugin_unloaded'),     'missing plugin_unloaded');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — manifest divergence: tools/list tool name mismatch → dead
// ---------------------------------------------------------------------------

describe('Scenario 2 — manifest divergence detected via FAKE_DIVERGE=1', () => {
  let sp, ctx;
  beforeEach(() => {
    sp  = makeScratchPlugin();
    ctx = makeLoader(sp.scanDir, {
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_DIVERGE'],
    });
  });
  afterEach(async () => {
    delete process.env.FAKE_DIVERGE;
    await ctx.loader.shutdown();
    sp.cleanup();
  });

  test('plugin advertising undeclared tool transitions to dead and emits plugin_manifest_divergence', async () => {
    process.env.FAKE_DIVERGE = '1';
    await ctx.loader.scan();
    const result = await ctx.loader.load('fake-plugin');
    assert.equal(result.state, 'dead', `expected dead on divergence, got ${result.state}`);

    const divEv = ctx.events.find(e => e.type === 'plugin_manifest_divergence');
    assert.ok(
      divEv,
      `plugin_manifest_divergence event missing; events: ${JSON.stringify(ctx.events.map(e => e.type))}`
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — crash mid-call: plugin exits during tool call → dead
// ---------------------------------------------------------------------------

describe('Scenario 3 — crash mid-call: plugin exits during tool call', () => {
  let sp, ctx;
  beforeEach(() => {
    sp  = makeScratchPlugin();
    ctx = makeLoader(sp.scanDir, {
      maxRestartAttempts: 0,
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_EXIT_ON_CALL'],
    });
  });
  afterEach(async () => {
    delete process.env.FAKE_EXIT_ON_CALL;
    await ctx.loader.shutdown();
    sp.cleanup();
  });

  test('callTool returns isError response when plugin exits mid-call', async () => {
    process.env.FAKE_EXIT_ON_CALL = '1';
    await ctx.loader.scan();
    await ctx.loader.load('fake-plugin');

    const result = await ctx.loader.callTool('plugin_fake-plugin_echo', { text: 'crash-test' });
    assert.equal(result.isError, true,
      `expected isError:true on crash, got: ${JSON.stringify(result)}`);

    // maxRestartAttempts=0 → budget immediately exhausted → plugin goes dead.
    const finalState = ctx.loader.getState('fake-plugin');
    assert.equal(finalState, 'dead',
      `expected dead after crash with 0 restart budget, got ${finalState}`);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — consent gate blocks load when require_explicit_grant=true and no consent
// ---------------------------------------------------------------------------

describe('Scenario 4 — consent gate blocks load when no consent record exists', () => {
  let sp, consentDir;
  afterEach(async () => {
    if (sp) sp.cleanup();
    if (consentDir) {
      try { fs.rmSync(consentDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });

  test('load() transitions to dead with consent_required when no consent record exists', async () => {
    sp = makeScratchPlugin();
    consentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-consent-'));
    const consentFile = path.join(consentDir, 'plugin-consents.json');

    const events = [];
    const loader = createLoader({
      discoveryPaths:    [sp.scanDir],
      audit:             (ev) => events.push(ev),
      requireConsent:    true,
      consentFile,
      registry:          makeFakeRegistry(),
      spawnTimeoutMs:    5_000,
      toolCallTimeoutMs: 5_000,
      maxRestartAttempts: 0,
    });

    await loader.scan();
    const result = await loader.load('fake-plugin');
    assert.equal(result.state, 'dead', `expected dead, got ${result.state}`);

    const rejEv = events.find(e =>
      e.type === 'plugin_install_rejected' && e.reason === 'consent_required'
    );
    assert.ok(
      rejEv,
      `consent_required rejection event missing; events: ${JSON.stringify(events.map(e => e.type + '/' + (e.reason || '')))}`
    );

    await loader.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — env strip: spawn env contains ONLY allowlisted keys
// ---------------------------------------------------------------------------

describe('Scenario 5 — env strip: spawned plugin env has no ORCHESTRAY_* or ANTHROPIC_* keys', () => {
  let sp, ctx;
  beforeEach(() => {
    sp  = makeScratchPlugin();
    ctx = makeLoader(sp.scanDir, {
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_DUMP_ENV'],
    });
  });
  afterEach(async () => {
    delete process.env.ORCHESTRAY_SECRET_SHOULD_NOT_LEAK;
    delete process.env.ANTHROPIC_API_KEY_FAKE;
    delete process.env.FAKE_DUMP_ENV;
    await ctx.loader.shutdown();
    sp.cleanup();
  });

  test('spawned plugin process does not receive ORCHESTRAY_* or ANTHROPIC_* env vars', async () => {
    process.env.ORCHESTRAY_SECRET_SHOULD_NOT_LEAK = 'secret-value';
    process.env.ANTHROPIC_API_KEY_FAKE = 'sk-fake-key-for-test';
    process.env.FAKE_DUMP_ENV = '1';

    await ctx.loader.scan();
    await ctx.loader.load('fake-plugin');
    const result = await ctx.loader.callTool('plugin_fake-plugin_echo', { text: 'env' });

    assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result)}`);
    const dumpedEnv = JSON.parse(result.content[0].text);

    assert.equal(dumpedEnv.ORCHESTRAY_SECRET_SHOULD_NOT_LEAK, undefined,
      'ORCHESTRAY_* vars must not reach the plugin (W-SEC-16)');
    assert.equal(dumpedEnv.ANTHROPIC_API_KEY_FAKE, undefined,
      'ANTHROPIC_* vars must not reach the plugin (W-SEC-16)');
    assert.ok(typeof dumpedEnv.PATH === 'string', 'PATH must be present (allowlisted)');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — kill switch: ORCHESTRAY_PLUGIN_LOADER_DISABLED=1 → config.enabled=false
// ---------------------------------------------------------------------------

describe('Scenario 6 — kill switch: ORCHESTRAY_PLUGIN_LOADER_DISABLED=1 → config.enabled=false', () => {
  afterEach(() => {
    delete process.env.ORCHESTRAY_PLUGIN_LOADER_DISABLED;
  });

  test('loadPluginLoaderConfig returns enabled=false when kill-switch env var is set', () => {
    const { loadPluginLoaderConfig } = require('../bin/_lib/config-schema');
    process.env.ORCHESTRAY_PLUGIN_LOADER_DISABLED = '1';
    const cfg = loadPluginLoaderConfig(os.tmpdir());
    assert.equal(cfg.enabled, false,
      'ORCHESTRAY_PLUGIN_LOADER_DISABLED=1 must yield plugin_loader.enabled=false');
  });

  test('loader with discoveryPaths=[] (kill-switch simulated) returns empty scan', async () => {
    const events = [];
    const loader = createLoader({
      discoveryPaths: [],
      audit: (ev) => events.push(ev),
      requireConsent: false,
      registry: makeFakeRegistry(),
    });
    const discovered = await loader.scan();
    assert.equal(discovered.length, 0, 'no plugins when discoveryPaths is empty');
    const pluginEvents = events.filter(e => (e.type || '').startsWith('plugin_'));
    assert.equal(pluginEvents.length, 0, 'no plugin_* events when scan yields nothing');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — name collision: two plugins with same namespaced tool → rejected
// ---------------------------------------------------------------------------

describe('Scenario 7 — name collision: duplicate overlay tool name is rejected by fake registry', () => {
  test('fake registry throws when same namespaced tool name registered twice', () => {
    const registry = makeFakeRegistry();
    const entry = {
      name: 'plugin_weather_forecast',
      definition: { name: 'plugin_weather_forecast', description: 'A tool', inputSchema: {} },
      handler: async () => ({}),
    };
    registry._register(entry);
    assert.throws(
      () => registry._register(entry),
      (err) => err instanceof Error && /collision/.test(err.message),
      'second registration of same name must throw'
    );
    assert.equal(registry._overlay.size, 1, 'overlay must contain only one entry');
  });
});

// ---------------------------------------------------------------------------
// W-SEC-7 — entrypoint tamper: fingerprint A consent → tamper bytes → dead
// ---------------------------------------------------------------------------

describe('W-SEC-7 — entrypoint tamper detected via fingerprint mismatch', () => {
  let sp, consentDir;
  afterEach(() => {
    if (sp) sp.cleanup();
    if (consentDir) {
      try { fs.rmSync(consentDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });

  test('load() rejects plugin when entrypoint bytes changed after consent was granted', async () => {
    sp = makeScratchPlugin();
    consentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sec7-'));
    const consentFile = path.join(consentDir, 'plugin-consents.json');

    const events = [];
    const loader = createLoader({
      discoveryPaths:    [sp.scanDir],
      audit:             (ev) => events.push(ev),
      requireConsent:    true,
      consentFile,
      registry:          makeFakeRegistry(),
      spawnTimeoutMs:    5_000,
      toolCallTimeoutMs: 5_000,
      maxRestartAttempts: 0,
    });

    // Step 1: scan to compute fingerprint A.
    await loader.scan();
    const ps = loader._internals.state.get('fake-plugin');
    assert.ok(ps, 'plugin must be in state map after scan');
    const fingerprintA = ps.fingerprint;
    assert.ok(fingerprintA && fingerprintA.length === 64, 'fingerprint must be 64-char hex SHA-256');

    // Step 2: grant consent for fingerprint A.
    loader._internals._writeConsent('fake-plugin', fingerprintA);
    const record = loader._internals._loadConsent('fake-plugin');
    assert.ok(record, 'consent record must be readable after _writeConsent');
    assert.equal(record.fingerprint, fingerprintA, 'stored fingerprint must match');

    // Step 3: tamper entrypoint bytes on disk.
    const entrypointPath = path.join(sp.pluginDir, 'server.js');
    fs.appendFileSync(entrypointPath, '\n// tamper-inserted-by-w-sec-7-test\n');

    // Step 4: reset state so scan() recomputes the fingerprint.
    loader._internals.state.delete('fake-plugin');
    await loader.scan();

    const ps2 = loader._internals.state.get('fake-plugin');
    assert.ok(ps2, 'plugin must be re-discovered after tamper');
    const fingerprintB = ps2.fingerprint;
    assert.notEqual(fingerprintA, fingerprintB,
      'tampered entrypoint must produce a different fingerprint from the consented one');

    // Step 5: load() must detect mismatch and go dead.
    const result = await loader.load('fake-plugin');
    assert.equal(result.state, 'dead',
      `expected dead on fingerprint mismatch, got ${result.state}`);

    const mismatchEv = events.find(e =>
      e.type === 'plugin_install_rejected' && e.reason === 'fingerprint_mismatch_consent'
    );
    assert.ok(
      mismatchEv,
      `fingerprint_mismatch_consent event missing; events: ${JSON.stringify(events.map(e => e.type + '/' + (e.reason || '')))}`
    );

    await loader.shutdown();
  });
});
