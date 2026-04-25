#!/usr/bin/env node
'use strict';

/**
 * preflight-spawn-budget.js — Pre-spawn context-size budget check (R-BUDGET, v2.1.15).
 *
 * Runs as a PreToolUse:Agent hook BEFORE each agent spawn. Compares the
 * computed total context size (system + tier2 + handoff) against the role's
 * configured budget. By default, enforcement is SOFT (warn-only). Hard-block
 * is opt-in only.
 *
 * Behaviour:
 *   budget_enforcement.enabled = true (default, soft-warn):
 *     On breach AND hard_block = false (default): emit budget_warn, exit 0 (proceed).
 *     On breach AND hard_block = true:            emit budget_warn, exit 2 (deny spawn).
 *   budget_enforcement.enabled = false: kill switch — skip all checks, exit 0.
 *   Fail-open on ANY read/parse error: stderr warn + exit 0.
 *
 * Per W5 F-03 (thin telemetry): no p50 derivation. All 15 role entries use
 * explicit conservative defaults recorded as source: "fallback_model_tier_thin_telemetry".
 *
 * Kill switch: set config.budget_enforcement.enabled = false to disable entirely.
 *
 * Self-test: node bin/preflight-spawn-budget.js --self-test  (exits 0 on success)
 *
 * v2.1.15 — W6 R-BUDGET implementation.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }       = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }      = require('./_lib/constants');
const { writeEvent }           = require('./_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// checkBudget — pure function, exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a spawn exceeds its role budget.
 *
 * @param {string} role           — agent role (e.g. "developer")
 * @param {number} computedSize   — total context tokens being sent to the agent
 * @param {Object} config         — parsed config.json object
 * @returns {{ action: 'ok'|'warn'|'block', role, computed_size, budget, reason, source }}
 */
function checkBudget(role, computedSize, config) {
  // Kill switch check
  const enforcement = config.budget_enforcement || {};
  if (enforcement.enabled === false) {
    return { action: 'ok', role, computed_size: computedSize, budget: null, reason: 'disabled', source: null };
  }

  // Fail-open when role_budgets block is missing
  const roleBudgets = config.role_budgets;
  if (!roleBudgets || typeof roleBudgets !== 'object') {
    return { action: 'ok', role, computed_size: computedSize, budget: null, reason: 'fail_open', source: null };
  }

  // Fail-open when role entry is missing
  const entry = roleBudgets[role];
  if (!entry || typeof entry !== 'object') {
    return { action: 'ok', role, computed_size: computedSize, budget: null, reason: 'fail_open', source: null };
  }

  const budget = entry.budget_tokens;
  if (typeof budget !== 'number' || budget <= 0) {
    return { action: 'ok', role, computed_size: computedSize, budget: null, reason: 'fail_open', source: null };
  }

  const source = entry.source || null;

  if (computedSize <= budget) {
    return { action: 'ok', role, computed_size: computedSize, budget, reason: 'within_budget', source };
  }

  // Over budget — determine warn vs block
  const hardBlock = enforcement.hard_block === true;
  const action = hardBlock ? 'block' : 'warn';
  return { action, role, computed_size: computedSize, budget, reason: 'over_budget', source };
}

// ---------------------------------------------------------------------------
// Module-vs-script guard
// ---------------------------------------------------------------------------
// When this file is `require()`'d (e.g. by tests importing `checkBudget`),
// the stdin listeners and self-test side-effects below MUST NOT execute —
// they would keep Node's event loop alive forever waiting for stdin EOF
// that never comes inside the test runner. Wrap script-mode logic in this
// `if` so the test require() returns cleanly with just `checkBudget`.
if (require.main === module) {
// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  const testConfig = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 60000, source: 'fallback_model_tier_thin_telemetry', calibrated_at: '2026-04-25' },
    },
  };

  // Test 1: warn on over-budget
  const r1 = checkBudget('developer', 70000, testConfig);
  if (r1.action !== 'warn') {
    process.stderr.write(`[preflight-spawn-budget] self-test FAIL: expected warn, got ${r1.action}\n`);
    process.exit(1);
  }

  // Test 2: ok on under-budget
  const r2 = checkBudget('developer', 10000, testConfig);
  if (r2.action !== 'ok') {
    process.stderr.write(`[preflight-spawn-budget] self-test FAIL: expected ok, got ${r2.action}\n`);
    process.exit(1);
  }

  // Test 3: kill switch disables
  const r3 = checkBudget('developer', 99999999, { budget_enforcement: { enabled: false } });
  if (r3.action !== 'ok' || r3.reason !== 'disabled') {
    process.stderr.write(`[preflight-spawn-budget] self-test FAIL: kill switch not working\n`);
    process.exit(1);
  }

  // Test 4: fail-open on missing role
  const r4 = checkBudget('unknown-role', 99999999, testConfig);
  if (r4.action !== 'ok' || r4.reason !== 'fail_open') {
    process.stderr.write(`[preflight-spawn-budget] self-test FAIL: expected fail_open for unknown role\n`);
    process.exit(1);
  }

  process.stdout.write('[preflight-spawn-budget] self-test PASS\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Hook mode — reads stdin from Claude Code PreToolUse event
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] preflight-spawn-budget: stdin exceeded limit; failing open\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);

    // Only run for Agent|Explore|Task — skip all other tools.
    const toolName = event.tool_name || '';
    if (!['Agent', 'Explore', 'Task'].includes(toolName)) {
      process.exit(0);
    }

    const cwd = resolveSafeCwd(event.cwd);

    // Load config — fail-open on any error
    let config;
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_e) {
      process.stderr.write('[orchestray] preflight-spawn-budget: failed to load config; failing open\n');
      process.exit(0);
    }

    // Extract role from tool_input
    const toolInput = event.tool_input || {};
    const role = toolInput.subagent_type || toolInput.agent_type || '';

    // Estimate context size from tool_input fields if available.
    // The PM stages system_size, tier2_size, handoff_size in tool_input when
    // this check is wired into the delegation path. Fall back to 0 (no-op) when
    // not provided — this is the v2.1.15 conservative approach until the PM
    // delegation templates are updated to pass explicit size fields.
    const systemSize   = (toolInput.context_size_hint && toolInput.context_size_hint.system)   || 0;
    const tier2Size    = (toolInput.context_size_hint && toolInput.context_size_hint.tier2)    || 0;
    const handoffSize  = (toolInput.context_size_hint && toolInput.context_size_hint.handoff)  || 0;
    const computedSize = systemSize + tier2Size + handoffSize;

    // When no context hint is provided, skip the check (fail-open).
    if (computedSize === 0 || !role) {
      process.exit(0);
    }

    const result = checkBudget(role, computedSize, config);

    if (result.action === 'warn' || result.action === 'block') {
      const overage = computedSize - result.budget;
      const overagePct = Math.round((overage / result.budget) * 100);

      // Emit budget_warn event via the central audit gateway
      try {
        const orchFile = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
        let orchId = 'unknown';
        try {
          const orchRaw = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
          orchId = orchRaw.orchestration_id || 'unknown';
        } catch (_e) { /* fail-open */ }

        writeEvent({
          event_type: 'budget_warn',
          version: 1,
          orchestration_id: orchId,
          agent_role: role,
          computed_size: computedSize,
          budget: result.budget,
          source: result.source,
          overage_tokens: overage,
          overage_pct: overagePct,
          hard_block: result.action === 'block',
          components: {
            system_prompt: systemSize,
            tier2_injected: tier2Size,
            handoff_payload: handoffSize,
          },
        }, { cwd });
      } catch (_e) {
        // Audit emit failure never blocks the spawn
      }

      // Warn to stderr (visible in session log)
      process.stderr.write(
        `[orchestray] Budget notice: "${role}" context is ${overagePct}% over its soft limit ` +
        `(${computedSize}/${result.budget} tokens). The spawn will proceed. ` +
        `To silence this warning, set "budget_enforcement.enabled": false in .orchestray/config.json; ` +
        `to block oversized spawns, set "hard_block": true.\n`
      );

      if (result.action === 'block') {
        // Hard-block: deny spawn with exit 2
        process.stdout.write(JSON.stringify({
          type: 'block',
          message: `[orchestray] Spawn blocked: the "${role}" agent's context (${computedSize} tokens) exceeds its budget limit (${result.budget} tokens). ` +
                   `To proceed: (1) break the task into smaller subtasks, or (2) set "budget_enforcement.hard_block": false in .orchestray/config.json to allow this spawn with a warning instead of a block.`,
        }) + '\n');
        process.exit(2);
      }
    }

    // Warn-only or ok: proceed
    process.exit(0);

  } catch (_e) {
    process.stderr.write('[orchestray] preflight-spawn-budget: unhandled error; failing open\n');
    process.exit(0);
  }
});

} // end: if (require.main === module)

module.exports = { checkBudget };
