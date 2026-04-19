#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/post-orchestration-extract.js (v2.1.6 — W3 auto-extraction hook).
 *
 * Design contract: test fixtures are pre-stripped (post-quarantine) format.
 * Raw events.jsonl → quarantined format tests belong in W11.
 *
 * Runner: node --test bin/_lib/__tests__/post-orchestration-extract.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  runExtraction,
  setExtractorBackend,
  _buildOrchestrationMeta,
  AUTO_EXTRACT_CATEGORY_ALLOWLIST,
  _setMaxEventsBytesForTest,
} = require('../../post-orchestration-extract.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-extract-test-'));
  // Set test backend env so spawnExtractor goes through _testBackend.
  process.env.ORCHESTRAY_AUTO_EXTRACT_BACKEND = 'test';
  // Clear kill switch env.
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setExtractorBackend(null);
  _setMaxEventsBytesForTest(null);
  delete process.env.ORCHESTRAY_AUTO_EXTRACT_BACKEND;
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
});

/** Write config.json with auto_learning section. */
function writeConfig(alConfig) {
  const cfgDir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ auto_learning: alConfig }),
    'utf8'
  );
}

/** Write events.jsonl with given event objects (each on its own line). */
function writeEvents(events) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), lines, 'utf8');
}

/** Write current-orchestration.json. */
function writeOrch(orchId) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

/** Standard pre-stripped events (already post-quarantine). */
function makeQuarantinedEvents(orchId) {
  return [
    { type: 'orchestration_start', orchestration_id: orchId, timestamp: '2026-04-19T10:00:00.000Z', complexity_score: 5, phase: 'implement' },
    { type: 'agent_start', orchestration_id: orchId, timestamp: '2026-04-19T10:01:00.000Z', agent_type: 'developer', model_used: 'sonnet', task_id: 't-001', phase: 'implement' },
    { type: 'agent_stop',  orchestration_id: orchId, timestamp: '2026-04-19T10:02:00.000Z', agent_type: 'developer', model_used: 'sonnet', duration_ms: 60000, turns_used: 8, input_tokens: 1200, output_tokens: 400, outcome: 'success' },
    { type: 'orchestration_complete', orchestration_id: orchId, timestamp: '2026-04-19T10:03:00.000Z', outcome: 'success', duration_ms: 180000, total_cost_usd: 0.05 },
  ];
}

/** Build a valid proposal object. */
function validProposal(overrides) {
  return Object.assign({
    name:             'test-pattern-slug',
    category:         'routing',
    tip_type:         'strategy',
    confidence:       0.5,
    description:      'For tasks with complexity_score under 5, routing to sonnet completed without replan.',
    approach:         'Observed agent_start with model_used sonnet and agent_stop outcome success, followed by orchestration_complete outcome success with zero replan_triggered. complexity_score was 5. Duration 180s.',
    evidence_orch_id: 'orch-test-001',
  }, overrides);
}

/** Read all parseable events from events.jsonl in tmpDir. */
function readEmittedEvents() {
  const eventsFile = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  try {
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const result = [];
    for (const line of raw.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { result.push(JSON.parse(trimmed)); } catch (_e) { /* skip malformed */ }
    }
    return result;
  } catch (_e) {
    return [];
  }
}

/** Run the extraction pipeline with feature enabled. */
function runEnabled(overrides) {
  const orchId = (overrides && overrides.orchId) || 'orch-test-001';
  const events = (overrides && overrides.events) || makeQuarantinedEvents(orchId);
  if (overrides && overrides.events !== null) {
    writeEvents(events);
  }
  writeOrch(orchId);
  // W7: breaker params now under safety.circuit_breaker (design §4).
  // Use high max_extractions_per_24h so tests don't hit the breaker.
  writeConfig({
    global_kill_switch: false,
    extract_on_complete: {
      enabled: true,
      shadow_mode: (overrides && overrides.shadow) || false,
      ...(overrides && overrides.extractConfig || {}),
    },
    safety: { circuit_breaker: { max_extractions_per_24h: 100, cooldown_minutes_on_trip: 60 } },
  });
  return runExtraction({
    projectRoot: tmpDir,
    eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
    orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
  });
}

// ---------------------------------------------------------------------------
// Happy path: 3 valid proposals → 3 files
// ---------------------------------------------------------------------------

describe('happy path — 3 valid proposals', () => {
  test('writes 3 files under proposed-patterns/, emits auto_extract_staged with count=3', () => {
    const orchId = 'orch-test-001';

    setExtractorBackend((_prompt, _events, _meta) => ({
      proposals: [
        validProposal({ name: 'pattern-alpha', evidence_orch_id: orchId }),
        validProposal({ name: 'pattern-beta',  evidence_orch_id: orchId }),
        validProposal({ name: 'pattern-gamma', evidence_orch_id: orchId }),
      ],
      skipped: [],
    }));

    const result = runEnabled({ orchId });

    assert.equal(result.proposals_written, 3);
    assert.equal(result.shadow, false);

    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 3);
    assert.ok(files.includes('pattern-alpha.md'));
    assert.ok(files.includes('pattern-beta.md'));
    assert.ok(files.includes('pattern-gamma.md'));

    // Verify auto_extract_staged event
    const events = readEmittedEvents();
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(staged, 'auto_extract_staged must be emitted');
    assert.equal(staged.proposal_count, 3);
    assert.equal(staged.shadow, false);
    assert.equal(staged.orchestration_id, orchId);
  });

  test('proposed file contains correct frontmatter fields', () => {
    const orchId = 'orch-test-001';
    setExtractorBackend(() => ({
      proposals: [validProposal({ name: 'my-pattern', evidence_orch_id: orchId })],
      skipped: [],
    }));

    runEnabled({ orchId });

    const filePath = path.join(tmpDir, '.orchestray', 'proposed-patterns', 'my-pattern.md');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('proposed: true'));
    assert.ok(content.includes('schema_version: 2'));
    assert.ok(content.includes('proposed_from: ' + orchId));
    assert.ok(content.includes('layer_b_markers: []'));
    // Must NOT contain protected fields
    assert.ok(!content.includes('trigger_actions'));
    assert.ok(!content.includes('deprecated'));
    assert.ok(!content.includes('times_applied'));
  });
});

// ---------------------------------------------------------------------------
// Kill switch — env
// ---------------------------------------------------------------------------

describe('kill switch — env', () => {
  test('env kill switch → no files, auto_extract_skipped with kill_switch_env', () => {
    process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH = '1';

    setExtractorBackend(() => ({
      proposals: [validProposal()],
      skipped: [],
    }));

    const orchId = 'orch-test-001';
    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    writeConfig({ extract_on_complete: { enabled: true } });

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    const exists = fs.existsSync(dir);
    if (exists) assert.equal(fs.readdirSync(dir).length, 0);

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'auto_extract_skipped');
    assert.ok(skipped, 'auto_extract_skipped must be emitted');
    assert.equal(skipped.reason, 'kill_switch_env');
  });
});

// ---------------------------------------------------------------------------
// Kill switch — config
// ---------------------------------------------------------------------------

describe('kill switch — config', () => {
  test('config kill switch → no files, reason kill_switch_config', () => {
    const orchId = 'orch-test-001';
    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    writeConfig({
      global_kill_switch: true,
      extract_on_complete: { enabled: true },
    });

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'auto_extract_skipped');
    assert.ok(skipped);
    assert.equal(skipped.reason, 'kill_switch_config');
  });
});

// ---------------------------------------------------------------------------
// Feature disabled (default)
// ---------------------------------------------------------------------------

describe('feature disabled', () => {
  test('when extract_on_complete.enabled is not true → reason feature_disabled', () => {
    const orchId = 'orch-test-001';
    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    writeConfig({});  // no extract_on_complete

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'auto_extract_skipped');
    assert.ok(skipped);
    assert.equal(skipped.reason, 'feature_disabled');
  });

  test('when config.json missing entirely → reason feature_disabled', () => {
    const orchId = 'orch-test-001';
    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    // No config file written.

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'auto_extract_skipped');
    assert.ok(skipped);
    assert.equal(skipped.reason, 'feature_disabled');
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker tripped
// ---------------------------------------------------------------------------

describe('circuit breaker tripped', () => {
  test('breaker tripped → no files, reason circuit_breaker_tripped', () => {
    const orchId = 'orch-test-001';
    // W7: breaker config is now under safety.circuit_breaker in config-schema loader.
    // Set max_extractions_per_24h=1 and run twice: first run passes, second trips.
    const alCfg = {
      extract_on_complete: { enabled: true },
      safety: { circuit_breaker: { max_extractions_per_24h: 1, cooldown_minutes_on_trip: 60 } },
    };

    setExtractorBackend(() => ({
      proposals: [validProposal({ evidence_orch_id: orchId })],
      skipped: [],
    }));

    // First run — should succeed (count goes to 1, trips at limit).
    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    writeConfig(alCfg);
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    // Second run — should be tripped.
    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    writeConfig(alCfg);
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'auto_extract_skipped' && e.reason === 'circuit_breaker_tripped');
    assert.ok(skipped, 'auto_extract_skipped(circuit_breaker_tripped) must be emitted on second run');

    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    if (fs.existsSync(dir)) {
      // Only 1 file from the first successful run (single proposal).
      assert.ok(fs.readdirSync(dir).length <= 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Shadow mode
// ---------------------------------------------------------------------------

describe('shadow mode', () => {
  test('2 valid proposals → 0 files, 2 pattern_proposed (shadow:true), auto_extract_staged (shadow:true)', () => {
    const orchId = 'orch-test-001';

    setExtractorBackend(() => ({
      proposals: [
        validProposal({ name: 'shadow-pat-a', evidence_orch_id: orchId }),
        validProposal({ name: 'shadow-pat-b', evidence_orch_id: orchId }),
      ],
      skipped: [],
    }));

    const result = runEnabled({ orchId, shadow: true });

    assert.equal(result.shadow, true);
    assert.equal(result.proposals_written, 2);

    // Zero files written
    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      assert.equal(files.length, 0);
    }

    const events = readEmittedEvents();
    const proposed = events.filter(e => e.type === 'pattern_proposed');
    assert.equal(proposed.length, 2);
    for (const p of proposed) {
      assert.equal(p.shadow, true);
    }

    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(staged);
    assert.equal(staged.shadow, true);
    assert.equal(staged.proposal_count, 2);
  });

  test('shadow mode still increments breaker counter', () => {
    // Run shadow mode 3 times with max=3; the 4th should be circuit_breaker_tripped.
    // W7: breaker config now under safety.circuit_breaker.max_extractions_per_24h.
    const makeSetup = () => {
      writeOrch('orch-test-shadow');
      writeEvents(makeQuarantinedEvents('orch-test-shadow'));
      writeConfig({
        extract_on_complete: {
          enabled: true,
          shadow_mode: true,  // CHG-01: canonical key
        },
        safety: { circuit_breaker: { max_extractions_per_24h: 3, cooldown_minutes_on_trip: 60 } },
      });
    };

    setExtractorBackend(() => ({ proposals: [], skipped: [] }));

    for (let i = 0; i < 3; i++) {
      makeSetup();
      runExtraction({
        projectRoot: tmpDir,
        eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
        orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
      });
    }

    // 4th run should trip
    makeSetup();
    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const tripped = events.filter(e => e.type === 'auto_extract_skipped' && e.reason === 'circuit_breaker_tripped');
    assert.ok(tripped.length >= 1, 'breaker should trip after 3 shadow runs');
  });
});

// ---------------------------------------------------------------------------
// Validator rejects all proposals
// ---------------------------------------------------------------------------

describe('validator rejects all proposals', () => {
  test('all invalid → 0 files, per-proposal pattern_extraction_skipped, auto_extract_staged count=0', () => {
    const orchId = 'orch-test-001';

    setExtractorBackend(() => ({
      proposals: [
        { name: 'bad!', category: 'routing', confidence: 0.5, description: 'x'.repeat(10), approach: 'y'.repeat(20), evidence_orch_id: orchId },
        { name: 'also-bad', category: 'routing', confidence: 0.99, description: 'ok description here.', approach: 'y'.repeat(20), evidence_orch_id: orchId },
      ],
      skipped: [],
    }));

    const result = runEnabled({ orchId });
    assert.equal(result.proposals_written, 0);

    const events = readEmittedEvents();
    const skipped = events.filter(e => e.type === 'pattern_extraction_skipped' && e.reason === 'validator_rejected');
    assert.equal(skipped.length, 2);

    // Verify validator skips never echo values
    for (const s of skipped) {
      const detail = JSON.stringify(s.detail || '');
      assert.ok(!detail.includes('bad!'), 'error detail must not echo rejected name value');
      assert.ok(!detail.includes('0.99'), 'error detail must not echo rejected confidence value');
    }

    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(staged);
    assert.equal(staged.proposal_count, 0);
  });
});

// ---------------------------------------------------------------------------
// Category not in allowlist (anti-pattern)
// ---------------------------------------------------------------------------

describe('category not in allowlist', () => {
  test('anti-pattern category → skipped with category_restricted_to_auto', () => {
    const orchId = 'orch-test-001';

    setExtractorBackend(() => ({
      proposals: [
        validProposal({ name: 'bad-category', category: 'anti-pattern', evidence_orch_id: orchId }),
        validProposal({ name: 'user-cor', category: 'user-correction', evidence_orch_id: orchId }),
      ],
      skipped: [],
    }));

    const result = runEnabled({ orchId });
    assert.equal(result.proposals_written, 0);

    const events = readEmittedEvents();
    const skipped = events.filter(e => e.type === 'pattern_extraction_skipped' && e.reason === 'category_restricted_to_auto');
    assert.equal(skipped.length, 2);
  });

  test('AUTO_EXTRACT_CATEGORY_ALLOWLIST contains exactly the 4 expected values', () => {
    assert.ok(AUTO_EXTRACT_CATEGORY_ALLOWLIST.has('decomposition'));
    assert.ok(AUTO_EXTRACT_CATEGORY_ALLOWLIST.has('routing'));
    assert.ok(AUTO_EXTRACT_CATEGORY_ALLOWLIST.has('specialization'));
    assert.ok(AUTO_EXTRACT_CATEGORY_ALLOWLIST.has('design-preference'));
    assert.ok(!AUTO_EXTRACT_CATEGORY_ALLOWLIST.has('anti-pattern'));
    assert.ok(!AUTO_EXTRACT_CATEGORY_ALLOWLIST.has('user-correction'));
    assert.equal(AUTO_EXTRACT_CATEGORY_ALLOWLIST.size, 4);
  });
});

// ---------------------------------------------------------------------------
// Slug collision
// ---------------------------------------------------------------------------

describe('slug collision', () => {
  test('collision with existing proposed-pattern → skipped, no file written', () => {
    const orchId = 'orch-test-001';
    const slug   = 'existing-slug';

    // Pre-create collision file in proposed-patterns
    const proposedDir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    fs.mkdirSync(proposedDir, { recursive: true });
    fs.writeFileSync(path.join(proposedDir, slug + '.md'), 'existing content', 'utf8');

    setExtractorBackend(() => ({
      proposals: [validProposal({ name: slug, evidence_orch_id: orchId })],
      skipped: [],
    }));

    const result = runEnabled({ orchId });
    assert.equal(result.proposals_written, 0);

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'pattern_extraction_skipped' && e.reason === 'slug_collision');
    assert.ok(skipped, 'slug_collision skip must be emitted');
    // File content unchanged
    const content = fs.readFileSync(path.join(proposedDir, slug + '.md'), 'utf8');
    assert.equal(content, 'existing content');
  });

  test('collision with active patterns/ → skipped', () => {
    const orchId = 'orch-test-001';
    const slug   = 'active-slug';

    // Pre-create collision file in active patterns
    const activeDir = path.join(tmpDir, '.orchestray', 'patterns');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, slug + '.md'), 'active pattern', 'utf8');

    setExtractorBackend(() => ({
      proposals: [validProposal({ name: slug, evidence_orch_id: orchId })],
      skipped: [],
    }));

    const result = runEnabled({ orchId });
    assert.equal(result.proposals_written, 0);

    const events = readEmittedEvents();
    const skipped = events.find(e => e.type === 'pattern_extraction_skipped' && e.reason === 'slug_collision');
    assert.ok(skipped);
  });
});

// ---------------------------------------------------------------------------
// input_too_large
// ---------------------------------------------------------------------------

describe('input_too_large', () => {
  test('kept.length > 500 → auto_extract_skipped with input_too_large', () => {
    const orchId = 'orch-test-001';

    // Build 501 quarantined events (all of type agent_stop — known allowed type).
    const events = [];
    for (let i = 0; i < 501; i++) {
      events.push({
        type: 'agent_stop',
        orchestration_id: orchId,
        timestamp: '2026-04-19T10:00:00.000Z',
        agent_type: 'developer',
        model_used: 'sonnet',
        duration_ms: 1000,
        turns_used: 5,
        input_tokens: 100,
        output_tokens: 50,
        outcome: 'success',
      });
    }

    setExtractorBackend(() => ({
      proposals: [validProposal({ evidence_orch_id: orchId })],
      skipped: [],
    }));

    writeEvents(events);
    writeOrch(orchId);
    writeConfig({
      extract_on_complete: { enabled: true },
      safety: { circuit_breaker: { max_extractions_per_24h: 100 } },
    });

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const emitted = readEmittedEvents();
    const skipped = emitted.find(e => e.type === 'auto_extract_skipped' && e.reason === 'input_too_large');
    assert.ok(skipped, 'input_too_large skip must be emitted');
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL line
// ---------------------------------------------------------------------------

describe('malformed JSONL line', () => {
  test('one bad line → skipped, remaining events processed', () => {
    const orchId = 'orch-test-001';

    // Write JSONL with one malformed line
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const goodLine = JSON.stringify({ type: 'orchestration_complete', orchestration_id: orchId, timestamp: '2026-04-19T10:00:00.000Z', outcome: 'success', duration_ms: 1000 });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      'NOT VALID JSON\n' + goodLine + '\n',  // both lines end with \n
      'utf8'
    );
    writeOrch(orchId);
    writeConfig({
      extract_on_complete: { enabled: true },
      safety: { circuit_breaker: { max_extractions_per_24h: 100 } },
    });

    setExtractorBackend(() => ({ proposals: [], skipped: [] }));

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(auditDir, 'events.jsonl'),
      orchFilePath: path.join(auditDir, 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const skipEvt = events.find(e => e.type === 'pattern_extraction_skipped' && e.reason === 'malformed_jsonl_line');
    assert.ok(skipEvt, 'malformed_jsonl_line skip must be emitted');

    // auto_extract_staged must still be emitted (remaining lines processed)
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(staged, 'auto_extract_staged must be emitted even after malformed line');
  });
});

// ---------------------------------------------------------------------------
// Missing current-orchestration.json
// ---------------------------------------------------------------------------

describe('missing current-orchestration.json', () => {
  test('no orch file → exits 0 silently, no auto_extract_staged', () => {
    writeEvents(makeQuarantinedEvents('orch-x'));
    writeConfig({ extract_on_complete: { enabled: true }, safety: { circuit_breaker: { max_extractions_per_24h: 100 } } });
    // Do NOT write current-orchestration.json

    setExtractorBackend(() => ({ proposals: [], skipped: [] }));

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(!staged, 'auto_extract_staged must NOT be emitted when orch file missing');
  });
});

// ---------------------------------------------------------------------------
// Missing events.jsonl or empty
// ---------------------------------------------------------------------------

describe('missing or empty events.jsonl', () => {
  test('missing events.jsonl → exits 0 silently, no auto_extract_staged', () => {
    writeOrch('orch-test-001');
    writeConfig({ extract_on_complete: { enabled: true }, safety: { circuit_breaker: { max_extractions_per_24h: 100 } } });
    // Do NOT write events.jsonl

    setExtractorBackend(() => ({ proposals: [], skipped: [] }));

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(!staged, 'auto_extract_staged must NOT be emitted when events.jsonl missing');
  });

  test('empty events.jsonl → exits 0 silently', () => {
    const orchId = 'orch-test-001';
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');
    writeOrch(orchId);
    writeConfig({ extract_on_complete: { enabled: true }, safety: { circuit_breaker: { max_extractions_per_24h: 100 } } });

    setExtractorBackend(() => ({ proposals: [], skipped: [] }));

    runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(auditDir, 'events.jsonl'),
      orchFilePath: path.join(auditDir, 'current-orchestration.json'),
    });

    const events = readEmittedEvents();
    const staged = events.find(e => e.type === 'auto_extract_staged');
    assert.ok(!staged, 'auto_extract_staged must NOT be emitted when events.jsonl empty');
  });
});

// ---------------------------------------------------------------------------
// Missing proposed-patterns/ dir → created automatically
// ---------------------------------------------------------------------------

describe('proposed-patterns/ dir auto-creation', () => {
  test('creates proposed-patterns/ if it does not exist', () => {
    const orchId = 'orch-test-001';

    setExtractorBackend(() => ({
      proposals: [validProposal({ name: 'new-dir-test', evidence_orch_id: orchId })],
      skipped: [],
    }));

    runEnabled({ orchId });

    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    assert.ok(fs.existsSync(dir), 'proposed-patterns/ must be created automatically');
  });
});

// ---------------------------------------------------------------------------
// orchestration_meta shape
// ---------------------------------------------------------------------------

describe('orchestration_meta shape', () => {
  test('_buildOrchestrationMeta returns exactly the 5 required fields', () => {
    const orchId = 'orch-test-001';
    const orchData = { orchestration_id: orchId };
    const events = [
      { type: 'orchestration_start', orchestration_id: orchId, timestamp: new Date(Date.now() - 10000).toISOString() },
      { type: 'agent_start', orchestration_id: orchId, timestamp: new Date().toISOString(), agent_type: 'developer', model_used: 'sonnet' },
      { type: 'group_start', orchestration_id: orchId, timestamp: new Date().toISOString() },
      { type: 'replan_triggered', orchestration_id: orchId, timestamp: new Date().toISOString() },
    ];

    const meta = _buildOrchestrationMeta(events, orchData);

    // Exactly these 5 fields
    const keys = Object.keys(meta).sort();
    assert.deepEqual(keys, ['agents_used', 'duration_ms', 'orchestration_id', 'phase_count', 'retry_count']);

    assert.equal(meta.orchestration_id, orchId);
    assert.ok(typeof meta.duration_ms === 'number');
    assert.ok(meta.duration_ms >= 0);
    assert.ok(Array.isArray(meta.agents_used));
    assert.equal(meta.agents_used[0].type, 'developer');
    assert.equal(meta.agents_used[0].count, 1);
    assert.equal(meta.phase_count, 1);
    assert.equal(meta.retry_count, 1);
  });
});

// ---------------------------------------------------------------------------
// orchestration_id in every pattern_proposed event
// ---------------------------------------------------------------------------

describe('orchestration_id in pattern_proposed', () => {
  test('every pattern_proposed event contains orchestration_id (B1 §2 evidence_orch_id requirement)', () => {
    const orchId = 'orch-test-001';

    setExtractorBackend(() => ({
      proposals: [
        validProposal({ name: 'pat-one', evidence_orch_id: orchId }),
        validProposal({ name: 'pat-two', evidence_orch_id: orchId }),
      ],
      skipped: [],
    }));

    runEnabled({ orchId });

    const events = readEmittedEvents();
    const proposed = events.filter(e => e.type === 'pattern_proposed');
    assert.equal(proposed.length, 2);
    for (const p of proposed) {
      assert.ok(p.orchestration_id, 'orchestration_id must be present in pattern_proposed');
      assert.equal(p.orchestration_id, orchId);
    }
  });
});

// ---------------------------------------------------------------------------
// CHG-01: legacy `shadow` alias still works (remove in W7)
// ---------------------------------------------------------------------------

describe('CHG-01 — shadow_mode legacy alias', () => {
  test('legacy shadow:true (not shadow_mode) still activates shadow mode (alias — remove in W7)', () => {
    const orchId = 'orch-test-shadow-alias';

    setExtractorBackend(() => ({
      proposals: [validProposal({ name: 'shadow-alias-pat', evidence_orch_id: orchId })],
      skipped: [],
    }));

    writeOrch(orchId);
    writeEvents(makeQuarantinedEvents(orchId));
    // Use legacy `shadow` key (not canonical `shadow_mode`) — must still activate shadow mode.
    // W7: breaker params moved to safety.circuit_breaker; use high limit to avoid breaker trips.
    writeConfig({
      extract_on_complete: {
        enabled: true,
        shadow: true,  // alias — canonical is shadow_mode; loader maps this to shadow_mode
      },
      safety: { circuit_breaker: { max_extractions_per_24h: 100 } },
    });

    const result = runExtraction({
      projectRoot: tmpDir,
      eventsPath:  path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      orchFilePath: path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    });

    assert.equal(result.shadow, true, 'shadow mode must activate via legacy `shadow` alias');

    // No files written (shadow mode).
    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    if (fs.existsSync(dir)) {
      const mdFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      assert.equal(mdFiles.length, 0, 'shadow mode must write zero files');
    }
  });
});

// ---------------------------------------------------------------------------
// CHG-02: per-orchestration proposal cap
// ---------------------------------------------------------------------------

describe('CHG-02 — per-orchestration proposal cap', () => {
  test('7 valid proposals with default cap (3) → exactly 3 written, 4 skipped with per_orchestration_cap', () => {
    const orchId = 'orch-test-cap';

    setExtractorBackend(() => ({
      proposals: [
        validProposal({ name: 'cap-pat-1', evidence_orch_id: orchId }),
        validProposal({ name: 'cap-pat-2', evidence_orch_id: orchId }),
        validProposal({ name: 'cap-pat-3', evidence_orch_id: orchId }),
        validProposal({ name: 'cap-pat-4', evidence_orch_id: orchId }),
        validProposal({ name: 'cap-pat-5', evidence_orch_id: orchId }),
        validProposal({ name: 'cap-pat-6', evidence_orch_id: orchId }),
        validProposal({ name: 'cap-pat-7', evidence_orch_id: orchId }),
      ],
      skipped: [],
    }));

    // No proposals_per_orchestration set → uses default of 3.
    const result = runEnabled({ orchId });
    assert.equal(result.proposals_written, 3, 'exactly 3 proposals should be written (cap=3)');

    const dir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    assert.equal(files.length, 3, 'exactly 3 files should be on disk');

    const events = readEmittedEvents();
    const capSkipped = events.filter(e => e.type === 'pattern_extraction_skipped' && e.reason === 'per_orchestration_cap');
    assert.equal(capSkipped.length, 4, 'exactly 4 proposals should be skipped with per_orchestration_cap reason');
  });

  test('cap can be set to 5 via proposals_per_orchestration config', () => {
    const orchId = 'orch-test-cap5';

    setExtractorBackend(() => ({
      proposals: Array.from({ length: 7 }, (_, i) =>
        validProposal({ name: `cap5-pat-${i + 1}`, evidence_orch_id: orchId })),
      skipped: [],
    }));

    const result = runEnabled({ orchId, extractConfig: { proposals_per_orchestration: 5 } });
    assert.equal(result.proposals_written, 5, '5 proposals should be written with cap=5');

    const events = readEmittedEvents();
    const capSkipped = events.filter(e => e.type === 'pattern_extraction_skipped' && e.reason === 'per_orchestration_cap');
    assert.equal(capSkipped.length, 2, '2 proposals should be skipped');
  });
});

// ---------------------------------------------------------------------------
// B4-02 regression: events.jsonl size cap → auto_extract_skipped
// ---------------------------------------------------------------------------

describe('B4-02 regression — events.jsonl size cap', () => {

  test('events file larger than cap emits auto_extract_skipped with events_file_too_large and exits early', () => {
    const orchId = 'orch-b402-test';

    setExtractorBackend(() => ({
      proposals: [validProposal({ name: 'should-not-appear', evidence_orch_id: orchId })],
      skipped: [],
    }));

    writeOrch(orchId);
    writeConfig({
      global_kill_switch: false,
      extract_on_complete: { enabled: true, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100 } },
    });

    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    // Lower the cap to 10 bytes via the test setter, then write a file clearly larger.
    _setMaxEventsBytesForTest(10);
    const bigContent = JSON.stringify({ type: 'orchestration_start', orchestration_id: orchId }) + '\n';
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), bigContent, 'utf8');

    try {
      const result = runExtraction({
        projectRoot: tmpDir,
        eventsPath:  path.join(auditDir, 'events.jsonl'),
        orchFilePath: path.join(auditDir, 'current-orchestration.json'),
      });

      // No proposals should have been written.
      assert.equal(result.proposals_written, 0, 'no proposals should be written when file exceeds cap');

      // auto_extract_skipped with reason events_file_too_large must be emitted.
      const events = readEmittedEvents();
      const skipped = events.find(e => e.type === 'auto_extract_skipped' && e.reason === 'events_file_too_large');
      assert.ok(skipped, 'auto_extract_skipped(events_file_too_large) must be emitted');
      assert.ok(typeof skipped.size_bytes === 'number', 'size_bytes must be present');
      assert.ok(typeof skipped.max_bytes === 'number', 'max_bytes must be present');
      assert.ok(skipped.size_bytes > skipped.max_bytes, 'size_bytes must exceed max_bytes');

      // proposed-patterns dir should be empty or absent.
      const ppDir = path.join(tmpDir, '.orchestray', 'proposed-patterns');
      const ppExists = fs.existsSync(ppDir);
      if (ppExists) {
        assert.equal(fs.readdirSync(ppDir).filter(f => f.endsWith('.md')).length, 0,
          'no proposal files should be written');
      }
    } finally {
      _setMaxEventsBytesForTest(null);
    }
  });

  test('events file at exactly the cap boundary is NOT skipped', () => {
    const orchId = 'orch-b402-boundary';

    setExtractorBackend(() => ({
      proposals: [],
      skipped: [],
    }));

    writeOrch(orchId);
    writeConfig({
      global_kill_switch: false,
      extract_on_complete: { enabled: true, shadow_mode: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 100 } },
    });

    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    // Set cap to exactly the file size so stat.size === cap (not >).
    const content = JSON.stringify({ type: 'orchestration_start', orchestration_id: orchId }) + '\n';
    const exactSize = Buffer.byteLength(content, 'utf8');
    _setMaxEventsBytesForTest(exactSize);
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), content, 'utf8');

    try {
      runExtraction({
        projectRoot: tmpDir,
        eventsPath:  path.join(auditDir, 'events.jsonl'),
        orchFilePath: path.join(auditDir, 'current-orchestration.json'),
      });

      // Should NOT emit events_file_too_large (stat.size === cap, not >).
      const events = readEmittedEvents();
      const tooLarge = events.find(e => e.type === 'auto_extract_skipped' && e.reason === 'events_file_too_large');
      assert.ok(!tooLarge, 'events_file_too_large must NOT be emitted when size equals cap exactly');
    } finally {
      _setMaxEventsBytesForTest(null);
    }
  });
});

// ---------------------------------------------------------------------------
// BLK-01 regression: approach and evidence_orch_id are in frontmatter
// ---------------------------------------------------------------------------

describe('BLK-01 regression — approach and evidence_orch_id in frontmatter', () => {
  const { _buildProposalContent } = require('../../post-orchestration-extract.js');

  test('_buildProposalContent writes approach and evidence_orch_id to frontmatter', () => {
    const orchId = 'orch-blk01-extract';
    const proposal = {
      name: 'blk01-extract-check',
      category: 'routing',
      tip_type: 'strategy',
      confidence: 0.5,
      description: 'Verifying that approach is written to frontmatter.',
      approach: 'This approach verifies approach field placement in the proposal file frontmatter.',
      evidence_orch_id: orchId,
    };

    const content = _buildProposalContent(proposal, orchId);

    // Parse the frontmatter from the output.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'content must have frontmatter delimiters');

    // Verify approach is in the frontmatter block (as JSON-stringified string).
    assert.ok(fmMatch[1].includes('approach:'), 'approach must be in frontmatter');
    assert.ok(fmMatch[1].includes('evidence_orch_id:'), 'evidence_orch_id must be in frontmatter');

    // Verify the values are correct.
    assert.ok(content.includes(orchId), 'evidence_orch_id value must appear in content');
  });
});
