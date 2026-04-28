'use strict';

/**
 * Test Event 4: tokenwright_spawn_coverage.
 *
 * Stages events.jsonl with:
 *   - 5 agent_start events
 *   - 4 prompt_compression events
 *   - 3 tokenwright_realized_savings (measured)
 *   - 1 tokenwright_realized_unknown
 *
 * Asserts coverage_compression_pct=80, and missing_pairs.length=1
 * (the agent_start without a prompt_compression).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { runCoverageProbe } = require('../../../bin/_lib/tokenwright/coverage-probe');

const ORCH_ID = 'orch-test-e4';

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e4-cov-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function writeEvent(eventsPath, evt) {
  fs.appendFileSync(eventsPath, JSON.stringify(evt) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Build fixture events.jsonl
// ---------------------------------------------------------------------------
function buildFixtureEvents(eventsPath) {
  // 5 agent_start events (spawn_keys a1..a5)
  for (let i = 1; i <= 5; i++) {
    writeEvent(eventsPath, {
      type:             'agent_start',
      event_type:       'agent_start',
      orchestration_id: ORCH_ID,
      agent_type:       'developer',
      spawn_key:        `developer:a${i}`,
      timestamp:        new Date().toISOString(),
    });
  }

  // 4 prompt_compression events (a1..a4; a5 is missing its compression)
  for (let i = 1; i <= 4; i++) {
    writeEvent(eventsPath, {
      type:             'prompt_compression',
      event_type:       'prompt_compression',
      orchestration_id: ORCH_ID,
      agent_type:       'developer',
      spawn_key:        `developer:a${i}`,
      timestamp:        new Date().toISOString(),
    });
  }

  // 3 realized_savings (measured) for a1, a2, a3
  for (let i = 1; i <= 3; i++) {
    writeEvent(eventsPath, {
      type:             'tokenwright_realized_savings',
      event_type:       'tokenwright_realized_savings',
      orchestration_id: ORCH_ID,
      agent_type:       'developer',
      spawn_key:        `developer:a${i}`,
      realized_status:  'measured',
      timestamp:        new Date().toISOString(),
    });
  }

  // 1 realized_unknown for a4
  writeEvent(eventsPath, {
    type:             'tokenwright_realized_savings',
    event_type:       'tokenwright_realized_savings',
    orchestration_id: ORCH_ID,
    agent_type:       'developer',
    spawn_key:        'developer:a4',
    realized_status:  'unknown',
    timestamp:        new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Test: coverage probe computes correct percentages
// ---------------------------------------------------------------------------
test('Event4-coverage-probe: computes coverage_compression_pct=80 and missing_pairs=1', (t) => {
  const tmpDir = makeTmpDir(t);
  const eventsPath = path.join(tmpDir, 'events.jsonl');
  buildFixtureEvents(eventsPath);

  const result = runCoverageProbe({
    orchestrationId: ORCH_ID,
    eventsPath,
  });

  assert.equal(result.agent_starts_total,       5, 'agent_starts_total must be 5');
  assert.equal(result.prompt_compression_emits, 4, 'prompt_compression_emits must be 4');
  // realized_savings_emits = measured count (3)
  assert.equal(result.realized_savings_emits,   3, 'realized_savings_emits must be 3');
  // realized_unknown_emits = unknown count (1)
  assert.equal(result.realized_unknown_emits,   1, 'realized_unknown_emits must be 1');

  // coverage_compression_pct = 4/5 * 100 = 80.0
  assert.equal(result.coverage_compression_pct, 80.0, 'coverage_compression_pct must be 80.0');

  // coverage_realized_pct = (3+1)/4 * 100 = 100.0
  assert.equal(result.coverage_realized_pct, 100.0, 'coverage_realized_pct must be 100.0');

  // missing_pairs: a5 has agent_start but no prompt_compression
  assert.equal(result.missing_pairs.length, 1, 'missing_pairs must have exactly 1 entry');
  assert.equal(result.missing_pairs[0].missing_event, 'prompt_compression',
    'the missing event must be prompt_compression for spawn a5');
});

// ---------------------------------------------------------------------------
// Test: empty events file produces zero payload
// ---------------------------------------------------------------------------
test('Event4-coverage-probe: empty events file returns zero payload', (t) => {
  const tmpDir = makeTmpDir(t);
  const eventsPath = path.join(tmpDir, 'empty-events.jsonl');
  // File does not exist

  const result = runCoverageProbe({
    orchestrationId: ORCH_ID,
    eventsPath,
  });

  assert.equal(result.agent_starts_total,       0);
  assert.equal(result.prompt_compression_emits, 0);
  assert.equal(result.coverage_compression_pct, 0);
  assert.deepEqual(result.missing_pairs,        []);
});

// ---------------------------------------------------------------------------
// Test: result has all required fields from W4 §event 4
// ---------------------------------------------------------------------------
test('Event4-coverage-probe: result has all required fields', (t) => {
  const tmpDir = makeTmpDir(t);
  const eventsPath = path.join(tmpDir, 'fields-events.jsonl');

  const result = runCoverageProbe({
    orchestrationId: ORCH_ID,
    eventsPath,
  });

  const required = [
    'orchestration_id', 'agent_starts_total', 'prompt_compression_emits',
    'realized_savings_emits', 'realized_unknown_emits', 'compression_skipped_emits',
    'coverage_compression_pct', 'coverage_realized_pct', 'missing_pairs',
  ];
  for (const f of required) {
    assert.ok(f in result, `result must have field: ${f}`);
  }
});
