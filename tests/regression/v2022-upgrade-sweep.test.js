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
 * v2.3.25: session-start detection switched from transcript-content inference
 * to an explicit session-start marker written by the SessionStart hook (see
 * bin/_lib/session-detect.js). `makeSessionStartMarker()` below writes that
 * marker directly under the fake project dir's .orchestray/state/, standing
 * in for "the SessionStart hook already ran for this session" without
 * needing to spawn it. This suite also carries the v2.3.25 regression test:
 * a resumed session whose transcript begins many days in the past must NOT
 * be treated as predating a recent install, because detection no longer
 * reads the transcript at all.
 *
 * Isolation strategy: ORCHESTRAY_TEST_SENTINEL_PATH is set per test to a
 * unique tmpfile, keeping each test's sentinel completely independent of the
 * real ~/.claude/ sentinel and of other parallel test suites.
 *
 * Session IDs must match /^[0-9a-f-]{1,36}$/i (hex + hyphens, max 36 chars)
 * to pass session-detect.js validation.
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
 * Write a session-start marker directly under the fake project's
 * .orchestray/state/, mirroring what the SessionStart hook
 * (reset-context-telemetry.js → session-detect.js:writeSessionStartMarker)
 * records at the top of every session. detectSessionStartMs() reads this
 * file, so this controls its return value without needing to spawn the
 * SessionStart hook.
 *
 * @param {string} projectDir     Absolute path to the fake project.
 * @param {string} sessionId      Session identifier (hex UUID format).
 * @param {number} sessionStartMs Desired detected session-start time.
 */
function makeSessionStartMarker(projectDir, sessionId, sessionStartMs) {
  const stateDir = path.join(projectDir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const markerFile = path.join(stateDir, 'session-start-markers.json');

  let data = { schema_version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      data = parsed;
    }
  } catch (_e) { /* fresh file */ }

  data.sessions[sessionId] = {
    started_at_ms: sessionStartMs,
    started_at: new Date(sessionStartMs).toISOString(),
  };
  fs.writeFileSync(markerFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Write a fake transcript JSONL file whose first timestamped line is
 * `firstTimestampMs`, mirroring the pre-v2.3.25 shape session-detect.js used
 * to scan. Only used by the v2.3.25 regression test below, to prove
 * detection no longer reads it.
 *
 * @param {string} projectDir      Absolute path to the fake project.
 * @param {string} sessionId       Session identifier (hex UUID format).
 * @param {number} firstTimestampMs
 */
function makeStaleTranscript(projectDir, sessionId, firstTimestampMs) {
  const encoded = '-' + projectDir.replace(/^\//, '').replace(/\//g, '-');
  const transcriptDir = path.join(HOME, '.claude', 'projects', encoded);
  fs.mkdirSync(transcriptDir, { recursive: true });
  dirsToRemove.push(transcriptDir);
  const transcriptPath = path.join(transcriptDir, sessionId + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId }),
    JSON.stringify({ type: 'agent-setting', agentSetting: 'pm', sessionId }),
    JSON.stringify({ type: 'attachment', timestamp: new Date(firstTimestampMs).toISOString(), sessionId }),
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');
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
    makeSessionStartMarker(dir, sessionId, sessionStartMs);

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

    makeSessionStartMarker(dir, sessionId, sessionStartMs);

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

    makeSessionStartMarker(dir, sessionId, sessionStartMs);

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

  // ── v2.3.25 regression: resumed session with an ancient transcript ───────

  test('v2.3.25 regression: a resumed session whose transcript begins 16 days ago is NOT treated as predating a recent install', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0007';
    const sentinelPath = makeSentinelPath();

    // Reproduces the exact reported scenario: transcript's first timestamped
    // line is 16 days old (inherited from the original session a --resume
    // grew out of), but the SessionStart hook just fired for THIS resumed
    // session and recorded a marker a few seconds ago — after the install.
    const sixteenDaysAgoMs = Date.now() - 16 * 24 * 60 * 60 * 1000;
    const installedAtMs    = Date.now() - 5 * 60 * 1000; // installed 5 min ago
    const sessionStartMs   = Date.now() - 30 * 1000;     // resumed 30s ago (postdates install)

    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.3.25',
      previous_version: '2.3.24',
    });

    // The stale transcript exists on disk (as it would for a real resume)
    // but must play no role in detection any more.
    makeStaleTranscript(dir, sessionId, sixteenDaysAgoMs);
    makeSessionStartMarker(dir, sessionId, sessionStartMs);

    const { stderr } = run(sessionId, dir, sentinelPath);

    // Under the v2.3.24 transcript-content detector this would resolve to
    // sixteenDaysAgoMs < installedAtMs → Case C (persist + warn), which is
    // the exact bug: a user who already restarted keeps getting told to.
    assert.ok(
      !stderr.includes('[orchestray]'),
      'no warning expected — a resumed session must not be judged by its inherited transcript history: got ' + stderr
    );
    assert.ok(
      !fs.existsSync(sentinelPath),
      'sentinel must be cleared (Case B) once the marker shows this session postdates the install'
    );
  });

  // ── v2.3.25: no marker for this session → fail-loud fallback (Case C) ────

  test('v2.3.25: no session-start marker recorded → treated as predating the install (fail-loud fallback)', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0009';
    const sentinelPath = makeSentinelPath();

    const installedAtMs = Date.now() - 60 * 60 * 1000;
    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.3.25',
      previous_version: '2.3.24',
    });

    // Deliberately do NOT write a session-start marker for this session_id —
    // simulates a marker that was never written (e.g. the SessionStart hook
    // crashed before reaching writeSessionStartMarker).
    try { fs.unlinkSync(markerPath(sessionId)); } catch (_e) {}

    const { stderr } = run(sessionId, dir, sentinelPath);

    assert.ok(
      stderr.includes('[orchestray]') && stderr.includes('one-time reminder'),
      'no-marker fallback must still warn (fail-loud policy) — got: ' + stderr
    );
    assert.ok(
      fs.existsSync(sentinelPath),
      'sentinel must survive the fail-loud fallback (only Case B deletes it)'
    );
  });

  // ── v2.3.25: a marker for a different session_id must not be used ────────

  test('v2.3.25: a marker recorded for a different session_id is not used for this session', () => {
    const dir = makeProjectDir();
    const otherSessionId = 'aaaa-bbbb-cccc-dddd-000aaaaa';
    const sessionId = 'aaaa-bbbb-cccc-dddd-000a';
    const sentinelPath = makeSentinelPath();

    const installedAtMs = Date.now() - 60 * 60 * 1000;
    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.3.25',
      previous_version: '2.3.24',
    });

    // Marker for a DIFFERENT session postdates the install — must not leak
    // into this session's detection.
    makeSessionStartMarker(dir, otherSessionId, Date.now());
    try { fs.unlinkSync(markerPath(sessionId)); } catch (_e) {}

    const { stderr } = run(sessionId, dir, sentinelPath);

    assert.ok(
      stderr.includes('[orchestray]'),
      'this session has no marker of its own — must still warn (fail-loud), got: ' + stderr
    );
  });

  // ── v2.3.24 leak fix: recordDegradation() must honour the caller's cwd ───

  test('v2.3.24 leak fix: Case C writes the degraded journal under the given projectRoot, not process.cwd()', () => {
    const dir = makeProjectDir();
    const sessionId = 'aaaa-bbbb-cccc-dddd-0008';
    const sentinelPath = makeSentinelPath();

    const repoJournalPath = path.join(path.resolve(__dirname, '..', '..'), '.orchestray', 'state', 'degraded.jsonl');
    const repoJournalBefore = fs.existsSync(repoJournalPath)
      ? fs.readFileSync(repoJournalPath, 'utf8')
      : null;

    const sessionStartMs = Date.now() - 2 * 60 * 60 * 1000;
    const installedAtMs  = Date.now() - 1 * 60 * 60 * 1000;

    writeSentinel(sentinelPath, {
      schema_version: 2,
      installed_at: new Date(installedAtMs).toISOString(),
      installed_at_ms: installedAtMs,
      version: '2.3.24',
      previous_version: '2.3.23',
    });

    makeSessionStartMarker(dir, sessionId, sessionStartMs);
    try { fs.unlinkSync(markerPath(sessionId)); } catch (_e) {}

    const { stderr } = run(sessionId, dir, sentinelPath);
    assert.ok(stderr.includes('[orchestray]'), 'sanity: Case C warning must fire — got: ' + stderr);

    // The record must land under the isolated project dir passed as cwd...
    const isolatedJournalPath = path.join(dir, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(isolatedJournalPath), 'degraded.jsonl must be written under the given projectRoot');
    const rows = fs.readFileSync(isolatedJournalPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(
      rows.some(r => r.kind === 'agent_registry_stale' && r.detail && r.detail.dedup_key === 'agent_registry_stale|' + sessionId),
      'isolated journal must contain the agent_registry_stale record for this session'
    );

    // ...and NOT under this repo's real operational journal (the leak).
    const repoJournalAfter = fs.existsSync(repoJournalPath)
      ? fs.readFileSync(repoJournalPath, 'utf8')
      : null;
    assert.equal(
      repoJournalAfter,
      repoJournalBefore,
      'this repo\'s real degraded.jsonl must be untouched — recordDegradation() leaked to process.cwd()'
    );
  });

});
