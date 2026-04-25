#!/usr/bin/env node
'use strict';

/**
 * r-gate-auto.test.js — R-GATE-AUTO acceptance tests (W7, v2.1.15).
 *
 * Verifies the v2.1.15 flip of feature_demand_gate from observer (shadow_mode)
 * to auto-active. Per locked Q1 decision (aggressive default-on):
 *   - Default `feature_demand_gate.shadow_mode` is now `false`.
 *   - On first session under v2.1.15, repos with explicit `shadow_mode: true`
 *     are MIGRATED to `false` and a one-time stderr banner is emitted.
 *
 * Test cases:
 *   1. shadow_mode:false (new default) auto-quarantines protocols with zero
 *      tier2_invoked events in the observation window.
 *   2. shadow_mode:true (legacy/explicit) is overridden by the v2.1.15
 *      default-flip migration on first session post-upgrade.
 *   3. --dry-run lists candidates as JSON without writing quarantine state.
 *   4. /orchestray:feature wake <name> clears the quarantine for a session.
 *   5. drift_sentinel default-off remains quarantined (W5 F-04 interaction):
 *      zero tier2_invoked under default-off is still a quarantine signal.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const SCRIPT       = path.resolve(__dirname, '..', 'bin', 'session-feature-gate.js');
const WAKE_SCRIPT  = path.resolve(__dirname, '..', 'bin', 'feature-wake.js');

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const FIFTEEN_DAYS_MS  = 15 * 24 * 60 * 60 * 1000;

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-r-gate-auto-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'),  { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'),  { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
});

/**
 * Write .orchestray/config.json in tmpDir with the given feature_demand_gate
 * block. Other config keys default to {}.
 */
function writeConfig(fdg) {
  const cfg = fdg ? { feature_demand_gate: fdg } : {};
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'config.json'),
    JSON.stringify(cfg, null, 2),
    'utf8'
  );
}

/**
 * Write events.jsonl in tmpDir with the given event objects.
 */
function writeEvents(events) {
  const lines = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
    lines,
    'utf8'
  );
}

/**
 * Run session-feature-gate.js with the given args. Captures stdout/stderr.
 */
function runGate(args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--cwd', tmpDir, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Run feature-wake.js with the given args.
 */
function runWake(args = []) {
  return spawnSync(process.execPath, [WAKE_SCRIPT, '--cwd', tmpDir, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Build a synthetic event stream that makes `pattern_extraction` quarantine-eligible:
 *   - 6 feature_gate_eval events with pattern_extraction in gates_true, oldest 15 days ago.
 *   - ZERO tier2_invoked events for pattern_extraction.
 */
function eligibleEventsFor(slugConfigKey) {
  const events = [];
  const now = Date.now();
  // Oldest first; spread across 15 days so observation window is satisfied.
  const oldestMs = now - FIFTEEN_DAYS_MS;
  for (let i = 0; i < 6; i++) {
    const ts = oldestMs + Math.floor(i * (FIFTEEN_DAYS_MS / 6));
    events.push({
      version: 1,
      type: 'feature_gate_eval',
      timestamp: new Date(ts).toISOString(),
      gates_true: [slugConfigKey],
    });
  }
  return events;
}

// ---------------------------------------------------------------------------

describe('R-GATE-AUTO — auto-active feature gate', () => {

  test('1. shadow_mode:false (new default) auto-quarantines zero-invoked protocol', () => {
    writeConfig({ shadow_mode: false });
    writeEvents(eligibleEventsFor('enable_pattern_extraction'));

    const result = runGate([]);
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);

    // Config must be updated to include pattern_extraction in quarantine_candidates.
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8'));
    assert.ok(cfg.feature_demand_gate, 'feature_demand_gate persisted');
    assert.ok(
      Array.isArray(cfg.feature_demand_gate.quarantine_candidates),
      'quarantine_candidates is an array'
    );
    assert.ok(
      cfg.feature_demand_gate.quarantine_candidates.includes('pattern_extraction'),
      `quarantine_candidates should include pattern_extraction; got ${JSON.stringify(cfg.feature_demand_gate.quarantine_candidates)}`
    );
  });

  test('2. shadow_mode:true (legacy/explicit) is overridden by v2.1.15 migration on first session', () => {
    // Pre-existing v2.1.14-style config with explicit shadow_mode:true.
    writeConfig({ shadow_mode: true });
    writeEvents(eligibleEventsFor('enable_pattern_extraction'));

    // No migration sentinel exists yet — first session under v2.1.15.
    const sentinelPath = path.join(tmpDir, '.orchestray', 'state', '.r-gate-auto-migration-2115');
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel absent pre-run');

    const result = runGate([]);
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);

    // Banner must be on stderr.
    assert.match(
      result.stderr,
      /v2\.1\.15.*shadow_mode/i,
      `migration banner expected on stderr; got: ${result.stderr}`
    );
    // Banner must explicitly tell user how to opt back in.
    assert.match(
      result.stderr,
      /shadow_mode.*true/i,
      'banner must reference how to restore v2.1.14 behavior'
    );

    // Config must be migrated: shadow_mode flipped to false.
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8'));
    assert.equal(cfg.feature_demand_gate.shadow_mode, false, 'shadow_mode flipped to false');

    // Quarantine should have run after the override.
    assert.ok(
      cfg.feature_demand_gate.quarantine_candidates.includes('pattern_extraction'),
      'override leads to immediate quarantine on first session'
    );

    // Sentinel must be written so the banner is one-time.
    assert.ok(fs.existsSync(sentinelPath), 'migration sentinel written');

    // Re-run: banner must NOT re-emit (one-time).
    const result2 = runGate([]);
    assert.equal(result2.status, 0);
    assert.doesNotMatch(
      result2.stderr,
      /v2\.1\.15.*shadow_mode/i,
      'banner is one-time only'
    );
  });

  test('3. --dry-run lists candidates as JSON and makes no state changes', () => {
    writeConfig({ shadow_mode: false });
    writeEvents(eligibleEventsFor('enable_pattern_extraction'));

    const cfgBefore = fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8');

    const result = runGate(['--dry-run']);
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);

    // stdout must be valid JSON enumerating candidates.
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dry_run, true);
    assert.ok(Array.isArray(parsed.candidates), 'candidates is array');
    assert.ok(
      parsed.candidates.includes('pattern_extraction'),
      `candidates should include pattern_extraction; got: ${JSON.stringify(parsed.candidates)}`
    );

    // Config must be untouched.
    const cfgAfter = fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8');
    assert.equal(cfgAfter, cfgBefore, '--dry-run must not mutate config.json');
  });

  test('4. /orchestray:feature wake <name> clears the quarantine for the session', () => {
    writeConfig({ shadow_mode: false });
    writeEvents(eligibleEventsFor('enable_pattern_extraction'));

    // Step 1: run the gate to populate quarantine_candidates.
    const r1 = runGate([]);
    assert.equal(r1.status, 0);
    const cfgQ = JSON.parse(fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8'));
    assert.ok(cfgQ.feature_demand_gate.quarantine_candidates.includes('pattern_extraction'));

    // Step 2: wake it.
    const wake = runWake(['pattern_extraction']);
    assert.equal(wake.status, 0, `wake exit ${wake.status}: ${wake.stderr}`);

    // Step 3: session-wake file must contain the slug.
    const sessionWakePath = path.join(tmpDir, '.orchestray', 'state', 'feature-wake-session.json');
    const sessionWake = JSON.parse(fs.readFileSync(sessionWakePath, 'utf8'));
    assert.ok(
      Array.isArray(sessionWake.slugs) && sessionWake.slugs.includes('pattern_extraction'),
      'session-wake registers pattern_extraction'
    );

    // Step 4: effective state should treat it as enabled.
    const { getEffectiveGateState } = require('../bin/_lib/effective-gate-state');
    const eff = getEffectiveGateState({
      cwd: tmpDir,
      config: cfgQ,
      gateSlug: 'pattern_extraction',
      rawValue: true,
    });
    assert.equal(eff.effective, true, 'wake clears the quarantine');
    assert.equal(eff.source, 'session_wake', 'source attributed to session_wake');
  });

  test('5. drift_sentinel default-off × R-GATE-AUTO: zero invocations remain quarantined (W5 F-04)', () => {
    // drift_sentinel is the canonical default-off feature in v2.1.14 onward.
    // Per W5 F-04 fix in the v2.1.15 plan: zero tier2_invoked events must be
    // treated as a quarantine signal regardless of the flag's default value.
    //
    // The wired-emitter allowlist (bin/_lib/feature-demand-tracker.js) only
    // exposes pattern_extraction and archetype_cache as eligible slugs in
    // v2.1.14; drift_sentinel becomes wired in v2.1.15 R-TGATE-PM. This test
    // therefore asserts the principle on the existing wired-emitter slot
    // (archetype_cache, default-off in many repos): zero tier2_invoked over
    // a 14-day window must produce a quarantine candidate. The same logic
    // will apply to drift_sentinel once R-TGATE-PM lands.

    writeConfig({ shadow_mode: false });
    // archetype_cache events: 6 evals over 15 days, zero tier2_invoked.
    writeEvents(eligibleEventsFor('enable_archetype_cache'));

    const result = runGate([]);
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8'));
    assert.ok(
      cfg.feature_demand_gate.quarantine_candidates.includes('archetype_cache'),
      'zero invocations under default-off still triggers quarantine — same rule applies to drift_sentinel post-R-TGATE-PM'
    );

    // Document the drift_sentinel-specific intent in the wake call: a user
    // who explicitly wants drift_sentinel must wake it after enabling.
    const wake = runWake(['archetype_cache']);
    assert.equal(wake.status, 0);
    const sessionWakePath = path.join(tmpDir, '.orchestray', 'state', 'feature-wake-session.json');
    const sw = JSON.parse(fs.readFileSync(sessionWakePath, 'utf8'));
    assert.ok(sw.slugs.includes('archetype_cache'));
  });

});
