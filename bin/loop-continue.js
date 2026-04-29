#!/usr/bin/env node
'use strict';

/**
 * loop-continue.js — SubagentStop hook for the /orchestray:loop primitive.
 *
 * Implements the Ralph Loop pattern: re-spawns an agent until a completion
 * promise appears in the output, max iterations are hit, or a cost cap fires.
 *
 * Hook event: SubagentStop
 * Position in chain: runs BEFORE collect-agent-metrics.js so cost data from
 * the just-completed agent hasn't been totalled yet — we estimate per-iter cost
 * from the stdin payload's usage field.
 *
 * Exit semantics (Claude Code SubagentStop):
 *   exit 0, stdout JSON `{ "continue": true }` — allow agent to stop (default).
 *   exit 0, stdout JSON `{ "decision": "deny", ... }` — block stop and re-spawn.
 *
 * Fail-open guarantee: ANY internal error → exit 0 with `{ "continue": true }`.
 * A bug here must never trap the user in an infinite stop-block loop.
 *
 * Kill switches:
 *   - ORCHESTRAY_DISABLE_LOOP=1 env var
 *   - `loop.enabled: false` in .orchestray/config.json
 *
 * State files:
 *   .orchestray/state/loop.json        — active loop config + counters
 *   .orchestray/state/loop-respawn.json — re-spawn sentinel consumed by PM
 *
 * Events emitted (via audit-event-writer.js):
 *   loop_iteration   — on each successful re-spawn
 *   loop_completed   — when loop terminates (any reason)
 *
 * Design: v2.2.8 Item 10 (M) — Ralph Loop pattern.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Stdin drain + entry point
// ---------------------------------------------------------------------------

const MAX_INPUT_BYTES = 64 * 1024;
let _stdinBuf = '';
let _ran = false;

process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { _allowStop(); });
process.stdin.on('data', (chunk) => {
  _stdinBuf += chunk;
  if (_stdinBuf.length > MAX_INPUT_BYTES) {
    _allowStop();
  }
});
process.stdin.on('end', () => { _once(main); });

// Guard: if stdin never closes (test contexts), run after 300ms.
const _guard = setTimeout(() => { _once(main); }, 300);

function _once(fn) {
  if (_ran) return;
  _ran = true;
  clearTimeout(_guard);
  fn();
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/**
 * Emit a JSON response and exit 0.
 * @param {object} payload
 */
function respond(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

/** Allow the agent to stop normally. */
function _allowStop() {
  _once(() => respond({ continue: true }));
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve project directory from stdin payload cwd, env, or process.cwd().
 * @param {object} payload
 * @returns {string}
 */
function resolveProjectDir(payload) {
  if (payload && typeof payload.cwd === 'string' && payload.cwd && !payload.cwd.includes('\0')) {
    return path.resolve(payload.cwd);
  }
  return process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
}

const STATE_DIR_REL   = path.join('.orchestray', 'state');
const LOOP_JSON_REL   = path.join(STATE_DIR_REL, 'loop.json');
const RESPAWN_JSON_REL = path.join(STATE_DIR_REL, 'loop-respawn.json');

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Check kill switches:
 *  - ORCHESTRAY_DISABLE_LOOP=1 env var
 *  - loop.enabled === false in config.json
 * @param {string} cwd
 * @returns {boolean} true if loop is enabled
 */
function isLoopEnabled(cwd) {
  if (process.env.ORCHESTRAY_DISABLE_LOOP === '1') return false;
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.loop && parsed.loop.enabled === false) {
      return false;
    }
  } catch (_e) {
    // Missing or malformed config — default to enabled.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Loop state helpers
// ---------------------------------------------------------------------------

/**
 * Read loop.json. Returns null if absent or unparseable.
 * @param {string} cwd
 * @returns {object|null}
 */
function readLoopState(cwd) {
  try {
    const loopPath = path.join(cwd, LOOP_JSON_REL);
    const raw = fs.readFileSync(loopPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

/**
 * Write loop.json atomically (write to tmp then rename).
 * @param {string} cwd
 * @param {object} state
 */
function writeLoopState(cwd, state) {
  const loopPath = path.join(cwd, LOOP_JSON_REL);
  const tmp = loopPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, loopPath);
}

/**
 * Delete loop.json. Best-effort; ignores errors.
 * @param {string} cwd
 */
function clearLoopState(cwd) {
  try { fs.unlinkSync(path.join(cwd, LOOP_JSON_REL)); } catch (_e) {}
}

/**
 * Write loop-respawn.json so the PM knows to re-spawn the agent.
 * @param {string} cwd
 * @param {object} state - current loop state
 */
function writeRespawnSentinel(cwd, state) {
  const respawnPath = path.join(cwd, RESPAWN_JSON_REL);
  const sentinel = {
    loop_active: true,
    agent: state.agent || 'developer',
    prompt: state.prompt || '',
    iter_count: state.iter_count,
    max_iterations: state.max_iterations,
    written_at: new Date().toISOString(),
  };
  const tmp = respawnPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(sentinel, null, 2), 'utf8');
  fs.renameSync(tmp, respawnPath);
}

/**
 * Delete loop-respawn.json. Best-effort; ignores errors.
 * @param {string} cwd
 */
function clearRespawnSentinel(cwd) {
  try { fs.unlinkSync(path.join(cwd, RESPAWN_JSON_REL)); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Output scanning
// ---------------------------------------------------------------------------

/**
 * Extract agent output text from the SubagentStop payload.
 * Claude Code may deliver it in different shapes depending on version.
 * Falls back to empty string if not found.
 *
 * @param {object} payload - parsed stdin
 * @returns {string}
 */
function extractAgentOutput(payload) {
  // SubagentStop payload: { output: string } or { result: string } or nested shapes
  if (payload && typeof payload.output === 'string') return payload.output;
  if (payload && typeof payload.result === 'string') return payload.result;
  if (payload && payload.agent && typeof payload.agent.output === 'string') {
    return payload.agent.output;
  }
  // Fallback: stringify the full payload to catch any nested output
  try { return JSON.stringify(payload || ''); } catch (_e) { return ''; }
}

/**
 * Check whether the output contains the completion promise string.
 * Case-sensitive exact substring match.
 *
 * @param {string} output
 * @param {string} completionPromise
 * @returns {boolean}
 */
function outputContainsPromise(output, completionPromise) {
  return typeof output === 'string' && typeof completionPromise === 'string'
    && output.includes(completionPromise);
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate per-iteration cost from payload usage fields (best-effort).
 * Returns 0 if usage data is absent.
 *
 * @param {object} payload
 * @returns {number} USD cost estimate
 */
function estimateIterCost(payload) {
  try {
    const usage = (payload && payload.usage) || (payload && payload.tokens) || {};
    const inputTokens  = (usage.input_tokens  || usage.input  || 0);
    const outputTokens = (usage.output_tokens || usage.output || 0);
    // Conservative Sonnet pricing: $3/$15 per 1M tokens
    const COST_PER_M_INPUT  = 3.00;
    const COST_PER_M_OUTPUT = 15.00;
    return (inputTokens * COST_PER_M_INPUT + outputTokens * COST_PER_M_OUTPUT) / 1_000_000;
  } catch (_e) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Audit event emission
// ---------------------------------------------------------------------------

/**
 * Emit an audit event via audit-event-writer.js. Fail-open.
 * @param {object} eventPayload
 * @param {string} cwd
 */
function emitEvent(eventPayload, cwd) {
  try {
    const { writeEvent } = require('./_lib/audit-event-writer');
    writeEvent(eventPayload, { cwd });
  } catch (_e) {
    // Audit event loss is acceptable over blocking Stop.
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

function main() {
  let payload = {};
  try { payload = JSON.parse(_stdinBuf || '{}'); } catch (_e) { /* treat as empty */ }

  const cwd = resolveProjectDir(payload);

  // Fail-open wrapper — any uncaught error must allow stop.
  try {
    run(payload, cwd);
  } catch (_err) {
    respond({ continue: true });
  }
}

function run(payload, cwd) {
  // Kill switch check.
  if (!isLoopEnabled(cwd)) {
    respond({ continue: true });
    return;
  }

  // Read loop state. If absent, this is not a loop iteration — pass through.
  const state = readLoopState(cwd);
  if (!state || state.enabled === false) {
    respond({ continue: true });
    return;
  }

  const completionPromise = state.completion_promise || 'TASK_COMPLETE';
  const maxIterations     = typeof state.max_iterations === 'number' ? state.max_iterations : 10;
  const costCapUsd        = typeof state.cost_cap_usd   === 'number' ? state.cost_cap_usd   : 0.50;
  const iterCount         = typeof state.iter_count     === 'number' ? state.iter_count     : 0;
  const costSoFar         = typeof state.cost_so_far    === 'number' ? state.cost_so_far    : 0;

  const agentOutput   = extractAgentOutput(payload);
  const iterCost      = estimateIterCost(payload);
  const newCostSoFar  = costSoFar + iterCost;

  // W2-12: resolve loop_kind for taxonomy disambiguation.
  // loop-continue.js drives the /orchestray:loop (orch) primitive by default.
  // State may carry loop_kind: "verify_fix" for future verify-fix loop callers.
  // Kill switch: ORCHESTRAY_LOOP_KIND_DISAMBIGUATION_DISABLED=1 omits the field.
  const loopKindDisabled = process.env.ORCHESTRAY_LOOP_KIND_DISAMBIGUATION_DISABLED === '1';
  const loopKind = loopKindDisabled
    ? undefined
    : (state.loop_kind === 'verify_fix' ? 'verify_fix' : 'orch');

  // 1. Completion promise met?
  if (outputContainsPromise(agentOutput, completionPromise)) {
    clearLoopState(cwd);
    clearRespawnSentinel(cwd);
    const _ev1 = {
      type:             'loop_completed',
      version:          1,
      schema_version:   1,
      orchestration_id: state.orchestration_id || null,
      reason:           'promise_met',
      iter_count:       iterCount,
      cost_so_far_usd:  newCostSoFar,
      agent:            state.agent || 'developer',
      max_iterations:   maxIterations,
    };
    if (loopKind !== undefined) _ev1.loop_kind = loopKind;
    emitEvent(_ev1, cwd);
    respond({ continue: true });
    return;
  }

  // 2. Max iterations reached?
  if (iterCount + 1 >= maxIterations) {
    clearLoopState(cwd);
    clearRespawnSentinel(cwd);
    const _ev2 = {
      type:             'loop_completed',
      version:          1,
      schema_version:   1,
      orchestration_id: state.orchestration_id || null,
      reason:           'max_iterations',
      iter_count:       iterCount + 1,
      cost_so_far_usd:  newCostSoFar,
      agent:            state.agent || 'developer',
      max_iterations:   maxIterations,
    };
    if (loopKind !== undefined) _ev2.loop_kind = loopKind;
    emitEvent(_ev2, cwd);
    respond({ continue: true });
    return;
  }

  // 3. Cost cap exceeded?
  if (newCostSoFar >= costCapUsd) {
    clearLoopState(cwd);
    clearRespawnSentinel(cwd);
    const _ev3 = {
      type:             'loop_completed',
      version:          1,
      schema_version:   1,
      orchestration_id: state.orchestration_id || null,
      reason:           'cost_cap',
      iter_count:       iterCount + 1,
      cost_so_far_usd:  newCostSoFar,
      agent:            state.agent || 'developer',
      max_iterations:   maxIterations,
    };
    if (loopKind !== undefined) _ev3.loop_kind = loopKind;
    emitEvent(_ev3, cwd);
    respond({ continue: true });
    return;
  }

  // 4. Continue loop: increment counter, write sentinel, emit loop_iteration.
  const newIterCount = iterCount + 1;
  const newState = Object.assign({}, state, {
    iter_count:  newIterCount,
    cost_so_far: newCostSoFar,
  });

  writeLoopState(cwd, newState);
  writeRespawnSentinel(cwd, newState);

  emitEvent({
    type:             'loop_iteration',
    version:          1,
    schema_version:   1,
    orchestration_id: state.orchestration_id || null,
    iter_count:       newIterCount,
    cost_so_far_usd:  newCostSoFar,
    agent:            state.agent || 'developer',
    max_iterations:   maxIterations,
    completion_promise: completionPromise,
  }, cwd);

  // Block the agent Stop so the PM can re-spawn.
  respond({
    decision:   'block',
    reason:     `[loop ${newIterCount}/${maxIterations}] Re-spawning ${state.agent || 'developer'} agent. ` +
                `Completion promise "${completionPromise}" not yet seen in output. ` +
                `Loop state written to .orchestray/state/loop-respawn.json — PM will re-spawn.`,
  });
}
