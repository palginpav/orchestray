#!/usr/bin/env node
'use strict';

/**
 * TeammateIdle hook — redirects idle teammates to pending work.
 *
 * Runs when a Claude Code Agent Teams teammate becomes idle (TeammateIdle
 * event). Checks .orchestray/state/task-graph.md for uncompleted tasks. If
 * pending tasks exist, writes `{ continue: false }` to stdout and exits 2 to
 * block the teammate from stopping and prompt it to pick up remaining work.
 *
 * Exit code semantics (per Claude Code hook protocol):
 *   exit 0  — allow the teammate to stop (no pending tasks, or error path)
 *   exit 2  — block the teammate from stopping; stderr message is shown to
 *              re-prompt the teammate with available work
 *
 * NOTE: exit 2 here is INTENTIONAL — this is NOT a fail-open script for this
 * path. The blocking exit is the designed behavior when tasks remain. All
 * unexpected error paths still exit 0 (fail-open) so a broken hook never
 * permanently wedges the team.
 */

const fs = require('fs');
const path = require('path');
const { writeEvent } = require('./_lib/audit-event-writer');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// 1 MB cap: corrupted or runaway task-graph.md files could be arbitrarily
// large, and reading them fully would OOM the hook process (Node default
// heap is ~1.5 GB, but hook timeout is 5 s). On overflow we skip the
// reassignment check and let the teammate stop cleanly. Per T13 audit I7.
const MAX_SIZE = 1_048_576;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const cwd = resolveSafeCwd(event.cwd);
    const auditDir = path.join(cwd, '.orchestray', 'audit');

    // Read orchestration_id from current-orchestration.json if available
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData.orchestration_id) {
        orchestrationId = orchData.orchestration_id;
      }
    } catch (_e) {
      // File missing or unreadable -- use default
    }

    // Ensure audit directory exists
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening; chmod may fail on exotic filesystems */ }

    // Construct audit event
    const auditEvent = {
      timestamp: new Date().toISOString(),
      type: 'teammate_idle',
      mode: 'teams',
      orchestration_id: orchestrationId,
      session_id: event.session_id || null,
    };

    // Append to events.jsonl via the central gateway
    writeEvent(auditEvent, { cwd });

    // Reassignment logic: check for pending tasks in task-graph.md
    const taskGraphPath = path.join(cwd, '.orchestray', 'state', 'task-graph.md');
    if (fs.existsSync(taskGraphPath)) {
      // DEF-3: cap the read so a corrupted/runaway task-graph cannot OOM the
      // hook. If the file exceeds MAX_SIZE bytes, skip the pending-task scan
      // and let the teammate stop. Log once to stderr so operators see it in
      // the hook log.
      let statSize = 0;
      try {
        statSize = fs.statSync(taskGraphPath).size;
      } catch (_e) {
        statSize = 0;
      }
      if (statSize > MAX_SIZE) {
        process.stderr.write('task-graph.md exceeds 1 MB -- skipping reassignment check\n');
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }
      const taskGraph = fs.readFileSync(taskGraphPath, 'utf8');
      // Require line-leading matches so stray checkbox-shaped markdown inside
      // descriptions or code blocks cannot wedge the team forever.
      const hasPendingTasks = taskGraph.split('\n').some(line => {
        const trimmed = line.trimStart();
        return trimmed.startsWith('- [ ]') ||
          /^status:\s*(pending|not started)/i.test(trimmed);
      });

      if (hasPendingTasks) {
        process.stdout.write(JSON.stringify({ continue: false }));
        process.stderr.write(
          'Unassigned tasks remain in the orchestration. ' +
          'Check ' + taskGraphPath + ' for available work before stopping.'
        );
        process.exit(2);
      }
    }

    // No pending tasks found (or task-graph.md missing) -- let teammate stop
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (_e) {
    // Never block due to handler failure
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
