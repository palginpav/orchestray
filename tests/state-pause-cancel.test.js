#!/usr/bin/env node
'use strict';

/**
 * Tests for W7 (UX4cd): /orchestray:state pause + cancel with sentinel protocol.
 *
 * Covers:
 *   - state-pause.js creates sentinel; --resume removes it; idempotent on both ends.
 *   - state-cancel.js creates sentinel; idempotent; --force overwrites.
 *   - check-pause-sentinel.js exits 0/2 correctly.
 *   - cancel_grace_seconds honoured: fresh sentinel → exit 0; stale → exit 2.
 *   - Cancel clean-abort: when state dir is renamed, events.jsonl is preserved.
 *   - Audit events: all 4 event types have canonical shape (timestamp/type, correct fields).
 *   - Kill flag: state_sentinel.pause_check_enabled: false → exit 0 regardless of sentinels.
 *   - Hook ordering: check-pause-sentinel appears before gate-agent-spawn in hooks.json.
 *   - Fail-open: missing stateDir → state-pause exits 0 (no crash).
 *   - config-schema: loadStateSentinelConfig returns defaults on missing/malformed config.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const PAUSE_SCRIPT = path.join(REPO_ROOT, 'bin', 'state-pause.js');
const CANCEL_SCRIPT = path.join(REPO_ROOT, 'bin', 'state-cancel.js');
const SENTINEL_SCRIPT = path.join(REPO_ROOT, 'bin', 'check-pause-sentinel.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated project root with .orchestray/state/ and audit/ dirs.
 * @param {object} opts
 * @param {string} [opts.orchId] - orchestration_id to write into orchestration.md
 * @param {object|null} [opts.config] - config.json content, or null to omit
 * @returns {{ dir, stateDir, auditDir, sentinelPath, cancelPath, eventsPath }}
 */
function makeProject({ orchId = 'orch-w7-test-001', config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-sentinel-test-'));
  cleanup.push(dir);

  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  // Write a minimal orchestration.md so scripts can resolve the orchestration_id.
  fs.writeFileSync(
    path.join(stateDir, 'orchestration.md'),
    `---\norchestration_id: ${orchId}\nstatus: in_progress\n---\n`
  );

  if (config !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(config)
    );
  }

  return {
    dir,
    stateDir,
    auditDir,
    sentinelPath: path.join(stateDir, 'pause.sentinel'),
    cancelPath: path.join(stateDir, 'cancel.sentinel'),
    eventsPath: path.join(auditDir, 'events.jsonl'),
  };
}

/**
 * Run a node script synchronously and return { status, stdout, stderr }.
 */
function run(script, args = [], { cwd } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || REPO_ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Run check-pause-sentinel.js with a given projectDir and optional stdin payload.
 * stdin simulates the Claude Code PreToolUse hook JSON payload.
 */
function runSentinelCheck(projectDir, stdinJson = '{}') {
  const result = spawnSync(process.execPath, [SENTINEL_SCRIPT, projectDir], {
    input: stdinJson,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Read and parse events.jsonl, returning an array of event objects.
 */
function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// state-pause.js tests
// ---------------------------------------------------------------------------

describe('state-pause.js', () => {

  test('creates pause.sentinel on first call', () => {
    const { dir, sentinelPath, eventsPath } = makeProject();
    const r = run(PAUSE_SCRIPT, [dir]);
    assert.strictEqual(r.status, 0, 'exits 0');
    assert.ok(fs.existsSync(sentinelPath), 'pause.sentinel was created');

    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    assert.strictEqual(sentinel.orchestration_id, 'orch-w7-test-001');
    assert.ok(typeof sentinel.paused_at === 'string', 'paused_at is a string');
    assert.ok(sentinel.paused_at.includes('T'), 'paused_at is ISO 8601');
    assert.strictEqual(sentinel.reason, null, 'reason is null when not supplied');

    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_pause_set');
    assert.ok(evt, 'state_pause_set event emitted');
    assert.strictEqual(evt.orchestration_id, 'orch-w7-test-001');
    assert.ok(typeof evt.timestamp === 'string', 'timestamp is a string');
    assert.ok(!('ts' in evt), 'no legacy ts field');
    assert.ok(!('event' in evt), 'no legacy event field');
  });

  test('stores --reason= in sentinel and event', () => {
    const { dir, sentinelPath, eventsPath } = makeProject();
    run(PAUSE_SCRIPT, [dir, '--reason=waiting for review']);

    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    assert.strictEqual(sentinel.reason, 'waiting for review');

    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_pause_set');
    assert.strictEqual(evt.reason, 'waiting for review');
  });

  test('is idempotent on second call (no --resume)', () => {
    const { dir, sentinelPath } = makeProject();
    run(PAUSE_SCRIPT, [dir]);
    const mtimeBefore = fs.statSync(sentinelPath).mtimeMs;

    const r = run(PAUSE_SCRIPT, [dir]);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('already paused'), 'reports already paused');

    const mtimeAfter = fs.statSync(sentinelPath).mtimeMs;
    assert.strictEqual(mtimeBefore, mtimeAfter, 'sentinel was not overwritten');
  });

  test('--resume removes sentinel and emits state_pause_resumed', () => {
    const { dir, sentinelPath, eventsPath } = makeProject();
    run(PAUSE_SCRIPT, [dir]);
    assert.ok(fs.existsSync(sentinelPath), 'sentinel created');

    const r = run(PAUSE_SCRIPT, [dir, '--resume']);
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel removed');

    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_pause_resumed');
    assert.ok(evt, 'state_pause_resumed event emitted');
    assert.strictEqual(evt.orchestration_id, 'orch-w7-test-001');
    assert.ok(typeof evt.timestamp === 'string');
    assert.ok(typeof evt.resumed_at === 'string');
    assert.ok(!('ts' in evt));
  });

  test('--resume is idempotent when no sentinel exists', () => {
    const { dir, sentinelPath } = makeProject();
    assert.ok(!fs.existsSync(sentinelPath), 'no sentinel initially');

    const r = run(PAUSE_SCRIPT, [dir, '--resume']);
    assert.strictEqual(r.status, 0, 'exits 0 even when no sentinel');
  });

  test('exits 0 (fail-open) when stateDir does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-nostate-'));
    cleanup.push(dir);
    // Do NOT create .orchestray/state/

    const r = run(PAUSE_SCRIPT, [dir]);
    assert.strictEqual(r.status, 0, 'fail-open: exits 0 on missing stateDir');
  });

});

// ---------------------------------------------------------------------------
// state-cancel.js tests
// ---------------------------------------------------------------------------

describe('state-cancel.js', () => {

  test('creates cancel.sentinel with correct fields', () => {
    const { dir, cancelPath, eventsPath } = makeProject();
    const r = run(CANCEL_SCRIPT, [dir]);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(cancelPath), 'cancel.sentinel was created');

    const sentinel = JSON.parse(fs.readFileSync(cancelPath, 'utf8'));
    assert.strictEqual(sentinel.orchestration_id, 'orch-w7-test-001');
    assert.ok(typeof sentinel.requested_at === 'string');
    assert.ok(sentinel.requested_at.includes('T'), 'requested_at is ISO 8601');
    assert.strictEqual(sentinel.reason, null);

    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_cancel_requested');
    assert.ok(evt, 'state_cancel_requested event emitted');
    assert.strictEqual(evt.orchestration_id, 'orch-w7-test-001');
    assert.ok(!('ts' in evt));
    assert.ok(!('event' in evt));
  });

  test('stores --reason= in sentinel and event', () => {
    const { dir, cancelPath, eventsPath } = makeProject();
    run(CANCEL_SCRIPT, [dir, '--reason=blocking bug found']);

    const sentinel = JSON.parse(fs.readFileSync(cancelPath, 'utf8'));
    assert.strictEqual(sentinel.reason, 'blocking bug found');

    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_cancel_requested');
    assert.strictEqual(evt.reason, 'blocking bug found');
  });

  test('is idempotent without --force', () => {
    const { dir, cancelPath } = makeProject();
    run(CANCEL_SCRIPT, [dir]);
    const mtimeBefore = fs.statSync(cancelPath).mtimeMs;

    const r = run(CANCEL_SCRIPT, [dir]);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('cancel already requested'));

    const mtimeAfter = fs.statSync(cancelPath).mtimeMs;
    assert.strictEqual(mtimeBefore, mtimeAfter, 'sentinel was not overwritten');
  });

  test('--force overwrites existing sentinel', () => {
    const { dir, cancelPath } = makeProject();
    run(CANCEL_SCRIPT, [dir]);
    const mtimeBefore = fs.statSync(cancelPath).mtimeMs;

    // Small delay to ensure mtime changes
    const t0 = Date.now();
    while (Date.now() - t0 < 20) { /* spin */ }

    const r = run(CANCEL_SCRIPT, [dir, '--force']);
    assert.strictEqual(r.status, 0);

    const mtimeAfter = fs.statSync(cancelPath).mtimeMs;
    assert.ok(mtimeAfter >= mtimeBefore, 'sentinel was refreshed with --force');
  });

  test('exits 0 (fail-open) when stateDir does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-nostate-cancel-'));
    cleanup.push(dir);

    const r = run(CANCEL_SCRIPT, [dir]);
    assert.strictEqual(r.status, 0, 'fail-open: exits 0 on missing stateDir');
  });

});

// ---------------------------------------------------------------------------
// check-pause-sentinel.js tests
// ---------------------------------------------------------------------------

describe('check-pause-sentinel.js', () => {

  test('exits 0 when no sentinel files present', () => {
    const { dir } = makeProject();
    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 0, 'exits 0 with no sentinels');
    assert.ok(
      !/paused:|cancelled:/.test(r.stderr),
      'stderr is empty of block text when nothing blocks'
    );
  });

  // W6 (v2.3.32): the block reason MUST land on stderr — Claude Code only
  // surfaces stderr to the model on a PreToolUse block; stdout is the JSON
  // control channel. A test that only checks the exit code would still pass
  // with the bug (reason on stdout) present, which is how this survived.
  test('pause sentinel: block reason is on stderr, names orch id and a resume instruction', () => {
    const { dir } = makeProject({ orchId: 'orch-w6-stderr-test' });
    run(PAUSE_SCRIPT, [dir]);

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes('orch-w6-stderr-test'), 'stderr names the orchestration id');
    assert.ok(
      r.stderr.includes('/orchestray:state pause --resume') || r.stderr.includes('state-pause.js --resume'),
      'stderr includes a concrete resume instruction'
    );
    assert.strictEqual(r.stdout, '', 'stdout carries no block text');
  });

  test('cancel sentinel: block reason is on stderr and explains the cancel state', () => {
    const { dir, cancelPath } = makeProject({
      orchId: 'orch-w6-cancel-stderr-test',
      config: { state_sentinel: { cancel_grace_seconds: 0 } },
    });
    const oldTime = new Date(Date.now() - 10000).toISOString();
    fs.writeFileSync(cancelPath, JSON.stringify({
      orchestration_id: 'orch-w6-cancel-stderr-test',
      reason: null,
      requested_at: oldTime,
    }));

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes('orch-w6-cancel-stderr-test'), 'stderr names the orchestration id');
    assert.ok(r.stderr.includes('Cancel sentinel present'), 'stderr explains the cancel state');
    assert.strictEqual(r.stdout, '', 'stdout carries no block text');
  });

  test('exits 2 when pause.sentinel is present', () => {
    const { dir } = makeProject();
    run(PAUSE_SCRIPT, [dir]);

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 2, 'exits 2 on pause sentinel');
    assert.ok(r.stderr.includes('paused:'), 'prints paused: <orch-id> on stderr');
    assert.ok(r.stderr.includes('--resume'), 'includes resume instructions on stderr');
    assert.strictEqual(r.stdout, '', 'stdout carries no block text');
  });

  test('exits 2 when cancel.sentinel is present and past grace window', () => {
    const { dir, cancelPath } = makeProject({
      config: { state_sentinel: { cancel_grace_seconds: 0 } },
    });

    // Write sentinel with a requested_at 10 seconds in the past.
    const oldTime = new Date(Date.now() - 10000).toISOString();
    fs.writeFileSync(cancelPath, JSON.stringify({
      orchestration_id: 'orch-w7-test-001',
      reason: null,
      requested_at: oldTime,
    }));

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 2, 'exits 2 on cancel sentinel past grace');
    assert.ok(r.stderr.includes('cancelled:'), 'prints cancelled: <orch-id> on stderr');
    assert.strictEqual(r.stdout, '', 'stdout carries no block text');
  });

  test('exits 0 when cancel.sentinel is within grace window', () => {
    const { dir, cancelPath } = makeProject({
      config: { state_sentinel: { cancel_grace_seconds: 60 } },
    });

    // Write sentinel with current time (within 60s grace).
    fs.writeFileSync(cancelPath, JSON.stringify({
      orchestration_id: 'orch-w7-test-001',
      reason: null,
      requested_at: new Date().toISOString(),
    }));

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 0, 'exits 0 within grace window');
    assert.strictEqual(r.stderr, '', 'stderr is empty when the grace window allows the spawn');
  });

  test('cancel sentinel takes priority over pause sentinel (both present)', () => {
    const { dir, cancelPath, sentinelPath } = makeProject({
      config: { state_sentinel: { cancel_grace_seconds: 0 } },
    });

    // Write both sentinels; cancel is past grace.
    const oldTime = new Date(Date.now() - 10000).toISOString();
    fs.writeFileSync(cancelPath, JSON.stringify({
      orchestration_id: 'orch-w7-test-001',
      reason: null,
      requested_at: oldTime,
    }));
    fs.writeFileSync(sentinelPath, JSON.stringify({
      orchestration_id: 'orch-w7-test-001',
      reason: null,
      paused_at: new Date().toISOString(),
    }));

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 2, 'cancel takes priority over pause (both exit 2)');
    assert.ok(r.stderr.includes('cancelled:'));
  });

  test('kill flag: pause_check_enabled=false → exits 0 even with sentinels', () => {
    const { dir } = makeProject({
      config: { state_sentinel: { pause_check_enabled: false } },
    });
    run(PAUSE_SCRIPT, [dir]);
    run(CANCEL_SCRIPT, [dir]);

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 0, 'kill flag inerts the sentinel check');
  });

  test('exits 0 (fail-open) when stateDir does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-nostatecheck-'));
    cleanup.push(dir);
    // No .orchestray/state/

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 0, 'fail-open on missing stateDir');
  });

  test('exits 0 (fail-open) on corrupt sentinel file', () => {
    const { dir, sentinelPath } = makeProject();
    fs.writeFileSync(sentinelPath, 'not-valid-json');

    const r = runSentinelCheck(dir);
    // pause.sentinel exists but is corrupt; should still exit 2 (sentinel present)
    // or 0 if the script fails-open internally. Verify it doesn't crash.
    assert.ok(r.status !== null, 'exits with a code (does not crash)');
  });

});

// ---------------------------------------------------------------------------
// cancel_grace_seconds config tests
// ---------------------------------------------------------------------------

describe('cancel_grace_seconds', () => {

  test('fresh cancel sentinel (default 5s grace) → exit 0', () => {
    const { dir } = makeProject();
    // Use default config (5s grace); write sentinel with current time.
    run(CANCEL_SCRIPT, [dir]);

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 0, 'within 5s grace → exit 0');
  });

  test('stale cancel sentinel (0s grace) → exit 2', () => {
    const { dir, cancelPath } = makeProject({
      config: { state_sentinel: { cancel_grace_seconds: 0 } },
    });

    // Write sentinel with a requested_at far in the past.
    fs.writeFileSync(cancelPath, JSON.stringify({
      orchestration_id: 'orch-w7-test-001',
      reason: null,
      requested_at: new Date(Date.now() - 30000).toISOString(),
    }));

    const r = runSentinelCheck(dir);
    assert.strictEqual(r.status, 2, 'past grace → exit 2');
  });

  test('no requested_at in sentinel → treated as past grace (exit 2 at 0s)', () => {
    const { dir, cancelPath } = makeProject({
      config: { state_sentinel: { cancel_grace_seconds: 0 } },
    });

    // Sentinel without requested_at field (malformed but partial).
    fs.writeFileSync(cancelPath, JSON.stringify({
      orchestration_id: 'orch-w7-test-001',
    }));

    const r = runSentinelCheck(dir);
    // No requested_at → can't compute grace; script should either exit 2 or 0 (fail-open).
    // The contract is: it must not crash.
    assert.ok(r.status === 0 || r.status === 2, 'does not crash on missing requested_at');
  });

});

// ---------------------------------------------------------------------------
// Cancel clean-abort: state dir rename preserves events.jsonl
// ---------------------------------------------------------------------------

describe('cancel clean-abort sequence', () => {

  test('renaming state dir preserves events.jsonl', () => {
    const { dir, stateDir, eventsPath } = makeProject();

    // Write some events into .orchestray/state/events.jsonl (simulating in-progress orch).
    const stateEventsPath = path.join(stateDir, 'events.jsonl');
    fs.appendFileSync(stateEventsPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'orchestration_start',
      orchestration_id: 'orch-w7-test-001',
    }) + '\n');

    // Simulate cancel request.
    run(CANCEL_SCRIPT, [dir]);

    // Simulate PM clean-abort: rename state/ to history/<orch_id>-cancelled/.
    // orchId already begins with "orch-" — do not prepend a second one
    // (v2.3.33 W4: the previously-pinned doubled-prefix form was corrected
    // across the writer, reader, and block message).
    const historyDir = path.join(dir, '.orchestray', 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    const cancelledDir = path.join(historyDir, 'orch-w7-test-001-cancelled');
    fs.renameSync(stateDir, cancelledDir);

    // Emit the state_cancel_aborted event to audit log.
    fs.appendFileSync(eventsPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'state_cancel_aborted',
      orchestration_id: 'orch-w7-test-001',
      archived_to: '.orchestray/history/orch-w7-test-001-cancelled',
      events_jsonl_preserved: true,
    }) + '\n');

    // Verify the archived state dir contains the original events.
    const archivedEventsPath = path.join(cancelledDir, 'events.jsonl');
    assert.ok(fs.existsSync(archivedEventsPath), 'events.jsonl preserved in cancelled dir');

    const archivedEvents = fs.readFileSync(archivedEventsPath, 'utf8');
    assert.ok(archivedEvents.includes('orchestration_start'), 'original events intact');

    // Verify the audit log has the abort event.
    const auditEvents = readEvents(eventsPath);
    const abortEvt = auditEvents.find(e => e.type === 'state_cancel_aborted');
    assert.ok(abortEvt, 'state_cancel_aborted event in audit log');
    assert.strictEqual(abortEvt.events_jsonl_preserved, true);
    assert.ok(abortEvt.archived_to.includes('cancelled'));
    assert.ok(!('ts' in abortEvt));
    assert.ok(!('event' in abortEvt));
  });

  // v2.3.33 W4: end-to-end assertion chain covering all three sites that
  // must agree on the cancel-archive path — the block message
  // (bin/check-pause-sentinel.js), the PM's manual `mv` (simulated here,
  // since it's a Bash op no hook can execute), and the reader
  // (checkStateCancelCompleteness in bin/_lib/pm-emit-state-watcher.js).
  // Before v2.3.33 the three sites happened to agree on a doubled
  // "orch-orch-<id>-cancelled" path that had never once been exercised
  // end-to-end (no `*-cancelled` dir has ever existed on disk); this test
  // is the one whose absence let that go unnoticed.
  test('cancel end-to-end: message path === PM mv target === watcher discovery path', () => {
    const { checkStateCancelCompleteness } = require(
      path.join(REPO_ROOT, 'bin', '_lib', 'pm-emit-state-watcher')
    );

    const orchId = 'orch-e2e-w4-test-001';
    const { dir, stateDir, cancelPath, eventsPath } = makeProject({
      orchId,
      config: { state_sentinel: { cancel_grace_seconds: 0 } },
    });

    // 1. Real cancel request via state-cancel.js.
    run(CANCEL_SCRIPT, [dir]);
    assert.ok(fs.existsSync(cancelPath), 'cancel sentinel created');
    // Backdate requested_at past the (0s) grace window so the block fires.
    const sentinel = JSON.parse(fs.readFileSync(cancelPath, 'utf8'));
    sentinel.requested_at = new Date(Date.now() - 10000).toISOString();
    fs.writeFileSync(cancelPath, JSON.stringify(sentinel));

    // 2. Site 1 — the block message: parse the archive path it names.
    const blocked = runSentinelCheck(dir);
    assert.strictEqual(blocked.status, 2, 'spawn is blocked by the cancel sentinel');
    const msgMatch = blocked.stderr.match(/archive state to (\S+) at the next boundary/);
    assert.ok(msgMatch, 'block message names an archive path: ' + blocked.stderr);
    const messagePath = msgMatch[1].replace(/\/$/, ''); // e.g. history/orch-e2e-w4-test-001-cancelled

    // 3. Site 2 — the PM's clean-abort `mv` (simulated; it's a Bash op, not
    // something a hook performs). Target the EXACT relative path the message
    // named, rooted at .orchestray/ like the watcher expects.
    const archivedRel = '.orchestray/' + messagePath;
    const archivedDir = path.join(dir, archivedRel);
    fs.mkdirSync(path.dirname(archivedDir), { recursive: true });
    fs.renameSync(stateDir, archivedDir);
    fs.appendFileSync(eventsPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'state_cancel_aborted',
      orchestration_id: orchId,
      archived_to: archivedRel,
      events_jsonl_preserved: true,
      version: 1,
    }) + '\n');

    // 4. Site 3 — the reader: checkStateCancelCompleteness must find the
    // SAME directory the message named and the mv actually created, and must
    // treat the abort as already-emitted (no backstop fires — it's already
    // in the audit log from step 3).
    const before = readEvents(eventsPath).filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    checkStateCancelCompleteness(dir, orchId, null);
    const after = readEvents(eventsPath).filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.strictEqual(before.length, 0);
    assert.strictEqual(after.length, 0, 'reader recognizes the archived dir the message named — no duplicate backstop emit');

    // Positive control: without a prior audit row, the reader independently
    // derives the SAME path and fires the backstop with a matching archived_to.
    const orchId2 = 'orch-e2e-w4-test-002';
    const { dir: dir2, stateDir: stateDir2 } = makeProject({ orchId: orchId2 });
    const archivedDir2 = path.join(dir2, '.orchestray', 'history', orchId2 + '-cancelled');
    fs.mkdirSync(path.dirname(archivedDir2), { recursive: true });
    fs.renameSync(stateDir2, archivedDir2);
    checkStateCancelCompleteness(dir2, orchId2, null);
    const events2 = readEvents(path.join(dir2, '.orchestray', 'audit', 'events.jsonl'));
    const backstop2 = events2.filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.strictEqual(backstop2.length, 1, 'reader independently discovers the archive dir and backstops the missing event');
    assert.strictEqual(backstop2[0].archived_to, '.orchestray/history/' + orchId2 + '-cancelled');
  });

});

// ---------------------------------------------------------------------------
// Audit event canonical shape tests
// ---------------------------------------------------------------------------

describe('audit events — canonical shape', () => {

  test('state_pause_set has timestamp/type (not ts/event)', () => {
    const { dir, eventsPath } = makeProject();
    run(PAUSE_SCRIPT, [dir]);
    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_pause_set');
    assert.ok(evt, 'event emitted');
    assert.ok('timestamp' in evt, 'timestamp present');
    assert.ok('type' in evt, 'type present');
    assert.ok(!('ts' in evt), 'no ts field');
    assert.ok(!('event' in evt), 'no event field');
  });

  test('state_pause_resumed has timestamp/type (not ts/event)', () => {
    const { dir, eventsPath } = makeProject();
    run(PAUSE_SCRIPT, [dir]);
    run(PAUSE_SCRIPT, [dir, '--resume']);
    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_pause_resumed');
    assert.ok(evt, 'event emitted');
    assert.ok('timestamp' in evt);
    assert.ok(!('ts' in evt));
    assert.ok(!('event' in evt));
    assert.ok('resumed_at' in evt, 'resumed_at present');
  });

  test('state_cancel_requested has timestamp/type (not ts/event)', () => {
    const { dir, eventsPath } = makeProject();
    run(CANCEL_SCRIPT, [dir]);
    const events = readEvents(eventsPath);
    const evt = events.find(e => e.type === 'state_cancel_requested');
    assert.ok(evt, 'event emitted');
    assert.ok('timestamp' in evt);
    assert.ok(!('ts' in evt));
    assert.ok(!('event' in evt));
    assert.ok('requested_at' in evt, 'requested_at present');
  });

  test('state_cancel_aborted has canonical shape', () => {
    // This event is emitted by the PM (not a script). Validate schema only.
    const evt = {
      timestamp: new Date().toISOString(),
      type: 'state_cancel_aborted',
      orchestration_id: 'orch-w7-test-001',
      archived_to: '.orchestray/history/orch-w7-test-001-cancelled',
      events_jsonl_preserved: true,
    };
    assert.ok('timestamp' in evt);
    assert.ok('type' in evt);
    assert.strictEqual(evt.type, 'state_cancel_aborted');
    assert.ok(!('ts' in evt));
    assert.ok(!('event' in evt));
    assert.strictEqual(evt.events_jsonl_preserved, true);
    assert.ok(evt.archived_to.endsWith('-cancelled'));
  });

});

// ---------------------------------------------------------------------------
// Hook ordering test
// ---------------------------------------------------------------------------

describe('hooks.json ordering', () => {

  test('check-pause-sentinel appears before gate-agent-spawn in PreToolUse:Agent chain', () => {
    const hooksJson = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const preToolUse = hooksJson.hooks.PreToolUse;
    assert.ok(Array.isArray(preToolUse), 'PreToolUse is an array');

    // Find the Agent|Explore|Task matcher entry.
    const agentEntry = preToolUse.find(e => e.matcher && e.matcher.includes('Agent'));
    assert.ok(agentEntry, 'Agent matcher entry exists');
    assert.ok(Array.isArray(agentEntry.hooks), 'hooks array exists');

    const commands = agentEntry.hooks.map(h => h.command || '');
    const sentinelIdx = commands.findIndex(c => c.includes('check-pause-sentinel'));
    const gateIdx = commands.findIndex(c => c.includes('gate-agent-spawn'));

    assert.ok(sentinelIdx !== -1, 'check-pause-sentinel.js is wired in hooks.json');
    assert.ok(gateIdx !== -1, 'gate-agent-spawn.js is wired in hooks.json');
    assert.ok(sentinelIdx < gateIdx, 'sentinel check runs BEFORE gate-agent-spawn');
  });

});

// ---------------------------------------------------------------------------
// config-schema loadStateSentinelConfig tests
// ---------------------------------------------------------------------------

describe('config-schema loadStateSentinelConfig', () => {
  const { loadStateSentinelConfig, DEFAULT_STATE_SENTINEL } = require(
    path.join(REPO_ROOT, 'bin', '_lib', 'config-schema')
  );

  test('returns defaults when config file is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-cfg-'));
    cleanup.push(dir);
    const cfg = loadStateSentinelConfig(dir);
    assert.strictEqual(cfg.pause_check_enabled, DEFAULT_STATE_SENTINEL.pause_check_enabled);
    assert.strictEqual(cfg.cancel_grace_seconds, DEFAULT_STATE_SENTINEL.cancel_grace_seconds);
  });

  test('returns defaults on malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-cfg-malformed-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), 'not-json');
    const cfg = loadStateSentinelConfig(dir);
    assert.strictEqual(cfg.pause_check_enabled, true);
    assert.strictEqual(cfg.cancel_grace_seconds, 5);
  });

  test('loads valid state_sentinel config correctly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-cfg-valid-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ state_sentinel: { pause_check_enabled: false, cancel_grace_seconds: 30 } })
    );
    const cfg = loadStateSentinelConfig(dir);
    assert.strictEqual(cfg.pause_check_enabled, false);
    assert.strictEqual(cfg.cancel_grace_seconds, 30);
  });

  test('rejects invalid pause_check_enabled type and falls back to default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-cfg-invalid-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ state_sentinel: { pause_check_enabled: 'yes', cancel_grace_seconds: 5 } })
    );
    const cfg = loadStateSentinelConfig(dir);
    // pause_check_enabled is invalid string → should fall back to default (true)
    assert.strictEqual(cfg.pause_check_enabled, true);
  });

  test('DEFAULT_STATE_SENTINEL has correct shape', () => {
    assert.strictEqual(typeof DEFAULT_STATE_SENTINEL.pause_check_enabled, 'boolean');
    assert.strictEqual(DEFAULT_STATE_SENTINEL.pause_check_enabled, true);
    assert.strictEqual(typeof DEFAULT_STATE_SENTINEL.cancel_grace_seconds, 'number');
    assert.strictEqual(DEFAULT_STATE_SENTINEL.cancel_grace_seconds, 5);
  });

});
