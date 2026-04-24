#!/usr/bin/env node
'use strict';

/**
 * Tests for R-DXT changes (v2.1.12):
 *
 * (a) AC-01: emit-orchestration-rollup.js summarises model_auto_resolved events
 *     as a count-by-source line.
 * (b) AC-02: remind-model-before-spawn.js emits the character-exact stderr sentence.
 * (c) AC-03: no regression on existing R-DX1 ACs (rollup still includes
 *     model_auto_resolved_warnings).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROLLUP_SCRIPT  = path.resolve(__dirname, '../bin/emit-orchestration-rollup.js');
const REMIND_SCRIPT  = path.resolve(__dirname, '../bin/remind-model-before-spawn.js');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRollupDir(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rdxt-rollup-'));
  cleanup.push(dir);
  const auditDir   = path.join(dir, '.orchestray', 'audit');
  const metricsDir = path.join(dir, '.orchestray', 'metrics');
  const stateDir   = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir,   { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.mkdirSync(stateDir,   { recursive: true });
  return { dir, auditDir, metricsDir, stateDir };
}

function writeEvents(auditDir, events) {
  const p = path.join(auditDir, 'events.jsonl');
  const lines = events.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(p, lines + '\n');
}

function runRollup(dir, orchId) {
  return spawnSync(process.execPath, [ROLLUP_SCRIPT, orchId, '--cwd', dir], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

function readRollup(metricsDir) {
  const p = path.join(metricsDir, 'orchestration_rollup.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// AC-01 (R-DXT): rollup summarises model_auto_resolved by source
// ---------------------------------------------------------------------------

describe('emit-orchestration-rollup.js model_auto_resolved summary (AC-01 R-DXT)', () => {

  test('rollup row includes model_auto_resolved_summary with count-by-source', () => {
    const orchId = 'orch-rdxt-ac01-1';
    const { dir, auditDir, metricsDir } = makeRollupDir(orchId);

    writeEvents(auditDir, [
      {
        type: 'model_auto_resolved',
        orchestration_id: orchId,
        ts: new Date().toISOString(),
        source: 'global_default_sonnet',
        resolved_model: 'sonnet',
        subagent_type: 'developer',
        task_hint: 'DEV-1 implement feature',
      },
      {
        type: 'model_auto_resolved',
        orchestration_id: orchId,
        ts: new Date().toISOString(),
        source: 'global_default_sonnet',
        resolved_model: 'sonnet',
        subagent_type: 'reviewer',
        task_hint: 'REV-1 review changes',
      },
      {
        type: 'model_auto_resolved',
        orchestration_id: orchId,
        ts: new Date().toISOString(),
        source: 'routing_lookup',
        resolved_model: 'haiku',
        subagent_type: 'architect',
        task_hint: 'ARCH-1 design API',
      },
      {
        type: 'orchestration_complete',
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
        status: 'success',
      },
    ]);

    const result = runRollup(dir, orchId);
    assert.equal(result.status, 0, 'rollup script must exit 0');

    const rows = readRollup(metricsDir);
    assert.ok(rows.length > 0, 'should write at least one rollup row');

    const row = rows.find(r => r.orchestration_id === orchId);
    assert.ok(row, 'rollup row must be present for orchestration_id');

    // AC-01: summary line must be present with count-by-source.
    assert.ok(
      typeof row.model_auto_resolved_summary === 'string',
      'model_auto_resolved_summary must be a string'
    );
    assert.ok(
      row.model_auto_resolved_summary.includes('3 times'),
      'summary must show total count (3)'
    );
    assert.ok(
      row.model_auto_resolved_summary.includes('global_default_sonnet=2'),
      'summary must show global_default_sonnet=2'
    );
    assert.ok(
      row.model_auto_resolved_summary.includes('routing_lookup=1'),
      'summary must show routing_lookup=1'
    );
    // Format check: starts with "- model auto-resolved N times:"
    assert.ok(
      row.model_auto_resolved_summary.startsWith('- model auto-resolved '),
      'summary must start with "- model auto-resolved "'
    );
  });

  test('rollup row omits model_auto_resolved_summary when no auto-resolve events', () => {
    const orchId = 'orch-rdxt-ac01-2';
    const { dir, auditDir, metricsDir } = makeRollupDir(orchId);

    writeEvents(auditDir, [
      {
        type: 'orchestration_complete',
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
        status: 'success',
      },
    ]);

    const result = runRollup(dir, orchId);
    assert.equal(result.status, 0);

    const rows = readRollup(metricsDir);
    const row  = rows.find(r => r.orchestration_id === orchId);
    assert.ok(row, 'rollup row must be present');

    // Zero counts should be elided (summary absent).
    assert.equal(
      row.model_auto_resolved_summary,
      undefined,
      'model_auto_resolved_summary must be absent when no events'
    );
  });

  test('rollup still includes existing model_auto_resolved_warnings (AC-03 regression)', () => {
    const orchId = 'orch-rdxt-ac03-regression';
    const { dir, auditDir, metricsDir } = makeRollupDir(orchId);

    writeEvents(auditDir, [
      {
        type: 'model_auto_resolved',
        orchestration_id: orchId,
        ts: new Date().toISOString(),
        source: 'global_default_sonnet',
        resolved_model: 'sonnet',
        subagent_type: 'developer',
        task_hint: 'DEV-1 implement something',
      },
      {
        type: 'orchestration_complete',
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
        status: 'success',
      },
    ]);

    const result = runRollup(dir, orchId);
    assert.equal(result.status, 0);

    const rows = readRollup(metricsDir);
    const row  = rows.find(r => r.orchestration_id === orchId);
    assert.ok(row, 'rollup row must be present');

    // Existing R-DX1 AC-13 field must still be present.
    assert.ok(
      Array.isArray(row.model_auto_resolved_warnings),
      'model_auto_resolved_warnings (R-DX1 AC-13) must still be present as array'
    );
    assert.ok(row.model_auto_resolved_warnings.length > 0, 'must have at least one warning line');
  });
});

// ---------------------------------------------------------------------------
// AC-02 (R-DXT): remind-model-before-spawn.js emits character-exact stderr sentence
// ---------------------------------------------------------------------------

describe('remind-model-before-spawn.js stderr nudge (AC-02 R-DXT)', () => {

  /**
   * Set up the minimal state for the hook to fire:
   *  - current-orchestration.json with orchestration_id
   *  - routing.jsonl with at least one entry for that orchestration
   *  - NO spawn-accepted sentinel
   *  - NO model-reminder-shown sentinel
   */
  function makeRemindDir(orchId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rdxt-remind-'));
    cleanup.push(dir);

    const auditDir = path.join(dir, '.orchestray', 'audit');
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Active orchestration
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );

    // Routing entry so condition 2 is met
    const routingEntry = {
      orchestration_id: orchId,
      task_id:          'TASK-1',
      agent_type:       'developer',
      model:            'sonnet',
      maxTurns:         30,
      timestamp:        new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stateDir, 'routing.jsonl'),
      JSON.stringify(routingEntry) + '\n'
    );

    return dir;
  }

  test('stderr includes the character-exact R-DXT AC-02 sentence', () => {
    const orchId = 'orch-rdxt-remind-1';
    const dir    = makeRemindDir(orchId);

    const payload = JSON.stringify({
      cwd:  dir,
      type: 'user_prompt',
    });

    const result = spawnSync(process.execPath, [REMIND_SCRIPT], {
      input:    payload,
      encoding: 'utf8',
      timeout:  5000,
    });

    assert.equal(result.status, 0, 'hook must exit 0');

    const EXPECTED_SENTENCE =
      '[orchestray] remind-model-before-spawn: If model is omitted, gate-agent-spawn ' +
      'will auto-resolve from routing.jsonl → agent frontmatter → default sonnet ' +
      '(emits model_auto_resolved warn event). Set model explicitly for audit clarity.\n';

    assert.ok(
      result.stderr.includes(EXPECTED_SENTENCE),
      'stderr must include the character-exact R-DXT sentence. Got:\n' + result.stderr
    );
  });

  test('stderr sentence is absent when reminder has already been shown (sentinel exists)', () => {
    const orchId = 'orch-rdxt-remind-2';
    const dir    = makeRemindDir(orchId);

    // Write the reminder-shown sentinel so condition 5 fails.
    const sentinelDir = path.join(dir, '.orchestray', 'state', 'model-reminder-shown');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, orchId), '');

    const payload = JSON.stringify({ cwd: dir, type: 'user_prompt' });

    const result = spawnSync(process.execPath, [REMIND_SCRIPT], {
      input:    payload,
      encoding: 'utf8',
      timeout:  5000,
    });

    assert.equal(result.status, 0);
    // Reminder sentence must NOT appear when sentinel exists.
    assert.ok(
      !result.stderr.includes('[orchestray] remind-model-before-spawn: If model is omitted'),
      'reminder sentence must not appear when sentinel is set'
    );
  });
});
