#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/audit-backup-sweep.js — retention sweep for
 * `.orchestray/audit/events.jsonl.bak-*` leftovers (v2.3.23).
 *
 * Runner: node --test bin/_lib/__tests__/audit-backup-sweep.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  sweepAuditBackups,
  isSweepDisabled,
  loadRetainCount,
  ENV_DISABLED,
  DEFAULT_RETAIN_COUNT,
} = require('../audit-backup-sweep');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-backup-sweep-test-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
});

afterEach(() => {
  delete process.env[ENV_DISABLED];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function auditDir() {
  return path.join(tmpDir, '.orchestray', 'audit');
}

function touch(name) {
  fs.writeFileSync(path.join(auditDir(), name), 'x');
}

function listAuditDir() {
  return fs.readdirSync(auditDir()).sort();
}

function writeConfig(cfg) {
  fs.writeFileSync(path.join(tmpDir, '.orchestray', 'config.json'), JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------

describe('sweepAuditBackups', () => {
  test('no audit dir — no-op, ran:true, no error', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-backup-sweep-noaudit-'));
    const result = sweepAuditBackups(emptyRoot);
    assert.equal(result.ran, true);
    assert.equal(result.disabled, false);
    assert.deepEqual(result.removed, []);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });

  test('fewer backups than retain_count — nothing removed', () => {
    touch('events.jsonl.bak-100');
    touch('events.jsonl.bak-200');
    const result = sweepAuditBackups(tmpDir);
    assert.equal(result.ran, true);
    assert.deepEqual(result.removed, []);
    assert.equal(result.retained.length, 2);
    assert.deepEqual(listAuditDir(), ['events.jsonl.bak-100', 'events.jsonl.bak-200']);
  });

  test('more backups than default retain_count (3) — oldest removed, newest kept', () => {
    for (const ms of [100, 200, 300, 400, 500]) touch('events.jsonl.bak-' + ms);
    const result = sweepAuditBackups(tmpDir);

    assert.deepEqual(result.retained.sort(), ['events.jsonl.bak-300', 'events.jsonl.bak-400', 'events.jsonl.bak-500'].sort());
    assert.deepEqual(result.removed.sort(), ['events.jsonl.bak-100', 'events.jsonl.bak-200'].sort());
    assert.deepEqual(listAuditDir(), ['events.jsonl.bak-300', 'events.jsonl.bak-400', 'events.jsonl.bak-500']);
  });

  test('unrelated audit-dir files are never touched', () => {
    touch('events.jsonl');
    touch('events.jsonl.1');
    touch('events.jsonl.pre-v222-reset-2026-04-28');
    touch('current-orchestration.json');
    for (const ms of [100, 200, 300, 400]) touch('events.jsonl.bak-' + ms);

    sweepAuditBackups(tmpDir);

    const remaining = listAuditDir();
    assert.ok(remaining.includes('events.jsonl'), 'live log untouched');
    assert.ok(remaining.includes('events.jsonl.1'), 'rotation generation untouched');
    assert.ok(remaining.includes('events.jsonl.pre-v222-reset-2026-04-28'), 'migration snapshot untouched');
    assert.ok(remaining.includes('current-orchestration.json'), 'unrelated file untouched');
    // Only 3 of the 4 .bak- files survive (retain_count default 3).
    const bakSurvivors = remaining.filter((f) => f.startsWith('events.jsonl.bak-'));
    assert.equal(bakSurvivors.length, 3);
  });

  test('custom retain_count from config is honoured', () => {
    writeConfig({ audit: { backup_sweep: { retain_count: 1 } } });
    for (const ms of [100, 200, 300]) touch('events.jsonl.bak-' + ms);

    const result = sweepAuditBackups(tmpDir);
    assert.deepEqual(result.retained, ['events.jsonl.bak-300']);
    assert.equal(result.removed.length, 2);
  });

  test('retain_count: 0 removes everything', () => {
    writeConfig({ audit: { backup_sweep: { retain_count: 0 } } });
    touch('events.jsonl.bak-100');
    touch('events.jsonl.bak-200');

    const result = sweepAuditBackups(tmpDir);
    assert.deepEqual(result.retained, []);
    assert.equal(result.removed.length, 2);
    assert.deepEqual(listAuditDir(), []);
  });

  test('dryRun: true reports what would be removed without deleting', () => {
    for (const ms of [100, 200, 300, 400]) touch('events.jsonl.bak-' + ms);
    const result = sweepAuditBackups(tmpDir, { dryRun: true });
    assert.equal(result.removed.length, 1);
    assert.deepEqual(listAuditDir(), ['events.jsonl.bak-100', 'events.jsonl.bak-200', 'events.jsonl.bak-300', 'events.jsonl.bak-400']);
  });

  test('malformed config.json fails open to the default retain count', () => {
    fs.writeFileSync(path.join(tmpDir, '.orchestray', 'config.json'), '{not json');
    for (const ms of [100, 200, 300, 400]) touch('events.jsonl.bak-' + ms);
    const result = sweepAuditBackups(tmpDir);
    assert.equal(result.removed.length, 4 - DEFAULT_RETAIN_COUNT);
  });
});

// ---------------------------------------------------------------------------

describe('kill switches', () => {
  test('env kill switch disables the sweep entirely', () => {
    process.env[ENV_DISABLED] = '1';
    for (const ms of [100, 200, 300, 400]) touch('events.jsonl.bak-' + ms);

    const result = sweepAuditBackups(tmpDir);
    assert.equal(result.disabled, true);
    assert.equal(result.removed.length, 0);
    assert.equal(listAuditDir().length, 4);
    assert.equal(isSweepDisabled(tmpDir), true);
  });

  test('config kill switch disables the sweep entirely', () => {
    writeConfig({ audit: { backup_sweep: { enabled: false } } });
    for (const ms of [100, 200, 300, 400]) touch('events.jsonl.bak-' + ms);

    const result = sweepAuditBackups(tmpDir);
    assert.equal(result.disabled, true);
    assert.equal(result.removed.length, 0);
    assert.equal(isSweepDisabled(tmpDir), true);
  });

  test('default-on: no config, no env — sweep runs', () => {
    assert.equal(isSweepDisabled(tmpDir), false);
    assert.equal(loadRetainCount(tmpDir), DEFAULT_RETAIN_COUNT);
  });

  test('sweepAuditBackups never throws even on a hostile config shape', () => {
    writeConfig({ audit: 'not-an-object' });
    touch('events.jsonl.bak-100');
    assert.doesNotThrow(() => sweepAuditBackups(tmpDir));
  });
});
