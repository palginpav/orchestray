#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-no-deferral.js — v2.1.9 Bundle B1 / I-13b.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-no-deferral.js');
const HOOK = path.resolve(__dirname, '..', 'validate-no-deferral.js');

function setupReleaseOrch(tmp) {
  const stateDir = path.join(tmp, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'orchestration.md'),
    '---\nid: orch-test-release\nphase: release\ntitle: v2.1.9 release\n---\n',
    'utf8'
  );
}

function runHook(payload, cwd) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
  });
  return res;
}

describe('validate-no-deferral — findDeferral', () => {
  test('detects "deferred to" (strict)', () => {
    const r = mod.findDeferral('Everything looks fine. This item is deferred to next release.');
    assert.equal(r.matched, true);
    assert.equal(r.phrase, 'deferred to');
  });

  test('detects "will fix in" (strict)', () => {
    const r = mod.findDeferral('We will fix in v2.2 after the current cycle.');
    assert.equal(r.matched, true);
    assert.equal(r.phrase, 'will fix in');
  });

  test('does not match "for now" without release cue', () => {
    const r = mod.findDeferral('This path works for now and tests pass.');
    assert.equal(r.matched, false);
  });

  test('matches "for now" when adjacent to release cue', () => {
    const r = mod.findDeferral('This will ship for now; revisit at next release.');
    assert.equal(r.matched, true);
    assert.equal(r.phrase, 'for now');
  });

  test('returns no match on clean output', () => {
    const r = mod.findDeferral('All acceptance criteria met. Closing.');
    assert.equal(r.matched, false);
  });
});

describe('validate-no-deferral — isReleasePhase', () => {
  test('detects phase: release in orchestration.md frontmatter', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-rel-'));
    setupReleaseOrch(tmp);
    const r = mod.isReleasePhase(tmp, {});
    assert.equal(r, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns false when no orchestration file exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-none-'));
    const r = mod.isReleasePhase(tmp, {});
    assert.equal(r, false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('payload task_flags triggers release phase', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-flag-'));
    const r = mod.isReleasePhase(tmp, { task_flags: ['release'] });
    assert.equal(r, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('validate-no-deferral — integration', () => {
  test('block path: exit 2 on deferral in release phase', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-block-'));
    setupReleaseOrch(tmp);
    const res = runHook({
      cwd: tmp,
      output: 'We finished most of the work, but the event-schema sweep is deferred to v2.2.',
    }, tmp);
    assert.equal(res.status, 2, 'stderr=' + res.stderr);
    const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const content = fs.readFileSync(auditPath, 'utf8');
    assert.match(content, /no_deferral_block/);
    assert.match(content, /deferred to/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('pass path: exit 0 on clean output in release phase', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-clean-'));
    setupReleaseOrch(tmp);
    const res = runHook({
      cwd: tmp,
      output: 'All acceptance criteria met. CHANGELOG entry added. README updated.',
    }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no-op path: exit 0 on deferral outside release phase', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-norel-'));
    // No orchestration.md — non-release context.
    const res = runHook({
      cwd: tmp,
      output: 'This edge case is deferred to a follow-up ticket.',
    }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('fail-open on malformed JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-bad-'));
    const res = spawnSync('node', [HOOK], {
      input: '{ garbage',
      cwd: tmp,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
