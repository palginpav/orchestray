#!/usr/bin/env node
'use strict';

/**
 * PreToolUse:Agent hook — H1 cost-budget enforcement gate.
 *
 * Runs BEFORE gate-agent-spawn.js on every Agent|Explore|Task spawn.
 * Projects the spawn's cost via cost_budget_check helpers and compares
 * against configured caps (max_cost_usd, daily_cost_limit_usd,
 * weekly_cost_limit_usd).
 *
 * Behaviour per config:
 *   cost_budget_enforcement.enabled = false (default): skip all checks, exit 0.
 *   cost_budget_enforcement.enabled = true:
 *     On breach AND hard_block = true:  exit 2 (deny spawn).
 *     On breach AND hard_block = false: stderr warn + exit 0 (allow spawn).
 *   Fail-open on ANY read/parse error: stderr warn + exit 0.
 *
 * Default config (2.0.16):
 *   cost_budget_enforcement: { enabled: false, hard_block: false }
 * Opt-in to hard blocking:
 *   cost_budget_enforcement: { enabled: true, hard_block: true }
 *
 * Per v2016-release-plan.md §W5 (H1 gate).
 * OQ2 decision: hard_block default is false (warn mode) for 2.0.16.
 */

const fs = require('fs');
const path = require('path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { loadCostBudgetEnforcementConfig } = require('./_lib/config-schema');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// Import cost_budget_check helpers — reuse library functions rather than
// duplicating cost projection logic. W15 effort multiplier is transparent here
// (resolveEffortMultiplier is called internally by the shared helper).
const {
  resolveModelTier,
  computeCost,
  readAccumulatedCost,
} = require('./mcp-server/tools/cost_budget_check');

// Import config-schema helpers for pricing + caps
const {
  loadCostBudgetCheckConfig,
} = require('./_lib/config-schema');

// Import the effort multiplier resolver (exported from cost_budget_check).
const { resolveEffortMultiplier } = require('./mcp-server/tools/cost_budget_check');

// Shared cost helpers — canonical pricing table, token estimates, cap helpers,
// and reservation reader (F09: de-duplicated from three callers).
const {
  DEFAULT_TOKEN_ESTIMATES,
  getRatesForTier,
  readCostCaps,
  loadRawConfig,
  readActiveReservations,
} = require('./_lib/cost-helpers');

// ---------------------------------------------------------------------------
// Current orchestration_id reader
// ---------------------------------------------------------------------------

function readOrchestrationId(cwd) {
  try {
    const orchFile = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
    const raw = fs.readFileSync(orchFile, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && parsed.orchestration_id) || null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] gate-cost-budget: stdin exceeded limit; failing open\n');
    process.exit(0);
  }
});
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(input);

    // Only gate known agent-dispatch tools — mirrors gate-agent-spawn.js allowlist.
    const toolName = event.tool_name || (event.tool_input && event.tool_input.tool) || '';
    const SKIP_ALLOWLIST = new Set([
      'Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Write',
      'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
    ]);
    const AGENT_DISPATCH_ALLOWLIST = new Set(['Agent', 'Explore', 'Task']);

    if (SKIP_ALLOWLIST.has(toolName)) {
      process.exit(0);
    }

    if (!AGENT_DISPATCH_ALLOWLIST.has(toolName)) {
      // Unknown tool — let gate-agent-spawn.js handle it; we exit 0.
      process.exit(0);
    }

    const cwd = resolveSafeCwd(event.cwd);

    // Load enforcement config — fail-open if missing/malformed.
    let enfConfig;
    try {
      enfConfig = loadCostBudgetEnforcementConfig(cwd);
    } catch (_e) {
      process.stderr.write(
        '[orchestray] gate-cost-budget: failed to load enforcement config; failing open\n'
      );
      process.exit(0);
    }

    // Fast path: enforcement disabled (default in 2.0.16).
    if (!enfConfig.enabled) {
      process.exit(0);
    }

    // Load raw config for cost caps.
    const rawConfig = loadRawConfig(cwd);
    const caps = readCostCaps(rawConfig);
    const anyCap = caps.max_cost_usd !== null ||
                   caps.daily_cost_limit_usd !== null ||
                   caps.weekly_cost_limit_usd !== null;

    // No caps configured — nothing to enforce.
    if (!anyCap) {
      process.exit(0);
    }

    // Read current orchestration_id for accumulated cost lookup.
    const orchId = readOrchestrationId(cwd);

    // Load pricing config.
    let pricingConfig;
    try {
      pricingConfig = loadCostBudgetCheckConfig(cwd);
    } catch (_e) {
      process.stderr.write(
        '[orchestray] gate-cost-budget: failed to load pricing config; failing open\n'
      );
      process.exit(0);
    }

    // Resolve model + tier from the spawn's tool_input.
    const toolInput = (event.tool_input && typeof event.tool_input === 'object')
      ? event.tool_input
      : {};
    const modelRaw = toolInput.model || 'sonnet';
    const tier = resolveModelTier(modelRaw);

    // Resolve token estimates — use tier defaults (conservative over-estimate).
    const defaults = DEFAULT_TOKEN_ESTIMATES[tier] || DEFAULT_TOKEN_ESTIMATES.sonnet;
    const inputTokens = defaults.input;
    const outputTokens = defaults.output;

    // Resolve rates.
    const rates = getRatesForTier(pricingConfig.pricing_table, tier);

    // Compute base projected cost.
    const baseCostUsd = computeCost(inputTokens, outputTokens, rates);

    // Apply effort multiplier if present in the spawn payload.
    const effortRaw = toolInput.effort || null;
    const multiplier = resolveEffortMultiplier(effortRaw, pricingConfig.effort_multipliers);
    const projectedCostUsd = baseCostUsd * multiplier;

    // Read accumulated cost — fail-open if unavailable.
    const today = new Date().toISOString().slice(0, 10);
    let accumulatedUsd = 0;
    let accumulatedDailyUsd = 0;

    if (orchId) {
      try {
        const [accTotal, accDaily] = await Promise.all([
          readAccumulatedCost(orchId, cwd, null),
          readAccumulatedCost(orchId, cwd, today),
        ]);
        accumulatedUsd = accTotal.accumulated_usd;
        accumulatedDailyUsd = accDaily.accumulated_usd;
      } catch (_accErr) {
        process.stderr.write(
          '[orchestray] gate-cost-budget: accumulated cost read failed; using $0 as accumulated\n'
        );
      }

      // F01 (v2.0.16): add unexpired reservations so parallel-spawn pre-checks
      // account for in-flight cost commitments. Fail-open: returns 0 on error.
      // A2-S2 fix: pass sinceTimestamp so yesterday's reservations don't inflate
      // today's daily-cap accumulator.
      try {
        const todayStartMs = new Date(today + 'T00:00:00.000Z').getTime();
        const activeRes = readActiveReservations(orchId, cwd, { sinceTimestamp: todayStartMs });
        accumulatedUsd += activeRes.reserved_usd;
        accumulatedDailyUsd += activeRes.reserved_daily_usd;
      } catch (_resErr) {
        process.stderr.write(
          '[orchestray] gate-cost-budget: reservation read failed; ignoring reservations\n'
        );
      }
    }

    // Cap comparisons.
    const totalForMaxCap   = accumulatedUsd + projectedCostUsd;
    const totalForDailyCap = accumulatedDailyUsd + projectedCostUsd;
    // Weekly: use total accumulated as conservative estimate (same as cost_budget_check.js).
    const totalForWeeklyCap = accumulatedUsd + projectedCostUsd;

    const breaches = [];
    if (caps.max_cost_usd !== null && totalForMaxCap > caps.max_cost_usd) {
      breaches.push(
        `max_cost_usd $${caps.max_cost_usd} (accumulated+projected: $${totalForMaxCap.toFixed(4)})`
      );
    }
    if (caps.daily_cost_limit_usd !== null && totalForDailyCap > caps.daily_cost_limit_usd) {
      breaches.push(
        `daily_cost_limit_usd $${caps.daily_cost_limit_usd} (accumulated+projected today: $${totalForDailyCap.toFixed(4)})`
      );
    }
    if (caps.weekly_cost_limit_usd !== null && totalForWeeklyCap > caps.weekly_cost_limit_usd) {
      breaches.push(
        `weekly_cost_limit_usd $${caps.weekly_cost_limit_usd} (accumulated+projected: $${totalForWeeklyCap.toFixed(4)})`
      );
    }

    if (breaches.length === 0) {
      // All caps within budget — allow spawn.
      process.exit(0);
    }

    // Breach detected.
    const breachMsg =
      '[orchestray] gate-cost-budget: cost-budget breach detected — ' +
      'projected $' + projectedCostUsd.toFixed(4) +
      ' (model=' + tier + (effortRaw ? ', effort=' + effortRaw : '') + ')' +
      ' would exceed: ' + breaches.join('; ') + '. ' +
      'Accumulated cost this orchestration: $' + accumulatedUsd.toFixed(4) + '.\n';

    if (enfConfig.hard_block) {
      // Hard block: deny spawn (exit 2).
      // F14: emit structured hookSpecificOutput JSON on stdout before exit so
      // Claude Code can surface a machine-readable denial reason (mirrors context-shield.js).
      const blockMsg =
        '[orchestray] gate-cost-budget: spawn BLOCKED (hard_block=true). ' +
        'Set cost_budget_enforcement.hard_block=false or raise the cap to allow. ' +
        'Emergency: set cost_budget_enforcement.enabled=false.\n';
      process.stderr.write(breachMsg + blockMsg);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: breachMsg.replace(/\n$/, ''),
        },
      }));
      process.exit(2);
    } else {
      // Warn mode (default): stderr warn + allow (exit 0).
      // F14: emit structured hookSpecificOutput JSON on stdout (advisory allow).
      const warnFull =
        breachMsg +
        '[orchestray] gate-cost-budget: spawn ALLOWED (hard_block=false, warn mode). ' +
        'Set cost_budget_enforcement.hard_block=true to block on breach.\n';
      process.stderr.write(warnFull);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      }));
      process.exit(0);
    }

  } catch (_e) {
    // Fail-open: malformed JSON or any unexpected error.
    process.stderr.write(
      '[orchestray] gate-cost-budget: unexpected error (' +
      (_e && _e.message) + '); failing open\n'
    );
    process.exit(0);
  }
});
