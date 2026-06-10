#!/usr/bin/env node
'use strict';

/**
 * plugin-loader-flag-lifecycle.test.js — v2.3.7 lifecycle race fixes (bucket A).
 *
 * Covers the three confirmed HIGH bugs from
 * .orchestray/kb/artifacts/v237-audit-plugin-race.md:
 *
 *   BUG-1  changed-flag written on EVERY server boot (not just mid-session).
 *          → boot-phase suppression: a boot scan→load chain (bracketed by
 *            beginBootPhase()/endBootPhase()) does NOT create the flag; a
 *            post-boot overlay mutation DOES.
 *   BUG-2  flapping plugin re-arms the flag forever.
 *          → an unload→reload restoring the IDENTICAL toolset does NOT re-arm;
 *            a genuinely changed toolset DOES.
 *   BUG-3  consent advisory-lock stale recovery double-hold.
 *          → two concurrent stale-lock recoverers → EXACTLY ONE acquires.
 *
 * Pitfall avoided (recorded anti-pattern): no doesNotThrow-only assertions —
 * every test asserts OBSERVABLE state (flag file existence, lock winner count).
 *
 * Runner: node --test tests/plugin-loader-flag-lifecycle.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');
const { spawnSync } = require('node:child_process');

const { createLoader } = require('../bin/_lib/plugin-loader');

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'fake-plugin');
const LOADER_PATH  = path.resolve(__dirname, '..', 'bin', '_lib', 'plugin-loader.js');

// ---------------------------------------------------------------------------
// Helpers (mirror tests/plugin-kill-switches.test.js conventions)
// ---------------------------------------------------------------------------

function makeScratchPlugin(nameOverride) {
  const scanDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-flag-'));
  const pluginDir = path.join(scanDir, 'fake-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  const serverSrc = fs.readFileSync(path.join(FIXTURE_ROOT, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'server.js'), serverSrc, { mode: 0o755 });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, 'orchestray-plugin.json'), 'utf8')
  );
  if (nameOverride) manifest.name = nameOverride;
  fs.writeFileSync(
    path.join(pluginDir, 'orchestray-plugin.json'),
    JSON.stringify(manifest, null, 2),
    { mode: 0o644 }
  );

  return {
    scanDir,
    pluginName: manifest.name,
    cleanup() {
      try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    },
  };
}

function makeFakeRegistry() {
  const overlay = new Map();
  return {
    _register({ name, definition, handler, plugin_name }) {
      if (overlay.has(name)) throw new Error(`collision: ${name} already registered`);
      overlay.set(name, { definition, handler, plugin_name });
    },
    _unregister(name) { overlay.delete(name); },
    _isCoreTool() { return false; },
    _overlay: overlay,
  };
}

// W-1 fix: track every loader so afterEach can shut down child plugin
// processes — without this the spawned plugin servers hold the event loop
// open and the file hangs the full suite (no --test-force-exit in npm test).
const liveLoaders = [];

function makeLoader(scanDir, projectRoot, extra) {
  const loader = createLoader(Object.assign({
    discoveryPaths:     [scanDir],
    projectRoot,
    audit:              () => {},
    requireConsent:     false,
    registry:           makeFakeRegistry(),
    spawnTimeoutMs:     5_000,
    toolCallTimeoutMs:  5_000,
    maxRestartAttempts: 0,
    restart_flag_check: true,
  }, extra || {}));
  liveLoaders.push(loader);
  return loader;
}

function flagPathFor(root) {
  return path.join(root, '.orchestray', 'state', 'plugin-tools-changed.flag');
}

// ---------------------------------------------------------------------------
// BUG-1 — boot-phase suppression of the changed-flag
// ---------------------------------------------------------------------------

describe('BUG-1 — boot-phase suppression of plugin-tools-changed.flag', () => {
  let sp, root;
  afterEach(async () => {
    await Promise.all(liveLoaders.splice(0).map((l) => l.shutdown().catch(() => { /* ignore */ })));
    if (sp) { sp.cleanup(); sp = null; }
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ } root = null; }
  });

  test('boot-time load (inside beginBootPhase/endBootPhase) does NOT create the flag', async () => {
    sp   = makeScratchPlugin();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-root-'));
    const loader = makeLoader(sp.scanDir, root);

    loader.beginBootPhase();
    await loader.scan();
    await loader.load(sp.pluginName);
    loader.endBootPhase();

    const flag = flagPathFor(root);
    assert.equal(
      fs.existsSync(flag), false,
      `boot-time load must NOT arm the flag, but ${flag} exists`
    );
    // The plugin DID register (so this is a real, meaningful boot load, not a no-op).
    assert.equal(loader.getState(sp.pluginName), 'ready',
      'plugin should be ready after boot load (guards against a vacuous pass)');

    await loader.shutdown();
  });

  test('post-boot overlay mutation (load after endBootPhase) DOES create the flag', async () => {
    sp   = makeScratchPlugin();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-root-'));
    const loader = makeLoader(sp.scanDir, root);

    // Simulate a server that finished booting with NO plugins, then a plugin
    // arrives mid-session.
    loader.beginBootPhase();
    await loader.scan();
    loader.endBootPhase();

    const flag = flagPathFor(root);
    assert.equal(fs.existsSync(flag), false, 'flag must be clean right after boot');

    // Mid-session load → genuine tool-list change → flag armed.
    await loader.load(sp.pluginName);
    assert.equal(
      fs.existsSync(flag), true,
      `post-boot load must arm the flag at ${flag}`
    );

    await loader.shutdown();
  });
});

// ---------------------------------------------------------------------------
// BUG-2 — flap with identical toolset must not re-arm; changed toolset does
// ---------------------------------------------------------------------------

describe('BUG-2 — identical-toolset flap does not re-arm; changed toolset does', () => {
  let sp, root;
  afterEach(async () => {
    await Promise.all(liveLoaders.splice(0).map((l) => l.shutdown().catch(() => { /* ignore */ })));
    if (sp) { sp.cleanup(); sp = null; }
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ } root = null; }
  });

  test('crash→reload (flap) restoring the identical toolset does NOT re-arm the flag', async () => {
    sp   = makeScratchPlugin();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-root-'));
    // maxRestartAttempts > 0 so transitionDead treats a crash as a restartable
    // flap (the death edge is transient → flag suppressed). The settling reload
    // re-registers the identical toolset → diff vs. boot baseline is a no-op.
    const loader = makeLoader(sp.scanDir, root, { maxRestartAttempts: 3 });
    const flag   = flagPathFor(root);

    // Boot the plugin (suppressed); endBootPhase() baselines the boot toolset.
    loader.beginBootPhase();
    await loader.scan();
    await loader.load(sp.pluginName);
    loader.endBootPhase();
    assert.equal(fs.existsSync(flag), false, 'boot must not arm');

    const ps = loader._internals.state.get(sp.pluginName);
    assert.ok(ps && ps.registeredToolNames.size > 0,
      'plugin must have registered tools before the flap (guards a vacuous pass)');

    // Simulate a crash with restart budget remaining: the death edge is a
    // transient flap and MUST NOT arm the flag (it is surfaced via plugin_dead /
    // plugin_restart_attempted audit events instead).
    // NOTE: in production transitionDead fires AFTER the child actually died;
    // driving it manually leaves the real child alive and orphaned (the later
    // reload spawns a second child; shutdown only reaps the current one). Kill
    // the orphan explicitly or its pipes hold the event loop open and the
    // whole test file hangs the suite (W-1).
    const orphanProc = ps.proc;
    loader._internals.transitionDead(ps, 'crash', 'simulated flap');
    if (orphanProc && orphanProc.pid) {
      try { process.kill(-orphanProc.pid, 'SIGKILL'); }
      catch (_e) { try { orphanProc.kill('SIGKILL'); } catch (_e2) { /* ignore */ } }
    }
    assert.equal(
      fs.existsSync(flag), false,
      'a restartable crash (transient flap) must NOT arm the flag (BUG-2)'
    );

    // The settling reload restores the EXACT same tool names → no real change.
    await loader.scan();
    await loader.load(sp.pluginName);
    assert.equal(
      fs.existsSync(flag), false,
      'reloading the IDENTICAL toolset after a flap must NOT re-arm the flag (BUG-2)'
    );

    await loader.shutdown();
  });

  test('deliberate unload (permanent removal) DOES arm the flag', async () => {
    sp   = makeScratchPlugin();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-root-'));
    const loader = makeLoader(sp.scanDir, root);
    const flag   = flagPathFor(root);

    loader.beginBootPhase();
    await loader.scan();
    await loader.load(sp.pluginName);
    loader.endBootPhase();
    assert.equal(fs.existsSync(flag), false, 'boot must not arm');

    // A user-initiated unload permanently removes the tools → genuine change.
    await loader.unload(sp.pluginName);
    assert.equal(
      fs.existsSync(flag), true,
      'deliberate unload (tools removed) MUST arm the flag'
    );

    await loader.shutdown();
  });

  test('a genuinely changed toolset DOES arm the flag', async () => {
    // Two distinct plugins with distinct tool namespaces. Booting plugin A,
    // then mid-session loading plugin B changes the toolset → arms.
    sp   = makeScratchPlugin('plugin-a');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-root-'));
    const spB = makeScratchPlugin('plugin-b');
    try {
      const loader = makeLoader(sp.scanDir, root, {
        discoveryPaths: [sp.scanDir, spB.scanDir],
      });
      const flag = flagPathFor(root);

      loader.beginBootPhase();
      await loader.scan();
      await loader.load('plugin-a');
      loader.endBootPhase();
      assert.equal(fs.existsSync(flag), false, 'boot must not arm');

      // Mid-session: a NEW plugin's tools appear → toolset genuinely changed.
      await loader.load('plugin-b');
      assert.equal(
        fs.existsSync(flag), true,
        'loading a new plugin (changed toolset) MUST arm the flag'
      );

      await loader.shutdown();
    } finally {
      spB.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-3 — concurrent stale-lock recovery → exactly one winner
// ---------------------------------------------------------------------------

describe('BUG-3 — consent stale-lock recovery is atomic (no double-hold)', () => {
  let dir;
  afterEach(() => {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } dir = null; }
  });

  test('two concurrent recoverers of a stale lock → exactly one acquires', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lock-'));
    const consentPath = path.join(dir, 'plugin-consents.json');
    const lockPath    = consentPath + '.lock';

    // Plant a STALE lock (mtime far in the past so the >10s recovery path fires).
    fs.writeFileSync(lockPath, 'stale-holder\n');
    const oldTime = (Date.now() - 60_000) / 1000; // 60s ago, in seconds
    fs.utimesSync(lockPath, oldTime, oldTime);

    // Spawn two child processes that BOTH attempt acquisition simultaneously.
    // Each prints ACQUIRED:<fd> or CONTENDED. Exactly one must acquire.
    const childSrc = `
      'use strict';
      const { createLoader } = require(${JSON.stringify(LOADER_PATH)});
      const loader = createLoader({ requireConsent: false, audit: () => {}, consentFile: ${JSON.stringify(consentPath)} });
      const acquire = loader._internals._acquireConsentLock;
      // Tiny busy-spin to widen the overlap window between the two children.
      const target = Date.now() + 40;
      while (Date.now() < target) { /* align start */ }
      try {
        const fd = acquire(${JSON.stringify(consentPath)});
        process.stdout.write('ACQUIRED:' + fd + '\\n');
        // Hold briefly so the sibling cannot acquire after we release.
        const hold = Date.now() + 200;
        while (Date.now() < hold) { /* hold lock */ }
      } catch (e) {
        process.stdout.write('CONTENDED:' + String(e && e.message || e).slice(0, 60) + '\\n');
      }
    `;

    const spawnOne = () => spawnSync(process.execPath, ['-e', childSrc], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    // Launch both as fast as possible. spawnSync is blocking, so to get true
    // concurrency we run them via two `spawn`-style detached invocations using
    // a single shell. Simpler+reliable: write a tiny runner that forks both.
    const runnerSrc = `
      'use strict';
      const { spawn } = require('child_process');
      const childSrc = ${JSON.stringify(childSrc)};
      const opts = { encoding: 'utf8' };
      let done = 0; const out = [];
      function go(tag) {
        const p = spawn(process.execPath, ['-e', childSrc], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        p.stdout.on('data', d => { buf += d; });
        p.on('close', () => { out.push(buf.trim()); if (++done === 2) { process.stdout.write(JSON.stringify(out)); } });
      }
      go('A'); go('B');
    `;
    const res = spawnSync(process.execPath, ['-e', runnerSrc], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(res.status, 0,
      `runner exited non-zero: status=${res.status} stderr=${res.stderr}`);

    let results;
    try { results = JSON.parse(res.stdout.trim()); }
    catch (e) {
      assert.fail(`could not parse runner output: ${JSON.stringify(res.stdout)} (${e.message})`);
    }

    const acquired = results.filter(r => r.startsWith('ACQUIRED:'));
    const contended = results.filter(r => r.startsWith('CONTENDED:'));

    assert.equal(
      acquired.length, 1,
      `EXACTLY ONE recoverer must acquire the lock; got ${acquired.length} ` +
      `acquirers. Full results: ${JSON.stringify(results)}`
    );
    assert.equal(
      contended.length, 1,
      `the loser must report contention (fail-closed); got ${contended.length}. ` +
      `Full results: ${JSON.stringify(results)}`
    );
    // Contract: the documented contention message is preserved.
    assert.ok(
      /lock contention/.test(contended[0]),
      `contention error must preserve the documented message; got "${contended[0]}"`
    );
  });

  test('a FRESH (non-stale) lock is never reclaimed → caller fails closed', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lock-fresh-'));
    const consentPath = path.join(dir, 'plugin-consents.json');
    const lockPath    = consentPath + '.lock';

    // A live holder's fresh lock (current mtime).
    const heldFd = fs.openSync(lockPath, 'wx');
    try {
      const loader = createLoader({
        requireConsent: false, audit: () => {}, consentFile: consentPath,
      });
      assert.throws(
        () => loader._internals._acquireConsentLock(consentPath),
        /lock contention/,
        'acquiring against a FRESH lock must fail closed (never steal a live lock)'
      );
      // The original holder's lock file is still present and untouched.
      assert.equal(fs.existsSync(lockPath), true,
        'fresh lock must not be deleted by a failed acquirer');
    } finally {
      fs.closeSync(heldFd);
    }
  });
});
