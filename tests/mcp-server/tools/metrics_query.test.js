#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/metrics_query.js  (T5 — v2.0.17)
 *
 * Contracts under test:
 *  - basic query returns grouped results
 *  - cache_hit_ratio drops rows with zero denominator from mean/p50 but counts in n
 *  - window:"all" returns all rows
 *  - group_by:"none" returns single group __all__
 *  - missing files -> empty groups + total_rows: 0, no throw
 *  - ORCHESTRAY_METRICS_DISABLED=1 -> empty result with meta flag
 *  - rollup rows (agent_kind="rollup") are included
 *  - input validation errors return isError: true
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { handle, definition } = require('../../../bin/mcp-server/tools/metrics_query');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-mq-test-'));
}

function makeContext(tmpDir) {
  return {
    projectRoot: tmpDir,
    config: {},
    logger: () => {},
  };
}

function writeAgentMetrics(tmpDir, rows) {
  const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    path.join(metricsDir, 'agent_metrics.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  );
}

function writeRollupMetrics(tmpDir, rows) {
  const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    path.join(metricsDir, 'orchestration_rollup.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  );
}

function makeSpawnRow(orchId, agentType, model, inputTokens, outputTokens, cacheRead, costUsd) {
  return {
    row_type: 'agent_spawn',
    schema_version: 1,
    orchestration_id: orchId,
    agent_type: agentType,
    model_used: model,
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

function makeRollupRow(orchId, inputTokens, outputTokens, cacheRead, costUsd) {
  return {
    row_type: 'orchestration_rollup',
    schema_version: 1,
    orchestration_id: orchId,
    status: 'complete',
    emitted_at: new Date().toISOString(),
    spawn_count: 2,
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    total_cache_read_input_tokens: cacheRead,
    total_cache_creation_input_tokens: 0,
    total_cost_usd: costUsd,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe('metrics_query definition', () => {

  test('exports a tool definition with name "metrics_query"', () => {
    assert.equal(definition.name, 'metrics_query');
    assert.ok(typeof definition.description === 'string');
    assert.ok(definition.inputSchema, 'must have inputSchema');
  });

  test('definition is frozen', () => {
    assert.ok(Object.isFrozen(definition));
  });

});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('metrics_query input validation', () => {

  test('returns isError when window is missing', async () => {
    const result = await handle({ group_by: 'agent_kind', metric: 'count' }, makeContext(os.tmpdir()));
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('metrics_query'));
  });

  test('returns isError when group_by is invalid enum value', async () => {
    const result = await handle({ window: '7d', group_by: 'bad_field', metric: 'count' }, makeContext(os.tmpdir()));
    assert.equal(result.isError, true);
  });

  test('returns isError when metric is invalid enum value', async () => {
    const result = await handle({ window: '7d', group_by: 'none', metric: 'bad_metric' }, makeContext(os.tmpdir()));
    assert.equal(result.isError, true);
  });

  test('returns isError when input is empty object', async () => {
    const result = await handle({}, makeContext(os.tmpdir()));
    assert.equal(result.isError, true);
  });

});

// ---------------------------------------------------------------------------
// Basic query
// ---------------------------------------------------------------------------

describe('metrics_query basic query', () => {

  test('returns groups keyed by agent_kind when group_by is agent_kind', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'claude-sonnet-4-6', 1000, 400, 200, 0.012),
      makeSpawnRow('orch-1', 'reviewer',  'claude-haiku',      800,  300, 100, 0.004),
      makeSpawnRow('orch-1', 'developer', 'claude-sonnet-4-6', 600,  250, 50,  0.008),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups, meta } = result.structuredContent;

      assert.ok(Array.isArray(groups));
      assert.equal(meta.window, 'all');
      assert.equal(meta.group_by, 'agent_kind');
      assert.equal(meta.metric, 'count');
      assert.equal(meta.total_rows, 3);
      assert.equal(meta.metrics_disabled, false);

      const devGroup = groups.find(g => g.key === 'developer');
      assert.ok(devGroup, 'developer group must exist');
      assert.equal(devGroup.n, 2);

      const revGroup = groups.find(g => g.key === 'reviewer');
      assert.ok(revGroup, 'reviewer group must exist');
      assert.equal(revGroup.n, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns cost_usd mean grouped by model', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'claude-sonnet', 1000, 400, 0, 0.010),
      makeSpawnRow('orch-1', 'developer', 'claude-sonnet', 1000, 400, 0, 0.030),
      makeSpawnRow('orch-1', 'reviewer',  'claude-haiku',  800,  300, 0, 0.004),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'model', metric: 'cost_usd' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups } = result.structuredContent;

      const sonnetGroup = groups.find(g => g.key === 'claude-sonnet');
      assert.ok(sonnetGroup, 'claude-sonnet group must exist');
      assert.equal(sonnetGroup.n, 2);
      // mean of [0.010, 0.030] = 0.020
      assert.ok(Math.abs(sonnetGroup.mean - 0.020) < 1e-9, `mean expected 0.020, got ${sonnetGroup.mean}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns input_tokens mean grouped by orchestration_id', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-A', 'developer', 'sonnet', 1000, 400, 0, 0.01),
      makeSpawnRow('orch-A', 'reviewer',  'haiku',  500,  200, 0, 0.004),
      makeSpawnRow('orch-B', 'developer', 'sonnet', 2000, 800, 0, 0.02),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'orchestration_id', metric: 'input_tokens' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups } = result.structuredContent;

      const orchAGroup = groups.find(g => g.key === 'orch-A');
      assert.ok(orchAGroup);
      assert.equal(orchAGroup.n, 2);
      // mean of [1000, 500] = 750
      assert.ok(Math.abs(orchAGroup.mean - 750) < 1e-9);

      const orchBGroup = groups.find(g => g.key === 'orch-B');
      assert.ok(orchBGroup);
      assert.equal(orchBGroup.n, 1);
      assert.ok(Math.abs(orchBGroup.mean - 2000) < 1e-9);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// cache_hit_ratio — zero denominator handling
// ---------------------------------------------------------------------------

describe('metrics_query cache_hit_ratio', () => {

  test('drops rows with zero denominator from mean/p50 but still counts them in n', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      // Two rows with non-zero denominator
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 200, 0.010), // ratio = 200/(200+1000) = 1/6
      makeSpawnRow('orch-1', 'reviewer',  'sonnet', 800,  300, 400, 0.008), // ratio = 400/(400+800) = 1/3
      // One row with zero denominator (input_tokens=0, cache_read=0)
      makeSpawnRow('orch-1', 'architect', 'sonnet', 0,    100, 0,   0.000),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'cache_hit_ratio' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const [group] = result.structuredContent.groups;

      assert.equal(group.n, 3, 'n must count all rows including zero-denominator row');
      assert.ok(group.mean !== null, 'mean must not be null when some rows have valid ratios');
      assert.ok(group.p50 !== null, 'p50 must not be null when some rows have valid ratios');

      // Valid ratios: 200/1200 = 0.1667, 400/1200 = 0.3333
      const expectedMean = (200 / 1200 + 400 / 1200) / 2;
      assert.ok(Math.abs(group.mean - expectedMean) < 1e-9,
        `cache_hit_ratio mean expected ${expectedMean}, got ${group.mean}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('mean and p50 are null when ALL rows have zero denominator', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 0, 100, 0, 0),
      makeSpawnRow('orch-1', 'reviewer',  'haiku',  0, 50,  0, 0),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'cache_hit_ratio' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const [group] = result.structuredContent.groups;

      assert.equal(group.n, 2);
      assert.equal(group.mean, null, 'mean must be null when all rows are zero-denominator');
      assert.equal(group.p50, null, 'p50 must be null when all rows are zero-denominator');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// window: "all" returns all rows regardless of age
// ---------------------------------------------------------------------------

describe('metrics_query window:"all"', () => {

  test('returns all rows including very old ones', async () => {
    const tmpDir = makeTmpDir();

    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ago
    const recentDate = new Date().toISOString();

    const oldRow = { ...makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.01), timestamp: oldDate };
    const recentRow = { ...makeSpawnRow('orch-2', 'reviewer', 'haiku', 500, 200, 0, 0.004), timestamp: recentDate };

    writeAgentMetrics(tmpDir, [oldRow, recentRow]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.meta.total_rows, 2, 'window:all must include old rows');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('7d window excludes rows older than 7 days', async () => {
    const tmpDir = makeTmpDir();

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const recentDate = new Date().toISOString();

    const oldRow = { ...makeSpawnRow('orch-old', 'developer', 'sonnet', 1000, 400, 0, 0.01), timestamp: oldDate };
    const recentRow = { ...makeSpawnRow('orch-new', 'reviewer', 'haiku', 500, 200, 0, 0.004), timestamp: recentDate };

    writeAgentMetrics(tmpDir, [oldRow, recentRow]);

    try {
      const result = await handle(
        { window: '7d', group_by: 'none', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.meta.total_rows, 1, '7d window must exclude 10-day-old row');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// group_by: "none" returns single group __all__
// ---------------------------------------------------------------------------

describe('metrics_query group_by:"none"', () => {

  test('returns exactly one group with key __all__ aggregating all rows', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.012),
      makeSpawnRow('orch-1', 'reviewer',  'haiku',  800,  300, 0, 0.004),
      makeSpawnRow('orch-2', 'architect', 'opus',   500,  200, 0, 0.008),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups } = result.structuredContent;

      assert.equal(groups.length, 1, 'group_by:none must return exactly one group');
      assert.equal(groups[0].key, '__all__', 'single group key must be __all__');
      assert.equal(groups[0].n, 3, 'group must contain all 3 rows');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Missing files
// ---------------------------------------------------------------------------

describe('metrics_query missing files', () => {

  test('returns empty groups and total_rows: 0 when no metrics files exist', async () => {
    const tmpDir = makeTmpDir();
    // Create empty project dir but no metrics files

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups, meta } = result.structuredContent;

      assert.deepEqual(groups, [], 'groups must be empty when no files exist');
      assert.equal(meta.total_rows, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not throw when projectRoot is null (no context)', async () => {
    const result = await handle(
      { window: 'all', group_by: 'none', metric: 'count' },
      {}
    );
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.groups, []);
    assert.equal(result.structuredContent.meta.total_rows, 0);
  });

  test('handles only agent_metrics.jsonl present (no rollup file)', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.01),
    ]);
    // No orchestration_rollup.jsonl

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.meta.total_rows, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles corrupt JSONL lines gracefully (skip and continue)', async () => {
    const tmpDir = makeTmpDir();
    const metricsDir = path.join(tmpDir, '.orchestray', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.writeFileSync(
      path.join(metricsDir, 'agent_metrics.jsonl'),
      [
        'not-json',
        JSON.stringify(makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.01)),
        '{broken',
      ].join('\n') + '\n'
    );

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      // Should have processed the 1 valid row
      assert.equal(result.structuredContent.meta.total_rows, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// ORCHESTRAY_METRICS_DISABLED kill-switch
// ---------------------------------------------------------------------------

describe('metrics_query ORCHESTRAY_METRICS_DISABLED kill-switch', () => {

  test('returns empty result with metrics_disabled: true when kill-switch is set', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.01),
    ]);

    const origEnv = process.env.ORCHESTRAY_METRICS_DISABLED;
    process.env.ORCHESTRAY_METRICS_DISABLED = '1';

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.groups, []);
      assert.equal(result.structuredContent.meta.total_rows, 0);
      assert.equal(result.structuredContent.meta.metrics_disabled, true);
    } finally {
      if (origEnv === undefined) delete process.env.ORCHESTRAY_METRICS_DISABLED;
      else process.env.ORCHESTRAY_METRICS_DISABLED = origEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Rollup rows
// ---------------------------------------------------------------------------

describe('metrics_query rollup rows', () => {

  test('rollup rows are included in results with agent_kind = "rollup"', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.01),
    ]);
    writeRollupMetrics(tmpDir, [
      makeRollupRow('orch-1', 5000, 2000, 500, 0.050),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups, meta } = result.structuredContent;

      // total_rows should include both agent + rollup rows
      assert.equal(meta.total_rows, 2, 'total_rows must include rollup rows');

      const rollupGroup = groups.find(g => g.key === 'rollup');
      assert.ok(rollupGroup, 'rollup group must be present');
      assert.equal(rollupGroup.n, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rollup rows have model: null in normalized form', async () => {
    const tmpDir = makeTmpDir();

    writeRollupMetrics(tmpDir, [
      makeRollupRow('orch-1', 5000, 2000, 500, 0.050),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'model', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups } = result.structuredContent;

      // Rollup rows have model=null, so they group under key "null"
      const nullGroup = groups.find(g => g.key === 'null');
      assert.ok(nullGroup, 'rollup rows (model=null) must appear in "null" group when grouped by model');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rollup row cache_hit_ratio uses total_cache_read_input_tokens / total denominator', async () => {
    const tmpDir = makeTmpDir();

    // total_cache_read = 500, total_input = 5000 -> ratio = 500 / 5500 ~= 0.0909
    writeRollupMetrics(tmpDir, [
      makeRollupRow('orch-1', 5000, 2000, 500, 0.050),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'none', metric: 'cache_hit_ratio' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const [group] = result.structuredContent.groups;

      const expectedRatio = 500 / (500 + 5000);
      assert.ok(Math.abs(group.mean - expectedRatio) < 1e-9,
        `rollup cache_hit_ratio expected ${expectedRatio}, got ${group.mean}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pm_turn rows appear with agent_kind "pm" (not rolled up)', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      {
        row_type: 'pm_turn',
        orchestration_id: 'orch-1',
        ts: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        usage: { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
        estimated_cost_usd: 0.020,
      },
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups } = result.structuredContent;

      const pmGroup = groups.find(g => g.key === 'pm');
      assert.ok(pmGroup, 'pm_turn rows must appear as agent_kind "pm"');
      assert.equal(pmGroup.n, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('metrics_query return shape', () => {

  test('each group has required fields: key, n, mean, p50', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 200, 0.012),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'cost_usd' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const [group] = result.structuredContent.groups;

      assert.ok('key' in group, 'group must have key');
      assert.ok('n' in group, 'group must have n');
      assert.ok('mean' in group, 'group must have mean');
      assert.ok('p50' in group, 'group must have p50');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('meta has required fields: window, group_by, metric, total_rows, source_files', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.01),
    ]);

    try {
      const result = await handle(
        { window: '14d', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { meta } = result.structuredContent;

      assert.equal(meta.window, '14d');
      assert.equal(meta.group_by, 'agent_kind');
      assert.equal(meta.metric, 'count');
      assert.ok(typeof meta.total_rows === 'number');
      assert.ok(Array.isArray(meta.source_files));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('groups are sorted alphabetically by key for deterministic output', async () => {
    const tmpDir = makeTmpDir();

    writeAgentMetrics(tmpDir, [
      makeSpawnRow('orch-1', 'reviewer',  'sonnet', 500,  200, 0, 0.005),
      makeSpawnRow('orch-1', 'architect', 'sonnet', 700,  300, 0, 0.007),
      makeSpawnRow('orch-1', 'developer', 'sonnet', 1000, 400, 0, 0.010),
    ]);

    try {
      const result = await handle(
        { window: 'all', group_by: 'agent_kind', metric: 'count' },
        makeContext(tmpDir)
      );
      assert.equal(result.isError, false);
      const { groups } = result.structuredContent;
      const keys = groups.map(g => g.key);

      // Should be alphabetically sorted
      const sorted = [...keys].sort();
      assert.deepEqual(keys, sorted, 'groups must be sorted alphabetically');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('isError result has content[0].text starting with "metrics_query:"', async () => {
    const result = await handle({ window: '7d', group_by: 'bad', metric: 'count' }, {});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.startsWith('metrics_query:'),
      'error message must start with "metrics_query:"');
  });

});
