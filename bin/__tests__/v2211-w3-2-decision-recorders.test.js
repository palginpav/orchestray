#!/usr/bin/env node
'use strict';

/**
 * v2211-w3-2-decision-recorders.test.js — unit tests for the 4
 * `*_decision_recorded` helpers introduced in W3-2 (v2.2.11).
 *
 * Design reference: W4b §1.2–§1.3 (v2211-W4b-semantic-redesign.md).
 *
 * Tests (≥8 minimum, 2 per tool + bonus):
 *   T1  pattern_deprecate — invoked path
 *   T2  pattern_deprecate — not_applicable path
 *   T3  ask_user          — invoked path
 *   T4  ask_user          — not_applicable path
 *   T5  spawn_agent        — invoked path
 *   T6  spawn_agent        — not_applicable path
 *   T7  curator_tombstone  — invoked path
 *   T8  curator_tombstone  — not_applicable path
 *   T9  pattern_deprecate  — considered_skipped via pattern_skip_enriched
 *   T10 kill switch        — disabled tool skips; others still fire
 *   T11 activation forecast — all 4 recorders emit per call in one pass
 *
 * Runner: node --test bin/__tests__/v2211-w3-2-decision-recorders.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  computeDecisions,
  readArchiveRows,
  decidePatternDeprecation,
  decideAskUser,
  decideAgentSpawn,
  decideCuratorTombstone,
} = require('../_lib/decision-recorder-helpers');

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w32-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Restore any env-var mutations set per test.
  delete process.env.ORCHESTRAY_DECISION_RECORDER_PATTERN_DEPRECATE_DISABLED;
  delete process.env.ORCHESTRAY_DECISION_RECORDER_ASK_USER_DISABLED;
  delete process.env.ORCHESTRAY_DECISION_RECORDER_AGENT_SPAWN_DISABLED;
  delete process.env.ORCHESTRAY_DECISION_RECORDER_CURATOR_TOMBSTONE_DISABLED;
});

const ORCH_ID = 'orch-test-20260429T000000Z';

/**
 * Write rows into `.orchestray/history/<orchId>/events.jsonl`.
 */
function seedArchive(orchId, events) {
  const dir = path.join(tmpDir, '.orchestray', 'history', orchId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines, 'utf8');
}

/**
 * Build a minimal row with orchestration_id set.
 */
function row(type, extra) {
  return Object.assign({ type, orchestration_id: ORCH_ID, timestamp: new Date().toISOString() }, extra);
}

// ---------------------------------------------------------------------------
// T1 — pattern_deprecate invoked path
// ---------------------------------------------------------------------------

describe('pattern_deprecate', () => {
  test('T1: invoked — pattern_deprecated row present', () => {
    seedArchive(ORCH_ID, [
      row('pattern_deprecated', { pattern_name: 'my-pattern', slug: 'my-pattern' }),
    ]);
    const result = decidePatternDeprecation(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'invoked');
    assert.equal(result.tool_name, 'pattern_deprecate');
    assert.equal(result.type, 'pattern_deprecation_decision_recorded');
    assert.equal(result.schema_version, '1');
    assert.equal(result.orchestration_id, ORCH_ID);
    assert.ok(result.evidence_ref !== null, 'evidence_ref must be non-null when invoked');
    assert.equal(result.candidate_subject, 'my-pattern');
    assert.equal(result.source, 'orch-complete-decision-recorder');
  });

  // T2 — not_applicable path
  test('T2: not_applicable — no curator signal in archive', () => {
    seedArchive(ORCH_ID, [
      row('agent_stop', { agent_type: 'developer' }),
    ]);
    const result = decidePatternDeprecation(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'not_applicable');
    assert.equal(result.reason, 'curator_disabled');
    assert.equal(result.evidence_ref, null);
  });

  // T9 — considered_skipped via pattern_skip_enriched
  test('T9: considered_skipped — pattern_skip_enriched row with known skip_category', () => {
    seedArchive(ORCH_ID, [
      row('pattern_skip_enriched', {
        skip_category:  'confidence_above_threshold',
        pattern_name:   'stable-pattern',
      }),
    ]);
    const result = decidePatternDeprecation(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'considered_skipped');
    assert.equal(result.reason, 'confidence_above_threshold');
    assert.ok(result.evidence_ref !== null, 'evidence_ref must be set for considered_skipped');
    assert.equal(result.candidate_subject, 'stable-pattern');
  });
});

// ---------------------------------------------------------------------------
// T3–T4 — ask_user
// ---------------------------------------------------------------------------

describe('ask_user', () => {
  test('T3: invoked — mcp_tool_call:ask_user with outcome=answered', () => {
    seedArchive(ORCH_ID, [
      row('mcp_tool_call', { tool: 'ask_user', outcome: 'answered' }),
    ]);
    const result = decideAskUser(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'invoked');
    assert.equal(result.tool_name, 'ask_user');
    assert.equal(result.type, 'user_question_decision_recorded');
    assert.equal(result.schema_version, '1');
    assert.ok(result.evidence_ref !== null, 'evidence_ref must be set when invoked');
  });

  test('T4: not_applicable — no ambiguity/disagreement signal', () => {
    seedArchive(ORCH_ID, [
      row('agent_stop', { agent_type: 'architect' }),
    ]);
    const result = decideAskUser(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'not_applicable');
    assert.equal(result.reason, 'no_ambiguity_signal');
    assert.equal(result.evidence_ref, null);
  });

  test('considered_skipped — disagreement_detected but no ask_user mcp_tool_call', () => {
    seedArchive(ORCH_ID, [
      row('disagreement_detected', { severity: 'high' }),
    ]);
    const result = decideAskUser(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'considered_skipped');
    assert.equal(result.reason, 'ambiguity_resolved_internally');
    assert.ok(result.evidence_ref !== null);
  });
});

// ---------------------------------------------------------------------------
// T5–T6 — spawn_agent
// ---------------------------------------------------------------------------

describe('spawn_agent', () => {
  test('T5: invoked — spawn_requested with processed=true', () => {
    seedArchive(ORCH_ID, [
      row('spawn_requested', { processed: true, role: 'security-engineer' }),
    ]);
    const result = decideAgentSpawn(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'invoked');
    assert.equal(result.tool_name, 'spawn_agent');
    assert.equal(result.type, 'agent_spawn_decision_recorded');
    assert.equal(result.schema_version, '1');
    assert.ok(result.evidence_ref !== null);
    assert.equal(result.candidate_subject, 'security-engineer');
  });

  test('T6: not_applicable — no spawn_requested rows', () => {
    seedArchive(ORCH_ID, [
      row('routing_outcome', { agent_type: 'developer' }),
    ]);
    const result = decideAgentSpawn(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'not_applicable');
    assert.equal(result.reason, 'no_worker_request');
    assert.equal(result.evidence_ref, null);
  });

  test('considered_skipped — spawn_requested with processed=false', () => {
    seedArchive(ORCH_ID, [
      row('spawn_requested', { processed: false, role: 'researcher' }),
    ]);
    const result = decideAgentSpawn(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'considered_skipped');
    assert.equal(result.reason, 'pm_rejected');
    assert.equal(result.candidate_subject, 'researcher');
  });
});

// ---------------------------------------------------------------------------
// T7–T8 — curator_tombstone
// ---------------------------------------------------------------------------

describe('curator_tombstone', () => {
  test('T7: invoked — curator_run_start + curator_action_promoted', () => {
    seedArchive(ORCH_ID, [
      row('curator_run_start', {}),
      row('curator_action_promoted', { pattern_name: 'useful-pattern' }),
    ]);
    const result = decideCuratorTombstone(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'invoked');
    assert.equal(result.tool_name, 'curator_tombstone');
    assert.equal(result.type, 'curator_tombstone_decision_recorded');
    assert.equal(result.schema_version, '1');
    assert.ok(result.evidence_ref !== null);
    assert.equal(result.candidate_subject, 'useful-pattern');
  });

  test('T8: not_applicable — no curator_run_start in archive', () => {
    seedArchive(ORCH_ID, [
      row('agent_stop', { agent_type: 'pm' }),
    ]);
    const result = decideCuratorTombstone(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'not_applicable');
    assert.equal(result.reason, 'no_curator_run_in_orch');
    assert.equal(result.evidence_ref, null);
  });

  test('considered_skipped — curator_run_start but no curator_action_* rows', () => {
    seedArchive(ORCH_ID, [
      row('curator_run_start', {}),
    ]);
    const result = decideCuratorTombstone(readArchiveRows(tmpDir, ORCH_ID), ORCH_ID);

    assert.equal(result.decision, 'considered_skipped');
    assert.equal(result.reason, 'dry_run');
    assert.ok(result.evidence_ref !== null);
  });
});

// ---------------------------------------------------------------------------
// T10 — Kill switch: disabled tool skips; others fire
// ---------------------------------------------------------------------------

test('T10: kill switch — PATTERN_DEPRECATE disabled; other 3 still return payloads', () => {
  process.env.ORCHESTRAY_DECISION_RECORDER_PATTERN_DEPRECATE_DISABLED = '1';
  seedArchive(ORCH_ID, []);

  const results = computeDecisions(tmpDir, ORCH_ID);

  assert.equal(results.length, 4, 'always 4 slots');
  assert.equal(results[0], null, 'slot 0 (pattern_deprecate) should be null');
  assert.ok(results[1] !== null, 'slot 1 (ask_user) should fire');
  assert.ok(results[2] !== null, 'slot 2 (spawn_agent) should fire');
  assert.ok(results[3] !== null, 'slot 3 (curator_tombstone) should fire');
  assert.equal(results[1].type, 'user_question_decision_recorded');
  assert.equal(results[2].type, 'agent_spawn_decision_recorded');
  assert.equal(results[3].type, 'curator_tombstone_decision_recorded');
});

// ---------------------------------------------------------------------------
// T11 — Activation forecast: all 4 emit per orch_complete fanout
// ---------------------------------------------------------------------------

test('T11: activation forecast — computeDecisions emits exactly 4 non-null payloads', () => {
  // Seed an archive with signals for all 4 tools so every recorder hits invoked.
  seedArchive(ORCH_ID, [
    row('pattern_deprecated',   { pattern_name: 'old-pattern' }),
    row('mcp_tool_call',        { tool: 'ask_user', outcome: 'answered' }),
    row('spawn_requested',      { processed: true, role: 'debugger' }),
    row('curator_run_start',    {}),
    row('curator_action_merged', { pattern_name: 'merged-pattern' }),
  ]);

  const results = computeDecisions(tmpDir, ORCH_ID);

  assert.equal(results.length, 4, 'exactly 4 slots');
  const nonNull = results.filter((r) => r !== null);
  assert.equal(nonNull.length, 4, 'all 4 recorders must fire when no kill switches set');

  // Verify event types.
  const types = nonNull.map((r) => r.type);
  assert.ok(types.includes('pattern_deprecation_decision_recorded'));
  assert.ok(types.includes('user_question_decision_recorded'));
  assert.ok(types.includes('agent_spawn_decision_recorded'));
  assert.ok(types.includes('curator_tombstone_decision_recorded'));

  // All should be invoked given the seeded archive.
  for (const payload of nonNull) {
    assert.equal(payload.decision, 'invoked',
      `${payload.type} should be invoked given seeded archive`);
    assert.ok(payload.evidence_ref !== null, `${payload.type} must have evidence_ref when invoked`);
    assert.equal(payload.schema_version, '1');
    assert.equal(payload.orchestration_id, ORCH_ID);
    assert.equal(payload.source, 'orch-complete-decision-recorder');
  }
});

// ---------------------------------------------------------------------------
// readArchiveRows — fail-open on missing archive
// ---------------------------------------------------------------------------

test('readArchiveRows returns [] when archive does not exist', () => {
  const rows = readArchiveRows(tmpDir, 'orch-nonexistent');
  assert.deepEqual(rows, []);
});

test('readArchiveRows filters out rows from other orchs', () => {
  const dir = path.join(tmpDir, '.orchestray', 'history', ORCH_ID);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'agent_stop', orchestration_id: ORCH_ID }),
    JSON.stringify({ type: 'agent_stop', orchestration_id: 'orch-other' }),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines, 'utf8');

  const rows = readArchiveRows(tmpDir, ORCH_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orchestration_id, ORCH_ID);
});
