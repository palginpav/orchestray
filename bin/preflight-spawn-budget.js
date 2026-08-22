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
// NEW-01 (v2.3.9): use canonical loaders so malformed config values are caught.
const { loadRoleBudgetsConfig, loadBudgetEnforcementConfig } = require('./_lib/config-schema');
const { readHookInputRaw } = require('./_lib/hook-stdin');

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
// Q1 compute-and-warn fallback (v2.3.18 W3) — replaces the v2.2.11 hard-block.
//
// Telemetry (v218-bugfix-candidates.md §3 Q1): 14 real misses over 51 days,
// concentrated in reviewer/researcher/curator/debugger, ZERO on developer/
// architect. `context_size_hint_parsed_inline` (source: prompt_body) already
// fired 176x — the inline parser carries the load. Blocking the spawn on a
// number the hook can derive itself is prose-enforcement wearing a hook
// costume (feedback_mechanical_over_prose.md). Compute it instead.
// ---------------------------------------------------------------------------

/**
 * Derive a context_size_hint from the spawn prompt when neither the native
 * `tool_input.context_size_hint` field nor an inline `context_size_hint:`
 * line was present. Character-count / 4 approximates tokens.
 *
 * The split across system/tier2/handoff is "best determinable", not exact:
 *   - system: looked up directly from `agents/<role>.md` on disk (the one
 *     component we can measure rather than guess — it is the receiving
 *     agent's own system prompt).
 *   - When the prompt carries `inject-delegation-delta.js` markers, the
 *     static (`<!-- delta:static-begin -->...`) block folds into system
 *     (boilerplate repeated on every spawn of this role); the per-spawn
 *     block (`<!-- delta:per-spawn-begin -->...`) is handoff; anything left
 *     over (design-doc refs, KB pointers) is tier2.
 *   - Without markers the whole body is undifferentiated and counted
 *     conservatively as handoff.
 *
 * @param {string} promptText
 * @param {string} role
 * @param {string} cwd
 * @returns {{systemSize: number, tier2Size: number, handoffSize: number}}
 */
function computeHintFromPrompt(promptText, role, cwd) {
  let systemSize = 0;
  try {
    const st = fs.statSync(path.join(cwd, 'agents', role + '.md'));
    systemSize = Math.ceil(st.size / 4);
  } catch (_e) { /* role file not found — fail-open, systemSize stays 0 */ }

  const staticMatch   = /<!--\s*delta:static-begin\s*-->([\s\S]*?)<!--\s*delta:static-end\s*-->/.exec(promptText);
  const perSpawnMatch = /<!--\s*delta:per-spawn-begin\s*-->([\s\S]*?)<!--\s*delta:per-spawn-end\s*-->/.exec(promptText);

  if (staticMatch || perSpawnMatch) {
    const staticLen   = staticMatch ? staticMatch[1].length : 0;
    const perSpawnLen = perSpawnMatch ? perSpawnMatch[1].length : 0;
    const restLen      = Math.max(0, promptText.length - staticLen - perSpawnLen);
    return {
      systemSize:  systemSize + Math.ceil(staticLen / 4),
      tier2Size:   Math.ceil(restLen / 4),
      handoffSize: Math.ceil(perSpawnLen / 4),
    };
  }

  return { systemSize, tier2Size: 0, handoffSize: Math.ceil(promptText.length / 4) };
}

/**
 * Kill switch for the compute-fallback path. When disabled, a missing hint
 * reverts to the pre-v2.3.18 behaviour (hard-block, no computed fallback).
 * Config key: `context_size_hint_compute.enabled` (default true).
 * Env: ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED=1
 *
 * Reads config.json directly (not via config-schema.js loaders) — this
 * section is out of scope for this wave; direct read matches the pattern
 * already used by several PreToolUse hooks (e.g. inject-active-phase-slice.js
 * loadConfig, inject-delegation-delta.js isKillSwitchConfig).
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isComputeFallbackDisabled(cwd) {
  if (process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED === '1') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    if (cfg && cfg.context_size_hint_compute && cfg.context_size_hint_compute.enabled === false) {
      return true;
    }
  } catch (_e) { /* fail-open: treat as enabled */ }
  return false;
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
input = readHookInputRaw();
if (input.length > MAX_INPUT_BYTES) {
  process.stderr.write('[orchestray] preflight-spawn-budget: stdin exceeded limit; failing open\n');
  process.exit(0);
}
setImmediate(() => {
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

    // NEW-01 (v2.3.9): wire canonical loaders so malformed config values
    // (e.g. non-boolean budget_enforcement.enabled) are caught and replaced
    // with safe defaults rather than silently mis-evaluating. The loaders are
    // fail-open and preserve EXACT current behavioral defaults.
    config = {
      ...config,
      budget_enforcement: loadBudgetEnforcementConfig(cwd),
      role_budgets: loadRoleBudgetsConfig(cwd),
    };

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
    //
    // G-11 (v2.2.14): Two inline forms are accepted (both case-insensitive to
    // whitespace variants):
    //
    //   Flat form (canonical):
    //     context_size_hint: system=8000 tier2=4000 handoff=12000
    //
    //   Object form (also accepted — PMs that copy from delegation-templates.md
    //   JSON examples would naturally write this):
    //     context_size_hint: { system: 8000, tier2: 4000, handoff: 12000 }
    //
    // Both parse to the same internal { systemSize, tier2Size, handoffSize }.
    // Mixed forms (e.g. "system: 8000 tier2=4000") do NOT match either regex and
    // fall through to the absent path, which emits a clear spawn-block message.
    //
    // Flat form regex: key=value triples, space-separated.
    const HINT_RE_FLAT = /^\s*`?context_size_hint:\s*system=(\d+)\s+tier2=(\d+)\s+handoff=(\d+)/m;
    // Object form regex: JSON-like { system: N, tier2: N, handoff: N } with
    // flexible whitespace around punctuation (handles copy-paste from docs).
    // Also accepts double-quoted keys ("system", "tier2", "handoff") — LLM-generated
    // prompts naturally produce JSON-with-quotes form. PM-1 fix (v2.2.21).
    const HINT_RE_OBJ  = /^\s*`?context_size_hint:\s*\{\s*"?system"?\s*:\s*(\d+)\s*,\s*"?tier2"?\s*:\s*(\d+)\s*,\s*"?handoff"?\s*:\s*(\d+)\s*\}/m;

    let systemSize  = (toolInput.context_size_hint && toolInput.context_size_hint.system)  || 0;
    let tier2Size   = (toolInput.context_size_hint && toolInput.context_size_hint.tier2)   || 0;
    let handoffSize = (toolInput.context_size_hint && toolInput.context_size_hint.handoff) || 0;
    let parseSource = (systemSize + tier2Size + handoffSize > 0) ? 'tool_input_native' : 'absent';

    if (parseSource === 'absent' &&
        process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED !== '1') {
      const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
      const mFlat = HINT_RE_FLAT.exec(prompt);
      const mObj  = !mFlat && HINT_RE_OBJ.exec(prompt);
      const m = mFlat || mObj;
      if (m) {
        systemSize  = parseInt(m[1], 10);
        tier2Size   = parseInt(m[2], 10);
        handoffSize = parseInt(m[3], 10);
        parseSource = 'prompt_body';
      }
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

    let computedSize = systemSize + tier2Size + handoffSize;

    // v2.3.18 W3 Q1: compute-and-warn fallback (was: hard-block on any missing
    // hint — v2318-implementation-plan.md "Q1 -> compute-and-warn, not block").
    // Kill switch ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1 still bypasses
    // this entire subsystem (no missing-event, no compute, no block), same as
    // before. Within the subsystem, isComputeFallbackDisabled() restores the
    // pre-v2.3.18 strict hard-block for anyone who wants it back.
    if (computedSize === 0 && role && process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED !== '1') {
      let orchId = 'unknown';
      try {
        const orchFile = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
        const orchRaw = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
        orchId = orchRaw.orchestration_id || 'unknown';
      } catch (_e) { /* fail-open */ }

      const promptText       = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
      const promptUnreadable = promptText.trim().length === 0;
      const strictModeOn     = isComputeFallbackDisabled(cwd);

      // W5 (v2.3.31): `context_size_hint_missing` used to fire unconditionally
      // here, even on the path below where the compute-fallback succeeds and
      // the spawn proceeds without incident. That made "missing" indistinguishable
      // from "handled automatically" — exactly the confusion the W5 acceptance
      // criterion targets ("zero context_size_hint_missing... because the field
      // was filled mechanically", not because nobody looked). Now it fires ONLY
      // on the two paths that still require a human decision (nothing to compute
      // from, or the operator opted back into strict enforcement). The success
      // path below emits `context_size_hint_computed` instead, which is the
      // correct "handled" signal and already existed.
      if (promptUnreadable || strictModeOn) {
        try {
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

        // Nothing to compute from (or the operator opted back into strict
        // enforcement) — the ONLY remaining block path (was: any missing hint).
        try {
          writeEvent({
            event_type:    'context_size_hint_required_failed',
            version:       1,
            spawn_id:      toolInput.task_id || orchId,
            subagent_type: role,
            reason:        promptUnreadable ? 'prompt_unreadable' : 'compute_fallback_disabled',
            schema_version: 1,
          }, { cwd });
        } catch (_e) {
          // Audit emit failure does not prevent the block
        }
        const _missingMsg = promptUnreadable
          ? `[orchestray] Spawn blocked: the "${role}" agent was spawned without a context_size_hint AND ` +
            `without a readable prompt to compute one from. Include a non-empty prompt, or a ` +
            `"context_size_hint: system=N tier2=N handoff=N" line.`
          : `[orchestray] Spawn blocked: the "${role}" agent was spawned without a context_size_hint and ` +
            `ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED=1 (or context_size_hint_compute.enabled=false) ` +
            `disables the v2.3.18 compute-and-warn fallback. Include "context_size_hint: system=N tier2=N ` +
            `handoff=N", or unset the kill switch to allow the automatic fallback.`;
        // PM-2 fix (v2.2.21): mirror to stderr so Claude Code's error reporter shows the actionable instruction.
        process.stderr.write(_missingMsg + '\n');
        process.stdout.write(JSON.stringify({
          type: 'block',
          message: _missingMsg,
        }) + '\n');
        process.exit(2);
      }

      // Compute a fallback from the prompt body / agent-definition file size
      // and proceed — no block.
      const computed = computeHintFromPrompt(promptText, role, cwd);
      systemSize   = computed.systemSize;
      tier2Size    = computed.tier2Size;
      handoffSize  = computed.handoffSize;
      computedSize = systemSize + tier2Size + handoffSize;

      try {
        writeEvent({
          event_type:       'context_size_hint_computed',
          version:          1,
          schema_version:   1,
          orchestration_id: orchId,
          subagent_type:    role,
          system:           systemSize,
          tier2:            tier2Size,
          handoff:          handoffSize,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
      process.stderr.write(
        `[orchestray] Budget notice: "${role}" spawned without a context_size_hint — computed ` +
        `system=${systemSize} tier2=${tier2Size} handoff=${handoffSize} from the prompt body. ` +
        `The spawn will proceed. To silence: add an explicit context_size_hint line.\n`
      );
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
        const _budgetMsg = `[orchestray] Spawn blocked: the "${role}" agent's context (${computedSize} tokens) exceeds its budget limit (${result.budget} tokens). ` +
                   `To proceed: (1) break the task into smaller subtasks, or (2) set "budget_enforcement.hard_block": false in .orchestray/config.json to allow this spawn with a warning instead of a block.`;
        // PM-2 fix (v2.2.21): mirror to stderr so Claude Code's error reporter shows the actionable instruction.
        process.stderr.write(_budgetMsg + '\n');
        process.stdout.write(JSON.stringify({
          type: 'block',
          message: _budgetMsg,
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

module.exports = { checkBudget, loadLiveRoleBudgets, computeHintFromPrompt, isComputeFallbackDisabled };
