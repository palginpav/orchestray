#!/usr/bin/env node
'use strict';

/**
 * emit-orchestration-rollup.js
 *
 * Given an orchestration_id, walks agent_metrics.jsonl and events.jsonl to
 * compute a per-orchestration rollup row and appends it to
 * .orchestray/metrics/orchestration_rollup.jsonl.
 *
 * Best-effort idempotent: uses a `.rollup-<id>.done` sentinel to prevent
 * re-emission, but a crash between the rollup append and the sentinel write
 * can produce a duplicate row. Downstream aggregation must tolerate duplicates
 * by deduping on `orchestration_id` + `emitted_at`.
 *
 * Usage (CLI):
 *   node bin/emit-orchestration-rollup.js <orchestration_id>
 *   node bin/emit-orchestration-rollup.js --orchestration-id <id>
 *   node bin/emit-orchestration-rollup.js --help
 *
 * Usage (programmatic):
 *   const { emitRollup } = require('./emit-orchestration-rollup');
 *   emitRollup(cwd, orchestrationId);  // returns { written: bool, reason: string }
 *
 * Fail-open: any I/O error is caught and logged; the process exits 0.
 * Respects ORCHESTRAY_METRICS_DISABLED=1 env kill-switch.
 */

const fs   = require('fs');
const path = require('path');

const { appendJsonlWithRotation } = require('./_lib/jsonl-rotate');
const { mean, p50, countBy }      = require('./_lib/analytics');
const { resolveSafeCwd }          = require('./_lib/resolve-project-cwd');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse all non-empty lines of a JSONL file. Returns [] if missing or unreadable.
 * Skips lines that are not valid JSON.
 *
 * @param {string} filePath
 * @param {number} [maxBytes] - Optional size cap; returns [] if exceeded.
 * @returns {Object[]}
 */
function readJsonl(filePath, maxBytes) {
  try {
    if (maxBytes != null) {
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) {
        process.stderr.write(
          '[orchestray] emit-rollup: ' + filePath +
          ' exceeds size cap (' + stat.size + ' > ' + maxBytes + '); skipping\n'
        );
        return [];
      }
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch (_e) {}
    }
    return rows;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write('[orchestray] emit-rollup: read error ' + filePath + ': ' + (err && err.message) + '\n');
    }
    return [];
  }
}

/**
 * Compute weighted cache-hit ratio across agent_metrics rows.
 * cache_hit_ratio = cache_read_input_tokens / (input_tokens + cache_read_input_tokens)
 * Weighted by (input_tokens + cache_read_input_tokens) per row.
 *
 * Returns null if there are no valid denominator rows.
 *
 * @param {Object[]} rows - Rows from agent_metrics.jsonl for one orchestration
 * @returns {number|null}
 */
function weightedCacheHitRatio(rows) {
  let numerator   = 0;
  let denominator = 0;
  for (const row of rows) {
    const u = row.usage || {};
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    const rawInput  = Number(u.input_tokens)            || 0;
    const denom     = rawInput + cacheRead;
    if (denom > 0) {
      numerator   += cacheRead;
      denominator += denom;
    }
  }
  return denominator > 0 ? numerator / denominator : null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Emit a rollup row for `orchestrationId` into `orchestration_rollup.jsonl`.
 * Idempotent via sentinel.
 *
 * @param {string} cwd              - Project root
 * @param {string} orchestrationId  - e.g. "orch-1775921459"
 * @returns {{ written: boolean, reason: string }}
 */
function emitRollup(cwd, orchestrationId) {
  if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') {
    return { written: false, reason: 'metrics_disabled' };
  }

  if (!orchestrationId || orchestrationId === 'unknown') {
    return { written: false, reason: 'invalid_orchestration_id' };
  }

  const stateDir   = path.join(cwd, '.orchestray', 'state');
  const metricsDir = path.join(cwd, '.orchestray', 'metrics');
  const auditDir   = path.join(cwd, '.orchestray', 'audit');

  // Idempotency sentinel.
  const sentinelPath = path.join(stateDir, '.rollup-' + orchestrationId + '.done');
  if (fs.existsSync(sentinelPath)) {
    return { written: false, reason: 'already_emitted' };
  }

  // Read source files (50 MB cap each — matches jsonl-rotate default).
  const MAX_READ = 50 * 1024 * 1024;
  const metricsPath = path.join(metricsDir, 'agent_metrics.jsonl');
  const eventsPath  = path.join(auditDir,   'events.jsonl');

  const allMetrics = readJsonl(metricsPath, MAX_READ);
  const allEvents  = readJsonl(eventsPath,  MAX_READ);

  // Filter to this orchestration.
  const orchMetrics = allMetrics.filter(r => r.orchestration_id === orchestrationId);
  const orchEvents  = allEvents.filter(r  => r.orchestration_id === orchestrationId);

  // Separate subagent spawn rows from pm_turn rows.
  const spawnRows  = orchMetrics.filter(r => r.row_type === 'agent_spawn');
  const pmTurnRows = orchMetrics.filter(r => r.row_type === 'pm_turn');

  // Total token sums across all subagent spawns.
  let total_input_tokens            = 0;
  let total_output_tokens           = 0;
  let total_cache_read_input_tokens = 0;
  let total_cache_creation_input_tokens = 0;
  let total_cost_usd                = 0;

  for (const row of spawnRows) {
    const u = row.usage || {};
    total_input_tokens            += Number(u.input_tokens)                  || 0;
    total_output_tokens           += Number(u.output_tokens)                 || 0;
    total_cache_read_input_tokens += Number(u.cache_read_input_tokens)       || 0;
    total_cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
    total_cost_usd                += Number(row.estimated_cost_usd)          || 0;
  }

  // PM-turn totals.
  let pm_total_input_tokens            = 0;
  let pm_total_output_tokens           = 0;
  let pm_total_cache_read_input_tokens = 0;

  for (const row of pmTurnRows) {
    const u = row.usage || {};
    pm_total_input_tokens            += Number(u.input_tokens)            || 0;
    pm_total_output_tokens           += Number(u.output_tokens)           || 0;
    pm_total_cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
  }

  // Agent-type breakdown (cost per agent_type, agent count).
  const agentTypeCounts = countBy(spawnRows, 'agent_type');

  // Per-spawn p50 + mean cost.
  const mean_spawn_cost_usd = mean(spawnRows, 'estimated_cost_usd');
  const p50_spawn_cost_usd  = p50(spawnRows,  'estimated_cost_usd');

  // Weighted subagent cache-hit ratio (excludes pm_turn rows by construction).
  const subagent_cache_hit_ratio = weightedCacheHitRatio(spawnRows);

  // PM cache-hit ratio (from pm_turn rows).
  const pm_cache_hit_ratio = weightedCacheHitRatio(pmTurnRows);

  // Determine overall orchestration result from orchestration_complete event.
  let status = 'unknown';
  for (const ev of orchEvents) {
    if (ev.type === 'orchestration_complete') {
      status = ev.status || 'complete';
      break;
    }
  }

  // Task hash: SHA-256 of the orchestration_id (downstream T10 CHANGELOG note:
  // task descriptions are hashed for the rollup, not included raw).
  // We use a simple deterministic placeholder here since Node crypto is stdlib.
  let task_hash = null;
  try {
    const crypto = require('crypto');
    // Hash the orchestration_id itself as a stable identifier.
    task_hash = crypto.createHash('sha256').update(orchestrationId).digest('hex').slice(0, 16);
  } catch (_e) {}

  // Find the orchestration_complete event for timestamps.
  const completeEvent = orchEvents.find(ev => ev.type === 'orchestration_complete');
  const started_at    = orchEvents.length > 0
    ? (orchEvents[0].timestamp || null)
    : null;
  const completed_at  = completeEvent ? (completeEvent.timestamp || null) : null;

  // R-DX1 (AC-13): collect model_auto_resolved warn events and render as human-readable lines.
  // These appear in the rollup so the PM can see auto-resolutions at a glance.
  const autoResolveEvents = orchEvents.filter(ev =>
    ev.event === 'model_auto_resolved' || ev.type === 'model_auto_resolved'
  );
  const model_auto_resolved_warnings = autoResolveEvents.map(ev => {
    const agentStr = ev.subagent_type || '(unknown)';
    const taskStr  = ev.task_hint ? ev.task_hint.substring(0, 40) : '(no hint)';
    const src      = ev.source || 'unknown';
    const mdl      = ev.resolved_model || '?';
    if (src === 'global_default_sonnet') {
      return "- model auto-resolved to default '" + mdl + "' for agent " + agentStr + " (task: " + taskStr + ")";
    }
    return "- model auto-resolved to '" + mdl + "' (source: " + src + ") for agent " + agentStr + " (task: " + taskStr + ")";
  });

  const rollupRow = {
    row_type:                        'orchestration_rollup',
    schema_version:                  1,
    orchestration_id:                orchestrationId,
    task_hash,
    status,
    started_at,
    completed_at,
    emitted_at:                      new Date().toISOString(),
    // Subagent totals
    spawn_count:                     spawnRows.length,
    agent_type_counts:               agentTypeCounts,
    total_input_tokens,
    total_output_tokens,
    total_cache_read_input_tokens,
    total_cache_creation_input_tokens,
    total_cost_usd:                  Math.round(total_cost_usd * 1_000_000) / 1_000_000,
    mean_spawn_cost_usd,
    p50_spawn_cost_usd,
    subagent_cache_hit_ratio,
    // PM-turn totals
    pm_turn_count:                   pmTurnRows.length,
    pm_total_input_tokens,
    pm_total_output_tokens,
    pm_total_cache_read_input_tokens,
    pm_cache_hit_ratio,
    // R-DX1 (AC-13): human-readable model auto-resolution warnings for the rollup.
    model_auto_resolved_warnings:    model_auto_resolved_warnings.length > 0
      ? model_auto_resolved_warnings
      : undefined,
  };

  // Write rollup row.
  try {
    fs.mkdirSync(metricsDir, { recursive: true });
    const rollupPath = path.join(metricsDir, 'orchestration_rollup.jsonl');
    appendJsonlWithRotation(rollupPath, rollupRow);
  } catch (err) {
    process.stderr.write('[orchestray] emit-rollup: write failed: ' + (err && err.message) + '\n');
    return { written: false, reason: 'write_error' };
  }

  // Write idempotency sentinel.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({ orchestration_id: orchestrationId, emitted_at: rollupRow.emitted_at }) + '\n');
  } catch (_e) {
    // Sentinel write failed — the rollup is already written. Log but do not fail.
    process.stderr.write('[orchestray] emit-rollup: sentinel write failed for ' + orchestrationId + '\n');
  }

  return { written: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    process.stdout.write([
      'Usage: node bin/emit-orchestration-rollup.js <orchestration_id>',
      '       node bin/emit-orchestration-rollup.js --orchestration-id <id>',
      '',
      'Reads .orchestray/metrics/agent_metrics.jsonl and',
      '.orchestray/audit/events.jsonl, computes a per-orchestration rollup,',
      'and appends one row to .orchestray/metrics/orchestration_rollup.jsonl.',
      '',
      'Idempotent: re-running for the same orchestration_id is a no-op.',
      '',
      'Kill-switch: set ORCHESTRAY_METRICS_DISABLED=1 to skip.',
      '',
      'Options:',
      '  --orchestration-id <id>   Explicit flag form.',
      '  --cwd <path>              Project root (default: process.cwd()).',
      '  --help, -h                Print this help.',
    ].join('\n') + '\n');
    process.exit(0);
  }

  let orchestrationId = null;
  let cwdArg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--orchestration-id' && args[i + 1]) {
      orchestrationId = args[++i];
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwdArg = args[++i];
    } else if (!args[i].startsWith('--')) {
      orchestrationId = args[i];
    }
  }

  if (!orchestrationId) {
    process.stderr.write('[orchestray] emit-rollup: orchestration_id is required\n');
    process.exit(1);
  }

  try {
    const cwd = resolveSafeCwd(cwdArg || process.cwd());

    const result = emitRollup(cwd, orchestrationId);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stderr.write('[orchestray] emit-rollup: fatal: ' + (err && err.message) + '\n');
    // Fail-open — exit 0 so a hook caller is never blocked.
    process.exit(0);
  }

  process.exit(0);
}

module.exports = { emitRollup };
