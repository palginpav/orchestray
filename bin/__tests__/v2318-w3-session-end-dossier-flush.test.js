#!/usr/bin/env node
'use strict';

/**
 * v2318-w3-session-end-dossier-flush.test.js — SessionEnd dossier flush (v2.3.18 W3, new).
 *
 * `SessionEnd` is a documented, previously-unused hook event
 * (2026-07-platform-capability-gaps.md §4) firing on session termination
 * with a `reason` field. `Stop`/`SubagentStop`/`PreCompact` already flush
 * the resilience dossier but none of them fire on `/clear` or logout the
 * same way SessionEnd does. This hook is a thin trigger over the existing
 * `writeDossierSnapshot()` — no reimplementation.
 *
 * Runner: node --test bin/__tests__/v2318-w3-session-end-dossier-flush.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'flush-dossier-on-session-end.js');
const NODE      = process.execPath;

function readEvents(root) {
  try {
    return fs.readFileSync(path.join(root, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-sessend-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'state', 'orchestration.md'),
    '---\nid: orch-sessend-test\ncurrent_phase: execute\nstatus: in_progress\n---\n',
    'utf8',
  );
  return dir;
}

function runHookSync(payload, cwd) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('SessionEnd dossier flush', () => {
  let dir;
  beforeEach(() => { dir = makeFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('writes resilience-dossier.json and dossier_written event with trigger session_end:<reason>', () => {
    const payload = { hook_event_name: 'SessionEnd', reason: 'clear', cwd: dir };
    const { stdout, stderr, status } = runHookSync(payload, dir);
    assert.equal(status, 0, `hook always exits 0; stderr=${stderr}`);
    assert.deepEqual(JSON.parse(stdout), { continue: true });

    const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
    assert.ok(fs.existsSync(dossierPath), 'resilience-dossier.json must be written');
    const dossier = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
    assert.equal(dossier.orchestration_id, 'orch-sessend-test');

    const events = readEvents(dir).filter(e => e.type === 'dossier_written');
    assert.equal(events.length, 1, 'exactly 1 dossier_written event');
    assert.equal(events[0].trigger, 'session_end:clear');
  });

  test('unrecognized reason value falls back to "other"', () => {
    const payload = { hook_event_name: 'SessionEnd', reason: 'not_a_real_reason', cwd: dir };
    runHookSync(payload, dir);
    const events = readEvents(dir).filter(e => e.type === 'dossier_written');
    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, 'session_end:other');
  });

  test('kill switch ORCHESTRAY_SESSION_END_DOSSIER_DISABLED=1 skips the flush entirely', () => {
    const payload = { hook_event_name: 'SessionEnd', reason: 'logout', cwd: dir };
    const r = cp.spawnSync(NODE, [HOOK_PATH], {
      input: JSON.stringify(payload),
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { ORCHESTRAY_SESSION_END_DOSSIER_DISABLED: '1' }),
    });
    assert.equal(r.status, 0);
    const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
    assert.ok(!fs.existsSync(dossierPath), 'kill switch must prevent the dossier write');
  });

  test('no active orchestration → no-op, still exits 0', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-sessend-empty-'));
    fs.mkdirSync(path.join(emptyDir, '.orchestray', 'audit'), { recursive: true });
    try {
      const payload = { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', cwd: emptyDir };
      const { stdout, status } = runHookSync(payload, emptyDir);
      assert.equal(status, 0);
      assert.deepEqual(JSON.parse(stdout), { continue: true });
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
