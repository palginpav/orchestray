#!/usr/bin/env node
'use strict';

/**
 * v2210-sentinel-dedup.test.js — N3.a per-session dedup tests.
 *
 * Verifies that sentinel-probe.js (session mode) emits at most one
 * sentinel_probe_session event per session ID, and that
 * ORCHESTRAY_SENTINEL_DEDUP_DISABLED=1 disables the dedup behaviour.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'sentinel-probe.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE       = process.execPath;

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-dedup-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{}', 'utf8');
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

function runProbe(root, envOverrides) {
  const env = Object.assign({}, process.env, envOverrides || {}, {
    ORCHESTRAY_PROJECT_ROOT: root,
  });
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    env,
    encoding: 'utf8',
    timeout: 10000,
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

describe('v2210 N3.a — sentinel-probe per-session dedup', () => {
  test('Test 1: two invocations with same session ID → exactly 1 sentinel_probe_session row', () => {
    const root = makeTmpRoot();
    const sessionId = 'test-session-' + Date.now();

    const r1 = runProbe(root, { CLAUDE_SESSION_ID: sessionId });
    assert.equal(r1.status, 0, 'first invocation exits 0; stderr=' + r1.stderr);

    const r2 = runProbe(root, { CLAUDE_SESSION_ID: sessionId });
    assert.equal(r2.status, 0, 'second invocation exits 0 (dedup); stderr=' + r2.stderr);

    const events = readEvents(root);
    const sessionEvents = events.filter(e => e.type === 'sentinel_probe_session');
    assert.equal(sessionEvents.length, 1,
      'exactly 1 sentinel_probe_session event; got ' + sessionEvents.length);
  });

  test('Test 2: two invocations with different session IDs → 2 sentinel_probe_session rows', () => {
    const root = makeTmpRoot();
    const ts = Date.now();

    const r1 = runProbe(root, { CLAUDE_SESSION_ID: 'session-A-' + ts });
    assert.equal(r1.status, 0, 'first invocation exits 0; stderr=' + r1.stderr);

    const r2 = runProbe(root, { CLAUDE_SESSION_ID: 'session-B-' + ts });
    assert.equal(r2.status, 0, 'second invocation exits 0; stderr=' + r2.stderr);

    const events = readEvents(root);
    const sessionEvents = events.filter(e => e.type === 'sentinel_probe_session');
    assert.equal(sessionEvents.length, 2,
      'exactly 2 sentinel_probe_session events (different sessions); got ' + sessionEvents.length);
  });

  test('Test 3: ORCHESTRAY_SENTINEL_DEDUP_DISABLED=1 → no dedup (2 rows for same session)', () => {
    const root = makeTmpRoot();
    const sessionId = 'test-session-nodedup-' + Date.now();

    const r1 = runProbe(root, {
      CLAUDE_SESSION_ID: sessionId,
      ORCHESTRAY_SENTINEL_DEDUP_DISABLED: '1',
    });
    assert.equal(r1.status, 0, 'first invocation exits 0; stderr=' + r1.stderr);

    const r2 = runProbe(root, {
      CLAUDE_SESSION_ID: sessionId,
      ORCHESTRAY_SENTINEL_DEDUP_DISABLED: '1',
    });
    assert.equal(r2.status, 0, 'second invocation exits 0; stderr=' + r2.stderr);

    const events = readEvents(root);
    const sessionEvents = events.filter(e => e.type === 'sentinel_probe_session');
    assert.equal(sessionEvents.length, 2,
      'dedup disabled: 2 sentinel_probe_session events expected; got ' + sessionEvents.length);
  });
});
