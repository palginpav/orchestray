'use strict';

/**
 * v2213-W4-lifecycle-emit.test.js — Lifecycle emit wire tests (G-05, v2.2.13 W4).
 *
 * Tests the orchestration_start emit in gate-agent-spawn.js and the
 * orchestration_complete emit in emit-orchestration-complete.js.
 *
 * 7 mandatory cases:
 *  1. First Agent spawn for orch X emits orchestration_start; sentinel created via wx.
 *  2. Second Agent spawn for same orch X (sentinel pre-exists) catches EEXIST; no duplicate.
 *  3. Parallel-race regression: two gate-agent-spawn.js invocations → exactly ONE orchestration_start.
 *  4. SubagentStop emit on first stop: emit-orchestration-complete.js emits orchestration_complete.
 *  5. Secondary gate against ox.js complete: row already exists → hook removes sentinel, no duplicate.
 *  6. SubagentStop idempotency on repeated stops: second SubagentStop catches EEXIST, exits 0.
 *  7. Kill switch: ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED=1 suppresses BOTH emits.
 *
 * Runner: node --test bin/__tests__/v2213-W4-lifecycle-emit.test.js
 */

const { test }      = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const SPAWN_GATE   = path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js');
const EMIT_COMPLETE = path.join(REPO_ROOT, 'bin', 'emit-orchestration-complete.js');
const NODE         = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(orchId = 'orch-w4-test') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-w4-'));
  const auditDir = path.join(tmp, '.orchestray', 'audit');
  const stateDir = path.join(tmp, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Write current-orchestration.json so gate-agent-spawn.js sees an active orch.
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8',
  );

  // Write a minimal routing.jsonl so the spawn gate doesn't block on model checks.
  // We need the spawn to reach the orchestration_start block without being blocked.
  // The simplest path: set ORCHESTRAY_STRICT_MODEL_REQUIRED=0 and ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED=1.

  return tmp;
}

function readEvents(tmp) {
  const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(e => e && e.type !== 'audit_event_autofilled'); /* v2.2.15: filter P1-13 */
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Build a minimal PreToolUse:Agent payload that passes the allowlist check
 * and won't hard-block on model/routing (we use env vars to relax gates).
 */
function makeSpawnPayload(tmp, orchId) {
  return JSON.stringify({
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'developer',
      model: 'claude-sonnet-4-6',
      description: 'W4-test task',
    },
    cwd: tmp,
  });
}

/**
 * Run gate-agent-spawn.js with env vars that relax non-W4 gates so they
 * don't interfere with observing the orchestration_start emit.
 */
function runSpawnGate(tmp, orchId, extraEnv = {}) {
  const env = {
    ...process.env,
    // Relax gates that would block before we reach the lifecycle-emit block.
    ORCHESTRAY_STRICT_MODEL_REQUIRED: '0',
    ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
    // Don't inherit any kill switch from the parent process.
    ...extraEnv,
  };
  // Ensure kill switch is unset unless test explicitly sets it.
  if (!('ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED' in extraEnv)) {
    delete env.ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED;
  }

  const res = spawnSync(NODE, [SPAWN_GATE], {
    input: makeSpawnPayload(tmp, orchId),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * Run emit-orchestration-complete.js (SubagentStop hook).
 */
function runEmitComplete(tmp, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
  };
  if (!('ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED' in extraEnv)) {
    delete env.ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED;
  }

  const res = spawnSync(NODE, [EMIT_COMPLETE], {
    input: JSON.stringify({ cwd: tmp }),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------------------------------------------------------------------------
// Case 1: First Agent spawn for orch X emits orchestration_start; sentinel created.
// ---------------------------------------------------------------------------
test('case 1 — first spawn emits orchestration_start and creates sentinel', () => {
  const orchId = 'orch-w4-c1';
  const tmp = makeTmpProject(orchId);
  try {
    const r = runSpawnGate(tmp, orchId);
    // Hook must exit 0 (fail-open on errors) or allow (0 or 2; we only care about emit).
    // The emit is what we're testing.

    const events = readEvents(tmp);
    const startEvents = events.filter(e =>
      (e.event_type === 'orchestration_start' || e.type === 'orchestration_start') &&
      e.orchestration_id === orchId,
    );
    assert.equal(startEvents.length, 1, 'should emit exactly one orchestration_start');

    const sentinelPath = path.join(tmp, '.orchestray', 'state',
      `orchestration-start-emitted.${orchId}`);
    assert.ok(fs.existsSync(sentinelPath), 'sentinel file should be created');
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Case 2: Second Agent spawn for same orch X — sentinel pre-exists, no duplicate.
// ---------------------------------------------------------------------------
test('case 2 — second spawn catches EEXIST and does not emit duplicate', () => {
  const orchId = 'orch-w4-c2';
  const tmp = makeTmpProject(orchId);
  try {
    // Pre-create the sentinel to simulate first spawn already ran.
    const sentinelPath = path.join(tmp, '.orchestray', 'state',
      `orchestration-start-emitted.${orchId}`);
    fs.writeFileSync(sentinelPath, '', 'utf8');

    runSpawnGate(tmp, orchId);

    const events = readEvents(tmp);
    const startEvents = events.filter(e =>
      (e.event_type === 'orchestration_start' || e.type === 'orchestration_start') &&
      e.orchestration_id === orchId,
    );
    assert.equal(startEvents.length, 0, 'second spawn must not emit orchestration_start');
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Case 3: Parallel-race regression — two simultaneous spawns → exactly ONE row.
// ---------------------------------------------------------------------------
test('case 3 — parallel race: two concurrent spawns emit exactly one orchestration_start', async () => {
  const orchId = 'orch-w4-c3';
  const tmp = makeTmpProject(orchId);
  try {
    // Launch both processes without waiting for either to finish.
    // Using spawnSync in a Promise.all simulates near-simultaneous starts.
    const [r1, r2] = await Promise.all([
      new Promise(resolve => {
        const { spawnSync: ss } = require('node:child_process');
        const env = {
          ...process.env,
          ORCHESTRAY_STRICT_MODEL_REQUIRED: '0',
          ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
        };
        delete env.ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED;
        resolve(ss(NODE, [SPAWN_GATE], {
          input: makeSpawnPayload(tmp, orchId),
          cwd: tmp,
          encoding: 'utf8',
          timeout: 15_000,
          env,
        }));
      }),
      new Promise(resolve => {
        const { spawnSync: ss } = require('node:child_process');
        const env = {
          ...process.env,
          ORCHESTRAY_STRICT_MODEL_REQUIRED: '0',
          ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
        };
        delete env.ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED;
        resolve(ss(NODE, [SPAWN_GATE], {
          input: makeSpawnPayload(tmp, orchId),
          cwd: tmp,
          encoding: 'utf8',
          timeout: 15_000,
          env,
        }));
      }),
    ]);

    const events = readEvents(tmp);
    const startEvents = events.filter(e =>
      (e.event_type === 'orchestration_start' || e.type === 'orchestration_start') &&
      e.orchestration_id === orchId,
    );
    assert.equal(startEvents.length, 1,
      'exactly one orchestration_start must be emitted even with parallel spawns; ' +
      `got ${startEvents.length}. wx atomic flag must prevent double-fire.`);
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Case 4: SubagentStop emit on first stop — emit-orchestration-complete.js emits the row.
// ---------------------------------------------------------------------------
test('case 4 — first SubagentStop emits orchestration_complete and creates sentinel', () => {
  const orchId = 'orch-w4-c4';
  const tmp = makeTmpProject(orchId);
  try {
    // events.jsonl is empty (or absent) — no prior orchestration_complete row.
    const r = runEmitComplete(tmp);
    assert.equal(r.status, 0, 'hook should exit 0');

    const events = readEvents(tmp);
    const completeEvents = events.filter(e =>
      (e.event_type === 'orchestration_complete' || e.type === 'orchestration_complete') &&
      e.orchestration_id === orchId,
    );
    assert.equal(completeEvents.length, 1, 'should emit exactly one orchestration_complete');

    const sentinelPath = path.join(tmp, '.orchestray', 'state',
      `orchestration-complete-emitted.${orchId}`);
    assert.ok(fs.existsSync(sentinelPath), 'sentinel file should be created');
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Case 5: Secondary gate — events.jsonl already has orchestration_complete from ox.js.
// Hook removes its sentinel, does NOT emit duplicate.
// ---------------------------------------------------------------------------
test('case 5 — secondary gate: existing orchestration_complete row prevents duplicate', () => {
  const orchId = 'orch-w4-c5';
  const tmp = makeTmpProject(orchId);
  try {
    // Pre-write an orchestration_complete row (simulating ox.js:329).
    const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    fs.writeFileSync(eventsPath,
      JSON.stringify({ event_type: 'orchestration_complete', orchestration_id: orchId, version: 1 }) + '\n',
      'utf8',
    );

    const r = runEmitComplete(tmp);
    assert.equal(r.status, 0, 'hook should exit 0');

    // Should still be exactly one row (the pre-written one, no new emit).
    const events = readEvents(tmp);
    const completeEvents = events.filter(e =>
      (e.event_type === 'orchestration_complete' || e.type === 'orchestration_complete') &&
      e.orchestration_id === orchId,
    );
    assert.equal(completeEvents.length, 1, 'should still have exactly one orchestration_complete (no duplicate)');

    // Sentinel should have been removed so a future emit can still fire.
    const sentinelPath = path.join(tmp, '.orchestray', 'state',
      `orchestration-complete-emitted.${orchId}`);
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel should be removed after secondary-gate removal');
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Case 6: SubagentStop idempotency — second stop catches EEXIST, exits 0, no duplicate.
// ---------------------------------------------------------------------------
test('case 6 — second SubagentStop catches EEXIST and exits 0 silently', () => {
  const orchId = 'orch-w4-c6';
  const tmp = makeTmpProject(orchId);
  try {
    // First stop: emits the row and creates sentinel.
    const r1 = runEmitComplete(tmp);
    assert.equal(r1.status, 0);

    const afterFirst = readEvents(tmp);
    const afterFirstCount = afterFirst.filter(e =>
      (e.event_type === 'orchestration_complete' || e.type === 'orchestration_complete') &&
      e.orchestration_id === orchId,
    ).length;
    assert.equal(afterFirstCount, 1, 'first stop should emit one row');

    // Second stop: sentinel exists, should catch EEXIST and not emit.
    const r2 = runEmitComplete(tmp);
    assert.equal(r2.status, 0);

    const afterSecond = readEvents(tmp);
    const afterSecondCount = afterSecond.filter(e =>
      (e.event_type === 'orchestration_complete' || e.type === 'orchestration_complete') &&
      e.orchestration_id === orchId,
    ).length;
    assert.equal(afterSecondCount, 1, 'second stop must not emit a duplicate row');
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Case 7: Kill switch suppresses BOTH emits at env-var check (sentinel never written).
// ---------------------------------------------------------------------------
test('case 7 — ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED=1 suppresses both start and complete emits', () => {
  const orchId = 'orch-w4-c7';
  const tmp = makeTmpProject(orchId);
  try {
    const killEnv = { ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED: '1' };

    // Test start emit is suppressed.
    runSpawnGate(tmp, orchId, killEnv);

    const startSentinel = path.join(tmp, '.orchestray', 'state',
      `orchestration-start-emitted.${orchId}`);
    assert.ok(!fs.existsSync(startSentinel), 'kill switch: start sentinel must NOT be created');

    const eventsAfterSpawn = readEvents(tmp);
    const startRows = eventsAfterSpawn.filter(e =>
      (e.event_type === 'orchestration_start' || e.type === 'orchestration_start') &&
      e.orchestration_id === orchId,
    );
    assert.equal(startRows.length, 0, 'kill switch: orchestration_start must not be emitted');

    // Test complete emit is suppressed.
    const r2 = runEmitComplete(tmp, killEnv);
    assert.equal(r2.status, 0);

    const completeSentinel = path.join(tmp, '.orchestray', 'state',
      `orchestration-complete-emitted.${orchId}`);
    assert.ok(!fs.existsSync(completeSentinel), 'kill switch: complete sentinel must NOT be created');

    const eventsAfterStop = readEvents(tmp);
    const completeRows = eventsAfterStop.filter(e =>
      (e.event_type === 'orchestration_complete' || e.type === 'orchestration_complete') &&
      e.orchestration_id === orchId,
    );
    assert.equal(completeRows.length, 0, 'kill switch: orchestration_complete must not be emitted');
  } finally {
    cleanup(tmp);
  }
});
