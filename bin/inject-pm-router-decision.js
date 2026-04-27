#!/usr/bin/env node
'use strict';

/**
 * inject-pm-router-decision.js — PreToolUse:Agent observability hook for the
 * v2.2.3 P4 A3 PM-router.
 *
 * Fires whenever an Agent() spawn names `subagent_type="pm-router"`. Reads
 * the prompt, runs the canonical `decideRoute()` predicate against it, and
 * emits ONE `pm_router_decision` audit event so the post-hoc telemetry
 * pipeline can compare the hook-side prediction against the agent's actual
 * decision (recorded later by `bin/capture-pm-router-stop.js`).
 *
 * The hook is OBSERVATIONAL — it never blocks the spawn. If the router and
 * the hook disagree on a decision, both rows survive and analytics computes
 * `decision_disagreement` rate from the join.
 *
 * Failure mode: any unexpected error → exit 0 silently (fail-open).
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent } = require('./_lib/audit-event-writer');
const { decideRoute, extractPathTokens } = require('./_lib/pm-router-rule');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const ROUTER_VERSION = 'v223-a3';

function loadConfig(cwd) {
  const cfgPath = path.join(cwd, '.orchestray', 'config.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw);
  } catch (_e) {
    return {};
  }
}

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return data.orchestration_id || null;
  } catch (_e) {
    return null;
  }
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
    const toolName = event.tool_name || (event.tool_input && event.tool_input.tool) || '';
    if (toolName !== 'Agent') process.exit(0);
    const toolInput = event.tool_input || {};
    if (toolInput.subagent_type !== 'pm-router') process.exit(0);

    const cwd = resolveSafeCwd(event.cwd);
    const config = loadConfig(cwd);
    const taskText = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';

    const result = decideRoute({
      task_text: taskText,
      config,
      env: process.env,
    });

    const taskSummary = taskText.replace(/\s+/g, ' ').trim().slice(0, 80);
    const wordCount = taskText.trim() ? taskText.trim().split(/\s+/).length : 0;
    const pathCount = extractPathTokens(taskText).length;

    const taskId = 'router-' + Date.now().toString(36) +
      '-' + Math.random().toString(36).slice(2, 8);

    const record = {
      version: 1,
      timestamp: new Date().toISOString(),
      type: 'pm_router_decision',
      hook: 'inject-pm-router-decision',
      orchestration_id: resolveOrchestrationId(cwd) || 'pre_orch',
      task_id: taskId,
      task_summary: taskSummary,
      lite_score: result.lite_score,
      decision: result.decision,
      reason: result.reason,
      task_word_count: wordCount,
      task_path_count: pathCount,
      model: 'haiku',
      router_version: ROUTER_VERSION,
      session_id: event.session_id || null,
    };

    try {
      writeEvent(record, { cwd });
    } catch (_writeErr) {
      // fail-open
    }
  } catch (_e) {
    // fail-open
  }
  process.exit(0);
});
