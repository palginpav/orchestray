#!/usr/bin/env node
'use strict';

/**
 * v2210-teammate-config-gate.test.js — N3.b config-gate tests.
 *
 * Verifies that reassign-idle-teammate.js exits 0 silently (no teammate_idle
 * event) when agent_teams.enabled is false or absent, and runs normally when
 * agent_teams.enabled is true.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'reassign-idle-teammate.js');
const NODE      = process.execPath;

function makeTmpRoot(configOverride) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-teamgate-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  if (configOverride !== undefined) {
    fs.writeFileSync(
      path.join(root, '.orchestray', 'config.json'),
      JSON.stringify(configOverride),
      'utf8'
    );
  }
  return root;
}

function runHook(root) {
  const hookInput = JSON.stringify({ cwd: root, session_id: 'test-session' });
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: hookInput,
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

describe('v2210 N3.b — reassign-idle-teammate config gate', () => {
  test('Test 1: agent_teams.enabled=false → exit 0, no teammate_idle event', () => {
    const root = makeTmpRoot({ agent_teams: { enabled: false } });
    const r = runHook(root);
    assert.equal(r.status, 0, 'exits 0 when agent_teams disabled; stderr=' + r.stderr);

    const events = readEvents(root);
    const idleEvents = events.filter(e => e.type === 'teammate_idle');
    assert.equal(idleEvents.length, 0,
      'no teammate_idle event emitted when agent_teams disabled; got ' + idleEvents.length);
  });

  test('Test 2: agent_teams.enabled=true → exits normally, teammate_idle event emitted', () => {
    const root = makeTmpRoot({ agent_teams: { enabled: true } });
    const r = runHook(root);
    // With no task-graph.md present, exits 0 (no pending tasks) but still emits
    // the teammate_idle event, which is the observable difference from disabled mode.
    assert.equal(r.status, 0, 'exits 0 (no pending tasks); stderr=' + r.stderr);

    const events = readEvents(root);
    const idleEvents = events.filter(e => e.type === 'teammate_idle');
    assert.equal(idleEvents.length, 1,
      'teammate_idle event emitted when agent_teams enabled; got ' + idleEvents.length);
  });

  test('Test 3: missing config file → exit 0, no teammate_idle event', () => {
    const root = makeTmpRoot(); // no config written
    const r = runHook(root);
    assert.equal(r.status, 0, 'exits 0 when no config; stderr=' + r.stderr);

    const events = readEvents(root);
    const idleEvents = events.filter(e => e.type === 'teammate_idle');
    assert.equal(idleEvents.length, 0,
      'no teammate_idle event when config absent; got ' + idleEvents.length);
  });
});
