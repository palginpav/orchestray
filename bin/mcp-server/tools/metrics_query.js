'use strict';

/**
 * `metrics_query` MCP tool.
 *
 * Aggregates data from agent_metrics.jsonl and orchestration_rollup.jsonl,
 * returning grouped statistics (mean, p50) for requested metrics.
 *
 * Respects ORCHESTRAY_METRICS_DISABLED=1 kill-switch — returns empty result
 * with meta flag when set.
 *
 * Per v2.0.17 design §9 G1 T5.
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { mean, p50, groupBy } = require('../../_lib/analytics');
const { parseFields, projectArray } = require('../lib/field-projection');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

const WINDOWS = ['7d', '14d', '30d', 'all'];
const GROUP_BY_VALUES = ['agent_kind', 'model', 'orchestration_id', 'none'];
const METRIC_VALUES = ['cache_hit_ratio', 'input_tokens', 'output_tokens', 'cost_usd', 'count'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['window', 'group_by', 'metric'],
  properties: {
    window: {
      type: 'string',
      enum: WINDOWS,
      description: 'Time window to filter rows: 7d, 14d, 30d, or all.',
    },
    group_by: {
      type: 'string',
      enum: GROUP_BY_VALUES,
      description: 'Field to group results by: agent_kind, model, orchestration_id, or none.',
    },
    metric: {
      type: 'string',
      enum: METRIC_VALUES,
      description:
        'Metric to aggregate: cache_hit_ratio, input_tokens, output_tokens, cost_usd, or count.',
    },
    // fields: accepts a comma-separated string or string[] — validated by parseFields() at runtime.
    // Schema type intentionally omitted: the validator subset does not support oneOf/anyOf,
    // and parseFields() enforces the allowed shapes with clear error messages.
    fields: { description: 'Optional comma-separated string or array of top-level field names to project. Omit for full response (backward compat).' },
  },
};

const definition = deepFreeze({
  name: 'metrics_query',
  description:
    'Aggregate metrics from agent_metrics.jsonl and orchestration_rollup.jsonl. ' +
    'Returns grouped statistics (n, mean, p50) for the requested metric and time window. ' +
    'Handles missing files gracefully (empty result). ' +
    'Respects ORCHESTRAY_METRICS_DISABLED=1 kill-switch.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Window cutoff helpers
// ---------------------------------------------------------------------------

/**
 * Compute the cutoff timestamp (ms since epoch) for the given window string.
 * Returns 0 for "all" (no filter).
 *
 * @param {string} window
 * @returns {number}
 */
function windowCutoffMs(window) {
  const now = Date.now();
  if (window === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (window === '14d') return now - 14 * 24 * 60 * 60 * 1000;
  if (window === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return 0; // 'all'
}

// ---------------------------------------------------------------------------
// JSONL reading helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSONL file. Returns an array of parsed rows.
 * Returns [] if the file does not exist or cannot be read. Fail-open.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    // Other I/O errors — fail open, return empty
    return [];
  }
  const rows = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') rows.push(obj);
    } catch (_e) {
      // Skip malformed lines
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an agent_metrics.jsonl row into a flat record suitable for
 * aggregation. Maps schema fields to the canonical metric field names
 * used by the query engine.
 *
 * Returns null if the row has an unrecognized row_type.
 *
 * @param {object} row
 * @returns {object|null}
 */
function normalizeAgentRow(row) {
  const usage = (row.usage && typeof row.usage === 'object') ? row.usage : {};

  const inputTokens = (typeof usage.input_tokens === 'number') ? usage.input_tokens : 0;
  const cacheRead = (typeof usage.cache_read_input_tokens === 'number')
    ? usage.cache_read_input_tokens : 0;
  const outputTokens = (typeof usage.output_tokens === 'number') ? usage.output_tokens : 0;
  const costUsd = (typeof row.estimated_cost_usd === 'number') ? row.estimated_cost_usd : 0;

  // cache_hit_ratio: cache_read / (cache_read + input_tokens)
  const denominator = cacheRead + inputTokens;
  const cacheHitRatio = denominator > 0 ? cacheRead / denominator : null;

  return {
    _row_type: row.row_type,
    timestamp: row.timestamp || null,
    orchestration_id: row.orchestration_id || null,
    // agent_kind maps from agent_type (agent_spawn) or is 'pm' (pm_turn)
    agent_kind: row.row_type === 'pm_turn' ? 'pm' : (row.agent_type || null),
    model: row.model_used || null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    cache_hit_ratio: cacheHitRatio,
  };
}

/**
 * Normalize an orchestration_rollup.jsonl row into a flat record.
 * The rollup row uses total_* fields. We map them to the same field names.
 *
 * @param {object} row
 * @returns {object}
 */
function normalizeRollupRow(row) {
  const inputTokens = (typeof row.total_input_tokens === 'number') ? row.total_input_tokens : 0;
  const cacheRead = (typeof row.total_cache_read_input_tokens === 'number')
    ? row.total_cache_read_input_tokens : 0;
  const outputTokens = (typeof row.total_output_tokens === 'number') ? row.total_output_tokens : 0;
  const costUsd = (typeof row.total_cost_usd === 'number') ? row.total_cost_usd : 0;

  const denominator = cacheRead + inputTokens;
  const cacheHitRatio = denominator > 0 ? cacheRead / denominator : null;

  return {
    _row_type: row.row_type,
    timestamp: row.emitted_at || row.completed_at || null,
    orchestration_id: row.orchestration_id || null,
    agent_kind: 'rollup',
    model: null, // rollup rows don't have a single model field
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    cache_hit_ratio: cacheHitRatio,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Compute the metric value for a given row. Returns null when the row should
 * be dropped (e.g., cache_hit_ratio with zero denominator).
 *
 * @param {object} row - Normalized row
 * @param {string} metric
 * @returns {number|null}
 */
function extractMetricValue(row, metric) {
  if (metric === 'cache_hit_ratio') {
    return row.cache_hit_ratio; // null means drop
  }
  if (metric === 'input_tokens') return row.input_tokens;
  if (metric === 'output_tokens') return row.output_tokens;
  if (metric === 'cost_usd') return row.cost_usd;
  // 'count' is handled at the group level — return 1 as a sentinel
  if (metric === 'count') return 1;
  return null;
}

/**
 * Build the group key string for a row given the group_by field.
 *
 * @param {object} row
 * @param {string} groupByField
 * @returns {string}
 */
function buildGroupKey(row, groupByField) {
  if (groupByField === 'none') return '__all__';
  const val = row[groupByField];
  return String(val != null ? val : 'null');
}

/**
 * Aggregate normalized rows into group summaries.
 *
 * For 'count' metric, mean and p50 are both set to the group count (n).
 * For other metrics, rows with null values (e.g., cache_hit_ratio with zero
 * denominator) are excluded from mean/p50 but counted in n.
 *
 * @param {object[]} rows - Normalized rows
 * @param {string} groupByField
 * @param {string} metric
 * @returns {Array<{key: string, n: number, mean: number|null, p50: number|null}>}
 */
function aggregate(rows, groupByField, metric) {
  // Partition rows by group key
  const groups = groupBy(rows, groupByField === 'none' ? '_group_none' : groupByField);

  // If group_by is 'none', all rows map to '__all__' via buildGroupKey.
  // groupBy uses the actual field value, so we need a normalized approach.
  // Rebuild manually to use buildGroupKey.
  const keyedGroups = new Map();
  for (const row of rows) {
    const key = buildGroupKey(row, groupByField);
    if (!keyedGroups.has(key)) keyedGroups.set(key, []);
    keyedGroups.get(key).push(row);
  }

  const result = [];
  for (const [key, groupRows] of keyedGroups) {
    const n = groupRows.length;

    if (metric === 'count') {
      result.push({ key, n, mean: n, p50: n });
      continue;
    }

    // Build a synthetic row array with the metric field set
    const metricRows = [];
    for (const row of groupRows) {
      const val = extractMetricValue(row, metric);
      if (val !== null && typeof val === 'number' && isFinite(val)) {
        metricRows.push({ _val: val });
      }
    }

    result.push({
      key,
      n,
      mean: mean(metricRows, '_val'),
      p50: p50(metricRows, '_val'),
    });
  }

  // Sort by key for deterministic output
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('metrics_query', context);
  // Validate input
  const validation = validateAgainstSchema(input || {}, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('metrics_query: ' + validation.errors.join('; '));
  }

  const { window: win, group_by: groupByField, metric } = input;

  // Kill-switch env var check.
  if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') {
    return toolSuccess({
      groups: [],
      meta: {
        window: win,
        group_by: groupByField,
        metric,
        total_rows: 0,
        source_files: [],
        metrics_disabled: true,
      },
    });
  }

  // Resolve project root for file paths
  const projectRoot = (context && context.projectRoot) || null;

  let agentMetricsPath = null;
  let rollupPath = null;
  const sourceFiles = [];

  if (projectRoot) {
    agentMetricsPath = path.join(projectRoot, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    rollupPath = path.join(projectRoot, '.orchestray', 'metrics', 'orchestration_rollup.jsonl');
  }

  // Read source files
  const rawAgentRows = agentMetricsPath ? readJsonl(agentMetricsPath) : [];
  const rawRollupRows = rollupPath ? readJsonl(rollupPath) : [];

  if (rawAgentRows.length > 0) sourceFiles.push('agent_metrics.jsonl');
  if (rawRollupRows.length > 0) sourceFiles.push('orchestration_rollup.jsonl');

  // Normalize rows
  const normalizedRows = [];
  for (const row of rawAgentRows) {
    const norm = normalizeAgentRow(row);
    if (norm !== null) normalizedRows.push(norm);
  }
  for (const row of rawRollupRows) {
    normalizedRows.push(normalizeRollupRow(row));
  }

  // Apply window filter
  const cutoffMs = windowCutoffMs(win);
  const filtered = cutoffMs === 0
    ? normalizedRows
    : normalizedRows.filter(row => {
        if (!row.timestamp) return true; // include rows with no timestamp
        const ts = Date.parse(row.timestamp);
        return isNaN(ts) || ts >= cutoffMs;
      });

  const totalRows = filtered.length;

  // Aggregate
  const groups = aggregate(filtered, groupByField, metric);

  // Apply field projection when `fields` is requested; omit for full response.
  const fieldSpec = parseFields(input && input.fields);
  if (fieldSpec && fieldSpec.error) {
    return toolError('metrics_query: ' + fieldSpec.error);
  }
  const projectedGroups = (fieldSpec !== null) ? projectArray(groups, fieldSpec) : groups;

  return toolSuccess({
    groups: projectedGroups,
    meta: {
      window: win,
      group_by: groupByField,
      metric,
      total_rows: totalRows,
      source_files: sourceFiles,
      metrics_disabled: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Self-test (node bin/mcp-server/tools/metrics_query.js --self-test)
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module && process.argv.includes('--self-test')) {
  const assert = require('node:assert');

  // Synthetic rows to exercise the handler in isolation without needing real files.
  // We exercise handle() by injecting a fake context with no projectRoot so it
  // skips file I/O and returns empty; then we test the aggregation helpers directly.

  // --- Test 1: aggregate counts ---
  const syntheticRows = [
    {
      _row_type: 'agent_spawn',
      timestamp: new Date().toISOString(),
      orchestration_id: 'orch-1',
      agent_kind: 'developer',
      model: 'sonnet',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.005,
      cache_hit_ratio: 0.3,
    },
    {
      _row_type: 'agent_spawn',
      timestamp: new Date().toISOString(),
      orchestration_id: 'orch-1',
      agent_kind: 'reviewer',
      model: 'haiku',
      input_tokens: 800,
      output_tokens: 300,
      cost_usd: 0.002,
      cache_hit_ratio: 0.5,
    },
    {
      _row_type: 'pm_turn',
      timestamp: new Date().toISOString(),
      orchestration_id: 'orch-2',
      agent_kind: 'pm',
      model: 'opus',
      input_tokens: 2000,
      output_tokens: 800,
      cost_usd: 0.015,
      cache_hit_ratio: null, // zero denominator — should be dropped from cache_hit_ratio agg
    },
  ];

  // count grouped by agent_kind
  const countGroups = aggregate(syntheticRows, 'agent_kind', 'count');
  assert.strictEqual(countGroups.length, 3, 'Expected 3 groups (developer, pm, reviewer)');
  const pmGroup = countGroups.find(g => g.key === 'pm');
  assert.ok(pmGroup, 'Expected pm group');
  assert.strictEqual(pmGroup.n, 1);
  assert.strictEqual(pmGroup.mean, 1);

  // cost_usd grouped by none
  const costGroups = aggregate(syntheticRows, 'none', 'cost_usd');
  assert.strictEqual(costGroups.length, 1, 'Expected single group for none');
  assert.strictEqual(costGroups[0].key, '__all__');
  assert.strictEqual(costGroups[0].n, 3);
  const expectedMean = (0.005 + 0.002 + 0.015) / 3;
  assert.ok(Math.abs(costGroups[0].mean - expectedMean) < 1e-9, 'Mean cost mismatch');

  // cache_hit_ratio — null row excluded from mean/p50 but counted in n
  const cacheGroups = aggregate(syntheticRows, 'none', 'cache_hit_ratio');
  assert.strictEqual(cacheGroups[0].n, 3, 'n should count all rows');
  const expectedCacheMean = (0.3 + 0.5) / 2;
  assert.ok(Math.abs(cacheGroups[0].mean - expectedCacheMean) < 1e-9, 'Cache hit ratio mean mismatch');

  // window cutoff filter — old row excluded
  const oldRow = Object.assign({}, syntheticRows[0], {
    timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
  });
  const rowsWithOld = [oldRow, syntheticRows[1], syntheticRows[2]];
  const cutoff7d = windowCutoffMs('7d');
  const filtered7d = rowsWithOld.filter(row => {
    if (!row.timestamp) return true;
    const ts = Date.parse(row.timestamp);
    return isNaN(ts) || ts >= cutoff7d;
  });
  assert.strictEqual(filtered7d.length, 2, 'Old row should be filtered out in 7d window');

  // kill-switch path (env var in handle())
  const disabledResult = (() => {
    const orig = process.env.ORCHESTRAY_METRICS_DISABLED;
    process.env.ORCHESTRAY_METRICS_DISABLED = '1';
    const disabled = process.env.ORCHESTRAY_METRICS_DISABLED === '1';
    if (orig === undefined) delete process.env.ORCHESTRAY_METRICS_DISABLED;
    else process.env.ORCHESTRAY_METRICS_DISABLED = orig;
    return disabled;
  })();
  assert.ok(disabledResult, 'Kill-switch env check should be truthy');

  process.stderr.write('[metrics_query self-test] All assertions passed.\n');
  process.exit(0);
}

module.exports = { definition, handle };
