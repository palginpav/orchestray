#!/usr/bin/env node
'use strict';

/**
 * plugin-loader.security.smoke.test.js — W-SEC-1, W-SEC-2, W-SEC-16 smoke
 * tests.
 *
 * Coverage:
 *   - W-SEC-1  symlink rejection at scan AND spawn time (3 cases: dir, manifest, entrypoint)
 *   - W-SEC-2  same plugin name in two scan paths → first wins, second emits path_shadow
 *   - W-SEC-16 env-strip: process.env passed to plugin contains ONLY allowlisted keys
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { createLoader, _buildSpawnEnv } = require('../plugin-loader.js');

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'fake-plugin');

// -- helpers -----------------------------------------------------------------

function copyFakePlugin(destPluginDir, opts) {
  opts = opts || {};
  fs.mkdirSync(destPluginDir, { recursive: true });
  const serverSrc = fs.readFileSync(path.join(FIXTURE_ROOT, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(destPluginDir, 'server.js'), serverSrc, { mode: 0o755 });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, 'orchestray-plugin.json'), 'utf8')
  );
  if (opts.nameOverride) manifest.name = opts.nameOverride;
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
    _overlay: overlay,
  };
}

// ---------------------------------------------------------------------------
// W-SEC-1 part 1: symlinked plugin DIRECTORY is rejected at scan time
// ---------------------------------------------------------------------------

describe('W-SEC-1 symlink rejection (scan)', () => {
  test('symlinked plugin dir emits plugin_install_rejected reason=symlink', () => {
    const root  = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sec-'));
    const realDir = path.join(root, 'real-fake');
    copyFakePlugin(realDir);
    // Plant a symlink elsewhere in the scan path.
    const scanDir  = path.join(root, 'scan');
    fs.mkdirSync(scanDir);
    const symlink = path.join(scanDir, 'symlinked-plugin');
    try { fs.symlinkSync(realDir, symlink, 'dir'); }
    catch (err) {
      // Some environments (e.g. Windows without admin) may forbid symlink creation.
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        return; // skip — sec test is best-effort on hostile FS
      }
      throw err;
    }

    const events = [];
    const loader = createLoader({
      discoveryPaths: [scanDir],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
    });
    return loader.scan().then(() => {
      const rej = events.find(e => e.type === 'plugin_install_rejected' && e.reason === 'symlink');
      assert.ok(rej, `expected plugin_install_rejected reason=symlink, events=${JSON.stringify(events)}`);
    }).finally(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });
  });

  test('symlinked manifest file inside a regular plugin dir is rejected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sec-'));
    const scanDir   = path.join(root, 'scan');
    const pluginDir = path.join(scanDir, 'with-link-manifest');
    const realRoot  = path.join(root, 'real');
    copyFakePlugin(realRoot);
    fs.mkdirSync(pluginDir, { recursive: true });
    // Plant a symlinked manifest pointing to the real one.
    try {
      fs.symlinkSync(path.join(realRoot, 'orchestray-plugin.json'),
                     path.join(pluginDir, 'orchestray-plugin.json'),
                     'file');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') return;
      throw err;
    }

    const events = [];
    const loader = createLoader({
      discoveryPaths: [scanDir],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
    });
    return loader.scan().then(() => {
      const rej = events.find(e =>
        e.type === 'plugin_install_rejected'
        && (e.reason === 'manifest_symlink' || e.reason === 'symlink')
      );
      assert.ok(rej, `expected manifest_symlink rejection, events=${JSON.stringify(events)}`);
    }).finally(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });
  });

  test('symlinked entrypoint is rejected at spawn time (TOCTOU)', async () => {
    const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sec-'));
    const scanDir   = path.join(root, 'scan');
    const pluginDir = path.join(scanDir, 'fake-plugin');
    const realRoot  = path.join(root, 'real');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(realRoot,  { recursive: true });

    // Real entrypoint lives at realRoot/server.js (outside the plugin dir).
    fs.writeFileSync(
      path.join(realRoot, 'server.js'),
      'process.exit(0);\n',
      { mode: 0o755 }
    );

    // Manifest is a real file...
    const manifest = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_ROOT, 'orchestray-plugin.json'), 'utf8')
    );
    fs.writeFileSync(
      path.join(pluginDir, 'orchestray-plugin.json'),
      JSON.stringify(manifest, null, 2)
    );

    // ...but the entrypoint is a symlink pointing outside the plugin dir.
    try {
      fs.symlinkSync(path.join(realRoot, 'server.js'),
                     path.join(pluginDir, 'server.js'),
                     'file');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') return;
      throw err;
    }

    const events = [];
    const loader = createLoader({
      discoveryPaths: [scanDir],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
      spawnTimeoutMs: 2_000,
      toolCallTimeoutMs: 2_000,
      maxRestartAttempts: 0,
    });
    try {
      await loader.scan();
      const r = await loader.load('fake-plugin');
      assert.equal(r.state, 'dead', `expected dead, got ${r.state}`);
      const dead = events.find(e =>
        e.type === 'plugin_dead' && e.reason === 'symlink_at_spawn'
      );
      assert.ok(dead, `expected symlink_at_spawn rejection, events=${JSON.stringify(events.map(e => ({type: e.type, reason: e.reason})))}`);
    } finally {
      await loader.shutdown();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// W-SEC-2: path-shadow detection — same plugin name in 2 scan paths
// ---------------------------------------------------------------------------

describe('W-SEC-2 path-shadow detection', () => {
  test('same plugin name in two scan paths: first wins, second emits path_shadow', async () => {
    const root  = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sec-'));
    const dir1  = path.join(root, 'scan1');
    const dir2  = path.join(root, 'scan2');
    const plug1 = path.join(dir1, 'fake-plugin');
    const plug2 = path.join(dir2, 'fake-plugin');
    copyFakePlugin(plug1);
    copyFakePlugin(plug2);

    const events = [];
    const loader = createLoader({
      discoveryPaths: [dir1, dir2],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
    });
    try {
      const discovered = await loader.scan();
      assert.equal(discovered.length, 1, 'only the first-discovered should win');
      assert.equal(discovered[0].scan_path, dir1);
      const shadow = events.find(e =>
        e.type === 'plugin_install_rejected' && e.reason === 'path_shadow'
      );
      assert.ok(shadow, `expected path_shadow event, events=${JSON.stringify(events.map(e => ({type: e.type, reason: e.reason})))}`);
      assert.equal(shadow.first_seen_in, dir1);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// W-SEC-16 env-strip: spawned process env contains ONLY allowlisted keys
// ---------------------------------------------------------------------------

describe('W-SEC-16 env-strip', () => {
  test('buildSpawnEnv keeps allowlisted keys and drops the rest', () => {
    process.env.FAKE_SECRET_FOR_TEST = 'leak-me';
    process.env.PATH_SHOULD_STAY = process.env.PATH_SHOULD_STAY || ''; // sanity
    try {
      const env = _buildSpawnEnv(['PATH', 'HOME', 'LANG', 'LC_*']);
      assert.ok(typeof env.PATH === 'string', 'PATH should be preserved');
      assert.equal(env.FAKE_SECRET_FOR_TEST, undefined, 'unallowed key must be stripped');
      // CLAUDE_CODE_* / ANTHROPIC_API_KEY / ORCHESTRAY_* would only leak if we
      // spread process.env — assert none of those are present.
      for (const k of Object.keys(env)) {
        assert.ok(
          !k.startsWith('CLAUDE_CODE_') && !k.startsWith('ANTHROPIC_') && !k.startsWith('ORCHESTRAY_'),
          `env should not contain ${k}`
        );
      }
    } finally {
      delete process.env.FAKE_SECRET_FOR_TEST;
    }
  });

  test('buildSpawnEnv expands LC_* wildcard to keep LC_ALL, LC_TIME, ...', () => {
    process.env.LC_ALL  = 'en_US.UTF-8';
    process.env.LC_TIME = 'C';
    try {
      const env = _buildSpawnEnv(['LC_*']);
      assert.equal(env.LC_ALL,  'en_US.UTF-8');
      assert.equal(env.LC_TIME, 'C');
    } finally {
      delete process.env.LC_ALL;
      delete process.env.LC_TIME;
    }
  });

  test('plugin subprocess sees stripped env (no FAKE_SECRET leak)', async () => {
    const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sec-'));
    const scanDir   = path.join(root, 'scan');
    const pluginDir = path.join(scanDir, 'fake-plugin');
    copyFakePlugin(pluginDir);

    process.env.FAKE_SECRET = 'super-leak';
    const events = [];
    const loader = createLoader({
      discoveryPaths: [scanDir],
      audit: ev => events.push(ev),
      registry: fakeRegistry(),
      requireConsent: false,
      spawnTimeoutMs: 4_000,
      toolCallTimeoutMs: 4_000,
      maxRestartAttempts: 0,
      // FAKE_DUMP_ENV is in allowlist for this test ONLY (it's a fixture flag),
      // so the plugin can be told to dump its env. FAKE_SECRET is NOT in the
      // allowlist, so we expect it absent from the dumped env.
      envAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ', 'FAKE_DUMP_ENV'],
    });
    process.env.FAKE_DUMP_ENV = '1';
    try {
      await loader.scan();
      await loader.load('fake-plugin');
      const result = await loader.callTool('plugin_fake-plugin_echo', { text: 'env' });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result)}`);
      const dumpedEnv = JSON.parse(result.content[0].text);
      assert.equal(dumpedEnv.FAKE_SECRET, undefined,
        'FAKE_SECRET leaked into plugin env (W-SEC-16 violation)');
      // Sanity: PATH should be present (allowlisted).
      assert.ok(typeof dumpedEnv.PATH === 'string', 'PATH should reach the plugin');
    } finally {
      delete process.env.FAKE_SECRET;
      delete process.env.FAKE_DUMP_ENV;
      await loader.shutdown();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });
});
