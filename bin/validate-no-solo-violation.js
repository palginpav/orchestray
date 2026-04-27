#!/usr/bin/env node
'use strict';

/**
 * validate-no-solo-violation.js — SubagentStop observational tripwire.
 *
 * Detects when a top-level PM ran with complexity >= threshold but spawned
 * zero subagents (solo-execution gate violation). Emits solo_violation_detected
 * audit event. NEVER blocks (exit 0 always). Fail-open on all errors.
 *
 * Logic:
 *   1. Only fires for agent_type === "pm".
 *   2. Reads current-orchestration.json for complexity_score.
 *   3. If score < threshold: exit 0.
 *   4. Checks routing.jsonl for agents spawned by this PM.
 *   5. Checks recent pm_router_decision events to detect pm-router solo sessions.
 *   6. Emits solo_violation_detected if PM skipped decomposition on complex task.
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const COMPLEXITY_THRESHOLD_DEFAULT = 4;
const GRACE_WINDOW_MS = 5000;

function loadCurrentOrchestration(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    return JSON.parse(fs.readFileSync(orchFile, 'utf8'));
  } catch (_e) { return null; }
}

function readRoutingEntries(cwd, orchestrationId) {
  try {
    const routingPath = path.join(cwd, '.orchestray', 'state', 'routing.jsonl');
    const lines = fs.readFileSync(routingPath, 'utf8').split('\n').filter(Boolean);
    return lines
      .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(r => r && r.orchestration_id === orchestrationId && r.decided_by === 'pm');
  } catch (_e) { return []; }
}

function readRecentRouterDecisions(cwd) {
  try {
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    // Read last 200 lines for recency.
    const tail = lines.slice(-200);
    return tail
      .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(r => r && r.type === 'pm_router_decision');
  } catch (_e) { return []; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');

    // Only check PM stops.
    const agentType = event.agent_type || event.subagent_type || '';
    if (agentType !== 'pm') process.exit(0);

    const cwd = resolveSafeCwd(event.cwd);

    // Load current orchestration.
    const orch = loadCurrentOrchestration(cwd);
    if (!orch) process.exit(0);

    const orchId = orch.orchestration_id;
    const complexityScore = typeof orch.complexity_score === 'number' ? orch.complexity_score : null;
    const threshold = typeof orch.complexity_threshold === 'number' ? orch.complexity_threshold : COMPLEXITY_THRESHOLD_DEFAULT;

    // If score absent or below threshold: no violation possible.
    if (complexityScore === null || complexityScore < threshold) process.exit(0);

    // Grace window: if orchestration just started (< 5s), skip.
    if (orch.started_at) {
      const startedMs = new Date(orch.started_at).getTime();
      if (!isNaN(startedMs) && (Date.now() - startedMs) < GRACE_WINDOW_MS) {
        process.exit(0);
      }
    }

    // Check agents spawned by PM.
    const agentsSpawned = readRoutingEntries(cwd, orchId).length;
    if (agentsSpawned > 0) process.exit(0);

    // Detect if this was actually a pm-router solo session (not a PM).
    // Only count router decisions from THIS orchestration — a stale solo decision
    // from a different orchestration must not suppress a real violation (F4 fix).
    const routerDecisions = readRecentRouterDecisions(cwd);
    const orchRouterDecisions = routerDecisions.filter(r => r.orchestration_id === orchId);
    if (orchRouterDecisions.length > 0) {
      const last = orchRouterDecisions[orchRouterDecisions.length - 1];
      if (last.decision === 'solo') {
        // This was a pm-router solo session for THIS orchestration — not a PM violation.
        process.exit(0);
      }
    }

    // Emit violation event (observational only).
    writeEvent({
      type: 'solo_violation_detected',
      version: 1,
      orchestration_id: orchId,
      complexity_score: complexityScore,
      complexity_threshold: threshold,
      agents_spawned: agentsSpawned,
      severity: 'error',
      summary: 'PM ran solo despite complexity score ' + complexityScore + '/12 (threshold ' + threshold + '). No subagents spawned.',
      session_id: process.env.CLAUDE_AGENT_SESSION_ID || null,
    }, { cwd });

    process.exit(0);
  } catch (_e) {
    // Fail-open always.
    process.exit(0);
  }
});
