#!/usr/bin/env node
'use strict';

/**
 * R-TGATE-PM emit tests (v2.1.15)
 *
 * Verifies that each of the 6 prompt-only Tier-2 protocols emits exactly one
 * `tier2_invoked` event with the correct `protocol` slug when its primary
 * action fires.
 *
 * Strategy: drive `bin/emit-tier2-invoked.js` (the CLI wrapper the PM calls
 * via Bash) with the expected `--protocol` and `--signal` arguments for each
 * protocol. Capture `events.jsonl` and assert:
 *   - exactly one `tier2_invoked` event written
 *   - `event.protocol` matches the expected slug
 *
 * TDD contract: these tests MUST fail before `bin/emit-tier2-invoked.js`
 * exists, and MUST pass after it is created and `agents/pm.md` is edited
 * to include the emit instructions.
 *
 * Protocols under test:
 *   drift_sentinel, consequence_forecast, replay_analysis,
 *   auto_documenter, disagreement_protocol, cognitive_backpressure
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/emit-tier2-invoked.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create an isolated temp directory that looks like a project root.
 * Provides a `current-orchestration.json` marker so the emitter can resolve
 * the orchestration_id.
 */
function makeDir({ orchId = 'orch-tgate-pm-test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tgate-pm-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  return dir;
}

/**
 * Run the CLI wrapper with the given protocol slug and trigger signal.
 * Returns the spawnSync result.
 */
function runEmitter(dir, protocol, signal) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--protocol', protocol, '--signal', signal, '--cwd', dir],
    {
      encoding: 'utf8',
      timeout: 5000,
    }
  );
}

/**
 * Read all events from `.orchestray/audit/events.jsonl` in the given dir.
 */
function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests — one per protocol
// ---------------------------------------------------------------------------

describe('R-TGATE-PM: tier2_invoked emit for prompt-only protocols', () => {

  test('drift_sentinel: emits exactly one tier2_invoked event with correct protocol', () => {
    const dir = makeDir({ orchId: 'orch-tgate-drift' });

    const result = runEmitter(
      dir,
      'drift_sentinel',
      'enable_drift_sentinel true; architect completed; invariants written to kb/decisions/'
    );

    assert.equal(result.status, 0, `Script exited ${result.status}; stderr: ${result.stderr}`);

    const events = readEvents(dir);
    const tier2Events = events.filter(e => e.type === 'tier2_invoked');

    assert.equal(tier2Events.length, 1, `Expected 1 tier2_invoked event, got ${tier2Events.length}`);
    assert.equal(tier2Events[0].protocol, 'drift_sentinel');
    assert.equal(tier2Events[0].version, 1);
    assert.ok(tier2Events[0].timestamp, 'Event must have a timestamp');
  });

  test('consequence_forecast: emits exactly one tier2_invoked event with correct protocol', () => {
    const dir = makeDir({ orchId: 'orch-tgate-consequence' });

    const result = runEmitter(
      dir,
      'consequence_forecast',
      'enable_consequence_forecast true; Phase A scan complete; predictions written to state/consequences.md'
    );

    assert.equal(result.status, 0, `Script exited ${result.status}; stderr: ${result.stderr}`);

    const events = readEvents(dir);
    const tier2Events = events.filter(e => e.type === 'tier2_invoked');

    assert.equal(tier2Events.length, 1, `Expected 1 tier2_invoked event, got ${tier2Events.length}`);
    assert.equal(tier2Events[0].protocol, 'consequence_forecast');
    assert.equal(tier2Events[0].version, 1);
    assert.ok(tier2Events[0].timestamp, 'Event must have a timestamp');
  });

  test('replay_analysis: emits exactly one tier2_invoked event with correct protocol', () => {
    const dir = makeDir({ orchId: 'orch-tgate-replay' });

    const result = runEmitter(
      dir,
      'replay_analysis',
      'enable_replay_analysis true; friction signals detected; replay pattern written'
    );

    assert.equal(result.status, 0, `Script exited ${result.status}; stderr: ${result.stderr}`);

    const events = readEvents(dir);
    const tier2Events = events.filter(e => e.type === 'tier2_invoked');

    assert.equal(tier2Events.length, 1, `Expected 1 tier2_invoked event, got ${tier2Events.length}`);
    assert.equal(tier2Events[0].protocol, 'replay_analysis');
    assert.equal(tier2Events[0].version, 1);
    assert.ok(tier2Events[0].timestamp, 'Event must have a timestamp');
  });

  test('auto_documenter: emits exactly one tier2_invoked event with correct protocol', () => {
    const dir = makeDir({ orchId: 'orch-tgate-autodoc' });

    const result = runEmitter(
      dir,
      'auto_documenter',
      'auto_document true; feature addition detected; documenter agent spawned'
    );

    assert.equal(result.status, 0, `Script exited ${result.status}; stderr: ${result.stderr}`);

    const events = readEvents(dir);
    const tier2Events = events.filter(e => e.type === 'tier2_invoked');

    assert.equal(tier2Events.length, 1, `Expected 1 tier2_invoked event, got ${tier2Events.length}`);
    assert.equal(tier2Events[0].protocol, 'auto_documenter');
    assert.equal(tier2Events[0].version, 1);
    assert.ok(tier2Events[0].timestamp, 'Event must have a timestamp');
  });

  test('disagreement_protocol: emits exactly one tier2_invoked event with correct protocol', () => {
    const dir = makeDir({ orchId: 'orch-tgate-disagree' });

    const result = runEmitter(
      dir,
      'disagreement_protocol',
      'surface_disagreements true; design trade-off detected; surfacing to user'
    );

    assert.equal(result.status, 0, `Script exited ${result.status}; stderr: ${result.stderr}`);

    const events = readEvents(dir);
    const tier2Events = events.filter(e => e.type === 'tier2_invoked');

    assert.equal(tier2Events.length, 1, `Expected 1 tier2_invoked event, got ${tier2Events.length}`);
    assert.equal(tier2Events[0].protocol, 'disagreement_protocol');
    assert.equal(tier2Events[0].version, 1);
    assert.ok(tier2Events[0].timestamp, 'Event must have a timestamp');
  });

  test('cognitive_backpressure: emits exactly one tier2_invoked event with correct protocol', () => {
    const dir = makeDir({ orchId: 'orch-tgate-backpressure' });

    const result = runEmitter(
      dir,
      'cognitive_backpressure',
      'enable_backpressure true; confidence signal read; PM reaction triggered'
    );

    assert.equal(result.status, 0, `Script exited ${result.status}; stderr: ${result.stderr}`);

    const events = readEvents(dir);
    const tier2Events = events.filter(e => e.type === 'tier2_invoked');

    assert.equal(tier2Events.length, 1, `Expected 1 tier2_invoked event, got ${tier2Events.length}`);
    assert.equal(tier2Events[0].protocol, 'cognitive_backpressure');
    assert.equal(tier2Events[0].version, 1);
    assert.ok(tier2Events[0].timestamp, 'Event must have a timestamp');
  });

});
