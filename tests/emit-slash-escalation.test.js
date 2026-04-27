#!/usr/bin/env node
'use strict';

/**
 * tests/emit-slash-escalation.test.js — Integration tests for
 * bin/_lib/emit-slash-escalation.js (F6).
 *
 * Tests: --reason + --lite-score write pm_router_escalated_via_slash event,
 * correct fields, exit 0 always.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/_lib/emit-slash-escalation.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-escalation-test-'));
  cleanup.push(d);
  // emit-slash-escalation.js writes to cwd's .orchestray/audit/events.jsonl
  const auditDir = path.join(d, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  return { dir: d, auditDir };
}

function run({ reason, liteScore, task, cwd }) {
  const args = [SCRIPT];
  if (reason !== undefined) { args.push('--reason'); args.push(reason); }
  if (liteScore !== undefined) { args.push('--lite-score'); args.push(String(liteScore)); }
  if (task !== undefined) { args.push('--task'); args.push(task); }

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 10000,
    cwd: cwd || os.tmpdir(),
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

describe('emit-slash-escalation', () => {
  test('writes pm_router_escalated_via_slash event with correct fields', () => {
    const { dir, auditDir } = makeTmpDir();
    const { status } = run({
      reason: 'keyword_denylist_hit',
      liteScore: 3,
      task: 'audit the auth module',
      cwd: dir,
    });
    assert.equal(status, 0, 'must exit 0');
    const events = readEvents(auditDir);
    const ev = events.find(e => e.type === 'pm_router_escalated_via_slash');
    assert.ok(ev, 'must write pm_router_escalated_via_slash event');
    assert.equal(ev.reason, 'keyword_denylist_hit');
    assert.equal(ev.lite_score, 3);
    assert.ok(ev.task_summary.length > 0, 'task_summary must be non-empty');
  });

  test('lite_score defaults to 0 when not provided', () => {
    const { dir, auditDir } = makeTmpDir();
    run({ reason: 'router_disabled', cwd: dir });
    const events = readEvents(auditDir);
    const ev = events.find(e => e.type === 'pm_router_escalated_via_slash');
    assert.ok(ev, 'event must be written');
    assert.equal(ev.lite_score, 0);
  });

  test('reason defaults to unknown when not provided', () => {
    const { dir, auditDir } = makeTmpDir();
    run({ liteScore: 2, cwd: dir });
    const events = readEvents(auditDir);
    const ev = events.find(e => e.type === 'pm_router_escalated_via_slash');
    assert.ok(ev, 'event must be written');
    assert.equal(ev.reason, 'unknown');
  });

  test('routing_path field is router_escalated_via_slash_dispatch', () => {
    const { dir, auditDir } = makeTmpDir();
    run({ reason: 'path_floor_triggered', liteScore: 0, cwd: dir });
    const events = readEvents(auditDir);
    const ev = events.find(e => e.type === 'pm_router_escalated_via_slash');
    assert.ok(ev, 'event must be written');
    assert.equal(ev.routing_path, 'router_escalated_via_slash_dispatch');
  });

  test('task_summary truncated to 80 chars max', () => {
    const { dir, auditDir } = makeTmpDir();
    const longTask = 'x'.repeat(200);
    run({ reason: 'task_too_long', liteScore: 5, task: longTask, cwd: dir });
    const events = readEvents(auditDir);
    const ev = events.find(e => e.type === 'pm_router_escalated_via_slash');
    assert.ok(ev, 'event must be written');
    assert.ok(ev.task_summary.length <= 80, 'task_summary must be <= 80 chars');
  });

  test('exits 0 always (no crash on missing args)', () => {
    const { dir } = makeTmpDir();
    const { status } = run({ cwd: dir });
    assert.equal(status, 0);
  });
});
