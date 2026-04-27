#!/usr/bin/env node
'use strict';

/**
 * capture-pm-router-stop.js — SubagentStop hook for the v2.2.3 P4 A3 PM-router.
 *
 * When `subagent_type === 'pm-router'`, parse the agent's last assistant
 * message for the Structured Result block, extract the routing decision,
 * and emit:
 *   - `pm_router_complete` (always — terminal observability row).
 *   - `pm_router_solo_complete` (only when decision == 'solo').
 *
 * Fail-open contract: any unexpected error → exit 0 silently. Never blocks
 * the SubagentStop pipeline.
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return data.orchestration_id || null;
  } catch (_e) {
    return null;
  }
}

function extractStructuredResult(event) {
  if (!event) return null;
  if (event.structured_result && typeof event.structured_result === 'object') {
    return event.structured_result;
  }
  const raw = [event.result, event.output, event.agent_output]
    .find((v) => typeof v === 'string' && v.length > 0);
  if (typeof raw !== 'string') return null;
  const tail = raw.slice(-65536);
  const re = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = tail.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_e) { return null; }
}

function identifyAgentRole(event) {
  if (!event) return null;
  const candidates = [
    event.subagent_type,
    event.agent_type,
    event.tool_input && event.tool_input.subagent_type,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c.normalize('NFKC').replace(/[\s\x00-\x1F]/g, '').toLowerCase();
    }
  }
  return null;
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
    if (!input) process.exit(0);
    const event = JSON.parse(input);
    const role = identifyAgentRole(event);
    if (role !== 'pm-router') process.exit(0);

    const cwd = resolveSafeCwd(event.cwd);
    const sr = extractStructuredResult(event);
    const decisionTaken = (sr && typeof sr.decision === 'string') ? sr.decision : null;
    const reasonTaken = (sr && typeof sr.reason === 'string') ? sr.reason : null;
    const routingPath = (sr && typeof sr.routing_path === 'string') ? sr.routing_path : null;
    const filesChanged = (sr && Array.isArray(sr.files_changed)) ? sr.files_changed : [];
    const delegationTarget = sr && sr.delegation_target_agent_id ? sr.delegation_target_agent_id : null;
    const taskId = sr && sr.task_id ? sr.task_id : (event.task_id || null);

    const orchId = resolveOrchestrationId(cwd) || 'pre_orch';

    try {
      writeEvent({
        timestamp: new Date().toISOString(),
        type: 'pm_router_complete',
        hook: 'capture-pm-router-stop',
        orchestration_id: orchId,
        task_id: taskId,
        decision_taken: decisionTaken,
        reason_taken: reasonTaken,
        routing_path: routingPath,
        escalation_target_orch_id: delegationTarget,
        files_changed_count: filesChanged.length,
        session_id: event.session_id || null,
      }, { cwd });
    } catch (_writeErr) { /* fail-open */ }

    if (decisionTaken === 'solo') {
      try {
        writeEvent({
          timestamp: new Date().toISOString(),
          type: 'pm_router_solo_complete',
          hook: 'capture-pm-router-stop',
          orchestration_id: orchId,
          task_id: taskId,
          files_changed: filesChanged,
          files_read: (sr && Array.isArray(sr.files_read)) ? sr.files_read : [],
          solo_outcome: (sr && typeof sr.status === 'string') ? sr.status : 'unknown',
          session_id: event.session_id || null,
        }, { cwd });
      } catch (_writeErr) { /* fail-open */ }
    }
  } catch (_e) {
    // fail-open
  }
  process.exit(0);
});
