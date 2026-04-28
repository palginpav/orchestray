#!/usr/bin/env node
'use strict';

/**
 * v229-sentinel-bypass.test.js — B-4.2 unit tests.
 *
 * Verifies that every SessionStart through `bin/sentinel-probe.js` produces
 * exactly one of two events — `sentinel_probe_session` (success path) OR
 * `sentinel_probe_bypassed` (kill-switch / config-disabled path) — and never
 * both. The bypass case used to be silently skipped; B-4.2 makes it
 * mechanically observable.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'sentinel-probe.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE      = process.execPath;

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b4-2-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{}', 'utf8');
  // Copy schema for validator path.
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

function runProbe(root, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {}, {
    ORCHESTRAY_PROJECT_ROOT: root,
  });
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    env,
    encoding: 'utf8',
    timeout: 8000,
    cwd: root,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(e => e !== null);
}

describe('v229 B-4.2 — sentinel-probe bypass observability', () => {
  test('SessionStart with kill_switch=1 → exactly one sentinel_probe_bypassed{kill_switch}', () => {
    const root = makeTmpRoot();
    const r = runProbe(root, { env: { ORCHESTRAY_DISABLE_SENTINEL_PROBE: '1' } });
    assert.equal(r.status, 0, 'kill switch path exits 0; stderr=' + r.stderr);

    const events = readEvents(root);
    const bypassed = events.filter(e => e.type === 'sentinel_probe_bypassed');
    const session  = events.filter(e => e.type === 'sentinel_probe_session');

    assert.equal(bypassed.length, 1, 'exactly one bypass event');
    assert.equal(session.length, 0, 'no success event when bypassed');
    assert.equal(bypassed[0].bypass_reason, 'kill_switch');
  });

  test('SessionStart with sentinel_probe.enabled=false in config → exactly one sentinel_probe_bypassed{config_disabled}', () => {
    const root = makeTmpRoot();
    fs.writeFileSync(
      path.join(root, '.orchestray', 'config.json'),
      JSON.stringify({ sentinel_probe: { enabled: false } }),
      'utf8'
    );

    const r = runProbe(root);
    assert.equal(r.status, 0, 'config-disabled path exits 0; stderr=' + r.stderr);

    const events = readEvents(root);
    const bypassed = events.filter(e => e.type === 'sentinel_probe_bypassed');
    const session  = events.filter(e => e.type === 'sentinel_probe_session');

    assert.equal(bypassed.length, 1, 'exactly one bypass event');
    assert.equal(session.length, 0, 'no success event when config-disabled');
    assert.equal(bypassed[0].bypass_reason, 'config_disabled');
  });

  test('SessionStart on healthy install → exactly one sentinel_probe_session, no bypass', () => {
    const root = makeTmpRoot();
    const r = runProbe(root);
    // Probe may exit 0 or 1 depending on which checks pass on the synthetic
    // tmpdir; we only care about the events written.
    assert.ok(r.status === 0 || r.status === 1, 'exits cleanly; stderr=' + r.stderr);

    const events = readEvents(root);
    const bypassed = events.filter(e => e.type === 'sentinel_probe_bypassed');
    const session  = events.filter(e => e.type === 'sentinel_probe_session');

    assert.equal(bypassed.length, 0, 'no bypass event on healthy install');
    assert.equal(session.length, 1, 'exactly one success event');
  });

  test('XOR invariant: every SessionStart produces exactly one of {bypassed, session}', () => {
    // Run all three modes back-to-back into separate roots and assert XOR.
    const cases = [
      { name: 'kill_switch', env: { ORCHESTRAY_DISABLE_SENTINEL_PROBE: '1' } },
      { name: 'healthy',     env: {} },
    ];
    for (const c of cases) {
      const root = makeTmpRoot();
      runProbe(root, { env: c.env });
      const evs = readEvents(root);
      const total = evs.filter(e =>
        e.type === 'sentinel_probe_bypassed' || e.type === 'sentinel_probe_session'
      ).length;
      assert.equal(total, 1, c.name + ' produced ' + total + ' (expected 1)');
    }
  });
});
