'use strict';

/**
 * `spawn_agent` MCP tool — reactive worker-initiated agent spawning.
 *
 * Allows developer/debugger subagents to request a helper spawn (e.g.
 * security-engineer, researcher) without returning control to the PM.
 * Requests are queued in `.orchestray/state/spawn-requests.jsonl` and
 * processed by the PreToolUse:Agent hook `bin/process-spawn-requests.js`
 * on the PM's next Agent() call.
 *
 * Per v2.2.8 Item 5 (L): reactive worker-initiated agent spawning.
 *
 * Kill switches:
 *   - ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1 (env)
 *   - reactive_spawn.enabled: false (config)
 *
 * Depth enforcement:
 *   The hook checks spawn depth. Workers that were themselves reactively
 *   spawned (spawn_depth >= 1 in their invocation context) are rejected with
 *   max_depth_exceeded so depth never exceeds 2.
 *
 * Quota: per-orchestration maximum of 5 requests (configurable via
 *   reactive_spawn.per_orchestration_quota).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('../lib/paths');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { AGENT_ROLES } = require('../lib/constants');

// Reuse writeEvent from the canonical audit-event gateway.
const { writeEvent } = require('../../_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPAWN_AGENT_ROLES = [
  'architect',
  'developer',
  'reviewer',
  'debugger',
  'tester',
  'documenter',
  'security-engineer',
  'researcher',
  'inventor',
  'release-manager',
  'ux-critic',
  'platform-oracle',
  'refactorer',
];

const DEFAULT_QUOTA = 5;
const DEFAULT_AUTO_APPROVE_THRESHOLD_PCT = 0.20;
const DEFAULT_MAX_DEPTH = 2;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  required: ['agent_type', 'prompt', 'justification'],
  properties: {
    agent_type: {
      type: 'string',
      enum: SPAWN_AGENT_ROLES,
      description: 'The agent role to spawn.',
    },
    prompt: {
      type: 'string',
      minLength: 1,
      maxLength: 32768,
      description: 'The task prompt for the spawned agent.',
    },
    max_cost_usd: {
      type: 'number',
      minimum: 0,
      description: 'Optional cost cap for this spawn. Defaults to 20% of remaining orchestration budget.',
    },
    justification: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      description: 'Why the calling worker needs this spawn.',
    },
    // Internal: calling agent passes its own spawn_depth so the tool can
    // enforce max-depth without reading context from the hook payload.
    _spawn_depth: {
      type: 'integer',
      minimum: 0,
      description: 'Internal — depth of the calling agent in the reactive spawn chain. 0 = top-level PM worker, 1+ = already reactively spawned.',
    },
    // Internal: orchestration_id override (avoids reading from disk in tests).
    _orchestration_id: {
      type: 'string',
      description: 'Internal — orchestration ID override for tests.',
    },
  },
};

const definition = deepFreeze({
  name: 'spawn_agent',
  description:
    'Request a reactive spawn of a helper agent (security-engineer, researcher, etc.) ' +
    'from within a running worker task. The request is queued; the PM processes it on ' +
    'its next Agent() call. Returns request_id and status "pending". ' +
    'Kill switches: ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1 or reactive_spawn.enabled: false.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Load reactive_spawn config block from .orchestray/config.json.
 * Returns sensible defaults on any error.
 */
function loadReactiveSpawnConfig(projectRoot) {
  const defaults = {
    enabled: true,
    auto_approve_threshold_pct: DEFAULT_AUTO_APPROVE_THRESHOLD_PCT,
    max_depth: DEFAULT_MAX_DEPTH,
    per_orchestration_quota: DEFAULT_QUOTA,
  };
  try {
    const configPath = path.join(projectRoot, '.orchestray', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const block = (config && config.reactive_spawn) || {};
    return {
      enabled: block.enabled !== false,
      auto_approve_threshold_pct:
        typeof block.auto_approve_threshold_pct === 'number'
          ? block.auto_approve_threshold_pct
          : DEFAULT_AUTO_APPROVE_THRESHOLD_PCT,
      max_depth:
        typeof block.max_depth === 'number' ? block.max_depth : DEFAULT_MAX_DEPTH,
      per_orchestration_quota:
        typeof block.per_orchestration_quota === 'number'
          ? block.per_orchestration_quota
          : DEFAULT_QUOTA,
    };
  } catch (_e) {
    return defaults;
  }
}

/**
 * Read the current orchestration ID from current-orchestration.json.
 * Returns null on any error.
 */
function readOrchestrationId(projectRoot) {
  try {
    const p = path.join(projectRoot, '.orchestray', 'audit', 'current-orchestration.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed.orchestration_id === 'string')
      ? parsed.orchestration_id
      : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Read the current orchestration's max_cost_usd budget from config.json
 * and compute remaining budget by summing agent_stop events.
 *
 * Returns { max_budget_usd, accumulated_usd, remaining_usd }.
 * Fail-open: returns { max_budget_usd: null, accumulated_usd: 0, remaining_usd: null }
 * on any error.
 */
function readBudgetState(projectRoot, orchId) {
  const fallback = { max_budget_usd: null, accumulated_usd: 0, remaining_usd: null };
  if (!projectRoot || !orchId) return fallback;

  // Read max_cost_usd from config.
  let maxBudgetUsd = null;
  try {
    const configPath = path.join(projectRoot, '.orchestray', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config && typeof config.max_cost_usd === 'number') {
      maxBudgetUsd = config.max_cost_usd;
    }
  } catch (_e) {
    // no budget configured — fine
  }

  // Sum agent_stop events for this orchestration.
  let accumulatedUsd = 0;
  try {
    const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
    const raw = fs.readFileSync(eventsPath, 'utf8');
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_e) { continue; }
      if (!ev || ev.orchestration_id !== orchId || ev.type !== 'agent_stop') continue;
      const cost =
        typeof ev.cost_usd === 'number' ? ev.cost_usd :
        (ev.cost && typeof ev.cost.cost_usd === 'number') ? ev.cost.cost_usd : 0;
      accumulatedUsd += cost;
    }
  } catch (_e) {
    // no events file yet — zero accumulated
  }

  const remainingUsd = maxBudgetUsd !== null ? Math.max(0, maxBudgetUsd - accumulatedUsd) : null;
  return { max_budget_usd: maxBudgetUsd, accumulated_usd: accumulatedUsd, remaining_usd: remainingUsd };
}

/**
 * Count how many spawn_requested events already exist for this orchestration.
 * Reads events.jsonl. Fail-open: returns 0 on any error.
 */
function countSpawnRequests(projectRoot, orchId) {
  try {
    const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
    const raw = fs.readFileSync(eventsPath, 'utf8');
    let count = 0;
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_e) { continue; }
      if (ev && ev.orchestration_id === orchId && ev.type === 'spawn_requested') {
        count++;
      }
    }
    return count;
  } catch (_e) {
    return 0;
  }
}

/**
 * Atomically append a request object to spawn-requests.jsonl.
 */
function appendSpawnRequest(projectRoot, request) {
  const stateDir = path.join(projectRoot, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, 'spawn-requests.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(request) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  // --- Kill switches ---
  if (process.env.ORCHESTRAY_DISABLE_REACTIVE_SPAWN === '1') {
    return toolSuccess({
      status: 'disabled',
      message: 'Reactive spawn is disabled via ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1.',
    });
  }

  // --- Input validation ---
  const validation = validateAgainstSchema(input || {}, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('spawn_agent: ' + validation.errors.join('; '));
  }

  // --- Resolve project root ---
  let projectRoot;
  try {
    projectRoot = (context && context.projectRoot) ? context.projectRoot : paths.getProjectRoot();
  } catch (err) {
    return toolError('spawn_agent: cannot resolve project root: ' + (err && err.message));
  }

  // --- Config ---
  const cfg = loadReactiveSpawnConfig(projectRoot);
  if (!cfg.enabled) {
    return toolSuccess({
      status: 'disabled',
      message: 'Reactive spawn is disabled via reactive_spawn.enabled: false in config.',
    });
  }

  // --- Orchestration ID ---
  const orchId = (input._orchestration_id) || readOrchestrationId(projectRoot) || 'unknown';

  // --- Max-depth check ---
  const spawnDepth = typeof input._spawn_depth === 'number' ? input._spawn_depth : 0;
  if (spawnDepth >= cfg.max_depth) {
    return toolError('spawn_agent: max_depth_exceeded — reactive spawn chains are limited to depth ' + cfg.max_depth + '. This agent was itself reactively spawned and cannot request further spawns.');
  }

  // --- Quota check ---
  const existingCount = countSpawnRequests(projectRoot, orchId);
  if (existingCount >= cfg.per_orchestration_quota) {
    return toolError(
      'spawn_agent: quota_exhausted — this orchestration has already used ' +
      existingCount + ' of ' + cfg.per_orchestration_quota + ' allowed reactive spawn requests.'
    );
  }

  // --- Resolve cost cap ---
  const budget = readBudgetState(projectRoot, orchId);
  let resolvedMaxCostUsd;
  if (typeof input.max_cost_usd === 'number') {
    resolvedMaxCostUsd = input.max_cost_usd;
  } else if (budget.remaining_usd !== null) {
    resolvedMaxCostUsd = +(budget.remaining_usd * cfg.auto_approve_threshold_pct).toFixed(4);
  } else {
    // No budget configured — use a conservative default of $0.50.
    resolvedMaxCostUsd = 0.50;
  }

  // --- Build request record ---
  const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const request = {
    request_id: requestId,
    orchestration_id: orchId,
    requester_agent: input.agent_type ? undefined : 'unknown', // set below
    requested_agent: input.agent_type,
    justification: input.justification,
    prompt: input.prompt,
    max_cost_usd: resolvedMaxCostUsd,
    spawn_depth: spawnDepth,
    status: 'pending',
    ts: new Date().toISOString(),
  };
  // Note: requester_agent identity is the calling agent context, not the
  // requested agent_type. We use the agent_type field name as the requester.
  // In practice the calling context is opaque; the agent provides this via
  // _spawn_depth but not directly its role. We set to 'worker' as a sentinel.
  // The hook has full event context to enrich this if needed.
  request.requester_agent = 'worker';

  // --- Write to spawn-requests.jsonl ---
  try {
    appendSpawnRequest(projectRoot, request);
  } catch (err) {
    return toolError('spawn_agent: failed to write request: ' + (err && err.message));
  }

  // --- Emit spawn_requested event ---
  try {
    writeEvent({
      type: 'spawn_requested',
      version: 1,
      schema_version: 1,
      orchestration_id: orchId,
      request_id: requestId,
      requester_agent: request.requester_agent,
      requested_agent: input.agent_type,
      justification: input.justification,
      max_cost_usd: resolvedMaxCostUsd,
    }, { cwd: projectRoot });
  } catch (_e) {
    // Audit failure is non-fatal per fail-open policy.
  }

  return toolSuccess({
    request_id: requestId,
    status: 'pending',
    message: 'Request queued; PM will process on next turn.',
    resolved_max_cost_usd: resolvedMaxCostUsd,
    queue_position: existingCount + 1,
  });
}

module.exports = {
  definition,
  handle,
  // Exported for tests and process-spawn-requests.js.
  loadReactiveSpawnConfig,
  readOrchestrationId,
  readBudgetState,
  countSpawnRequests,
  DEFAULT_QUOTA,
  DEFAULT_AUTO_APPROVE_THRESHOLD_PCT,
  DEFAULT_MAX_DEPTH,
};
