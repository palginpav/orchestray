#!/usr/bin/env node
'use strict';

/**
 * v2.0.17 tests for bin/collect-agent-metrics.js
 *
 * Covers new functionality introduced in T2:
 *  - agent_spawn row written to agent_metrics.jsonl on SubagentStop
 *  - ORCHESTRAY_METRICS_DISABLED=1 suppresses metrics write
 *  - orchestration_complete triggers rollup (idempotent via sentinel)
 *  - fail-open: malformed transcript -> no throw, exit 0
 *  - smoke: existing audit event telemetry still works
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/collect-agent-metrics.js');

function run(stdinData, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function parseOutput(stdout) {
  return JSON.parse(stdout.trim());
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cam-v2017-'));
}

function writeOrchestrationId(tmpDir, id) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

function readMetricsRows(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function makeTranscript(lines) {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function writeTranscript(tmpDir, lines) {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, makeTranscript(lines));
  return transcriptPath;
}

// ---------------------------------------------------------------------------
// agent_spawn row written to agent_metrics.jsonl
// ---------------------------------------------------------------------------

describe('agent_spawn row written to agent_metrics.jsonl', () => {

  test('appends one agent_spawn row on SubagentStop with known orchestration', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-v2017-001');

    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: 'done',
        usage: {
          input_tokens: 1000,
          output_tokens: 400,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_id: 'agent-dev-01',
        session_id: 'sess-001',
        agent_transcript_path: transcriptPath,
      });
      const { status, stdout } = run(input);
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);

      const rows = readMetricsRows(tmpDir);
      assert.ok(rows.length >= 1, 'should have written at least one metrics row');
      const spawnRow = rows.find(r => r.row_type === 'agent_spawn');
      assert.ok(spawnRow, 'should have an agent_spawn row');
      assert.equal(spawnRow.schema_version, 1);
      assert.equal(spawnRow.orchestration_id, 'orch-v2017-001');
      assert.equal(spawnRow.agent_type, 'developer');
      assert.ok(spawnRow.timestamp, 'row must have timestamp');
      assert.ok(typeof spawnRow.estimated_cost_usd === 'number', 'must have estimated_cost_usd');
      assert.ok(spawnRow.usage, 'must have usage object');
      assert.equal(spawnRow.usage.input_tokens, 1000);
      assert.equal(spawnRow.usage.output_tokens, 400);
      assert.equal(spawnRow.usage.cache_read_input_tokens, 200);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('agent_spawn row has correct schema fields', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-v2017-schema');

    const transcriptPath = writeTranscript(tmpDir, [
      {
        role: 'assistant',
        usage: {
          input_tokens: 500,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    try {
      run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'reviewer',
        agent_id: 'agent-rev-01',
        session_id: 'sess-schema',
        agent_transcript_path: transcriptPath,
      }));

      const rows = readMetricsRows(tmpDir);
      const spawnRow = rows.find(r => r.row_type === 'agent_spawn');
      assert.ok(spawnRow, 'agent_spawn row required');

      // Required fields per schema spec
      assert.equal(typeof spawnRow.row_type, 'string');
      assert.equal(typeof spawnRow.schema_version, 'number');
      assert.equal(typeof spawnRow.timestamp, 'string');
      assert.equal(typeof spawnRow.orchestration_id, 'string');
      assert.equal(typeof spawnRow.agent_type, 'string');
      assert.equal(typeof spawnRow.turns_used, 'number');
      assert.equal(typeof spawnRow.usage_source, 'string');
      assert.equal(typeof spawnRow.cost_confidence, 'string');
      assert.equal(typeof spawnRow.estimated_cost_usd, 'number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('agent_spawn row turns_used equals number of assistant entries in transcript', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-turns');

    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'step1', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'step2', usage: { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      }));

      const rows = readMetricsRows(tmpDir);
      const spawnRow = rows.find(r => r.row_type === 'agent_spawn');
      assert.ok(spawnRow, 'agent_spawn row required');
      assert.equal(spawnRow.turns_used, 2, 'should count 2 assistant turns');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// ORCHESTRAY_METRICS_DISABLED=1 suppresses metrics write
// ---------------------------------------------------------------------------

describe('ORCHESTRAY_METRICS_DISABLED kill-switch', () => {

  test('does not write agent_metrics.jsonl when ORCHESTRAY_METRICS_DISABLED=1', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-disabled');

    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      const { status } = run(
        JSON.stringify({
          cwd: tmpDir,
          hook_event_name: 'SubagentStop',
          agent_type: 'developer',
          agent_transcript_path: transcriptPath,
        }),
        { ORCHESTRAY_METRICS_DISABLED: '1' }
      );
      assert.equal(status, 0);

      const metricsPath = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
      assert.ok(!fs.existsSync(metricsPath), 'agent_metrics.jsonl must not be created when disabled');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('still exits 0 with continue:true when kill-switch is set', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-disabled-exit');

    try {
      const { status, stdout } = run(
        JSON.stringify({ cwd: tmpDir, hook_event_name: 'SubagentStop', agent_type: 'developer' }),
        { ORCHESTRAY_METRICS_DISABLED: '1' }
      );
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// orchestration_complete triggers rollup (idempotent via sentinel)
// ---------------------------------------------------------------------------

describe('orchestration_complete triggers rollup', () => {

  test('emits orchestration_rollup.jsonl when orchestration_complete event is present', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(tmpDir, 'orch-rollup-001');

    // Pre-write an orchestration_complete event to events.jsonl so _hasOrchestrationComplete returns true
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({ type: 'orchestration_complete', orchestration_id: 'orch-rollup-001', status: 'complete', timestamp: new Date().toISOString() }) + '\n'
    );

    // Pre-write an agent_spawn row so rollup has something to aggregate
    const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.writeFileSync(
      path.join(metricsDir, 'agent_metrics.jsonl'),
      JSON.stringify({
        row_type: 'agent_spawn',
        schema_version: 1,
        orchestration_id: 'orch-rollup-001',
        agent_type: 'developer',
        timestamp: new Date().toISOString(),
        turns_used: 3,
        usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
        usage_source: 'transcript',
        cost_confidence: 'measured',
        estimated_cost_usd: 0.018,
      }) + '\n'
    );

    try {
      run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
      }));

      const rollupPath = path.join(metricsDir, 'orchestration_rollup.jsonl');
      assert.ok(fs.existsSync(rollupPath), 'orchestration_rollup.jsonl should be created');
      const lines = fs.readFileSync(rollupPath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 1, 'should have exactly one rollup row');
      const row = JSON.parse(lines[0]);
      assert.equal(row.row_type, 'orchestration_rollup');
      assert.equal(row.orchestration_id, 'orch-rollup-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rollup is idempotent: running twice for same orchestration_id yields one row', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(tmpDir, 'orch-rollup-idem');

    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({ type: 'orchestration_complete', orchestration_id: 'orch-rollup-idem', status: 'complete', timestamp: new Date().toISOString() }) + '\n'
    );

    const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.writeFileSync(
      path.join(metricsDir, 'agent_metrics.jsonl'),
      JSON.stringify({
        row_type: 'agent_spawn',
        schema_version: 1,
        orchestration_id: 'orch-rollup-idem',
        agent_type: 'developer',
        timestamp: new Date().toISOString(),
        turns_used: 1,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        usage_source: 'transcript',
        cost_confidence: 'measured',
        estimated_cost_usd: 0.001,
      }) + '\n'
    );

    try {
      const input = JSON.stringify({ cwd: tmpDir, hook_event_name: 'SubagentStop', agent_type: 'developer' });
      run(input);
      run(input); // second run should be no-op via sentinel

      const rollupPath = path.join(metricsDir, 'orchestration_rollup.jsonl');
      const lines = fs.readFileSync(rollupPath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 1, 'idempotent: second run must not write a second row');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not trigger rollup when orchestration_id is unknown', () => {
    const tmpDir = makeTmpDir();
    // No current-orchestration.json -> orchestrationId = 'unknown'

    try {
      run(JSON.stringify({ cwd: tmpDir, hook_event_name: 'SubagentStop', agent_type: 'developer' }));

      const rollupPath = path.join(tmpDir, '.orchestray', 'metrics', 'orchestration_rollup.jsonl');
      assert.ok(!fs.existsSync(rollupPath), 'rollup must not be triggered for unknown orchestration_id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Fail-open: malformed transcript -> no throw, exit 0
// ---------------------------------------------------------------------------

describe('fail-open on malformed transcript', () => {

  test('exits 0 when agent_transcript_path points to a file with invalid JSON lines', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-malformed');

    const transcriptPath = path.join(tmpDir, 'bad-transcript.jsonl');
    fs.writeFileSync(transcriptPath, 'not-json\n{broken\n{"role": "assistant", "usage":{truncated\n');

    try {
      const { status, stdout } = run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exits 0 when agent_transcript_path does not exist', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-no-transcript');

    try {
      const { status, stdout } = run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: path.join(tmpDir, 'nonexistent.jsonl'),
      }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exits 0 when stdin is completely empty', () => {
    const { status, stdout } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});

// ---------------------------------------------------------------------------
// Smoke: existing audit event telemetry still works
// ---------------------------------------------------------------------------

describe('smoke: existing audit event telemetry regression', () => {

  test('still writes agent_stop event to events.jsonl (pre-v2017 behavior preserved)', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(tmpDir, 'orch-regression-001');

    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', content: 'done', usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'reviewer',
        agent_id: 'agent-rev',
        session_id: 'sess-reg',
        agent_transcript_path: transcriptPath,
      }));

      const eventsPath = path.join(auditDir, 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), 'events.jsonl must exist');
      const events = fs.readFileSync(eventsPath, 'utf8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      const agentStop = events.find(e => e.type === 'agent_stop');
      assert.ok(agentStop, 'agent_stop event must be written');
      assert.equal(agentStop.orchestration_id, 'orch-regression-001');
      assert.equal(agentStop.agent_type, 'reviewer');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('estimated_cost_usd is a finite number greater than zero when tokens are present', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-cost');

    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      run(JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      }));

      const rows = readMetricsRows(tmpDir);
      const spawnRow = rows.find(r => r.row_type === 'agent_spawn');
      assert.ok(spawnRow, 'spawn row required');
      assert.ok(isFinite(spawnRow.estimated_cost_usd), 'estimated_cost_usd must be finite');
      assert.ok(spawnRow.estimated_cost_usd > 0, 'estimated_cost_usd must be > 0 when tokens > 0');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
