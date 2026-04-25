'use strict';

/**
 * Regression test: R-GATE demand-measured feature quarantine (v2.1.14).
 *
 * Covers (≥ 30 tests):
 *   - Demand tracker: synthetic events → correct counts and eligibility
 *   - Build-time emitter audit: only pattern_extraction and archetype_cache eligible
 *   - Shadow advisor: emits feature_quarantine_candidate; rate-limits within 24h
 *   - Opt-in immediate path: quarantine_candidates moves gate to gates_false
 *   - /orchestray:feature wake writes session state; feature_wake event emitted
 *   - /orchestray:feature wake --persist writes pinned state
 *   - /orchestray:feature status output is correct
 *   - Auto-release: issues[] matching quarantined feature → feature_wake_auto emitted
 *   - Session banner: prints when features quarantined; silent when none
 *   - Kill switches: feature_demand_gate.enabled:false AND ORCHESTRAY_DISABLE_DEMAND_GATE=1
 *   - Config schema: unknown slug in quarantine_candidates produces warning, not hard error
 *   - effective-gate-state: overlay precedence (session wake > pinned > quarantine > config)
 */

const { test, describe, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');

// ── File-under-test paths ──────────────────────────────────────────────────

const ROOT                 = path.resolve(__dirname, '../..');
const DEMAND_TRACKER       = path.join(ROOT, 'bin/_lib/feature-demand-tracker.js');
const EFFECTIVE_GATE       = path.join(ROOT, 'bin/_lib/effective-gate-state.js');
const ADVISOR_SCRIPT       = path.join(ROOT, 'bin/feature-quarantine-advisor.js');
const GATE_TELEMETRY       = path.join(ROOT, 'bin/gate-telemetry.js');
const WAKE_SCRIPT          = path.join(ROOT, 'bin/feature-wake.js');
const STATUS_SCRIPT        = path.join(ROOT, 'bin/feature-gate-status.js');
const AUTO_RELEASE_SCRIPT  = path.join(ROOT, 'bin/feature-auto-release.js');
const BANNER_SCRIPT        = path.join(ROOT, 'bin/feature-quarantine-banner.js');
const CONFIG_SCHEMA        = path.join(ROOT, 'bin/_lib/config-schema.js');

// ── Helpers ────────────────────────────────────────────────────────────────

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a temp project directory with .orchestray structure.
 *
 * @param {object} opts
 * @param {object|null} opts.config   - Config JSON object (null = no config file)
 * @param {string} opts.orchId        - Orchestration ID
 * @param {object[]} opts.events      - Pre-seeded events for events.jsonl
 * @returns {string} dir
 */
function makeDir({ config = null, orchId = 'orch-rgate-test', events = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-gate-'));
  cleanup.push(dir);

  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Write orchestration state file
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );

  // Write config if provided
  if (config !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(config)
    );
  }

  // Seed events.jsonl if provided
  if (events.length > 0) {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), lines);
  }

  return dir;
}

/**
 * Read all events from .orchestray/audit/events.jsonl.
 */
function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/**
 * Run a script with a JSON payload on stdin.
 */
function runScript(scriptPath, dir, extraEnv = {}, extraArgs = []) {
  const payload = JSON.stringify({ cwd: dir });
  return spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    input: payload,
    encoding: 'utf8',
    timeout: 8000,
    env: Object.assign({}, process.env, extraArgs.length ? {} : {}, extraEnv),
  });
}

/**
 * Run a CLI script (reads argv, not stdin).
 */
function runCli(scriptPath, dir, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, '--cwd', dir, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    env: Object.assign({}, process.env, extraEnv),
  });
}

/** Build a feature_gate_eval event. */
function gateEvalEvent(gatesTrue, gateFalse, timestamp) {
  return {
    version: 1,
    type: 'feature_gate_eval',
    timestamp: timestamp || new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    orchestration_id: 'orch-rgate-synthetic',
    gates_true: gatesTrue,
    gates_false: gateFalse,
    eval_source: 'config_snapshot',
  };
}

/** Build a tier2_invoked event. */
function tier2InvokedEvent(protocol, timestamp) {
  return {
    version: 1,
    type: 'tier2_invoked',
    timestamp: timestamp || new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    orchestration_id: 'orch-rgate-synthetic',
    protocol,
    trigger_signal: 'test signal',
  };
}

// ── Section 1: Demand Tracker ──────────────────────────────────────────────

describe('feature-demand-tracker: compute demand report', () => {

  test('returns empty report when no events exist', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    const dir = makeDir();
    const report = computeDemandReport(dir);
    assert.deepEqual(Object.keys(report).sort(), ['archetype_cache', 'pattern_extraction']);
    // Both should have zero counts
    for (const slug of Object.keys(report)) {
      assert.equal(report[slug].gate_eval_true_count, 0);
      assert.equal(report[slug].tier2_invoked_count, 0);
    }
  });

  test('counts gate_eval_true for pattern_extraction correctly', () => {
    const { computeDemandReport, CONFIG_KEY_TO_GATE_SLUG } = require(DEMAND_TRACKER);
    const events = [];
    // Seed 6 gate_eval events with enable_pattern_extraction in gates_true
    for (let i = 0; i < 6; i++) {
      events.push(gateEvalEvent(['enable_pattern_extraction'], []));
    }
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.gate_eval_true_count, 6);
    assert.equal(report.pattern_extraction.tier2_invoked_count, 0);
  });

  test('counts tier2_invoked for archetype_cache correctly', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    const events = [
      gateEvalEvent(['enable_archetype_cache'], []),
      gateEvalEvent(['enable_archetype_cache'], []),
      gateEvalEvent(['enable_archetype_cache'], []),
      gateEvalEvent(['enable_archetype_cache'], []),
      gateEvalEvent(['enable_archetype_cache'], []),
      gateEvalEvent(['enable_archetype_cache'], []),
      tier2InvokedEvent('archetype_cache'),
      tier2InvokedEvent('archetype_cache'),
    ];
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.archetype_cache.gate_eval_true_count, 6);
    assert.equal(report.archetype_cache.tier2_invoked_count, 2);
  });

  test('demand_ratio is 0.0 when invoked_count is 0', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    const events = Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], []));
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.demand_ratio, 0.0);
  });

  test('demand_ratio computed as invoked / eval_true', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    const events = [
      ...Array(4).fill(null).map(() => gateEvalEvent(['enable_archetype_cache'], [])),
      ...Array(4).fill(null).map(() => gateEvalEvent(['enable_archetype_cache'], [])), // 8 total
      tier2InvokedEvent('archetype_cache'), // 1 invoked
    ];
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.ok(Math.abs(report.archetype_cache.demand_ratio - 1/8) < 0.001);
  });

  test('quarantine_eligible=true when all three conditions met', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    // 15 days ago for first_eval to pass 14-day window
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = [
      ...Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo)),
    ];
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.quarantine_eligible, true, 'should be eligible');
    assert.equal(report.pattern_extraction.ineligible_reason, null);
  });

  test('quarantine_eligible=false when eval_true_count < 5', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(4).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo));
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.quarantine_eligible, false);
    assert.ok(report.pattern_extraction.ineligible_reason.includes('not enough observation'));
  });

  test('quarantine_eligible=false when invoked_count > 0', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = [
      ...Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo)),
      tier2InvokedEvent('pattern_extraction', fifteenDaysAgo),
    ];
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.quarantine_eligible, false);
    assert.ok(report.pattern_extraction.ineligible_reason.includes('protocol has fired'));
  });

  test('quarantine_eligible=false when observation window not elapsed', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    // Events from 3 days ago — window not yet elapsed
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(8).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], threeDaysAgo));
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.quarantine_eligible, false);
    assert.ok(report.pattern_extraction.ineligible_reason.includes('observation window not elapsed'));
  });

  test('events older than 30 days are excluded from counts', () => {
    const { computeDemandReport } = require(DEMAND_TRACKER);
    // Events from 31 days ago should be excluded
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(10).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], thirtyOneDaysAgo));
    const dir = makeDir({ events });
    const report = computeDemandReport(dir);
    assert.equal(report.pattern_extraction.gate_eval_true_count, 0, 'old events must be excluded');
  });

});

// ── Section 2: Build-time emitter audit ────────────────────────────────────

describe('build-time emitter audit: eligible slugs', () => {

  test('WIRED_EMITTER_PROTOCOLS contains exactly pattern_extraction and archetype_cache', () => {
    const { WIRED_EMITTER_PROTOCOLS } = require(DEMAND_TRACKER);
    assert.equal(WIRED_EMITTER_PROTOCOLS.length, 2);
    assert.ok(WIRED_EMITTER_PROTOCOLS.includes('pattern_extraction'));
    assert.ok(WIRED_EMITTER_PROTOCOLS.includes('archetype_cache'));
  });

  test('unwired protocols are not eligible for quarantine (not in WIRED_EMITTER_PROTOCOLS)', () => {
    const { WIRED_EMITTER_PROTOCOLS } = require(DEMAND_TRACKER);
    const unwired = ['drift_sentinel', 'consequence_forecast', 'replay_analysis',
                     'auto_documenter', 'disagreement_protocol', 'cognitive_backpressure'];
    for (const slug of unwired) {
      assert.ok(!WIRED_EMITTER_PROTOCOLS.includes(slug), `${slug} should not be eligible in v2.1.14`);
    }
  });

  test('demand report only includes wired-emitter gates', () => {
    const { computeDemandReport, WIRED_EMITTER_PROTOCOLS } = require(DEMAND_TRACKER);
    const dir = makeDir();
    const report = computeDemandReport(dir);
    const reportSlugs = Object.keys(report).sort();
    const expected = [...WIRED_EMITTER_PROTOCOLS].sort();
    assert.deepEqual(reportSlugs, expected);
  });

});

// ── Section 3: Shadow Advisor ──────────────────────────────────────────────

describe('feature-quarantine-advisor: shadow mode emission', () => {

  test('emits feature_quarantine_candidate for eligible gate', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo));
    const dir = makeDir({ config: {}, events });
    const result = runScript(ADVISOR_SCRIPT, dir);
    assert.equal(result.status, 0);

    const allEvents = readEvents(dir);
    const candidates = allEvents.filter(e => e.type === 'feature_quarantine_candidate');
    assert.equal(candidates.length, 1, 'should emit exactly one candidate event');
    const ev = candidates[0];
    assert.equal(ev.version, 1);
    assert.equal(ev.gate_slug, 'pattern_extraction');
    assert.equal(ev.eval_true_count_30d, 6);
    assert.equal(ev.invoked_count_30d, 0);
  });

  test('does not double-emit within 24h (rate-limit)', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo));
    const dir = makeDir({ config: {}, events });

    // First run
    runScript(ADVISOR_SCRIPT, dir);
    const afterFirst = readEvents(dir).filter(e => e.type === 'feature_quarantine_candidate');
    assert.equal(afterFirst.length, 1, 'first run should emit one event');

    // Second run immediately — cursor should prevent re-emission
    runScript(ADVISOR_SCRIPT, dir);
    const afterSecond = readEvents(dir).filter(e => e.type === 'feature_quarantine_candidate');
    assert.equal(afterSecond.length, 1, 'second run should not duplicate the event');
  });

  test('does not emit when no gate is eligible', () => {
    // Not enough evals (only 2)
    const events = Array(2).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], []));
    const dir = makeDir({ config: {}, events });
    runScript(ADVISOR_SCRIPT, dir);
    const allEvents = readEvents(dir);
    const candidates = allEvents.filter(e => e.type === 'feature_quarantine_candidate');
    assert.equal(candidates.length, 0);
  });

  test('ORCHESTRAY_DISABLE_DEMAND_GATE=1 suppresses advisor', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo));
    const dir = makeDir({ config: {}, events });
    runScript(ADVISOR_SCRIPT, dir, { ORCHESTRAY_DISABLE_DEMAND_GATE: '1' });
    const allEvents = readEvents(dir);
    assert.equal(allEvents.filter(e => e.type === 'feature_quarantine_candidate').length, 0);
  });

  test('feature_demand_gate.enabled:false suppresses advisor', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const events = Array(6).fill(null).map(() => gateEvalEvent(['enable_pattern_extraction'], [], fifteenDaysAgo));
    const dir = makeDir({
      config: { feature_demand_gate: { enabled: false } },
      events,
    });
    runScript(ADVISOR_SCRIPT, dir);
    const allEvents = readEvents(dir);
    assert.equal(allEvents.filter(e => e.type === 'feature_quarantine_candidate').length, 0);
  });

});

// ── Section 4: Opt-in immediate quarantine (gate-telemetry overlay) ────────

describe('gate-telemetry: quarantine_candidates overlay', () => {

  function runGateTelemetry(dir, extraEnv = {}) {
    const payload = JSON.stringify({ cwd: dir });
    return spawnSync(process.execPath, [GATE_TELEMETRY], {
      input: payload,
      encoding: 'utf8',
      timeout: 8000,
      env: Object.assign({}, process.env, extraEnv),
    });
  }

  test('gate in quarantine_candidates appears in gates_false even if config says true', () => {
    const dir = makeDir({
      config: {
        enable_pattern_extraction: true,
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    runGateTelemetry(dir);
    const events = readEvents(dir);
    const ev = events.find(e => e.type === 'feature_gate_eval');
    assert.ok(ev, 'gate_eval event must exist');
    assert.ok(ev.gates_false.includes('enable_pattern_extraction'),
      'quarantined gate must be in gates_false');
    assert.ok(!ev.gates_true.includes('enable_pattern_extraction'),
      'quarantined gate must NOT be in gates_true');
  });

  test('eval_source is config_with_quarantine_overlay when overlay applied', () => {
    const dir = makeDir({
      config: {
        enable_pattern_extraction: true,
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    runGateTelemetry(dir);
    const events = readEvents(dir);
    const ev = events.find(e => e.type === 'feature_gate_eval');
    assert.equal(ev.eval_source, 'config_with_quarantine_overlay');
  });

  test('eval_source remains config_snapshot when no overlay', () => {
    const dir = makeDir({
      config: {
        enable_pattern_extraction: true,
        feature_demand_gate: {
          quarantine_candidates: [],
        },
      },
    });
    runGateTelemetry(dir);
    const events = readEvents(dir);
    const ev = events.find(e => e.type === 'feature_gate_eval');
    assert.equal(ev.eval_source, 'config_snapshot');
  });

  test('session wake overrides quarantine_candidates (gate stays in gates_true)', () => {
    const dir = makeDir({
      config: {
        enable_pattern_extraction: true,
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    // Write session wake for pattern_extraction
    const { addSessionWake } = require(EFFECTIVE_GATE);
    addSessionWake(dir, 'pattern_extraction');

    runGateTelemetry(dir);
    const events = readEvents(dir);
    // Filter to only gate_eval events (addSessionWake doesn't emit events)
    const ev = events.find(e => e.type === 'feature_gate_eval');
    assert.ok(ev, 'gate_eval event must exist');
    // Session wake overrides quarantine; gate should be in gates_true
    assert.ok(ev.gates_true.includes('enable_pattern_extraction'),
      'session-woken gate must be in gates_true despite quarantine');
  });

});

// ── Section 5: feature-wake CLI ────────────────────────────────────────────

describe('feature-wake: session and pinned wake', () => {

  test('wake adds slug to feature-wake-session.json', () => {
    const dir = makeDir({ config: {} });
    const result = runCli(WAKE_SCRIPT, dir, ['pattern_extraction']);
    assert.equal(result.status, 0);
    const sessionFile = path.join(dir, '.orchestray', 'state', 'feature-wake-session.json');
    assert.ok(fs.existsSync(sessionFile), 'session file must exist');
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.ok(Array.isArray(data.slugs), 'slugs must be an array');
    assert.ok(data.slugs.includes('pattern_extraction'));
  });

  test('wake emits feature_wake event with scope=session and caller=cli', () => {
    const dir = makeDir({ config: {} });
    runCli(WAKE_SCRIPT, dir, ['pattern_extraction']);
    const events = readEvents(dir);
    const wakeEv = events.find(e => e.type === 'feature_wake');
    assert.ok(wakeEv, 'feature_wake event must exist');
    assert.equal(wakeEv.version, 1);
    assert.equal(wakeEv.gate_slug, 'pattern_extraction');
    assert.equal(wakeEv.scope, 'session');
    assert.equal(wakeEv.caller, 'cli');
  });

  test('wake --persist adds slug to feature-wake-pinned.json with expiry', () => {
    const dir = makeDir({ config: {} });
    runCli(WAKE_SCRIPT, dir, ['--persist', 'archetype_cache']);
    const pinnedFile = path.join(dir, '.orchestray', 'state', 'feature-wake-pinned.json');
    assert.ok(fs.existsSync(pinnedFile), 'pinned file must exist');
    const data = JSON.parse(fs.readFileSync(pinnedFile, 'utf8'));
    assert.ok(Array.isArray(data.entries), 'entries must be an array');
    const entry = data.entries.find(e => e.slug === 'archetype_cache');
    assert.ok(entry, 'entry for archetype_cache must exist');
    assert.ok(entry.until, 'entry must have until field');
    // Verify until is ~30 days from now
    const untilMs = Date.parse(entry.until);
    const nowMs = Date.now();
    const diffDays = (untilMs - nowMs) / (24 * 60 * 60 * 1000);
    assert.ok(diffDays > 29 && diffDays < 31, `until should be ~30 days out, got ${diffDays}`);
  });

  test('wake --persist emits feature_wake event with scope=30d_pinned', () => {
    const dir = makeDir({ config: {} });
    runCli(WAKE_SCRIPT, dir, ['--persist', 'archetype_cache']);
    const events = readEvents(dir);
    const wakeEv = events.find(e => e.type === 'feature_wake');
    assert.ok(wakeEv, 'feature_wake event must exist');
    assert.equal(wakeEv.scope, '30d_pinned');
    assert.equal(wakeEv.caller, 'cli');
  });

  test('wake with unknown slug produces warning on stderr but still writes', () => {
    const dir = makeDir({ config: {} });
    const result = runCli(WAKE_SCRIPT, dir, ['unknown_gate_xyz']);
    assert.equal(result.status, 0);
    assert.ok(result.stderr.includes('not a recognized gate slug'), 'should warn about unknown slug');
    // But still writes to session file
    const sessionFile = path.join(dir, '.orchestray', 'state', 'feature-wake-session.json');
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.ok(data.slugs.includes('unknown_gate_xyz'));
  });

  test('wake is idempotent: adding same slug twice does not duplicate', () => {
    const dir = makeDir({ config: {} });
    runCli(WAKE_SCRIPT, dir, ['pattern_extraction']);
    runCli(WAKE_SCRIPT, dir, ['pattern_extraction']);
    const sessionFile = path.join(dir, '.orchestray', 'state', 'feature-wake-session.json');
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const count = data.slugs.filter(s => s === 'pattern_extraction').length;
    assert.equal(count, 1, 'slug should appear only once');
  });

});

// ── Section 6: feature-gate-status CLI ────────────────────────────────────

describe('feature-gate-status: status output', () => {

  test('status shows quarantine candidates from config', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    const result = runCli(STATUS_SCRIPT, dir, []);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('pattern_extraction'), 'should list quarantine candidate');
    assert.ok(result.stdout.includes('Feature Demand Gate Status'), 'should have header');
  });

  test('status shows (none) when no quarantine candidates', () => {
    const dir = makeDir({ config: {} });
    const result = runCli(STATUS_SCRIPT, dir, []);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('(none)'), 'should indicate none quarantined');
  });

  test('status shows active quarantines when feature is quarantined', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['archetype_cache'],
        },
      },
    });
    const result = runCli(STATUS_SCRIPT, dir, []);
    assert.ok(result.stdout.includes('archetype_cache'), 'quarantined slug should appear');
    assert.ok(result.stdout.includes('[opt-in via quarantine_candidates]'), 'source label must show');
  });

  test('status disabled message when ORCHESTRAY_DISABLE_DEMAND_GATE=1', () => {
    const dir = makeDir({ config: {} });
    const result = runCli(STATUS_SCRIPT, dir, [], { ORCHESTRAY_DISABLE_DEMAND_GATE: '1' });
    assert.ok(result.stdout.includes('disabled'), 'should report disabled state');
  });

});

// ── Section 7: Auto-release (feature-auto-release.js) ─────────────────────

describe('feature-auto-release: issues[] namespace scanning', () => {

  test('issues[] with matching text wakes pattern_extraction and emits feature_wake_auto', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });

    // Simulate PostToolUse payload with structured result containing matching issues[]
    const payload = JSON.stringify({
      cwd: dir,
      tool_result: JSON.stringify({
        status: 'partial',
        issues: ['pattern extraction failed to fire on this orchestration'],
      }),
    });

    const result = spawnSync(process.execPath, [AUTO_RELEASE_SCRIPT], {
      input: payload,
      encoding: 'utf8',
      timeout: 8000,
      env: Object.assign({}, process.env),
    });

    assert.equal(result.status, 0);

    // Check feature_wake_auto event emitted
    const events = readEvents(dir);
    const wakeAuto = events.find(e => e.type === 'feature_wake_auto');
    assert.ok(wakeAuto, 'feature_wake_auto event must be emitted');
    assert.equal(wakeAuto.version, 1);
    assert.equal(wakeAuto.gate_slug, 'pattern_extraction');
    assert.ok(wakeAuto.match_text.includes('pattern extraction'), 'match_text must contain matched text');

    // Check session wake was added
    const { readSessionWakes } = require(EFFECTIVE_GATE);
    const wakes = readSessionWakes(dir);
    assert.ok(wakes.has('pattern_extraction'), 'pattern_extraction must be in session wakes');
  });

  test('issues[] without matching text does not wake any feature', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });

    const payload = JSON.stringify({
      cwd: dir,
      tool_result: JSON.stringify({
        issues: ['unrelated issue text about something else'],
      }),
    });

    spawnSync(process.execPath, [AUTO_RELEASE_SCRIPT], {
      input: payload,
      encoding: 'utf8',
      timeout: 8000,
      env: Object.assign({}, process.env),
    });

    const events = readEvents(dir);
    assert.equal(events.filter(e => e.type === 'feature_wake_auto').length, 0);
  });

  test('ORCHESTRAY_DISABLE_DEMAND_GATE=1 suppresses auto-release', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });

    const payload = JSON.stringify({
      cwd: dir,
      tool_result: JSON.stringify({
        issues: ['pattern extraction failed'],
      }),
    });

    spawnSync(process.execPath, [AUTO_RELEASE_SCRIPT], {
      input: payload,
      encoding: 'utf8',
      timeout: 8000,
      env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_DEMAND_GATE: '1' }),
    });

    const events = readEvents(dir);
    assert.equal(events.filter(e => e.type === 'feature_wake_auto').length, 0);
  });

  test('archetype_cache issues text triggers auto-release for archetype_cache', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['archetype_cache'],
        },
      },
    });

    const payload = JSON.stringify({
      cwd: dir,
      tool_result: JSON.stringify({
        issues: ['archetype cache lookup returned no results'],
      }),
    });

    spawnSync(process.execPath, [AUTO_RELEASE_SCRIPT], {
      input: payload,
      encoding: 'utf8',
      timeout: 8000,
      env: Object.assign({}, process.env),
    });

    const events = readEvents(dir);
    const wakeAuto = events.find(e => e.type === 'feature_wake_auto');
    assert.ok(wakeAuto, 'feature_wake_auto must be emitted for archetype_cache');
    assert.equal(wakeAuto.gate_slug, 'archetype_cache');
  });

});

// ── Section 8: Session Banner ──────────────────────────────────────────────

describe('feature-quarantine-banner: session banner', () => {

  test('prints banner to stderr when features are quarantined', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    const result = runScript(BANNER_SCRIPT, dir);
    assert.equal(result.status, 0);
    assert.ok(result.stderr.includes('Quarantined this session'), 'banner must be on stderr');
    assert.ok(result.stderr.includes('pattern_extraction'), 'banner must name the quarantined slug');
    assert.ok(result.stderr.includes('/orchestray:feature wake'), 'banner must show re-enable command');
  });

  test('no banner when quarantine_candidates is empty', () => {
    const dir = makeDir({ config: { feature_demand_gate: { quarantine_candidates: [] } } });
    const result = runScript(BANNER_SCRIPT, dir);
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes('Quarantined'), 'no banner when nothing quarantined');
  });

  test('no banner when feature_demand_gate.enabled is false', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          enabled: false,
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    const result = runScript(BANNER_SCRIPT, dir);
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes('Quarantined'), 'no banner when gate disabled');
  });

  test('ORCHESTRAY_DISABLE_DEMAND_GATE=1 suppresses banner', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: { quarantine_candidates: ['archetype_cache'] },
      },
    });
    const result = runScript(BANNER_SCRIPT, dir, { ORCHESTRAY_DISABLE_DEMAND_GATE: '1' });
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes('Quarantined'), 'ORCHESTRAY_DISABLE_DEMAND_GATE=1 must suppress banner');
  });

  test('no banner when woken gate is in quarantine_candidates', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: { quarantine_candidates: ['pattern_extraction'] },
      },
    });
    // Wake the gate so it's not actually quarantined this session
    const { addSessionWake } = require(EFFECTIVE_GATE);
    addSessionWake(dir, 'pattern_extraction');

    const result = runScript(BANNER_SCRIPT, dir);
    assert.equal(result.status, 0);
    // Banner should be suppressed (gate woken = not quarantined)
    assert.ok(!result.stderr.includes('Quarantined'), 'woken gate should not appear in banner');
  });

});

// ── Section 9: Config Schema ───────────────────────────────────────────────

describe('config-schema: feature_demand_gate block', () => {

  let loadFeatureDemandGateConfig, validateFeatureDemandGateConfig, DEFAULT_FEATURE_DEMAND_GATE;

  before(() => {
    const schema = require(CONFIG_SCHEMA);
    loadFeatureDemandGateConfig   = schema.loadFeatureDemandGateConfig;
    validateFeatureDemandGateConfig = schema.validateFeatureDemandGateConfig;
    DEFAULT_FEATURE_DEMAND_GATE    = schema.DEFAULT_FEATURE_DEMAND_GATE;
  });

  test('default: enabled=true, observation_window_days=14, quarantine_candidates=[]', () => {
    assert.equal(DEFAULT_FEATURE_DEMAND_GATE.enabled, true);
    assert.equal(DEFAULT_FEATURE_DEMAND_GATE.observation_window_days, 14);
    assert.deepEqual([...DEFAULT_FEATURE_DEMAND_GATE.quarantine_candidates], []);
  });

  test('loads feature_demand_gate from config.json correctly', () => {
    const dir = makeDir({
      config: {
        feature_demand_gate: {
          enabled: true,
          observation_window_days: 21,
          quarantine_candidates: ['pattern_extraction'],
        },
      },
    });
    const loaded = loadFeatureDemandGateConfig(dir);
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.observation_window_days, 21);
    assert.deepEqual(loaded.quarantine_candidates, ['pattern_extraction']);
  });

  test('unknown slug in quarantine_candidates produces validation warning, not hard error', () => {
    const result = validateFeatureDemandGateConfig({
      enabled: true,
      observation_window_days: 14,
      quarantine_candidates: ['completely_unknown_slug'],
    });
    // Should return invalid (warning) but NOT throw
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('completely_unknown_slug')),
      'error must mention the unknown slug');
    assert.ok(result.errors.some(e => e.includes('pattern_extraction')),
      'error must list eligible slugs');
  });

  test('valid quarantine_candidates passes validation', () => {
    const result = validateFeatureDemandGateConfig({
      enabled: true,
      observation_window_days: 14,
      quarantine_candidates: ['pattern_extraction', 'archetype_cache'],
    });
    assert.equal(result.valid, true);
  });

  test('enabled:false passes validation', () => {
    const result = validateFeatureDemandGateConfig({
      enabled: false,
      observation_window_days: 14,
      quarantine_candidates: [],
    });
    assert.equal(result.valid, true);
  });

  test('missing config file returns defaults (fail-open)', () => {
    const dir = makeDir(); // no config
    const loaded = loadFeatureDemandGateConfig(dir);
    assert.equal(loaded.enabled, DEFAULT_FEATURE_DEMAND_GATE.enabled);
    assert.equal(loaded.observation_window_days, DEFAULT_FEATURE_DEMAND_GATE.observation_window_days);
    assert.deepEqual(loaded.quarantine_candidates, [...DEFAULT_FEATURE_DEMAND_GATE.quarantine_candidates]);
  });

});

// ── Section 10: effective-gate-state overlay precedence ───────────────────

describe('effective-gate-state: overlay precedence', () => {

  test('quarantine_overlay makes gate false even when config says true', () => {
    const { getEffectiveGateState } = require(EFFECTIVE_GATE);
    const dir = makeDir();
    const config = { feature_demand_gate: { quarantine_candidates: ['pattern_extraction'] } };
    const result = getEffectiveGateState({ cwd: dir, config, gateSlug: 'pattern_extraction', rawValue: true });
    assert.equal(result.effective, false);
    assert.equal(result.source, 'quarantine_overlay');
  });

  test('session_wake overrides quarantine_overlay', () => {
    const { getEffectiveGateState, addSessionWake } = require(EFFECTIVE_GATE);
    const dir = makeDir();
    addSessionWake(dir, 'pattern_extraction');
    const config = { feature_demand_gate: { quarantine_candidates: ['pattern_extraction'] } };
    const result = getEffectiveGateState({ cwd: dir, config, gateSlug: 'pattern_extraction', rawValue: false });
    assert.equal(result.effective, true);
    assert.equal(result.source, 'session_wake');
  });

  test('pinned_wake overrides quarantine_overlay', () => {
    const { getEffectiveGateState, addPinnedWake } = require(EFFECTIVE_GATE);
    const dir = makeDir();
    addPinnedWake(dir, 'archetype_cache');
    const config = { feature_demand_gate: { quarantine_candidates: ['archetype_cache'] } };
    const result = getEffectiveGateState({ cwd: dir, config, gateSlug: 'archetype_cache', rawValue: false });
    assert.equal(result.effective, true);
    assert.equal(result.source, 'pinned_wake');
  });

  test('config value used when no overlay applies', () => {
    const { getEffectiveGateState } = require(EFFECTIVE_GATE);
    const dir = makeDir();
    const config = {};
    const result = getEffectiveGateState({ cwd: dir, config, gateSlug: 'pattern_extraction', rawValue: true });
    assert.equal(result.effective, true);
    assert.equal(result.source, 'config');
  });

});
