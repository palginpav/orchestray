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
// loadLiveRoleBudgets — try `.orchestray/state/role-budgets.json` first, fall
// back to the static `role_budgets` block in `.orchestray/config.json`.
// (R-BUDGET-WIRE, v2.1.16.)
// ---------------------------------------------------------------------------
//
// The live file is written by `bin/calibrate-role-budgets.js` (or as a fallback
// matching the static defaults during the v2.1.16 release pass). When present
// it takes precedence so calibrated p95 values flow through without a config
// edit. On any read/parse error we silently fall back — the v2.1.15 fail-open
// posture forbids blocking spawns on telemetry-source issues.
//
// Per-session debug log: when ORCHESTRAY_DEBUG is set, the source ('live'
// vs 'static') is logged once per process to stderr.
function loadLiveRoleBudgets(cwd, debugSink) {
  const livePath = path.join(cwd, '.orchestray', 'state', 'role-budgets.json');
  try {
    if (fs.existsSync(livePath)) {
      const raw = fs.readFileSync(livePath, 'utf8');
      const parsed = JSON.parse(raw);
      const liveBudgets = parsed && typeof parsed === 'object' ? (parsed.role_budgets || parsed) : null;
      if (liveBudgets && typeof liveBudgets === 'object' && Object.keys(liveBudgets).length > 0) {
        if (debugSink) debugSink('live');
        return liveBudgets;
      }
    }
  } catch (_e) {
    // Fail-open: any read/parse error → fall through to static defaults.
  }
  if (debugSink) debugSink('static');
  return null;
}

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

    // R-BUDGET-WIRE (v2.1.16): overlay live calibrated budgets if present.
    // The live file lives at `.orchestray/state/role-budgets.json` and is
    // written by `bin/calibrate-role-budgets.js`. When absent, fall back to
    // the static `role_budgets` block already loaded in config.json.
    const debugSink = process.env.ORCHESTRAY_DEBUG
      ? (src) => process.stderr.write(`[preflight-spawn-budget] role-budgets source=${src}\n`)
      : null;
    const liveBudgets = loadLiveRoleBudgets(cwd, debugSink);
    if (liveBudgets) {
      config = { ...config, role_budgets: { ...(config.role_budgets || {}), ...liveBudgets } };
    }

    // Extract role from tool_input
    const toolInput = event.tool_input || {};
    const role = toolInput.subagent_type || toolInput.agent_type || '';

    // v2.2.13 W1 (G-01): Inline prompt-body parser. Replaces the v2.2.12 W1a
    // stager hook (inject-context-size-hint.js) which is now deleted because
    // updatedInput does NOT propagate between sibling PreToolUse:Agent hooks
    // (Claude Code platform constraint — each hook receives the original
    // tool_input from stdin, never a mutated version from a prior hook).
    //
    // Resolution order:
    //   1. tool_input.context_size_hint (native field, non-zero) → 'tool_input_native'
    //   2. regex match on tool_input.prompt → 'prompt_body'
    //   3. neither → 'absent' (falls through to hard-block path below)
    //
    // Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1 skips
    // step 2 (falls back to legacy "must come from tool_input" behaviour).
    const HINT_RE = /^\s*`?context_size_hint:\s*system=(\d+)\s+tier2=(\d+)\s+handoff=(\d+)/m;

    let systemSize  = (toolInput.context_size_hint && toolInput.context_size_hint.system)  || 0;
    let tier2Size   = (toolInput.context_size_hint && toolInput.context_size_hint.tier2)   || 0;
    let handoffSize = (toolInput.context_size_hint && toolInput.context_size_hint.handoff) || 0;
    let parseSource = (systemSize + tier2Size + handoffSize > 0) ? 'tool_input_native' : 'absent';

    if (parseSource === 'absent' &&
        process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED !== '1') {
      const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
      const m = HINT_RE.exec(prompt);
      if (m) {
        systemSize  = parseInt(m[1], 10);
        tier2Size   = parseInt(m[2], 10);
        handoffSize = parseInt(m[3], 10);
        parseSource = 'prompt_body';
      }
    }

    // Deprecated env-var detection: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED
    // is now a NO-OP (the gated code path no longer exists). Emit a one-time-per-
    // session deprecation event and warn, gated by a sentinel file.
    if (process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED === '1') {
      const orchStateDir = require('path').join(cwd, '.orchestray', 'state');
      // Shared sentinel (no pid component) so boot + preflight dedupe per session.
      const sentinelPath = require('path').join(orchStateDir, 'deprecated-env-warned-context-hint');
      try {
        if (!require('fs').existsSync(sentinelPath)) {
          try {
            require('fs').mkdirSync(orchStateDir, { recursive: true });
            require('fs').writeFileSync(sentinelPath, new Date().toISOString() + '\n', { flag: 'wx' });
          } catch (_) { /* fail-open — sentinel write failure is non-fatal */ }
          process.stderr.write(
            '[orchestray] DEPRECATED: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED is a no-op as of ' +
            'v2.2.13 and will be removed in v2.2.14. Remove it from .claude/settings.json — the inline ' +
            'prompt-body parser (v2.2.13) now satisfies the context_size_hint gate automatically. ' +
            '(If you need to disable inline parsing, use ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1.)\n'
          );
          try {
            let orchId = 'unknown';
            try {
              const orchFile = require('path').join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
              const orchRaw = JSON.parse(require('fs').readFileSync(orchFile, 'utf8'));
              orchId = orchRaw.orchestration_id || 'unknown';
            } catch (_) { /* fail-open */ }
            writeEvent({
              event_type:    'deprecated_kill_switch_detected',
              version:       1,
              name:          'ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED',
              replacement:   'ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED',
              retires_in:    'v2.2.14',
              schema_version: 1,
            }, { cwd });
          } catch (_) { /* fail-open */ }
        }
      } catch (_) { /* fail-open — entire deprecation path must never crash the hook */ }
    }

    // Emit inline-parse result event (once per spawn, always).
    try {
      let orchId = 'unknown';
      try {
        const orchFile = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
        const orchRaw = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
        orchId = orchRaw.orchestration_id || 'unknown';
      } catch (_) { /* fail-open */ }
      writeEvent({
        event_type:       'context_size_hint_parsed_inline',
        version:          1,
        orchestration_id: orchId,
        subagent_type:    role,
        source:           parseSource,
        schema_version:   1,
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    const computedSize = systemSize + tier2Size + handoffSize;

    // Emit warn event when hint is missing or all-zero and role is known.
    // B4 (v2.2.10): emit context_size_hint_missing warn-event when the hint is
    // absent or all values are zero. Never blocks the spawn (warn-only).
    // Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1
    // B4 (v2.2.11): after the warn emit, hard-block the spawn via
    // context_size_hint_required_failed + exit 2 (fail-closed).
    // v2.2.13 W1: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED is now a NO-OP
    // (the env var is deprecated; the inline parser replaces its function).
    if (computedSize === 0 && role && process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED !== '1') {
      let orchId = 'unknown';
      try {
        const orchFile = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
        try {
          const orchRaw = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
          orchId = orchRaw.orchestration_id || 'unknown';
        } catch (_e) { /* fail-open */ }

        // Warn event always fires (telemetry trail).
        writeEvent({
          event_type:     'context_size_hint_missing',
          version:        1,
          orchestration_id: orchId,
          subagent_type:  role,
          task_id:        toolInput.task_id || null,
        }, { cwd });
      } catch (_e) {
        // Audit emit failure never blocks the spawn
      }

      // Hard-block: emit required_failed and exit 2.
      // v2.2.13 W1: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED is deprecated
      // (NO-OP in v2.2.13; retires v2.2.14). The inline prompt-body parser
      // (parseSource='prompt_body') is now the primary mechanism — if the hint
      // was in the prompt it would have been resolved above. Reaching here means
      // neither tool_input nor prompt had the hint.
      // During the deprecation window, the env var still bypasses the hard-block
      // for backward compat (operators who set it won't get blocked spawns).
      if (process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED !== '1') {
        try {
          writeEvent({
            event_type:    'context_size_hint_required_failed',
            version:       1,
            spawn_id:      toolInput.task_id || orchId,
            subagent_type: role,
            schema_version: 1,
          }, { cwd });
        } catch (_e) {
          // Audit emit failure does not prevent the block
        }
        process.stdout.write(JSON.stringify({
          type: 'block',
          message: `[orchestray] Spawn blocked: the "${role}" agent was spawned without a context_size_hint. ` +
                   `To fix: include "context_size_hint: system=N tier2=N handoff=N" as a line in the delegation ` +
                   `prompt (or pass tool_input.context_size_hint with non-zero system/tier2/handoff values). ` +
                   `To disable this gate entirely (not recommended in production): ` +
                   `ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1.`,
        }) + '\n');
        process.exit(2);
      }
    }

    // When no context hint is provided, skip the budget check (fail-open).
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

module.exports = { checkBudget, loadLiveRoleBudgets };
