#!/usr/bin/env node
'use strict';

/**
 * v2.0.22 regression — emitUpgradePendingWarning 4-case state machine.
 *
 * Tests the rewritten upgrade-sweep warning logic introduced in v2.0.22:
 *
 *   Case A: no sentinel           → silent, no warning, no marker
 *   Case B: sentinel < TTL, session postdates install → silent cleanup, no warning
 *   Case C: sentinel < TTL, session predates install  → warning + marker written
 *   Case D (TTL): sentinel age > 7d                  → silent cleanup
 *   Case D (malformed): sentinel lacks installed_at_ms → silent cleanup
 *   Idempotency: Case C fired twice in same session   → second call silent
 *
 * Isolation strategy: ORCHESTRAY_TEST_SENTINEL_PATH is set per test to a
 * unique tmpfile, keeping each test's sentinel completely independent of the
 * real ~/.claude/ sentinel and of other parallel test suites.
 *
 * Session IDs must match /^[0-9a-f-]{1,36}$/i (hex + hyphens, max 36 chars)
 * to pass session-detect.js validation so the transcript lookup succeeds.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'post-upgrade-sweep.js');
const HOME = os.homedir();

// Temp dirs and files created by tests — cleaned up in afterEach.
const dirsToRemove = [];
const filesToRemove = [];

afterEach(() => {
  for (const d of dirsToRemove.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
  for (const f of filesToRemove.splice(0)) {
    try { fs.unlinkSync(f); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated tmpdir representing the fake project (cwd).
 * A minimal .orchestray/state directory is created so resolveSafeCwd
 * doesn't bail and so the sweep can write state files.
 */
function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v2022-sweep-'));
  dirsToRemove.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

/**
 * Create an isolated sentinel file in a tmpdir and return its path.
 * Pass this path as ORCHESTRAY_TEST_SENTINEL_PATH to the subprocess.
 */
function makeSentinelPath() {
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sentinel-'));
  dirsToRemove.push(sentinelDir);
  return path.join(sentinelDir, '.orchestray-upgrade-pending');
}

/**
 * Write a sentinel at the given path.
 */
function writeSentinel(sentinelPath, content) {
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify(content) + '\n', 'utf8');
}

/**
 * Create a fake transcript JSONL file so detectSessionStartMs returns a
 * controlled mtime.
 *
 * Session IDs must match /^[0-9a-f-]{1,36}$/i to pass session-detect.js
 * validation (hex + hyphens, max 36 chars).
 *
 * @param {string} projectDir  Absolute path to the fake project.
 * @param {string} sessionId   Session identifier (hex UUID format).
 * @param {number} mtimeMs     Desired mtime for the transcript file.
 */
function makeTranscript(projectDir, sessionId, mtimeMs) {
  // Encode cwd the same way session-detect.js does:
  //   /home/user/proj  →  -home-user-proj
  const encoded = '-' + projectDir.replace(/^\//, '').replace(/\//g, '-');
  const transcriptDir = path.join(HOME, '.claude', 'projects', encoded);
  fs.mkdirSync(transcriptDir, { recursive: true });
  dirsToRemove.push(transcriptDir);
  const transcriptPath = path.join(transcriptDir, sessionId + '.jsonl');
  fs.writeFileSync(transcriptPath, '{}', 'utf8');
  const mtimeSec = mtimeMs / 1000;
  fs.utimesSync(transcriptPath, mtimeSec, mtimeSec);
}

/** Build the per-session marker path for a given sessionId. */
function markerPath(sessionId) {
  return path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId);
}

/** Build the session lock path for a given sessionId. */
function lockPath(sessionId) {
  return path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock');
}

/**
 * Run post-upgrade-sweep.js with an isolated sentinel path and a
 * UserPromptSubmit payload. Each test uses a unique sessionId so session
 * locks don't cross-contaminate.
 *
 * @param {string} sessionId      Hex session ID (≤36 chars).
 * @param {string} cwd            Absolute project directory.
 * @param {string} sentinelPath   Isolated sentinel file path for this test.
 */
function run(sessionId, cwd, sentinelPath) {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: cwd,
  });
  // Schedule lock and marker cleanup in afterEach.
  filesToRemove.push(lockPath(sessionId));
  filesToRemove.push(markerPath(sessionId));

  const result = spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, {
      ORCHESTRAY_TEST_SENTINEL_PATH: sentinelPath,
    }),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.0.22 emitUpgradePendingWarning state machine', () => {

  // ── Case A: no sentinel → silent, no warning, no marker ──────────────────

  test('Case A: no sentinel — silent return, no warning emitted, no marker written', () => {
    const dir = makeProjectDir();
    // hex + hyphens, ≤36 chars — passes SESSION_ID_RE in session-detect.js
    const sessionId = 'aaaa-bbbb-cccc-dddd-0001';
    const sentinelPath = makeSentinelPath();
    // Sentinel path points to a non-existent file — Case A.

    const { stderr } = run(sessionId, dir, sentinelPath);

    assert.ok(
      !stderr.includes('[orchestray]'),
      'no [orchestray] warning expected in Case A — got: ' + stderr
    );
    assert.ok(
      !fs.existsSync(markerPath(sessionId)),
      'per-session marker must not be created in Case A'
    );
  });

  // ── Case B: sentinel < TTL, session postdates install → silent cleanup ───

  test('Case B: session postdates install — silent cleanup, no warning, sentinel deleted', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0002';
    const sentinelPath = makeSentinelPath();

    // Sentinel installed 1 hour ago.
    const installedAtMs = Date.now() - 60 * 60 * 1000;
    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.0.22',
      previous_version: '2.0.21',
    });

    // Session started AFTER install: sessionStartMs > installedAtMs.
    const sessionStartMs = installedAtMs + 1000;
    makeTranscript(dir, sessionId, sessionStartMs);

    const { stderr } = run(sessionId, dir, sentinelPath);

    assert.ok(
      !stderr.includes('[orchestray]'),
      'no warning expected in Case B — got: ' + stderr
    );
    assert.ok(
      !fs.existsSync(sentinelPath),
      'sentinel must be deleted in Case B (post-install session)'
    );
  });

  // ── Case C: sentinel < TTL, session predates install → warning + marker ──

  test('Case C: session predates install — warning emitted with "one-time reminder", marker written with content "1"', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0003';
    const sentinelPath = makeSentinelPath();

    // Session opened 2h ago; install happened 1h ago → session predates install.
    const sessionStartMs = Date.now() - 2 * 60 * 60 * 1000;
    const installedAtMs  = Date.now() - 1 * 60 * 60 * 1000;

    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.0.22',
      previous_version: '2.0.21',
    });

    makeTranscript(dir, sessionId, sessionStartMs);

    // Ensure per-session marker absent before the run.
    try { fs.unlinkSync(markerPath(sessionId)); } catch (_e) {}

    const { stderr } = run(sessionId, dir, sentinelPath);

    // Warning must be emitted.
    assert.ok(
      stderr.includes('[orchestray]'),
      'expected [orchestray] warning in stderr — got: ' + stderr
    );
    // R2-W4-F1: must include "one-time reminder" phrasing.
    assert.ok(
      stderr.includes('one-time reminder'),
      'warning must include "one-time reminder" — got: ' + stderr
    );
    // Per-session marker must exist with content "1".
    assert.ok(
      fs.existsSync(markerPath(sessionId)),
      'per-session marker must be created after Case C warning'
    );
    const content = fs.readFileSync(markerPath(sessionId), 'utf8');
    assert.equal(content, '1', 'marker file content must be "1"');
  });

  // ── Case D (TTL): sentinel age > 7d → silent cleanup ─────────────────────

  test('Case D (TTL expired): sentinel older than 7 days — silent cleanup, no warning', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0004';
    const sentinelPath = makeSentinelPath();

    // Sentinel installed 10 days ago — exceeds 7-day TTL.
    const installedAtMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.0.22',
      previous_version: '2.0.21',
    });

    const { stderr } = run(sessionId, dir, sentinelPath);

    assert.ok(
      !stderr.includes('[orchestray]'),
      'no warning expected for TTL-expired sentinel — got: ' + stderr
    );
    assert.ok(
      !fs.existsSync(sentinelPath),
      'sentinel must be deleted after TTL expiry'
    );
  });

  // ── Case D (malformed): no installed_at_ms → silent cleanup ──────────────

  test('Case D (malformed): sentinel without installed_at_ms — silent cleanup, no warning', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0005';
    const sentinelPath = makeSentinelPath();

    // v1-style sentinel — no schema_version, no installed_at_ms.
    writeSentinel(sentinelPath, {
      installed_at: new Date().toISOString(),
      version: '2.0.21',
    });

    const { stderr } = run(sessionId, dir, sentinelPath);

    assert.ok(
      !stderr.includes('[orchestray]'),
      'no warning expected for malformed sentinel — got: ' + stderr
    );
    assert.ok(
      !fs.existsSync(sentinelPath),
      'malformed sentinel must be deleted'
    );
  });

  // ── Idempotency: Case C fired twice in same session → second call silent ─

  test('Idempotency: Case C fired twice in same session — second run is silent', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0006';
    const sentinelPath = makeSentinelPath();

    const sessionStartMs = Date.now() - 2 * 60 * 60 * 1000;
    const installedAtMs  = Date.now() - 1 * 60 * 60 * 1000;

    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.0.22',
      previous_version: '2.0.21',
    });

    makeTranscript(dir, sessionId, sessionStartMs);

    // Ensure marker absent before first run.
    try { fs.unlinkSync(markerPath(sessionId)); } catch (_e) {}

    // First run — must warn.
    // emitUpgradePendingWarning runs BEFORE the session lock check, so even
    // on a second sweep invocation the warning gate is the per-session marker.
    const first = run(sessionId, dir, sentinelPath);
    assert.ok(
      first.stderr.includes('[orchestray]'),
      'first run must emit warning — got: ' + first.stderr
    );
    assert.ok(
      first.stderr.includes('one-time reminder'),
      'first run must include "one-time reminder" — got: ' + first.stderr
    );

    // Delete the sweep-session lock so the second invocation's process can
    // proceed past that check and reach emitUpgradePendingWarning again.
    try { fs.unlinkSync(lockPath(sessionId)); } catch (_e) {}

    // Re-write sentinel (Case C does NOT delete it — only Case B does).
    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.0.22',
      previous_version: '2.0.21',
    });

    // Second run — per-session marker is present; must be silent.
    const second = run(sessionId, dir, sentinelPath);
    assert.ok(
      !second.stderr.includes('[orchestray]'),
      'second run must be silent (per-session marker present) — got: ' + second.stderr
    );
  });

});
