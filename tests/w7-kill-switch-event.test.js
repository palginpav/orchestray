#!/usr/bin/env node
'use strict';

/**
 * W7 tests — kill-switch event emission + analytics health signal.
 *
 * 2013-W7-kill-switch
 *
 * Tests:
 *   A — flip false → true  → kill_switch_activated event written
 *   B — flip true  → false → kill_switch_deactivated event written
 *   C — no-op flip (same value) → NO event written
 *   D — event-write failure → config write still succeeds (fail-open) [STRETCH]
 *   E — analytics: config has global_kill_switch=true → warning output
 *   F — analytics: config has global_kill_switch=false → NO warning output
 *   G — analytics: kill_switch_activated in events.jsonl without later deactivation
 *       → "has not been deactivated" signal [STRETCH]
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EMIT_SCRIPT = path.resolve(__dirname, '../bin/emit-kill-switch-event.js');
const { emitKillSwitchEvent } = require('../bin/_lib/kill-switch-event');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-kill-switch-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  if (orchId) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );
  }
  return { dir, auditDir, eventsPath: path.join(auditDir, 'events.jsonl') };
}

function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function runCli(args) {
  return spawnSync(process.execPath, [EMIT_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// Test A — flip false → true → kill_switch_activated event written
// ---------------------------------------------------------------------------

describe('W7 kill-switch event emission', () => {

  test('A: flip false → true writes kill_switch_activated event', () => {
    const orchId = 'orch-w7-test-A';
    const { dir, eventsPath } = makeTmpProject(orchId);

    const emitted = emitKillSwitchEvent({
      cwd: dir,
      previousValue: false,
      newValue: true,
    });

    assert.equal(emitted, true, 'emitKillSwitchEvent must return true when event is written');

    const events = readEvents(eventsPath);
    assert.equal(events.length, 1, 'Exactly one event must be written');

    const ev = events[0];
    assert.equal(ev.type, 'kill_switch_activated', 'type must be kill_switch_activated');
    assert.equal(ev.source, 'config-skill', 'source must be config-skill');
    assert.equal(ev.previous_value, false, 'previous_value must be false');
    assert.equal(ev.new_value, true, 'new_value must be true');
    assert.equal(ev.orchestration_id, orchId, 'orchestration_id must match current orch');
    assert.ok(typeof ev.timestamp === 'string', 'timestamp must be present');
    assert.ok(ev.timestamp.endsWith('Z'), 'timestamp must be ISO 8601 UTC');
    assert.equal(ev.reason, null, 'reason must be null when not supplied');
  });

  // ---------------------------------------------------------------------------
  // Test B — flip true → false → kill_switch_deactivated event written
  // ---------------------------------------------------------------------------

  test('B: flip true → false writes kill_switch_deactivated event', () => {
    const orchId = 'orch-w7-test-B';
    const { dir, eventsPath } = makeTmpProject(orchId);

    const emitted = emitKillSwitchEvent({
      cwd: dir,
      previousValue: true,
      newValue: false,
    });

    assert.equal(emitted, true, 'emitKillSwitchEvent must return true when event is written');

    const events = readEvents(eventsPath);
    assert.equal(events.length, 1, 'Exactly one event must be written');

    const ev = events[0];
    assert.equal(ev.type, 'kill_switch_deactivated', 'type must be kill_switch_deactivated');
    assert.equal(ev.source, 'config-skill', 'source must be config-skill');
    assert.equal(ev.previous_value, true, 'previous_value must be true');
    assert.equal(ev.new_value, false, 'new_value must be false');
    assert.equal(ev.orchestration_id, orchId, 'orchestration_id must match current orch');
  });

  // ---------------------------------------------------------------------------
  // Test C — no-op flip → NO event written
  // ---------------------------------------------------------------------------

  test('C: no-op flip (same value) produces NO event', () => {
    const { dir, eventsPath } = makeTmpProject('orch-w7-test-C');

    // Flip from true → true (no-op)
    const emitted1 = emitKillSwitchEvent({ cwd: dir, previousValue: true, newValue: true });
    assert.equal(emitted1, false, 'emitKillSwitchEvent must return false on no-op flip');
    assert.equal(fs.existsSync(eventsPath), false, 'events.jsonl must NOT be created for a no-op flip');

    // Flip from false → false (no-op)
    const emitted2 = emitKillSwitchEvent({ cwd: dir, previousValue: false, newValue: false });
    assert.equal(emitted2, false, 'emitKillSwitchEvent must return false on no-op flip (false→false)');
    assert.equal(fs.existsSync(eventsPath), false, 'events.jsonl must NOT be created for a false→false no-op');
  });

  // ---------------------------------------------------------------------------
  // Test D (stretch) — event-write failure is fail-open
  // ---------------------------------------------------------------------------

  test('D (stretch): event-write failure does not throw (fail-open)', () => {
    // Simulate write failure by passing a cwd that cannot host a .orchestray dir.
    // We use a non-existent cwd path — atomicAppendJsonl will attempt to mkdir and
    // then fail to write. emitKillSwitchEvent must return false and not throw.
    const fakeCwd = '/nonexistent/path/that/cannot/be/created';

    // emitKillSwitchEvent should not throw even when I/O fails
    let threw = false;
    let returnValue;
    try {
      returnValue = emitKillSwitchEvent({
        cwd: fakeCwd,
        previousValue: false,
        newValue: true,
      });
    } catch (_e) {
      threw = true;
    }

    assert.equal(threw, false, 'emitKillSwitchEvent must not throw on I/O failure (fail-open)');
    // Return value may be true or false depending on whether mkdir partially succeeded;
    // what matters is it did not throw.
  });

  // ---------------------------------------------------------------------------
  // CLI wrapper tests — via bin/emit-kill-switch-event.js
  // ---------------------------------------------------------------------------

  test('CLI: emit-kill-switch-event.js exits 0 and writes event', () => {
    const orchId = 'orch-w7-cli-test';
    const { dir, eventsPath } = makeTmpProject(orchId);

    const result = runCli([dir, 'false', 'true']);
    assert.equal(result.status, 0, 'CLI must exit 0');

    const events = readEvents(eventsPath);
    assert.equal(events.length, 1, 'One event must be written via CLI');
    assert.equal(events[0].type, 'kill_switch_activated');
  });

  test('CLI: invalid arguments exits 0 (fail-open) without crashing', () => {
    const result = runCli(['not-a-valid-cwd', 'notbool', 'alsowrong']);
    assert.equal(result.status, 0, 'CLI must exit 0 even with invalid arguments');
  });

  test('CLI: no-op flip exits 0 and writes no event', () => {
    const { dir, eventsPath } = makeTmpProject(null);

    const result = runCli([dir, 'true', 'true']);
    assert.equal(result.status, 0, 'CLI must exit 0');
    assert.equal(fs.existsSync(eventsPath), false, 'No event must be written for no-op via CLI');
  });

  test('orchestration_id is null when current-orchestration.json is absent', () => {
    // No orchId passed → current-orchestration.json not created
    const { dir, eventsPath } = makeTmpProject(null);

    emitKillSwitchEvent({ cwd: dir, previousValue: false, newValue: true });

    const events = readEvents(eventsPath);
    assert.equal(events.length, 1, 'Event must be written even without orchestration file');
    assert.equal(events[0].orchestration_id, null, 'orchestration_id must be null when file absent');
  });

  test('orchestration_id is null when stored value is "unknown"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-unknown-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    // Write file with orchestration_id = "unknown"
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'unknown' })
    );
    const eventsPath = path.join(auditDir, 'events.jsonl');

    emitKillSwitchEvent({ cwd: dir, previousValue: false, newValue: true });

    const events = readEvents(eventsPath);
    assert.equal(events[0].orchestration_id, null, 'orchestration_id must be null when value is "unknown"');
  });

  test('reason field is set when provided', () => {
    const { dir, eventsPath } = makeTmpProject('orch-w7-reason-test');

    emitKillSwitchEvent({
      cwd: dir,
      previousValue: false,
      newValue: true,
      reason: 'production incident INC-1234',
    });

    const events = readEvents(eventsPath);
    assert.equal(events[0].reason, 'production incident INC-1234', 'reason must be preserved');
  });

});

// ---------------------------------------------------------------------------
// Tests E + F — analytics health signal via config.json state
// These are unit-level tests of the health-signal logic extracted from the
// analytics skill spec. We simulate the conditions the skill would encounter.
// ---------------------------------------------------------------------------

describe('W7 analytics health signal — config state', () => {

  // Health signal check helper — simulates what the analytics skill does:
  // reads config.json and returns whether the warning should be shown.
  function shouldShowKillSwitchWarning(configPath) {
    if (!fs.existsSync(configPath)) return false;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return cfg.mcp_enforcement && cfg.mcp_enforcement.global_kill_switch === true;
    } catch (_e) {
      return false;
    }
  }

  test('E: global_kill_switch=true → health warning should be shown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-E-'));
    cleanup.push(dir);
    const orchDir = path.join(dir, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    const configPath = path.join(orchDir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      mcp_enforcement: { global_kill_switch: true },
    }));

    const showWarning = shouldShowKillSwitchWarning(configPath);
    assert.equal(showWarning, true,
      'Analytics health check must return true (show warning) when global_kill_switch=true');
  });

  test('F: global_kill_switch=false → health warning must NOT be shown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-F-'));
    cleanup.push(dir);
    const orchDir = path.join(dir, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    const configPath = path.join(orchDir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      mcp_enforcement: { global_kill_switch: false },
    }));

    const showWarning = shouldShowKillSwitchWarning(configPath);
    assert.equal(showWarning, false,
      'Analytics health check must return false (no warning) when global_kill_switch=false');
  });

  test('F-variant: config.json absent → health warning must NOT be shown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-Fv-'));
    cleanup.push(dir);
    const configPath = path.join(dir, '.orchestray', 'config.json');

    const showWarning = shouldShowKillSwitchWarning(configPath);
    assert.equal(showWarning, false,
      'Analytics health check must return false (no warning) when config.json absent');
  });

});

// ---------------------------------------------------------------------------
// Test G (stretch) — analytics: unmatched kill_switch_activated in last 100 events
// ---------------------------------------------------------------------------

describe('W7 analytics health signal — events.jsonl history', () => {

  // Helper: scan last N events for unpaired kill_switch_activated.
  // Returns the activation event if found unpaired, or null.
  function findUnmatchedActivation(eventsPath, windowSize = 100) {
    if (!fs.existsSync(eventsPath)) return null;
    const lines = fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(l => l.trim());
    const window = lines.slice(-windowSize);
    const events = [];
    for (const line of window) {
      try { events.push(JSON.parse(line)); } catch (_e) {}
    }

    // Find most recent activation
    let lastActivation = null;
    let lastActivationIdx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'kill_switch_activated') {
        lastActivation = events[i];
        lastActivationIdx = i;
      }
    }
    if (!lastActivation) return null;

    // Check for a deactivation after it
    for (let i = lastActivationIdx + 1; i < events.length; i++) {
      if (events[i].type === 'kill_switch_deactivated') {
        const deactTs = new Date(events[i].timestamp).getTime();
        const actTs = new Date(lastActivation.timestamp).getTime();
        if (deactTs > actTs) return null; // paired — switch is off
      }
    }
    return lastActivation;
  }

  test('G (stretch): kill_switch_activated without later deactivation fires unmatched signal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-G-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const activatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

    // Plant an activation event with no subsequent deactivation
    fs.writeFileSync(eventsPath, JSON.stringify({
      timestamp: activatedAt,
      type: 'kill_switch_activated',
      orchestration_id: 'orch-w7-G',
      source: 'config-skill',
      previous_value: false,
      new_value: true,
    }) + '\n');

    const unmatched = findUnmatchedActivation(eventsPath);
    assert.ok(unmatched !== null, 'Must detect unpaired kill_switch_activated event');
    assert.equal(unmatched.type, 'kill_switch_activated',
      'Returned event must be the activation event');
    assert.equal(unmatched.timestamp, activatedAt, 'Returned event must have the planted timestamp');
  });

  test('G-variant: kill_switch_activated followed by kill_switch_deactivated → no unmatched signal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-Gv-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const t1 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const lines = [
      JSON.stringify({ timestamp: t1, type: 'kill_switch_activated', source: 'config-skill', previous_value: false, new_value: true }),
      JSON.stringify({ timestamp: t2, type: 'kill_switch_deactivated', source: 'config-skill', previous_value: true, new_value: false }),
    ];
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

    const unmatched = findUnmatchedActivation(eventsPath);
    assert.equal(unmatched, null,
      'Must NOT show unmatched signal when activation is followed by deactivation');
  });

  test('G-variant: no kill_switch events in window → no unmatched signal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-Gv2-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    // Plant unrelated events
    fs.writeFileSync(eventsPath, JSON.stringify({ timestamp: new Date().toISOString(), type: 'orchestration_start', orchestration_id: 'orch-other' }) + '\n');

    const unmatched = findUnmatchedActivation(eventsPath);
    assert.equal(unmatched, null, 'Must return null when no kill_switch events exist');
  });

  test('G-variant: only the last 100 events are scanned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w7-analytics-Gv3-'));
    cleanup.push(dir);
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    // Plant an activation event, then 101 unrelated events after it (pushes it out of the 100-event window)
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const lines = [
      JSON.stringify({ timestamp: oldTs, type: 'kill_switch_activated', source: 'config-skill', previous_value: false, new_value: true }),
    ];
    for (let i = 0; i < 101; i++) {
      lines.push(JSON.stringify({ timestamp: new Date().toISOString(), type: 'orchestration_start', orchestration_id: `orch-filler-${i}` }));
    }
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

    const unmatched = findUnmatchedActivation(eventsPath, 100);
    assert.equal(unmatched, null,
      'Activation event outside the 100-event window must not be reported');
  });

});
