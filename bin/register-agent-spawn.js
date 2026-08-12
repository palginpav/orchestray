#!/usr/bin/env node
'use strict';

/**
 * register-agent-spawn.js — writes `registered` / `running` rows to the
 * agent lifecycle registry (W2, `.orchestray/kb/artifacts/v2326-lifecycle-design.md` §3).
 *
 * Subcommands (first positional arg):
 *   pre-spawn   PreToolUse(Agent|Explore|Task) — write a `registered` row
 *               carrying task_id/model/effort/description as handed to the spawn.
 *   start       SubagentStart                  — bind the `registered` row to
 *               the now-known agent_id and write a `running` row.
 *
 * This is the ONE place `model`/`task_id` are captured at the moment they
 * exist (PreToolUse) and carried forward by `agent_id` — the one join key
 * with 100% fidelity — instead of the (orchestration_id, agent_type) join
 * that breaks for dynamic roster names (see design doc §0.2, §4).
 *
 * Kill switches (default-on feature, fail-open on error):
 *   ORCHESTRAY_DISABLE_AGENT_LIFECYCLE=1     — master switch, no registry writes
 *   ORCHESTRAY_AGENT_REGISTRY_DISABLED=1     — registry-writes-only switch
 *   agent_lifecycle.enabled === false        — same, via config.json
 *
 * Fail-open contract: any error → stderr → exit 0 ({continue:true}). Never
 * blocks a spawn.
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { extractSpawnTaskId } = require('./_lib/spawn-task-id');
const { appendTransition, readRegistry, matchPendingSpawn, deriveRosterName } = require('./_lib/agent-registry');
const { loadAgentLifecycleConfig } = require('./_lib/config-schema');
const { safeReadJson } = require('./_lib/state-gc');

const SUBCOMMAND = process.argv[2] || '';

if (!['pre-spawn', 'start'].includes(SUBCOMMAND)) {
  process.stdout.write(
    'register-agent-spawn.js — Orchestray agent lifecycle registry writer\n' +
    'Usage: node register-agent-spawn.js <subcommand>\n' +
    'Subcommands: pre-spawn, start\n'
  );
  process.exit(0);
}

/**
 * True when the master kill switch (env or config) is active. Fail-open on
 * config read error (feature stays ON — default-on per project convention).
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function lifecycleDisabled(cwd) {
  if (process.env.ORCHESTRAY_DISABLE_AGENT_LIFECYCLE === '1') return true;
  if (process.env.ORCHESTRAY_AGENT_REGISTRY_DISABLED === '1') return true;
  try {
    const cfg = loadAgentLifecycleConfig(cwd);
    if (cfg && cfg.enabled === false) return true;
  } catch (_e) { /* fail-open — feature stays on */ }
  return false;
}

/**
 * Resolve the active orchestration_id, or null.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const data = safeReadJson(orchFile, {});
    return (data && data.orchestration_id) || null;
  } catch (_e) {
    return null;
  }
}

/**
 * pre-spawn: write a `registered` row from the PreToolUse payload.
 *
 * @param {object} event
 * @param {string} cwd
 */
function handlePreSpawn(event, cwd) {
  const toolInput = event.tool_input || {};
  const orchestrationId = resolveOrchestrationId(cwd);
  const spawnKey = event.tool_use_id ||
    ('spawn-' + Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2));

  const agentType = toolInput.subagent_type || toolInput.agent_type || null;
  const taskId = extractSpawnTaskId(toolInput);

  appendTransition(cwd, {
    event: 'registered',
    orchestration_id: orchestrationId,
    agent_id: null,
    roster_name: null,
    agent_type: agentType,
    task_id: taskId,
    model: toolInput.model || null,
    effort: toolInput.effort || null,
    session_id: event.session_id || null,
    spawn_key: spawnKey,
    spawn_tool: event.tool_name || null,
    description: toolInput.description || null,
    turns_used: null,
    estimated_cost_usd: null,
    transcript_path: null,
    result_status: null,
    hold_for_resume: null,
    resume_count: 0,
    reason: null,
  });
}

/**
 * start: bind the pending `registered` row to the now-known agent_id and
 * write a `running` row. Falls back to a bare `running` row (no pending
 * partner found — a `registered` row was denied by a gate, evicted by TTL,
 * or missed for any other reason) so the agent is still tracked.
 *
 * @param {object} event
 * @param {string} cwd
 */
function handleStart(event, cwd) {
  const agentId = event.agent_id || null;
  if (!agentId) return; // Can't register without an id.

  const orchestrationId = resolveOrchestrationId(cwd);
  const agentType = event.agent_type || null;
  const rosterName = deriveRosterName(agentId);

  const { pending } = readRegistry(cwd, { orchestrationId });
  const matched = matchPendingSpawn(pending, { agentType, nowMs: Date.now() });

  appendTransition(cwd, {
    event: 'running',
    orchestration_id: orchestrationId,
    agent_id: agentId,
    roster_name: rosterName,
    agent_type: agentType || (matched && matched.agent_type) || null,
    task_id: matched ? matched.task_id : null,
    model: matched ? matched.model : null,
    effort: matched ? matched.effort : null,
    session_id: event.session_id || null,
    spawn_key: matched ? matched.spawn_key : null,
    spawn_tool: matched ? matched.spawn_tool : null,
    description: matched ? matched.description : null,
    turns_used: null,
    estimated_cost_usd: null,
    transcript_path: event.agent_transcript_path || null,
    result_status: null,
    hold_for_resume: null,
    resume_count: 0,
    reason: null,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

let input = '';
input = readHookInputRaw();
if (input.length > MAX_INPUT_BYTES) {
  process.stderr.write('[orchestray] register-agent-spawn: stdin exceeded limit; aborting\n');
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}

setImmediate(() => {
  try {
    const event = JSON.parse(input || '{}');
    const cwd = resolveSafeCwd(event.cwd);

    if (!lifecycleDisabled(cwd)) {
      switch (SUBCOMMAND) {
        case 'pre-spawn': handlePreSpawn(event, cwd); break;
        case 'start': handleStart(event, cwd); break;
        default: break; // Already filtered above
      }
    }
  } catch (err) {
    process.stderr.write('[orchestray] register-agent-spawn ' + SUBCOMMAND + ': error (fail-open): ' + String(err) + '\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
