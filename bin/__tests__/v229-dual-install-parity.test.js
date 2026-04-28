#!/usr/bin/env node
'use strict';

/**
 * v229-dual-install-parity.test.js — v2.2.9 B-6.1 dual-install parity gate.
 *
 * Covers:
 *   1. Synthetic two-tree fixture with one orphan in `.claude/orchestray/bin/`
 *      → exit 2, 1 `dual_install_divergence_detected(orphan)` event.
 *   2. Synthetic two-tree fixture with same files but different content
 *      → exit 2, 1 `dual_install_divergence_detected(content_mismatch)` event.
 *   3. Single-tree (no `.claude/orchestray/bin/`) → exit 0, no events.
 *   4. Identical two-tree → exit 0, no events.
 *   5. Kill switch verification:
 *      a. `ORCHESTRAY_DUAL_INSTALL_CHECK_DISABLED=1` for non-release
 *         SubagentStop → bypass even with divergences.
 *      b. Same env var for release-manager SubagentStop → does NOT bypass
 *         (releases must always parity-check).
 *
 * Tests invoke the script as a child process to exercise the real exit-code
 * + stdout + emit pipeline.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT    = path.join(REPO_ROOT, 'bin', 'release-manager', 'dual-install-parity-check.js');

// ---------------------------------------------------------------------------
// Test-tree builder
// ---------------------------------------------------------------------------

function makeRepo({ withTarget = true, sourceFiles = {}, targetFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-parity-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });

  for (const [rel, content] of Object.entries(sourceFiles)) {
    const full = path.join(dir, 'bin', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  if (withTarget) {
    const targetRoot = path.join(dir, '.claude', 'orchestray', 'bin');
    fs.mkdirSync(targetRoot, { recursive: true });
    for (const [rel, content] of Object.entries(targetFiles)) {
      const full = path.join(targetRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_e) { return null; } })
    .filter(Boolean);
}

function runHook(dir, hookPayload, env = {}) {
  // SubagentStop hook invocation: payload on stdin.
  const proc = spawnSync('node', [SCRIPT], {
    cwd: dir,
    input: hookPayload ? JSON.stringify(hookPayload) : '',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function runManual(dir, env = {}) {
  // Manual invocation (no stdin) — used for `bin/install.js` pre-publish or
  // ad-hoc CLI run. Pass an empty stdin (TTY=false) so the script reads it
  // as "no payload".
  const proc = spawnSync('node', [SCRIPT], {
    cwd: dir,
    input: '',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

// ---------------------------------------------------------------------------
// Direct unit tests on `checkParity`
// ---------------------------------------------------------------------------

describe('v2.2.9 B-6.1 — checkParity unit semantics', () => {
  const { checkParity } = require(SCRIPT);

  test('absent install tree → skipped(no_install_tree)', () => {
    const dir = makeRepo({ withTarget: false, sourceFiles: { 'foo.js': 'a' } });
    const r = checkParity(dir);
    assert.equal(r.skipped, true);
    assert.equal(r.skip_reason, 'no_install_tree');
    assert.deepEqual(r.divergences, []);
  });

  test('identical two-tree → no divergences', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'hello', 'sub/bar.js': 'world' },
      targetFiles: { 'foo.js': 'hello', 'sub/bar.js': 'world' },
    });
    const r = checkParity(dir);
    assert.equal(r.skipped, false);
    assert.deepEqual(r.divergences, []);
  });

  test('orphan in target → 1 divergence(orphan)', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a', 'orphan.js': 'b' },
    });
    const r = checkParity(dir);
    assert.equal(r.divergences.length, 1);
    assert.equal(r.divergences[0].file_path, 'orphan.js');
    assert.equal(r.divergences[0].divergence_type, 'orphan');
    assert.equal(r.divergences[0].source_hash, null);
    assert.match(r.divergences[0].target_hash, /^[0-9a-f]{64}$/);
  });

  test('content mismatch → 1 divergence(content_mismatch)', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'old' },
      targetFiles: { 'foo.js': 'new' },
    });
    const r = checkParity(dir);
    assert.equal(r.divergences.length, 1);
    assert.equal(r.divergences[0].file_path, 'foo.js');
    assert.equal(r.divergences[0].divergence_type, 'content_mismatch');
    assert.match(r.divergences[0].source_hash, /^[0-9a-f]{64}$/);
    assert.match(r.divergences[0].target_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(r.divergences[0].source_hash, r.divergences[0].target_hash);
  });

  test('source-only file (not in target) → NOT a divergence', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a', 'install.js': 'installer' },
      targetFiles: { 'foo.js': 'a' }, // installer not yet shipped — fine.
    });
    const r = checkParity(dir);
    assert.deepEqual(r.divergences, []);
  });
});

// ---------------------------------------------------------------------------
// End-to-end CLI / hook tests
// ---------------------------------------------------------------------------

describe('v2.2.9 B-6.1 — CLI exit codes + event emission', () => {

  test('case 1: orphan in target → exit 2, 1 orphan event (release ctx)', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a', 'orphan.js': 'b' },
    });
    const r = runHook(dir, { hook_event_name: 'SubagentStop', subagent_type: 'release-manager' });
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}; stderr=${r.stderr}`);
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 1);
    assert.equal(events[0].divergence_type, 'orphan');
    assert.equal(events[0].file_path, 'orphan.js');
  });

  test('case 2: content mismatch → exit 2, 1 content_mismatch event (release ctx)', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'old' },
      targetFiles: { 'foo.js': 'new' },
    });
    const r = runHook(dir, { hook_event_name: 'SubagentStop', subagent_type: 'release-manager' });
    assert.equal(r.code, 2);
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 1);
    assert.equal(events[0].divergence_type, 'content_mismatch');
    assert.equal(events[0].file_path, 'foo.js');
  });

  test('case 3: single-tree (no install) → exit 0, no events (release ctx)', () => {
    const dir = makeRepo({ withTarget: false, sourceFiles: { 'foo.js': 'a' } });
    const r = runHook(dir, { hook_event_name: 'SubagentStop', subagent_type: 'release-manager' });
    assert.equal(r.code, 0);
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 0);
  });

  test('case 4: identical two-tree → exit 0, no events (release ctx)', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a', 'sub/bar.js': 'b' },
      targetFiles: { 'foo.js': 'a', 'sub/bar.js': 'b' },
    });
    const r = runHook(dir, { hook_event_name: 'SubagentStop', subagent_type: 'release-manager' });
    assert.equal(r.code, 0);
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 0);
  });

  test('case 5a: kill switch on NON-release SubagentStop → bypass', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a', 'orphan.js': 'b' },
    });
    const r = runHook(
      dir,
      { hook_event_name: 'SubagentStop', subagent_type: 'developer' },
      { ORCHESTRAY_DUAL_INSTALL_CHECK_DISABLED: '1' }
    );
    assert.equal(r.code, 0, `kill switch should bypass; stderr=${r.stderr}`);
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 0, 'kill switch should suppress emission too');
  });

  test('case 5b: kill switch on RELEASE-manager SubagentStop → still blocks', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a', 'orphan.js': 'b' },
    });
    const r = runHook(
      dir,
      { hook_event_name: 'SubagentStop', subagent_type: 'release-manager' },
      { ORCHESTRAY_DUAL_INSTALL_CHECK_DISABLED: '1' }
    );
    assert.equal(r.code, 2, 'release context must NOT honor the kill switch');
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 1);
  });

  test('non-release SubagentStop without kill switch → silent pass-through', () => {
    // Hook is wired generically but only enforces in release context.
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a', 'orphan.js': 'b' },
    });
    const r = runHook(dir, { hook_event_name: 'SubagentStop', subagent_type: 'developer' });
    assert.equal(r.code, 0, 'non-release contexts pass through silently');
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 0);
  });

  test('manual CLI invocation (no payload) with divergence → exit 2', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a', 'orphan.js': 'b' },
    });
    const r = runManual(dir);
    assert.equal(r.code, 2);
  });

  test('manual CLI invocation (no payload) clean tree → exit 0 with "ok"', () => {
    const dir = makeRepo({
      sourceFiles: { 'foo.js': 'a' },
      targetFiles: { 'foo.js': 'a' },
    });
    const r = runManual(dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ok/);
  });

  test('multiple divergences → multiple events, sorted deterministically', () => {
    const dir = makeRepo({
      sourceFiles: { 'a.js': 'alpha', 'b.js': 'beta' },
      targetFiles: { 'a.js': 'ALPHA', 'b.js': 'beta', 'orphan-z.js': 'z', 'orphan-a.js': 'a' },
    });
    const r = runHook(dir, { hook_event_name: 'SubagentStop', subagent_type: 'release-manager' });
    assert.equal(r.code, 2);
    const events = readEvents(dir).filter(e => e.type === 'dual_install_divergence_detected');
    assert.equal(events.length, 3);
    // Sort: content_mismatch < orphan alphabetically; within each group, file_path asc.
    assert.equal(events[0].divergence_type, 'content_mismatch');
    assert.equal(events[0].file_path, 'a.js');
    assert.equal(events[1].divergence_type, 'orphan');
    assert.equal(events[1].file_path, 'orphan-a.js');
    assert.equal(events[2].divergence_type, 'orphan');
    assert.equal(events[2].file_path, 'orphan-z.js');
  });
});
