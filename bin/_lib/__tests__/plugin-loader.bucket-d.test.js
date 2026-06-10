#!/usr/bin/env node
'use strict';

/**
 * plugin-loader.bucket-d.test.js — Bucket D (plugin trust boundary) tests.
 *
 * D1: NODE_OPTIONS absent from spawned plugin env.
 * D2: Intermediate-dir symlink escape rejected (subdir→/ escapes plugin root).
 * D4: cwd-scoped consent file ignored by readConsents (inject-plugin-tools).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  createLoader,
  _buildSpawnEnv,
} = require('../plugin-loader.js');

const { readConsents } = require('../inject-plugin-tools-into-pm.js');

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'fake-plugin');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyFakePlugin(destPluginDir) {
  fs.mkdirSync(destPluginDir, { recursive: true });
  const serverSrc = fs.readFileSync(path.join(FIXTURE_ROOT, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(destPluginDir, 'server.js'), serverSrc, { mode: 0o755 });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, 'orchestray-plugin.json'), 'utf8')
  );
  fs.writeFileSync(
    path.join(destPluginDir, 'orchestray-plugin.json'),
    JSON.stringify(manifest, null, 2)
  );
}

function fakeRegistry() {
  const overlay = new Map();
  return {
    _register({ name, definition, handler }) { overlay.set(name, { definition, handler }); },
    _unregister(name) { overlay.delete(name); },
    _isCoreTool() { return false; },
    get(name) { return overlay.get(name); },
    overlay,
  };
}

// ---------------------------------------------------------------------------
// D1 — NODE_OPTIONS absent from default envAllowlist
// ---------------------------------------------------------------------------

describe('D1 — NODE_OPTIONS absent from plugin spawn env', () => {
  test('default envAllowlist does not include NODE_OPTIONS', () => {
    // _buildSpawnEnv with the default allowlist must not pass NODE_OPTIONS.
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--require /evil/hook.js';
    try {
      const env = _buildSpawnEnv(['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'TZ']);
      assert.equal(env.NODE_OPTIONS, undefined,
        'NODE_OPTIONS must not appear in plugin env (D1 — code injection risk)');
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
  });

  test('loader default envAllowlist does not contain NODE_OPTIONS', async () => {
    // Verify the loader's built-in default does not allowlist NODE_OPTIONS.
    const root    = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-d1-'));
    const scanDir = path.join(root, 'scan');
    const pluginDir = path.join(scanDir, 'fake-plugin');
    copyFakePlugin(pluginDir);
    process.env.NODE_OPTIONS = '--require /evil/hook.js';
    process.env.FAKE_DUMP_ENV = '1';
    const events = [];
    const loader = createLoader({
      discoveryPaths: [scanDir],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
      spawnTimeoutMs: 4_000,
      toolCallTimeoutMs: 4_000,
      maxRestartAttempts: 0,
      // Explicitly add FAKE_DUMP_ENV so the plugin can report its env.
      // NODE_OPTIONS must NOT be in this list.
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'TZ', 'FAKE_DUMP_ENV'],
    });
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      const result = await loader.callTool('plugin_fake-plugin_echo', { text: 'env' });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result)}`);
      const dumpedEnv = JSON.parse(result.content[0].text);
      assert.equal(dumpedEnv.NODE_OPTIONS, undefined,
        'NODE_OPTIONS leaked into plugin env (D1 violation)');
    } finally {
      delete process.env.NODE_OPTIONS;
      delete process.env.FAKE_DUMP_ENV;
      await loader.shutdown();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// D2 — Intermediate-dir symlink escape rejected
// ---------------------------------------------------------------------------

describe('D2 — intermediate-dir symlink escape blocked at spawn', () => {
  test('plugin with subdir symlink pointing outside root → dead reason=symlink_escape', async () => {
    const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-d2-'));
    const scanDir   = path.join(root, 'scan');
    const pluginDir = path.join(scanDir, 'fake-plugin');

    // Build plugin dir normally first.
    copyFakePlugin(pluginDir);

    // Now replace the 'sub' directory inside the plugin with a symlink to /tmp
    // and rewrite the manifest entrypoint to go through it.
    // Strategy: create an extra subdir level, symlink it outside root.
    const subDir = path.join(pluginDir, 'sub');
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-d2-outside-'));

    // Copy server.js to the outside target so the file is real and readable.
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'server.js'), path.join(outsideTarget, 'server.js'));

    // Create subDir as a symlink to outsideTarget.
    fs.symlinkSync(outsideTarget, subDir);

    // Rewrite manifest entrypoint to sub/server.js (goes through the symlinked dir).
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, 'orchestray-plugin.json'), 'utf8')
    );
    manifest.entrypoint = 'sub/server.js';
    fs.writeFileSync(
      path.join(pluginDir, 'orchestray-plugin.json'),
      JSON.stringify(manifest, null, 2)
    );

    const events = [];
    const loader = createLoader({
      discoveryPaths: [scanDir],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
      spawnTimeoutMs: 4_000,
      toolCallTimeoutMs: 4_000,
      maxRestartAttempts: 0,
    });

    try {
      await loader.scan();
      // load() returns {state, plugin_name} — it does NOT throw on spawn failure.
      // Symlink escape is caught inside spawnAndHandshake; loader transitions to dead.
      const result = await loader.load('fake-plugin');
      assert.equal(result.state, 'dead',
        `expected plugin state to be 'dead' after symlink escape; got: ${result.state}`);

      // Verify a dead audit event with a symlink-related reason was emitted.
      const deadEvt = events.find(e => e.type === 'plugin_dead');
      assert.ok(deadEvt, `expected plugin_dead audit event. Events: ${JSON.stringify(events.map(e => e.type))}`);
      const reason = deadEvt.reason || '';
      const reasonOk = reason.includes('symlink') || reason.includes('escape') || reason.includes('unresolvable');
      assert.ok(
        reasonOk,
        `expected plugin_dead reason to indicate symlink/escape/unresolvable; got: "${reason}"`
      );
    } finally {
      await loader.shutdown();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) {}
      try { fs.rmSync(outsideTarget, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// D4 — cwd-scoped consent file ignored by readConsents
// ---------------------------------------------------------------------------

describe('D4 — readConsents ignores cwd-scoped consent file', () => {
  test('consent file in cwd is NOT read when HOME canonical path is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-d4-'));
    try {
      // Write a consent record in cwd/.orchestray/state/plugin-consents.json
      const cwdConsentDir = path.join(tmp, '.orchestray', 'state');
      fs.mkdirSync(cwdConsentDir, { recursive: true });
      const cwdConsentFile = path.join(cwdConsentDir, 'plugin-consents.json');
      const forgedConsent = { 'evil-plugin': { revoked: false, manifest: { tools: [] } } };
      fs.writeFileSync(cwdConsentFile, JSON.stringify(forgedConsent), 'utf8');

      // readConsents with a non-existent HOME should return {} (not the cwd file).
      const result = readConsents({ home: path.join(tmp, 'no-such-home') });
      assert.deepEqual(result, {},
        'readConsents must not fall back to cwd consent file (D4 — agent forge risk)');
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('explicit consentFile override (absolute path) IS honored', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-d4-'));
    try {
      const consentFile = path.join(tmp, 'plugin-consents.json');
      const record = { 'my-plugin': { revoked: false, manifest: { tools: [] } } };
      fs.writeFileSync(consentFile, JSON.stringify(record), 'utf8');

      const result = readConsents({ consentFile });
      assert.deepEqual(result, record, 'explicit absolute consentFile must be honored');
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('relative consentFile override is rejected (must be absolute)', () => {
    // A relative path could be relative to a cwd an agent controls.
    // Pass a non-existent HOME so the HOME fallback also returns {} —
    // we want to isolate only the relative-path rejection behavior.
    const result = readConsents({
      consentFile: 'relative/path/consents.json',
      home: '/nonexistent-home-for-test-isolation',
    });
    assert.deepEqual(result, {},
      'relative consentFile must be rejected and return empty consents');
  });
});
