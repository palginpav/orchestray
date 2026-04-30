#!/usr/bin/env node
'use strict';

/**
 * v2218-w3-master-auto-commit.test.js
 *
 * Integration tests for W3: auto-commit-master-on-pm-stop.js
 *
 * Test strategy:
 *   - Spin up a real git repo in a tmpdir per test.
 *   - Write .orchestray/state/orchestration.md with controlled frontmatter.
 *   - Invoke the hook script via spawnSync (piping stdin JSON).
 *   - Assert git log, exit codes, and events.jsonl content.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/v2218-w3-master-auto-commit.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const path          = require('node:path');
const os            = require('node:os');
const { execSync, spawnSync } = require('node:child_process');

// Path to hook under test.
const HOOK = path.resolve(__dirname, '..', 'auto-commit-master-on-pm-stop.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated git repo in a temp directory.
 * Returns the repo root path.
 * @returns {string}
 */
function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.local"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  // Gitignore .orchestray/ so state files don't count as dirty working tree
  // (mirrors real project layout where .orchestray/ is in .gitignore).
  fs.writeFileSync(path.join(dir, '.gitignore'), '.orchestray/\n');
  // Initial commit so HEAD exists.
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore', shell: true });
  return dir;
}

/**
 * Write .orchestray/state/orchestration.md with given frontmatter values.
 * @param {string} dir
 * @param {{ status?: string, orchestration_id?: string, current_phase?: string }} opts
 */
function writeOrchestrationMd(dir, opts = {}) {
  const status          = opts.status          || 'active';
  const orchestrationId = opts.orchestration_id || 'orch-test-001';
  const currentPhase    = opts.current_phase   || 'execute';
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'orchestration.md'),
    [
      '---',
      'orchestration_id: ' + orchestrationId,
      'status: ' + status,
      'current_phase: ' + currentPhase,
      '---',
      '',
      '# Test orchestration',
    ].join('\n')
  );
}

/**
 * Invoke the hook with a synthetic Stop event JSON.
 * @param {string} dir - Project root (cwd in event payload).
 * @param {object} [envOverrides] - Extra env vars to set.
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function invokeHook(dir, envOverrides = {}) {
  const event = JSON.stringify({ cwd: dir });
  const env = Object.assign({}, process.env, envOverrides);
  const result = spawnSync(process.execPath, [HOOK], {
    input: event,
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Read the HEAD commit message body from a git repo.
 * @param {string} dir
 * @returns {string}
 */
function headCommitBody(dir) {
  return execSync('git log -1 --format=%B HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/**
 * Read events.jsonl from .orchestray/audit/ and return parsed lines.
 * @param {string} dir
 * @returns {object[]}
 */
function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  try {
    return fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

/**
 * Make the working tree dirty by writing an untracked file.
 * @param {string} dir
 * @param {string} [filename]
 */
function makeDirty(dir, filename = 'dirty.txt') {
  fs.writeFileSync(path.join(dir, filename), 'dirty content\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W3: auto-commit-master-on-pm-stop', () => {
  let dir;

  beforeEach(() => {
    dir = mkGitRepo();
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  // -------------------------------------------------------------------------
  // Test 1: active orch + dirty master → commit appears
  // -------------------------------------------------------------------------
  test('active orch + dirty master tree → commit created with correct subject and trailer', () => {
    writeOrchestrationMd(dir, { status: 'active', orchestration_id: 'orch-test-001', current_phase: 'execute' });
    makeDirty(dir);

    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0');

    const body = headCommitBody(dir);
    assert.match(body, /^wip\(orch orch-test-001 stop /, 'commit subject must start with wip(orch orch-test-001 stop');
    assert.ok(body.includes('Generated-By: orchestray-auto-commit-master'), 'commit body must contain Generated-By trailer');
    assert.ok(body.includes('Phase: execute'), 'commit body must contain Phase');
    assert.ok(body.includes('Files: 1 changed'), 'commit body must contain Files count');

    // Success event should be emitted.
    const events = readEvents(dir);
    const successEvent = events.find(e => e.type === 'master_auto_commit_emitted');
    assert.ok(successEvent, 'master_auto_commit_emitted event must be emitted');
    assert.equal(successEvent.orchestration_id, 'orch-test-001', 'event must carry orchestration_id');
    assert.equal(successEvent.current_phase, 'execute', 'event must carry current_phase');
    assert.equal(successEvent.files_changed_count, 1, 'event must carry files_changed_count');
    assert.equal(typeof successEvent.commit_sha, 'string', 'event must carry commit_sha string');
  });

  // -------------------------------------------------------------------------
  // Test 2: active orch + clean master → no commit, no event
  // -------------------------------------------------------------------------
  test('active orch + clean master tree → no commit, no event emitted', () => {
    writeOrchestrationMd(dir, { status: 'active' });

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0');
    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change on clean tree');

    const events = readEvents(dir);
    assert.equal(
      events.filter(e => e.type === 'master_auto_commit_emitted').length, 0,
      'no success event on clean tree'
    );
    assert.equal(
      events.filter(e => e.type === 'master_auto_commit_failed').length, 0,
      'no failure event on clean tree'
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: no active orchestration + dirty master → no commit
  // -------------------------------------------------------------------------
  test('no active orch (status=complete) + dirty master → no commit', () => {
    writeOrchestrationMd(dir, { status: 'complete' });
    makeDirty(dir);

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0');
    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change when orch is not active');

    const events = readEvents(dir);
    assert.equal(
      events.filter(e => e.type === 'master_auto_commit_emitted').length, 0,
      'no success event when orch not active'
    );
  });

  // -------------------------------------------------------------------------
  // Test 3b: orchestration.md missing + dirty master → no commit
  // -------------------------------------------------------------------------
  test('orchestration.md absent + dirty master → no commit', () => {
    makeDirty(dir);

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0');
    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change when orchestration.md absent');
  });

  // -------------------------------------------------------------------------
  // Test 4: mid-rebase guard → exit 0 with stderr notice, no commit
  // -------------------------------------------------------------------------
  test('mid-rebase guard: REBASE_HEAD present → exit 0 with notice, no commit', () => {
    writeOrchestrationMd(dir, { status: 'active' });
    makeDirty(dir);

    // Touch .git/REBASE_HEAD to simulate an in-progress rebase.
    fs.writeFileSync(path.join(dir, '.git', 'REBASE_HEAD'), 'abc1234\n');

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0 during rebase');
    assert.ok(r.stderr.includes('skipping during git operation'), 'must log skip notice');
    assert.ok(r.stderr.includes('REBASE_HEAD'), 'must mention REBASE_HEAD');

    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change during rebase');

    const events = readEvents(dir);
    assert.equal(
      events.filter(e => e.type === 'master_auto_commit_emitted').length, 0,
      'no success event during rebase'
    );
    assert.equal(
      events.filter(e => e.type === 'master_auto_commit_failed').length, 0,
      'no failure event during rebase (expected control flow)'
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: kill switch env var → exit 0, no commit
  // -------------------------------------------------------------------------
  test('ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED=1 → exit 0, no commit', () => {
    writeOrchestrationMd(dir, { status: 'active' });
    makeDirty(dir);

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir, { ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED: '1' });

    assert.equal(r.status, 0, 'hook must exit 0 with kill switch');
    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change with kill switch');

    const events = readEvents(dir);
    assert.equal(
      events.filter(e => e.type === 'master_auto_commit_emitted').length, 0,
      'no event emitted with kill switch'
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: config kill switch → exit 0, no commit
  // -------------------------------------------------------------------------
  test('master_auto_commit.enabled=false in config → exit 0, no commit', () => {
    writeOrchestrationMd(dir, { status: 'active' });
    makeDirty(dir);

    const configDir = path.join(dir, '.orchestray');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ master_auto_commit: { enabled: false } })
    );

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0 with config kill switch');
    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change with config kill switch');
  });

  // -------------------------------------------------------------------------
  // Test 7: MERGE_HEAD guard → exit 0, no commit
  // -------------------------------------------------------------------------
  test('mid-merge guard: MERGE_HEAD present → exit 0, no commit', () => {
    writeOrchestrationMd(dir, { status: 'active' });
    makeDirty(dir);
    fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'abc1234\n');

    const headBefore = headCommitBody(dir);
    const r = invokeHook(dir);

    assert.equal(r.status, 0, 'hook must exit 0 during merge');
    assert.ok(r.stderr.includes('MERGE_HEAD'), 'must mention MERGE_HEAD');
    const headAfter = headCommitBody(dir);
    assert.equal(headAfter, headBefore, 'HEAD must not change during merge');
  });
});
