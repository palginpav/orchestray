#!/usr/bin/env node
'use strict';

/**
 * v2318-w3-q3-phase-slice-reason-split.test.js — Q3 reason-code split (v2.3.18 W3).
 *
 * inject-active-phase-slice.js used to emit `phase_slice_fallback` with
 * `reason: "no_active_orchestration"` for two distinct situations (126/126
 * rows, unmeasurable): no orchestration.md on disk (benign — this hook runs
 * on every UserPromptSubmit) vs. orchestration.md present but unparseable
 * (a real PM-protocol-loading degradation). Split into `no_orch_file` /
 * `phase_unparseable`. `unrecognized_phase` (phase parsed but not in
 * PHASE_TO_FILE) is unchanged and covered by a regression check here.
 *
 * Runner: node --test tests/v2318-w3-q3-phase-slice-reason-split.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'inject-active-phase-slice.js');
const NODE      = process.execPath;

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-q3-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  // emitFallbackEvent() dynamically requires `<cwd>/bin/_lib/audit-event-writer.js`
  // (existence-gated) rather than the hook's own bin/_lib — symlink the real
  // bin/ tree in so events actually get written under the tmp cwd. Also
  // symlink agents/ so stageSlice() can find the real phase-slice files (a
  // missing slice file is itself a different fallback reason, not what these
  // tests are about).
  fs.symlinkSync(path.join(REPO_ROOT, 'bin'),    path.join(dir, 'bin'),    'dir');
  fs.symlinkSync(path.join(REPO_ROOT, 'agents'), path.join(dir, 'agents'), 'dir');
  return dir;
}

function readEvents(root) {
  try {
    return fs.readFileSync(path.join(root, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

// The hook reads `process.cwd()` directly (not the stdin payload's `cwd`),
// so the subprocess's own working directory must be the fixture root.
function runHookSync(cwd) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify({}),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, { ORCHESTRAY_DEBUG: '' }),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('v2.3.18 W3 Q3 — phase_slice_fallback reason split', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('no orchestration.md on disk → reason: no_orch_file', () => {
    const r = runHookSync(tmpRoot);
    assert.equal(r.status, 0, 'hook always exits 0; stderr=' + r.stderr);

    const events = readEvents(tmpRoot).filter(e => e.type === 'phase_slice_fallback');
    assert.equal(events.length, 1, 'exactly 1 phase_slice_fallback event');
    assert.equal(events[0].reason, 'no_orch_file');
  });

  test('orchestration.md present but phase unparseable → reason: phase_unparseable', () => {
    fs.writeFileSync(
      path.join(tmpRoot, '.orchestray', 'state', 'orchestration.md'),
      '---\nid: orch-test\nsome_other_key: value\n---\nNo phase key here.\n',
      'utf8',
    );
    const r = runHookSync(tmpRoot);
    assert.equal(r.status, 0, 'hook always exits 0; stderr=' + r.stderr);

    const events = readEvents(tmpRoot).filter(e => e.type === 'phase_slice_fallback');
    assert.equal(events.length, 1, 'exactly 1 phase_slice_fallback event');
    assert.equal(events[0].reason, 'phase_unparseable');
  });

  test('orchestration.md present with a recognized-but-unmapped phase → reason: unrecognized_phase (unchanged)', () => {
    fs.writeFileSync(
      path.join(tmpRoot, '.orchestray', 'state', 'orchestration.md'),
      '---\nid: orch-test\ncurrent_phase: flibbertigibbet\n---\n',
      'utf8',
    );
    const r = runHookSync(tmpRoot);
    assert.equal(r.status, 0, 'hook always exits 0; stderr=' + r.stderr);

    const events = readEvents(tmpRoot).filter(e => e.type === 'phase_slice_fallback');
    assert.equal(events.length, 1, 'exactly 1 phase_slice_fallback event');
    assert.equal(events[0].reason, 'unrecognized_phase');
  });

  test('orchestration.md present with a recognized phase → no fallback event, slice staged', () => {
    fs.writeFileSync(
      path.join(tmpRoot, '.orchestray', 'state', 'orchestration.md'),
      '---\nid: orch-test\ncurrent_phase: execute\n---\n',
      'utf8',
    );
    const r = runHookSync(tmpRoot);
    assert.equal(r.status, 0, 'hook always exits 0; stderr=' + r.stderr);

    const events = readEvents(tmpRoot).filter(e => e.type === 'phase_slice_fallback');
    assert.equal(events.length, 0, 'no fallback event when phase resolves cleanly');
  });
});
