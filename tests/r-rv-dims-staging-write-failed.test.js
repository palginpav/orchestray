#!/usr/bin/env node
'use strict';

/**
 * R-RV-DIMS-CAPTURE — `staging_write_failed` event tests
 * (v2.1.17 W11-fix F-W11-07).
 *
 * The context-telemetry staging cache is fail-open by contract: a read-only
 * filesystem or a race condition must never block a spawn. F-W11-07 restores
 * observability by emitting a `staging_write_failed` audit event whenever the
 * silent fail-open kicks in.
 *
 * Cases:
 *   (a) Write to a read-only directory → event emitted with op:"write" and an
 *       error_class matching the underlying errno (EACCES / EROFS / EPERM).
 *   (b) Successful write → no event emitted (negative case).
 *   (c) The cache_path field is populated correctly.
 *   (d) An unwritable audit dir does not propagate the emit failure (the
 *       fail-open contract is idempotent — emission itself cannot fail).
 *
 * Spec source: `.orchestray/kb/artifacts/v2117-w11-preship-audit-r1.md`
 * §F-W11-07.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const CACHE_MOD = path.join(REPO_ROOT, 'bin', '_lib', 'context-telemetry-cache.js');

// Force a fresh require cycle for every test so the lazy `_writeEvent` slot in
// context-telemetry-cache.js is reinitialized — important when tests intermix
// successful and failing cases.
function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)];
  // Also drop the audit-event-writer cache so it picks up the new test cwd.
  const writerPath = path.join(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');
  delete require.cache[require.resolve(writerPath)];
  return require(modPath);
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-staging-fail-test-'));
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// (a) Read-only state dir → event emitted with op:"write"
// ---------------------------------------------------------------------------

describe('staging_write_failed (a) — write fails on read-only dir', () => {
  test('emits staging_write_failed with op:"write" and error_class set', () => {
    const tmpDir = makeTmpDir();
    try {
      // Pre-create the state dir so mkdir succeeds, then strip write permission
      // so the tmp-write inside updateCache fails. We chmod the directory (not
      // the file) because the failure path under test is the
      // `fs.writeFileSync(tmpPath, ...)` inside the advisory-lock body.
      const stateDir = path.join(tmpDir, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      // Audit dir must remain writable so the emit lands; the staging cache
      // dir is what we're locking down.
      const auditDir = path.join(tmpDir, '.orchestray', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });

      // Read+execute only — writes (including tmp-create) must fail with EACCES.
      fs.chmodSync(stateDir, 0o500);

      const { updateCache } = freshRequire(CACHE_MOD);
      // Should not throw — fail-open contract.
      updateCache(tmpDir, (cache) => cache);

      // Restore perms for cleanup.
      fs.chmodSync(stateDir, 0o700);

      const events = readEvents(tmpDir);
      const failEvents = events.filter((e) => e.type === 'staging_write_failed');
      assert.ok(failEvents.length >= 1, 'expected ≥1 staging_write_failed event');

      const evt = failEvents.find((e) => e.op === 'write') || failEvents[0];
      assert.equal(evt.type, 'staging_write_failed');
      assert.equal(evt.version, 1);
      assert.equal(evt.op, 'write', 'op must be "write" for tmp-file write failures');
      // EACCES is the canonical chmod-0o500 errno on Linux; some kernels may
      // report EPERM under containers. Accept either + EROFS (read-only mount).
      assert.ok(
        ['EACCES', 'EPERM', 'EROFS'].includes(evt.error_class),
        'error_class should match the underlying errno; got ' + evt.error_class
      );
      assert.ok(typeof evt.error_message === 'string' && evt.error_message.length > 0);
      assert.ok(evt.error_message.length <= 256, 'error_message must be ≤256 chars');
    } finally {
      // Best-effort restore + cleanup. Some systems require write to remove.
      try { fs.chmodSync(path.join(tmpDir, '.orchestray', 'state'), 0o700); } catch (_e) { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Successful write → no event emitted
// ---------------------------------------------------------------------------

describe('staging_write_failed (b) — no event on successful write', () => {
  test('writable state dir → updateCache writes cleanly, no failure event', () => {
    const tmpDir = makeTmpDir();
    try {
      const { updateCache } = freshRequire(CACHE_MOD);
      updateCache(tmpDir, (cache) => {
        cache.session = cache.session || {};
        cache.session.model = 'test-model';
        return cache;
      });

      // Cache file must exist post-write.
      const cachePath = path.join(tmpDir, '.orchestray', 'state', 'context-telemetry.json');
      assert.ok(fs.existsSync(cachePath), 'cache file should be written on success');

      const events = readEvents(tmpDir);
      const failEvents = events.filter((e) => e.type === 'staging_write_failed');
      assert.equal(failEvents.length, 0, 'no staging_write_failed events on success');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) cache_path field is populated correctly
// ---------------------------------------------------------------------------

describe('staging_write_failed (c) — cache_path field populated', () => {
  test('cache_path matches <cwd>/.orchestray/state/context-telemetry.json', () => {
    const tmpDir = makeTmpDir();
    try {
      const stateDir = path.join(tmpDir, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
      fs.chmodSync(stateDir, 0o500);

      const { updateCache } = freshRequire(CACHE_MOD);
      updateCache(tmpDir, (cache) => cache);

      fs.chmodSync(stateDir, 0o700);

      const events = readEvents(tmpDir);
      const failEvents = events.filter((e) => e.type === 'staging_write_failed');
      assert.ok(failEvents.length >= 1, 'expected ≥1 failure event');

      const expected = path.join(tmpDir, '.orchestray', 'state', 'context-telemetry.json');
      for (const evt of failEvents) {
        assert.equal(evt.cache_path, expected, 'cache_path must point at the canonical staging cache file');
        assert.equal(evt.cwd, tmpDir, 'cwd must equal the project root passed to updateCache');
      }
    } finally {
      try { fs.chmodSync(path.join(tmpDir, '.orchestray', 'state'), 0o700); } catch (_e) { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Emit failure inside the catch block doesn't propagate
// ---------------------------------------------------------------------------

describe('staging_write_failed (d) — emit failure is idempotent fail-open', () => {
  test('updateCache never throws even when the audit pipeline cannot persist', () => {
    const tmpDir = makeTmpDir();
    try {
      // Lock down BOTH the staging dir AND the audit dir's parent — every
      // I/O path the cache module touches will fail. The contract is that
      // updateCache STILL must not throw: the emit itself is fail-open.
      const orchDir = path.join(tmpDir, '.orchestray');
      fs.mkdirSync(orchDir, { recursive: true });
      fs.chmodSync(orchDir, 0o500);

      const { updateCache } = freshRequire(CACHE_MOD);

      // Must not throw, must return undefined (no return value contract).
      let threw = null;
      try {
        updateCache(tmpDir, (cache) => {
          cache.active_subagents = cache.active_subagents || [];
          cache.active_subagents.push({ agent_id: 'a-1' });
          return cache;
        });
      } catch (e) {
        threw = e;
      }
      assert.equal(threw, null, 'updateCache must never propagate I/O failures');

      fs.chmodSync(orchDir, 0o700);
    } finally {
      try { fs.chmodSync(path.join(tmpDir, '.orchestray'), 0o700); } catch (_e) { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
