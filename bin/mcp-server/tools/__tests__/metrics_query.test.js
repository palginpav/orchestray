#!/usr/bin/env node
'use strict';

/**
 * Tests for R-FPX field projection in metrics_query (v2.1.12).
 *
 * Test plan:
 *   T1. No `fields` → full legacy response (backward compat)
 *   T2. fields=["key","mean"] → only those keys in each group
 *   T3. fields=["nonexistent"] → empty objects per group (unknown fields silently skipped)
 *   T4. fields="key,n" (comma string) → projection works with string form
 *   T5. fields="key.mean" (dot notation) → isError, forbidden
 *   T6. Byte-count reduction ≥ 50% on representative fixture (AC-03)
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/metrics_query.test.js
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle } = require('../metrics_query.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mq-test-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'metrics'), { recursive: true });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

/**
 * Write an agent_metrics.jsonl with entries across multiple models and orchestrations.
 * Uses enough orchestration IDs so that grouping by orchestration_id produces many groups,
 * making the groups portion dominate the response (needed for the byte-reduction test).
 */
function writeMetricsEntries(projectRoot) {
  const models = ['sonnet', 'haiku', 'opus'];
  const lines = [];
  const now = Date.now();

  // Write 60 entries across 20 orchestrations — gives enough groups for byte test
  for (let i = 0; i < 60; i++) {
    const model = models[i % models.length];
    const orchId = 'orch-mq-test-' + String(i % 20).padStart(4, '0');
    lines.push(JSON.stringify({
      row_type: 'agent_spawn',
      timestamp: new Date(now - i * 60000).toISOString(),
      orchestration_id: orchId,
      agent_type: i % 3 === 0 ? 'developer' : i % 3 === 1 ? 'reviewer' : 'architect',
      model_used: model,
      usage: {
        input_tokens: 1000 + i * 100,
        cache_read_input_tokens: 200 + i * 10,
        output_tokens: 500 + i * 50,
      },
      estimated_cost_usd: 0.005 + i * 0.001,
    }));
  }

  const metricsPath = path.join(projectRoot, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('metrics_query field projection (R-FPX)', () => {
  let projectRoot;

  before(() => {
    projectRoot = makeTmpProject();
    writeMetricsEntries(projectRoot);
  });

  after(() => {
    cleanup(projectRoot);
  });

  test('T1: no fields → full legacy response (backward compat)', async () => {
    const result = await handle(
      { window: 'all', group_by: 'model', metric: 'cost_usd' },
      { projectRoot }
    );
    assert.equal(result.isError, false, 'should not be an error');
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.groups), 'groups should be an array');
    assert.ok(resp.groups.length > 0, 'should have at least one group');
    // Full response should have all fields per group entry
    const firstGroup = resp.groups[0];
    const groupKeys = Object.keys(firstGroup);
    assert.ok(groupKeys.includes('key'), 'full response should have key');
    assert.ok(groupKeys.includes('n'), 'full response should have n');
    assert.ok(groupKeys.includes('mean'), 'full response should have mean');
    assert.ok(groupKeys.includes('p50'), 'full response should have p50');
  });

  test('T2: fields=["key","mean"] → only those keys in each group', async () => {
    const result = await handle(
      { window: 'all', group_by: 'model', metric: 'cost_usd', fields: ['key', 'mean'] },
      { projectRoot }
    );
    assert.equal(result.isError, false);
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.groups));
    assert.ok(resp.groups.length > 0);
    for (const group of resp.groups) {
      const keys = Object.keys(group);
      for (const key of keys) {
        assert.ok(['key', 'mean'].includes(key), 'unexpected key: ' + key);
      }
    }
  });

  test('T3: fields=["nonexistent"] → empty objects per group (unknown fields silently skipped)', async () => {
    const result = await handle(
      { window: 'all', group_by: 'model', metric: 'cost_usd', fields: ['nonexistent'] },
      { projectRoot }
    );
    assert.equal(result.isError, false);
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.groups));
    for (const group of resp.groups) {
      assert.deepEqual(group, {}, 'unknown fields should produce empty objects');
    }
  });

  test('T4: fields="key,n" (comma string) → projection works', async () => {
    const result = await handle(
      { window: 'all', group_by: 'model', metric: 'count', fields: 'key,n' },
      { projectRoot }
    );
    assert.equal(result.isError, false);
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.groups));
    for (const group of resp.groups) {
      for (const key of Object.keys(group)) {
        assert.ok(['key', 'n'].includes(key), 'unexpected key: ' + key);
      }
    }
  });

  test('T5: fields="key.mean" (dot notation) → error, forbidden', async () => {
    const result = await handle(
      { window: 'all', group_by: 'model', metric: 'cost_usd', fields: 'key.mean' },
      { projectRoot }
    );
    assert.equal(result.isError, true, 'dot notation should be rejected');
  });

  test('T6: byte-count reduction ≥ 50% grouping by orchestration_id with fields=["key"] (AC-03)', async () => {
    // Group by orchestration_id to get 10 groups — each group has key, n, mean, p50.
    // Many groups ensure the groups array dominates the response size, making projection
    // savings (dropping n, mean, p50) exceed 50% of total bytes.
    const fullResult = await handle(
      { window: 'all', group_by: 'orchestration_id', metric: 'cost_usd' },
      { projectRoot }
    );
    const fullText = fullResult.content[0].text;
    const fullResp = JSON.parse(fullText);

    // Verify we have enough groups for a meaningful byte comparison
    assert.ok(fullResp.groups.length >= 10, 'need at least 10 groups for meaningful byte test; got ' + fullResp.groups.length);

    // Project to only key — drops n (count), mean (float), p50 (float) from each group
    const projResult = await handle(
      { window: 'all', group_by: 'orchestration_id', metric: 'cost_usd', fields: ['key'] },
      { projectRoot }
    );
    const projText = projResult.content[0].text;

    const fullBytes = Buffer.byteLength(fullText, 'utf8');
    const projBytes = Buffer.byteLength(projText, 'utf8');

    assert.ok(
      projBytes < fullBytes * 0.5,
      'projected response should be < 50% of full response size; got ' +
        projBytes + ' vs ' + fullBytes + ' bytes (' +
        ((projBytes / fullBytes) * 100).toFixed(1) + '%)'
    );
  });
});
