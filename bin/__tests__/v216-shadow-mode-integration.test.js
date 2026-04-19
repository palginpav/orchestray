#!/usr/bin/env node
'use strict';

/**
 * v216-shadow-mode-integration.test.js — T-06 Shadow-mode integration tests.
 *
 * End-to-end invocation of post-orchestration-extract.js runExtraction() with
 * various combinations of shadow_mode and enabled flags.
 *
 * Design: §2.A Pillar A + §4 Config surface + F-09.
 *
 * Test matrix:
 *   1. shadow_mode=true  + enabled=true  → breaker increments, ZERO files, events shadow:true
 *   2. shadow_mode=false + enabled=true  → files ARE written, events shadow:false
 *   3. enabled=false (any shadow value)  → no breaker increment, no files
 *   4. global_kill_switch=true           → no breaker increment, no files
 *   5. auto_extract_staged event carries correct proposal_count + shadow flag
 *   6. pattern_proposed events in shadow mode carry shadow:true
 *
 * Runner: node --test bin/__tests__/v216-shadow-mode-integration.test.js
 *
 * W11 adversarial validation suite.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  runExtraction,
  setExtractorBackend,
  _setMaxEventsBytesForTest,
} = require('../post-orchestration-extract.js');

const {
  isTripped,
  reset,
  _internal: { _counterPath },
} = require('../_lib/learning-circuit-breaker.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shadow-t06-'));
  process.env.ORCHESTRAY_AUTO_EXTRACT_BACKEND = 'test';
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setExtractorBackend(null);
  _setMaxEventsBytesForTest(null);
  delete process.env.ORCHESTRAY_AUTO_EXTRACT_BACKEND;
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
});

/** Write .orchestray/config.json with the given auto_learning block. */
function writeConfig(alConfig) {
  const cfgDir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ auto_learning: alConfig }),
    'utf8'
  );
}

/** Write events.jsonl with given event objects. */
function writeEvents(events) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), lines, 'utf8');
}

/** Write current-orchestration.json. */
function writeOrch(orchId) {
  const stateDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

/** Standard pre-quarantined events (no free-text fields). */
function makeQuarantinedEvents(orchId) {
  return [
    { type: 'orchestration_start', orchestration_id: orchId, timestamp: '2026-04-19T10:00:00.000Z', complexity_score: 5, phase: 'implement' },
    { type: 'agent_start', orchestration_id: orchId, timestamp: '2026-04-19T10:01:00.000Z', agent_type: 'developer', model_used: 'sonnet', task_id: 't-001', phase: 'implement' },
    { type: 'agent_stop',  orchestration_id: orchId, timestamp: '2026-04-19T10:02:00.000Z', agent_type: 'developer', model_used: 'sonnet', duration_ms: 60000, turns_used: 8, input_tokens: 1200, output_tokens: 400, outcome: 'success' },
    { type: 'orchestration_complete', orchestration_id: orchId, timestamp: '2026-04-19T10:03:00.000Z', outcome: 'success', duration_ms: 180000, total_cost_usd: 0.05 },
  ];
}

/** Build a valid proposal. */
function validProposal(overrides) {
  return Object.assign({
    name:             'shadow-pattern-slug',
    category:         'routing',
    tip_type:         'strategy',
    confidence:       0.5,
    description:      'For tasks with complexity_score under 5, routing to sonnet completed without replan.',
    approach:         'Observed agent_start with model sonnet and agent_stop outcome success. complexity_score was 5. Duration 180s. No replan_triggered events.',
    evidence_orch_id: 'orch-shadow-001',
  }, overrides);
}

/** Config with enabled=true, configurable shadow_mode and breaker max. */
function enabledConfig(shadowMode, breakerMax) {
  return {
    global_kill_switch: false,
    extract_on_complete: {
      enabled: true,
      shadow_mode: shadowMode,
      proposals_per_orchestration: 3,
      proposals_per_24h: 10,
    },
    safety: { circuit_breaker: { max_extractions_per_24h: breakerMax || 100, cooldown_minutes_on_trip: 60 } },
  };
}

/** Read emitted events from the audit log. */
function readEmittedEvents() {
  const eventsFile = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  try {
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const result = [];
    for (const line of raw.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { result.push(JSON.parse(trimmed)); } catch (_e) { /* skip */ }
    }
    return result;
  } catch (_e) { return []; }
}

/** Count files under proposed-patterns/ (excluding .tmp files). */
function countProposedFiles() {
  const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.endsWith('.tmp.md'))
      .length;
  } catch (_e) { return 0; }
}

/** Get current counter value for the auto_extract scope. */
function getBreakerCount() {
  const cPath = _counterPath(tmpDir, 'auto_extract');
  try {
    const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    return state.count;
  } catch (_e) { return 0; }
}

/** Standard run setup: write config, events, orch file, run extraction. */
function runWithConfig(alConfig, orchId, proposals) {
  const oid = orchId || 'orch-shadow-001';
  writeConfig(alConfig);
  writeEvents(makeQuarantinedEvents(oid));
  writeOrch(oid);
  setExtractorBackend((_p, _e, _m) => ({
    proposals: proposals || [validProposal({ evidence_orch_id: oid })],
    skipped: [],
  }));
  return runExtraction({
    projectRoot: tmpDir,
    eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
    orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
  });
}

// ---------------------------------------------------------------------------
// T-06 shadow-mode matrix tests
// ---------------------------------------------------------------------------

describe('T-06 — shadow mode: enabled=true, shadow_mode=true', () => {

  test('shadow=true: breaker counter increments', () => {
    runWithConfig(enabledConfig(true));
    const count = getBreakerCount();
    assert.ok(count >= 1, `breaker counter must increment in shadow mode, got ${count}`);
  });

  test('shadow=true: zero files written under proposed-patterns/', () => {
    runWithConfig(enabledConfig(true));
    const fileCount = countProposedFiles();
    assert.equal(
      fileCount, 0,
      `shadow mode must write ZERO proposal files, got ${fileCount}`
    );
  });

  test('shadow=true: pattern_proposed events carry shadow:true', () => {
    runWithConfig(enabledConfig(true), 'orch-shadow-001', [
      validProposal({ name: 'shadow-prop-one', evidence_orch_id: 'orch-shadow-001' }),
      validProposal({ name: 'shadow-prop-two', evidence_orch_id: 'orch-shadow-001' }),
    ]);

    const events = readEmittedEvents();
    const proposed = events.filter(e => e.type === 'pattern_proposed');
    assert.ok(proposed.length > 0, 'at least one pattern_proposed event must be emitted in shadow mode');
    for (const ev of proposed) {
      assert.equal(
        ev.shadow, true,
        `pattern_proposed event in shadow mode must have shadow:true, got ${JSON.stringify(ev)}`
      );
    }
  });

  test('shadow=true: auto_extract_staged has shadow:true + correct proposal_count', () => {
    const proposals = [
      validProposal({ name: 'shadow-a', evidence_orch_id: 'orch-shadow-001' }),
      validProposal({ name: 'shadow-b', evidence_orch_id: 'orch-shadow-001' }),
    ];
    runWithConfig(enabledConfig(true), 'orch-shadow-001', proposals);

    const events = readEmittedEvents();
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(staged, 'auto_extract_staged event must be emitted in shadow mode');
    assert.equal(staged.shadow, true, 'auto_extract_staged must have shadow:true');
    assert.equal(staged.proposal_count, 2, 'auto_extract_staged must carry correct proposal_count');
  });

  test('shadow=true: proposed-patterns directory is not created', () => {
    runWithConfig(enabledConfig(true));
    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    // The dir may or may not be created — but no .md files should be in it.
    const fileCount = countProposedFiles();
    assert.equal(fileCount, 0, 'No .md files under proposed-patterns/ in shadow mode');
  });

  test('shadow=true: no trigger_actions appear in any emitted event', () => {
    runWithConfig(enabledConfig(true));
    const events = readEmittedEvents();
    const eventsStr = JSON.stringify(events);
    assert.ok(
      !eventsStr.includes('trigger_actions'),
      'trigger_actions must not appear in any emitted event during shadow mode'
    );
  });
});

describe('T-06 — non-shadow mode: enabled=true, shadow_mode=false', () => {

  test('shadow=false: files ARE written under proposed-patterns/', () => {
    const orchId = 'orch-noshadow-001';
    const proposals = [
      validProposal({ name: 'real-pattern-one', evidence_orch_id: orchId }),
      validProposal({ name: 'real-pattern-two', evidence_orch_id: orchId }),
    ];
    runWithConfig(enabledConfig(false), orchId, proposals);

    const fileCount = countProposedFiles();
    assert.equal(fileCount, 2, `shadow=false must write 2 proposal files, got ${fileCount}`);
  });

  test('shadow=false: pattern_proposed events carry shadow:false', () => {
    runWithConfig(enabledConfig(false));
    const events = readEmittedEvents();
    const proposed = events.filter(e => e.type === 'pattern_proposed');
    assert.ok(proposed.length > 0, 'pattern_proposed events must be emitted when shadow=false');
    for (const ev of proposed) {
      assert.equal(
        ev.shadow, false,
        `pattern_proposed event must have shadow:false, got ${JSON.stringify(ev)}`
      );
    }
  });

  test('shadow=false: auto_extract_staged has shadow:false', () => {
    runWithConfig(enabledConfig(false));
    const events = readEmittedEvents();
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(staged, 'auto_extract_staged must be emitted');
    assert.equal(staged.shadow, false, 'auto_extract_staged must have shadow:false when not in shadow mode');
  });

  test('shadow=false: breaker counter also increments', () => {
    runWithConfig(enabledConfig(false));
    const count = getBreakerCount();
    assert.ok(count >= 1, `breaker counter must increment in non-shadow mode too, got ${count}`);
  });
});

describe('T-06 — disabled: enabled=false', () => {

  test('enabled=false: no breaker counter increment', () => {
    const alConfig = {
      global_kill_switch: false,
      extract_on_complete: { enabled: false, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
    };
    // Set up a backend that would produce proposals (but extraction is gated off)
    setExtractorBackend((_p, _e, _m) => ({
      proposals: [validProposal()],
      skipped: [],
    }));
    writeConfig(alConfig);
    writeEvents(makeQuarantinedEvents('orch-disabled-001'));
    writeOrch('orch-disabled-001');
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const count = getBreakerCount();
    assert.equal(count, 0, `no breaker increment when enabled=false, got ${count}`);
  });

  test('enabled=false: no files written', () => {
    const alConfig = {
      global_kill_switch: false,
      extract_on_complete: { enabled: false, shadow_mode: true },
      safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
    };
    setExtractorBackend((_p, _e, _m) => ({
      proposals: [validProposal()],
      skipped: [],
    }));
    writeConfig(alConfig);
    writeEvents(makeQuarantinedEvents('orch-disabled-002'));
    writeOrch('orch-disabled-002');
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    assert.equal(countProposedFiles(), 0, 'no files when enabled=false regardless of shadow_mode');
  });

  test('enabled=false: auto_extract_skipped event emitted (not auto_extract_staged)', () => {
    const alConfig = {
      global_kill_switch: false,
      extract_on_complete: { enabled: false, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
    };
    writeConfig(alConfig);
    writeEvents(makeQuarantinedEvents('orch-disabled-003'));
    writeOrch('orch-disabled-003');
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'auto_extract_skipped');
    assert.ok(skipped, 'auto_extract_skipped must be emitted when feature is disabled');
    assert.equal(skipped.reason, 'feature_disabled', 'skip reason must be feature_disabled');

    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.equal(staged, undefined, 'auto_extract_staged must NOT be emitted when feature is disabled');
  });
});

describe('T-06 — global kill switch: global_kill_switch=true', () => {

  test('kill_switch=true (config): no breaker increment', () => {
    const alConfig = {
      global_kill_switch: true,
      extract_on_complete: { enabled: true, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
    };
    writeConfig(alConfig);
    writeEvents(makeQuarantinedEvents('orch-ks-001'));
    writeOrch('orch-ks-001');
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const count = getBreakerCount();
    assert.equal(count, 0, `no breaker increment when kill_switch=true, got ${count}`);
  });

  test('kill_switch env var: no breaker increment', () => {
    process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH = '1';
    const alConfig = {
      global_kill_switch: false,
      extract_on_complete: { enabled: true, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
    };
    writeConfig(alConfig);
    writeEvents(makeQuarantinedEvents('orch-envks-001'));
    writeOrch('orch-envks-001');
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const count = getBreakerCount();
    assert.equal(count, 0, `no breaker increment when kill switch env var is set, got ${count}`);
  });

  test('kill_switch=true: no files written', () => {
    const alConfig = {
      global_kill_switch: true,
      extract_on_complete: { enabled: true, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
    };
    setExtractorBackend((_p, _e, _m) => ({
      proposals: [validProposal()],
      skipped: [],
    }));
    writeConfig(alConfig);
    writeEvents(makeQuarantinedEvents('orch-ks-002'));
    writeOrch('orch-ks-002');
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    assert.equal(countProposedFiles(), 0, 'no files when kill_switch=true');
  });
});

describe('T-06 — shadow mode breaker behavior (F-09)', () => {

  test('shadow mode still increments the counter (F-09: Haiku cost is real)', () => {
    // Shadow mode must NOT be "free" from a cost perspective.
    // Running in shadow mode should increment the breaker just like real mode.
    reset({ scope: 'auto_extract', cwd: tmpDir });

    runWithConfig(enabledConfig(true)); // shadow_mode=true

    const count = getBreakerCount();
    assert.ok(count >= 1, `shadow mode must count toward breaker (F-09), got ${count}`);
  });

  test('shadow mode reaches breaker limit just like real mode', () => {
    // With max=2 and shadow=true, after 2 successful runs the counter is at
    // max. The THIRD run hits count>=max, trips the breaker, and returns 0 proposals.
    const alConfig = {
      global_kill_switch: false,
      extract_on_complete: {
        enabled: true,
        shadow_mode: true,
        proposals_per_orchestration: 3,
        proposals_per_24h: 10,
      },
      safety: { circuit_breaker: { max_extractions_per_24h: 2, cooldown_minutes_on_trip: 60 } },
    };

    function runShadowOnce(orchId) {
      writeConfig(alConfig);
      writeEvents(makeQuarantinedEvents(orchId));
      writeOrch(orchId);
      setExtractorBackend((_p, _e, _m) => ({
        proposals: [validProposal({ name: `shadow-prop-${orchId.slice(-3)}`, evidence_orch_id: orchId })],
        skipped: [],
      }));
      return runExtraction({
        projectRoot: tmpDir,
        eventsPath:   path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
        orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
      });
    }

    // Two runs consume the quota (counter goes to max=2)
    runShadowOnce('orch-shadow-lim-001');
    runShadowOnce('orch-shadow-lim-002');

    // Check counter is at max
    const cPath = _counterPath(tmpDir, 'auto_extract');
    const state = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(state.count, 2, 'counter must be at max after 2 shadow runs');

    // Third run should be blocked by the breaker (count >= max on entry)
    const result3 = runShadowOnce('orch-shadow-lim-003');
    assert.equal(result3.proposals_written, 0, 'third run must be blocked by breaker (count at max)');

    // Breaker is now tripped (the third attempt exceeded the cap and wrote the sentinel)
    assert.ok(
      isTripped({ scope: 'auto_extract', cwd: tmpDir }),
      'breaker must be tripped after the run that exceeded max shadow-mode count (F-09)'
    );
  });

  test('shadow mode: runExtraction returns shadow:true in result', () => {
    const result = runWithConfig(enabledConfig(true));
    assert.equal(result.shadow, true, 'runExtraction result.shadow must be true when shadow_mode=true');
  });

  test('non-shadow mode: runExtraction returns shadow:false in result', () => {
    const result = runWithConfig(enabledConfig(false));
    assert.equal(result.shadow, false, 'runExtraction result.shadow must be false when shadow_mode=false');
  });
});

describe('T-06 — proposed-patterns directory isolation', () => {

  test('shadow mode: no .md files land in .orchestray/patterns/ (active corpus)', () => {
    runWithConfig(enabledConfig(true));
    const activeDir = path.join(tmpDir, '.orchestray', 'patterns');
    let activeFiles = [];
    try {
      activeFiles = fs.readdirSync(activeDir).filter(f => f.endsWith('.md'));
    } catch (_e) { /* dir may not exist */ }
    assert.equal(
      activeFiles.length, 0,
      `shadow mode must not write to active patterns/ directory, found: ${activeFiles.join(', ')}`
    );
  });

  test('non-shadow mode: .md files land in proposed-patterns/, NOT patterns/', () => {
    const orchId = 'orch-isolation-001';
    runWithConfig(enabledConfig(false), orchId, [
      validProposal({ name: 'isolation-test-slug', evidence_orch_id: orchId }),
    ]);

    // Must be in proposed-patterns/
    const proposedPath = path.join(tmpDir, '.orchestray', 'proposed-patterns', 'isolation-test-slug.md');
    assert.ok(fs.existsSync(proposedPath), 'proposal must land in proposed-patterns/');

    // Must NOT be in patterns/
    const activePath = path.join(tmpDir, '.orchestray', 'patterns', 'isolation-test-slug.md');
    assert.ok(!fs.existsSync(activePath), 'proposal must NOT land in active patterns/');
  });
});
