#!/usr/bin/env node
'use strict';
/**
 * emit-slash-escalation.js — emits pm_router_escalated_via_slash audit event.
 * Called from skills/orchestray:run/SKILL.md after direct PM spawn.
 * Args: --reason <str> --lite-score <N> --task <str>
 */
const path = require('path');
const { resolveSafeCwd } = require('./resolve-project-cwd');
const { writeEvent } = require('./audit-event-writer');

function parseArgs(argv) {
  const out = { reason: 'unknown', lite_score: 0, task: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--reason' && argv[i+1]) out.reason = argv[++i];
    else if (argv[i] === '--lite-score' && argv[i+1]) out.lite_score = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--task' && argv[i+1]) out.task = argv[++i];
  }
  return out;
}

try {
  const args = parseArgs(process.argv);
  const cwd = resolveSafeCwd(process.cwd());
  writeEvent({
    type: 'pm_router_escalated_via_slash',
    version: 1,
    reason: args.reason,
    lite_score: args.lite_score,
    task_summary: args.task.slice(0, 80),
    routing_path: 'router_escalated_via_slash_dispatch',
  }, { cwd });
} catch (_e) {}
process.exit(0);
