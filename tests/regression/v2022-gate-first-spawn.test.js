#!/usr/bin/env node
'use strict';

/**
 * v2.0.22 regression — gate-agent-spawn first-spawn cross-orch task_id collision fix.
 *
 * Bug (I-1 / R2W1-L-2): when a new orchestration ("orch-NEW") starts and spawns its
 * first agent (e.g., "W-N developer"), routing.jsonl may contain a stale entry for
 * the same task_id from a prior orchestration ("orch-OLD") with a different model
 * tier (e.g., opus).  Before the fix the gate fell back to the global allTaskMatches
 * on `sameOrchMatches.length === 0`, matched the stale opus entry, compared it
 * against the spawn's sonnet model, and exited 2 with "model routing mismatch".
 *
 * Fix (v2.0.22):
 *   1. `currentOrchId` is loaded BEFORE both match branches.
 *   2. When `currentOrchId` is set and no same-orch entry exists, `taskIdMatches`
 *      is set to an empty array — the auto-seed path handles the miss.  The global
 *      fallback is ONLY used when `currentOrchId` is null (no active orch).
 *   3. When `spawnTaskId === null` AND `currentOrchId !== null`, `findRoutingEntry`
 *      is skipped — entry stays null and auto-seed handles it (R2W1-L-2).
 *
 * Scenario tested:
 *   - routing.jsonl has a "W-N" / "developer" / opus entry for "orch-OLD"
 *   - current-orchestration.json is "orch-NEW" (no W-N entry yet)
 *   - Agent("developer", "W-N do work", model=sonnet) is spawned
 *   - Gate must exit 0 (auto-seed allowed)
 *   - Stderr must NOT contain "model routing mismatch"
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'gate-agent-spawn.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create an isolated tmpdir with an active orchestration JSON.
 * @param {string} orchId - orchestration_id to write into current-orchestration.json
 */
function makeDir(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v2022-gate-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  // v2.2.13 W4: symlink schemas so writeEvent's validation succeeds silently.
  const schemaDir = path.join(__dirname, '..', '..', 'agents', 'pm-reference');
  const sandboxSchemaDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(sandboxSchemaDir, { recursive: true });
  for (const f of ['event-schemas.md', 'event-schemas.shadow.json']) {
    try { fs.symlinkSync(path.join(schemaDir, f), path.join(sandboxSchemaDir, f)); }
    catch (_e) { try { fs.copyFileSync(path.join(schemaDir, f), path.join(sandboxSchemaDir, f)); } catch (_e2) {} }
  }
  return dir;
}

/** Write routing.jsonl entries into <dir>/.orchestray/state/routing.jsonl */
function writeRoutingFile(dir, entries) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), lines);
}

/**
 * Write a pattern_record_skip_reason event to events.jsonl for the given orchId.
 * This satisfies the §22c post-decomp gate when routing.jsonl already exists.
 */
function writePostDecompSatisfied(dir, orchId) {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');
  const ev = JSON.stringify({
    type: 'pattern_record_skip_reason',
    orchestration_id: orchId,
    timestamp: new Date().toISOString(),
  }) + '\n';
  if (fs.existsSync(eventsPath)) {
    fs.appendFileSync(eventsPath, ev);
  } else {
    fs.writeFileSync(eventsPath, ev);
  }
}

/** Run gate-agent-spawn.js with the given hook payload on stdin. */
function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Core regression: stale prior-orch entry must not trigger model-mismatch exit
// ---------------------------------------------------------------------------

describe('v2.0.22 first-spawn cross-orch collision fix', () => {

  test('stale prior-orch W-N/opus entry does NOT block new-orch W-N/sonnet spawn (exits 0)', () => {
    // Arrange: current orch is "orch-NEW"; routing.jsonl has a stale "orch-OLD"
    // entry for the same task_id (W-N) and agent_type (developer) but model=opus.
    const dir = makeDir('orch-NEW');

    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-15T10:00:00.000Z',
        orchestration_id: 'orch-OLD',
        task_id: 'W-N',
        agent_type: 'developer',
        description: 'W-N implement feature',
        model: 'opus',
        effort: 'high',
      },
    ]);

    // routing.jsonl exists → §22c post-decomp gate is in second-spawn window.
    // Satisfy it for orch-NEW (the active orch).
    writePostDecompSatisfied(dir, 'orch-NEW');

    // Act: spawn developer/W-N/sonnet for the NEW orch.
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'W-N implement the auth module',
      },
    });

    // Assert: gate must allow (exit 0); must NOT say "model routing mismatch".
    assert.equal(status, 0, 'gate must exit 0 (auto-seed path) on first spawn of new orch');
    assert.ok(
      !stderr.includes('model routing mismatch'),
      'stderr must not contain "model routing mismatch" — got: ' + stderr
    );
  });

  test('stderr does NOT contain "model routing mismatch" on first spawn of new orch', () => {
    // Same scenario as above, explicit assertion on the absence of the mismatch message.
    const dir = makeDir('orch-BRAND-NEW');

    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-14T08:00:00.000Z',
        orchestration_id: 'orch-PREV',
        task_id: 'W-N',
        agent_type: 'developer',
        description: 'W-N old description',
        model: 'opus',
        effort: 'high',
      },
    ]);
    writePostDecompSatisfied(dir, 'orch-BRAND-NEW');

    const { stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'W-N new task description',
      },
    });

    assert.ok(
      !stderr.includes('model routing mismatch'),
      'no mismatch message expected — got: ' + stderr
    );
  });

  test('auto-seed warning appears in stderr (normal first-spawn behavior)', () => {
    // The gate should emit its auto-seed diagnostic (not a hard error).
    const dir = makeDir('orch-FIRST');

    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-14T08:00:00.000Z',
        orchestration_id: 'orch-OLD-2',
        task_id: 'W-N',
        agent_type: 'developer',
        description: 'W-N something',
        model: 'opus',
        effort: 'high',
      },
    ]);
    writePostDecompSatisfied(dir, 'orch-FIRST');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'W-N implement the new feature',
      },
    });

    assert.equal(status, 0);
    // The auto-seed path emits a warning — verify it appeared so we know the
    // correct branch was taken (not a silent pass-through).
    assert.ok(
      stderr.includes('auto-seeding') || stderr.includes('auto-seed') || stderr.includes('no entry'),
      'expected auto-seed diagnostic in stderr — got: ' + stderr
    );
  });

  test('same-orch entry IS matched and model comparison runs normally', () => {
    // When routing.jsonl has an entry for the CURRENT orch with the correct model,
    // the gate must still allow (normal happy-path, not regressed by the fix).
    const dir = makeDir('orch-CURRENT');

    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-15T10:00:00.000Z',
        orchestration_id: 'orch-CURRENT',
        task_id: 'W-N',
        agent_type: 'developer',
        description: 'W-N implement auth',
        model: 'sonnet',
        effort: 'medium',
      },
    ]);
    writePostDecompSatisfied(dir, 'orch-CURRENT');

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'W-N implement auth',
      },
    });

    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  test('same-orch entry with WRONG model still triggers mismatch exit-2 (fix does not break guard)', () => {
    // The fix must not suppress legitimate model-mismatch detections within the
    // same orchestration.
    const dir = makeDir('orch-STRICT');

    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-15T10:00:00.000Z',
        orchestration_id: 'orch-STRICT',
        task_id: 'W-N',
        agent_type: 'developer',
        description: 'W-N implement auth',
        model: 'haiku',   // routing says haiku
        effort: 'low',
      },
    ]);
    // No need to satisfy post-decomp gate — gate exits 2 on mismatch before it matters.

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',   // but spawn uses sonnet
        description: 'W-N implement auth',
      },
    });

    assert.equal(status, 2, 'gate must exit 2 on same-orch model mismatch');
    assert.ok(
      stderr.includes('model routing mismatch'),
      'expected mismatch message — got: ' + stderr
    );
  });

  // -------------------------------------------------------------------------
  // R2W1-L-2: spawnTaskId===null && currentOrchId!==null path
  // -------------------------------------------------------------------------

  test('R2W1-L-2: free-form description (no task_id prefix) + currentOrchId → auto-seed, no stale match', () => {
    // When the description does NOT match the TASK-ID regex, spawnTaskId===null.
    // Pre-fix: findRoutingEntry ran unscoped and could match a stale prior-orch row
    //          by description, triggering a false model-mismatch.
    // Post-fix: when currentOrchId is set, findRoutingEntry is skipped entirely;
    //           entry stays null → auto-seed handles it.
    const dir = makeDir('orch-ACTIVE');

    // Stale entry for orch-PAST with same agent_type and description substring,
    // but different model (opus vs sonnet being spawned).
    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-10T09:00:00.000Z',
        orchestration_id: 'orch-PAST',
        task_id: null,
        agent_type: 'architect',
        description: 'design the new module',
        model: 'opus',
        effort: 'high',
      },
    ]);
    writePostDecompSatisfied(dir, 'orch-ACTIVE');

    // Free-form description (no TASK-ID prefix) → spawnTaskId will be null.
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'architect',
        model: 'sonnet',
        description: 'design the new module',  // matches stale entry description
      },
    });

    assert.equal(status, 0, 'must exit 0 (auto-seed) when no task_id and orch is active');
    assert.ok(
      !stderr.includes('model routing mismatch'),
      'must not false-match stale entry via description — got: ' + stderr
    );
  });

  test('R2W1-L-2: free-form description without currentOrchId still uses findRoutingEntry (no regression)', () => {
    // When there is NO active orchestration (currentOrchId===null), the global
    // findRoutingEntry fallback must still run — this is the pre-orch / ad-hoc path.
    // We verify by showing a matching entry ALLOWS the spawn (model matches).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v2022-noorch-'));
    cleanup.push(dir);
    // No current-orchestration.json written → currentOrchId will be null.

    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // Write an orchestration file so the gate's outer orchFile check passes.
    // Wait — without current-orchestration.json the gate short-circuits at line 131.
    // So this test must have an orch file but no routing.jsonl to verify the gate
    // behavior matches expectations in the no-active-orch state.
    // Actually: without orchFile the gate exits 0 before routing logic.
    // This test confirms that pre-orch ad-hoc spawns still exit 0 freely.
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    // Write an orchestration state file (so gate enters routing logic) but no
    // current-orchestration.json (so currentOrchId is null).
    fs.writeFileSync(path.join(auditDir, 'current-orchestration.json'), 'INVALID JSON');

    // Write a routing.jsonl entry with correct model.
    writeRoutingFile(dir, [
      {
        timestamp: '2026-04-10T09:00:00.000Z',
        orchestration_id: 'orch-SOME',
        task_id: null,
        agent_type: 'developer',
        description: 'build the widget',
        model: 'sonnet',
        effort: 'medium',
      },
    ]);
    writePostDecompSatisfied(dir, 'orch-SOME');

    // malformed current-orchestration.json → currentOrchId will be null (catch swallows)
    // → findRoutingEntry runs globally → matches by description → sonnet===sonnet → exit 0
    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        model: 'sonnet',
        description: 'build the widget',
      },
    });

    assert.equal(status, 0, 'global fallback must still work when currentOrchId is null');
    assert.ok(
      !stderr.includes('model routing mismatch'),
      'unexpected mismatch — got: ' + stderr
    );
  });

});
