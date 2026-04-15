#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/emit-orchestration-rollup.js  (T2 — v2.0.17)
 *
 * Contracts under test:
 *  - given fixture agent_metrics.jsonl + events.jsonl, emitRollup writes one row
 *  - idempotent: running twice -> one row (sentinel prevents second write)
 *  - empty metrics handled gracefully
 *  - correct aggregation: sum of input/output tokens, spawn count, cost total
 *  - ORCHESTRAY_METRICS_DISABLED=1 returns without writing
 *  - invalid orchestration_id is rejected
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { emitRollup } = require('../bin/emit-orchestration-rollup');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-rollup-test-'));
}

function writeMetrics(tmpDir, rows) {
  const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    path.join(metricsDir, 'agent_metrics.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  );
}

function writeEvents(tmpDir, events) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + '\n'
  );
}

function readRollupRows(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'metrics', 'orchestration_rollup.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function makeSpawnRow(orchestrationId, agentType, inputTokens, outputTokens, cacheRead, costUsd) {
  return {
    row_type: 'agent_spawn',
    schema_version: 1,
    orchestration_id: orchestrationId,
    agent_type: agentType,
    timestamp: new Date().toISOString(),
    turns_used: 2,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    },
    usage_source: 'transcript',
    cost_confidence: 'measured',
    estimated_cost_usd: costUsd,
  };
}

function makePmTurnRow(orchestrationId, inputTokens, outputTokens, cacheRead) {
  return {
    row_type: 'pm_turn',
    orchestration_id: orchestrationId,
    ts: new Date().toISOString(),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    },
  };
}

function makeCompleteEvent(orchestrationId, status = 'complete') {
  return {
    type: 'orchestration_complete',
    orchestration_id: orchestrationId,
    status,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Basic rollup write
// ---------------------------------------------------------------------------

describe('emitRollup — basic write', () => {

  test('writes one orchestration_rollup row given populated metrics + events', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-basic', 'developer', 1000, 400, 200, 0.012),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-basic')]);

    try {
      const result = emitRollup(tmpDir, 'orch-basic');
      assert.equal(result.written, true);
      assert.equal(result.reason, 'ok');

      const rows = readRollupRows(tmpDir);
      assert.equal(rows.length, 1, 'exactly one rollup row expected');
      const row = rows[0];
      assert.equal(row.row_type, 'orchestration_rollup');
      assert.equal(row.schema_version, 1);
      assert.equal(row.orchestration_id, 'orch-basic');
      assert.ok(row.emitted_at, 'emitted_at must be present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rollup row contains status from orchestration_complete event', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-status', 'developer', 500, 200, 0, 0.005)]);
    writeEvents(tmpDir, [{ type: 'orchestration_complete', orchestration_id: 'orch-status', status: 'failed', timestamp: new Date().toISOString() }]);

    try {
      emitRollup(tmpDir, 'orch-status');
      const rows = readRollupRows(tmpDir);
      assert.equal(rows[0].status, 'failed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rollup row status is unknown when no orchestration_complete event exists', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-nostatus', 'developer', 500, 200, 0, 0.005)]);
    // No events file at all

    try {
      emitRollup(tmpDir, 'orch-nostatus');
      const rows = readRollupRows(tmpDir);
      assert.equal(rows[0].status, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('creates sentinel file after successful write', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-sentinel', 'developer', 500, 200, 0, 0.005)]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-sentinel')]);

    try {
      emitRollup(tmpDir, 'orch-sentinel');

      const sentinelPath = path.join(tmpDir, '.orchestray', 'state', '.rollup-orch-sentinel.done');
      assert.ok(fs.existsSync(sentinelPath), 'sentinel file must be created');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('emitRollup — idempotency', () => {

  test('running twice for same orchestration_id writes exactly one row', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-idem', 'developer', 1000, 400, 0, 0.01)]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-idem')]);

    try {
      const r1 = emitRollup(tmpDir, 'orch-idem');
      const r2 = emitRollup(tmpDir, 'orch-idem');

      assert.equal(r1.written, true);
      assert.equal(r2.written, false);
      assert.equal(r2.reason, 'already_emitted');

      const rows = readRollupRows(tmpDir);
      assert.equal(rows.length, 1, 'must have exactly one row after two calls');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('idempotency sentinel prevents write even after new metrics are appended', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-idem2', 'developer', 1000, 400, 0, 0.01)]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-idem2')]);

    try {
      emitRollup(tmpDir, 'orch-idem2');

      // Append new metrics after sentinel exists
      fs.appendFileSync(
        path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl'),
        JSON.stringify(makeSpawnRow('orch-idem2', 'reviewer', 500, 200, 0, 0.005)) + '\n'
      );

      emitRollup(tmpDir, 'orch-idem2');

      const rows = readRollupRows(tmpDir);
      assert.equal(rows.length, 1, 'sentinel must prevent a second write even after new data');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Empty metrics
// ---------------------------------------------------------------------------

describe('emitRollup — empty metrics', () => {

  test('handles empty agent_metrics.jsonl gracefully', () => {
    const tmpDir = makeTmpDir();

    const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.writeFileSync(path.join(metricsDir, 'agent_metrics.jsonl'), '');
    writeEvents(tmpDir, [makeCompleteEvent('orch-empty')]);

    try {
      const result = emitRollup(tmpDir, 'orch-empty');
      assert.equal(result.written, true);

      const rows = readRollupRows(tmpDir);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.spawn_count, 0);
      assert.equal(row.total_input_tokens, 0);
      assert.equal(row.total_output_tokens, 0);
      assert.equal(row.total_cost_usd, 0);
      assert.equal(row.mean_spawn_cost_usd, null);
      assert.equal(row.p50_spawn_cost_usd, null);
      assert.equal(row.subagent_cache_hit_ratio, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles missing agent_metrics.jsonl gracefully', () => {
    const tmpDir = makeTmpDir();

    writeEvents(tmpDir, [makeCompleteEvent('orch-no-metrics')]);
    // No metrics file at all

    try {
      const result = emitRollup(tmpDir, 'orch-no-metrics');
      assert.equal(result.written, true);

      const rows = readRollupRows(tmpDir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].spawn_count, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles missing events.jsonl gracefully (status: unknown)', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-no-events', 'developer', 100, 50, 0, 0.001)]);
    // No events file at all

    try {
      const result = emitRollup(tmpDir, 'orch-no-events');
      assert.equal(result.written, true);
      assert.equal(readRollupRows(tmpDir)[0].status, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Aggregation correctness
// ---------------------------------------------------------------------------

describe('emitRollup — aggregation correctness', () => {

  test('sums input_tokens across all spawn rows for this orchestration', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-agg', 'developer',  1000, 400, 200, 0.012),
      makeSpawnRow('orch-agg', 'reviewer',   800,  300, 100, 0.008),
      makeSpawnRow('orch-agg', 'architect',  500,  200, 0,   0.005),
      // Row for a different orchestration — must not be included
      makeSpawnRow('orch-other', 'developer', 9999, 9999, 0, 9.999),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-agg')]);

    try {
      emitRollup(tmpDir, 'orch-agg');
      const row = readRollupRows(tmpDir)[0];

      assert.equal(row.spawn_count, 3, 'spawn_count should be 3 (other orch excluded)');
      assert.equal(row.total_input_tokens, 1000 + 800 + 500, 'total_input_tokens must be sum of 3 rows');
      assert.equal(row.total_output_tokens, 400 + 300 + 200, 'total_output_tokens must be sum of 3 rows');
      assert.equal(row.total_cache_read_input_tokens, 200 + 100 + 0, 'cache tokens must be summed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('total_cost_usd is sum of estimated_cost_usd across spawn rows', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-cost', 'developer', 1000, 400, 0, 0.012),
      makeSpawnRow('orch-cost', 'reviewer',  800,  300, 0, 0.008),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-cost')]);

    try {
      emitRollup(tmpDir, 'orch-cost');
      const row = readRollupRows(tmpDir)[0];

      // 0.012 + 0.008 = 0.02 (rounded to 6 dp)
      assert.ok(Math.abs(row.total_cost_usd - 0.02) < 1e-9, `total_cost_usd expected ~0.02, got ${row.total_cost_usd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('agent_type_counts maps each agent type to its spawn count', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-types', 'developer', 100, 50, 0, 0.001),
      makeSpawnRow('orch-types', 'developer', 100, 50, 0, 0.001),
      makeSpawnRow('orch-types', 'reviewer',  100, 50, 0, 0.001),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-types')]);

    try {
      emitRollup(tmpDir, 'orch-types');
      const row = readRollupRows(tmpDir)[0];

      assert.equal(row.agent_type_counts.developer, 2);
      assert.equal(row.agent_type_counts.reviewer, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('mean_spawn_cost_usd is arithmetic mean of per-spawn costs', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-mean', 'developer', 100, 50, 0, 0.010),
      makeSpawnRow('orch-mean', 'reviewer',  100, 50, 0, 0.030),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-mean')]);

    try {
      emitRollup(tmpDir, 'orch-mean');
      const row = readRollupRows(tmpDir)[0];

      // mean of [0.010, 0.030] = 0.020
      assert.ok(Math.abs(row.mean_spawn_cost_usd - 0.020) < 1e-9,
        `mean_spawn_cost_usd expected 0.020, got ${row.mean_spawn_cost_usd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('p50_spawn_cost_usd is lower-median of per-spawn costs', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-p50', 'developer', 100, 50, 0, 0.005),
      makeSpawnRow('orch-p50', 'reviewer',  100, 50, 0, 0.015),
      makeSpawnRow('orch-p50', 'architect', 100, 50, 0, 0.025),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-p50')]);

    try {
      emitRollup(tmpDir, 'orch-p50');
      const row = readRollupRows(tmpDir)[0];

      // sorted: [0.005, 0.015, 0.025] — lower-median is index floor((3-1)/2) = 1 => 0.015
      assert.ok(Math.abs(row.p50_spawn_cost_usd - 0.015) < 1e-9,
        `p50_spawn_cost_usd expected 0.015, got ${row.p50_spawn_cost_usd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pm_turn_count and pm token totals reflect pm_turn rows only', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [
      makeSpawnRow('orch-pm', 'developer', 1000, 400, 0, 0.012),
      makePmTurnRow('orch-pm', 500, 200, 300),
      makePmTurnRow('orch-pm', 600, 250, 400),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-pm')]);

    try {
      emitRollup(tmpDir, 'orch-pm');
      const row = readRollupRows(tmpDir)[0];

      assert.equal(row.pm_turn_count, 2, 'should count 2 pm_turn rows');
      assert.equal(row.pm_total_input_tokens, 500 + 600, 'pm input tokens summed');
      assert.equal(row.pm_total_output_tokens, 200 + 250, 'pm output tokens summed');
      assert.equal(row.pm_total_cache_read_input_tokens, 300 + 400, 'pm cache read tokens summed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('subagent_cache_hit_ratio is null when all spawn rows have zero denominator', () => {
    const tmpDir = makeTmpDir();

    // Spawn rows with input_tokens=0 and cache_read=0 -> denominator=0
    writeMetrics(tmpDir, [
      makeSpawnRow('orch-cache-null', 'developer', 0, 0, 0, 0),
    ]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-cache-null')]);

    try {
      emitRollup(tmpDir, 'orch-cache-null');
      const row = readRollupRows(tmpDir)[0];
      assert.equal(row.subagent_cache_hit_ratio, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('task_hash is a 16-char hex string derived from orchestration_id', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, []);
    writeEvents(tmpDir, [makeCompleteEvent('orch-hash-check')]);

    try {
      emitRollup(tmpDir, 'orch-hash-check');
      const row = readRollupRows(tmpDir)[0];
      assert.ok(row.task_hash, 'task_hash must be present');
      assert.equal(row.task_hash.length, 16, 'task_hash must be 16 hex chars');
      assert.ok(/^[0-9a-f]+$/i.test(row.task_hash), 'task_hash must be hexadecimal');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Kill-switch and validation
// ---------------------------------------------------------------------------

describe('emitRollup — kill-switch and validation', () => {

  test('ORCHESTRAY_METRICS_DISABLED=1 returns without writing', () => {
    const tmpDir = makeTmpDir();

    writeMetrics(tmpDir, [makeSpawnRow('orch-disabled', 'developer', 500, 200, 0, 0.005)]);
    writeEvents(tmpDir, [makeCompleteEvent('orch-disabled')]);

    const origEnv = process.env.ORCHESTRAY_METRICS_DISABLED;
    process.env.ORCHESTRAY_METRICS_DISABLED = '1';

    try {
      const result = emitRollup(tmpDir, 'orch-disabled');
      assert.equal(result.written, false);
      assert.equal(result.reason, 'metrics_disabled');

      const rollupPath = path.join(tmpDir, '.orchestray', 'metrics', 'orchestration_rollup.jsonl');
      assert.ok(!fs.existsSync(rollupPath), 'no rollup file should exist');
    } finally {
      if (origEnv === undefined) delete process.env.ORCHESTRAY_METRICS_DISABLED;
      else process.env.ORCHESTRAY_METRICS_DISABLED = origEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns invalid_orchestration_id when orchestration_id is "unknown"', () => {
    const tmpDir = makeTmpDir();

    try {
      const result = emitRollup(tmpDir, 'unknown');
      assert.equal(result.written, false);
      assert.equal(result.reason, 'invalid_orchestration_id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns invalid_orchestration_id when orchestration_id is null', () => {
    const tmpDir = makeTmpDir();

    try {
      const result = emitRollup(tmpDir, null);
      assert.equal(result.written, false);
      assert.equal(result.reason, 'invalid_orchestration_id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns invalid_orchestration_id when orchestration_id is empty string', () => {
    const tmpDir = makeTmpDir();

    try {
      const result = emitRollup(tmpDir, '');
      assert.equal(result.written, false);
      assert.equal(result.reason, 'invalid_orchestration_id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Malformed JSONL lines are skipped (fail-open)
// ---------------------------------------------------------------------------

describe('emitRollup — fail-open on malformed JSONL', () => {

  test('skips corrupt lines in agent_metrics.jsonl and uses valid rows only', () => {
    const tmpDir = makeTmpDir();
    const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });

    fs.writeFileSync(
      path.join(metricsDir, 'agent_metrics.jsonl'),
      [
        'not-json',
        JSON.stringify(makeSpawnRow('orch-corrupt', 'developer', 1000, 400, 0, 0.010)),
        '{broken json',
        JSON.stringify(makeSpawnRow('orch-corrupt', 'reviewer', 800, 300, 0, 0.008)),
      ].join('\n') + '\n'
    );
    writeEvents(tmpDir, [makeCompleteEvent('orch-corrupt')]);

    try {
      const result = emitRollup(tmpDir, 'orch-corrupt');
      assert.equal(result.written, true);

      const row = readRollupRows(tmpDir)[0];
      assert.equal(row.spawn_count, 2, 'should count only the 2 valid rows');
      assert.equal(row.total_input_tokens, 1000 + 800);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
