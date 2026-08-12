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
const { readHookInputRaw } = require('./_lib/hook-stdin');

/**
 * Read agent_teams.enabled from .orchestray/config.json.
 * Returns false when:
 *   - the config file is absent,
 *   - the field is absent,
 *   - or the field is explicitly false.
 * Returns true only when agent_teams.enabled === true.
 * Never throws.
 */
function _isAgentTeamsEnabled(cwd) {
  try {
    const cfgPath = path.join(cwd, '.orchestray', 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return !!(cfg && cfg.agent_teams && cfg.agent_teams.enabled === true);
  } catch (_e) {
    return false; // unreadable or corrupt config → treat as disabled
  }
}

// 1 MB cap: corrupted or runaway task-graph.md files could be arbitrarily
// large, and reading them fully would OOM the hook process (Node default
// heap is ~1.5 GB, but hook timeout is 5 s). On overflow we skip the
// reassignment check and let the teammate stop cleanly. Per T13 audit I7.
const MAX_SIZE = 1_048_576;

// Pending-task detection (v2.3.26 W5). The `- [ ]` / `status: pending` forms
// below are the H2-spec format documented in phase-decomp.md's "Task Graph
// Format" -- kept for forward compatibility, but 0 of 88 historical
// task-graph.md files under .orchestray/history/ actually use it. Real
// generated graphs use a markdown table (W/Task ID column), an H2-H4 heading
// per task (`### T1 —`, `## Task 1:`), or a bold task-id bullet
// (`- **T1** owner: ...`). These three patterns together cover 87/88 (98.9%)
// of the historical corpus; the one residual miss is an ASCII tree-diagram
// format inside a fenced code block with no ID-shaped line start.
const CHECKBOX_UNCHECKED_RE = /^\s*-\s*\[ \]/m;
const STATUS_PENDING_RE = /^status:\s*(pending|not started)/mi;
const TABLE_ROW_RE = /^\s*\|\s*([A-Za-z][A-Za-z0-9_.-]{0,8})\s*\|/m;
const TABLE_SEP_RE = /^\s*\|[\s:-]*-[\s:|-]*\|/m;
const HEADING_TASKID_RE = /^#{2,4}\s+(Task\s+\d+|[A-Z]{1,4}-?\d+)\b/mi;
const BOLD_TASKID_RE = /\*\*([A-Z]{1,4}-?\d+)\b/m;
const BARE_TASKID_LINE_RE = /^[│├└─\s]*([A-Z]{1,4}\d+[a-z]?)\s*[(→]/m;

/**
 * Does `taskGraphText` show evidence of pending (not-yet-complete) work?
 * Checks the documented legacy forms first, then the real generated-table/
 * heading/bold-bullet forms. A task-graph with no recognizable task marker
 * at all (e.g. absent, empty, or only completion prose) reports no pending
 * work -- see the module doc comment above for measured coverage.
 */
function _hasPendingTasks(taskGraphText) {
  return CHECKBOX_UNCHECKED_RE.test(taskGraphText) ||
    STATUS_PENDING_RE.test(taskGraphText) ||
    (TABLE_ROW_RE.test(taskGraphText) && TABLE_SEP_RE.test(taskGraphText)) ||
    HEADING_TASKID_RE.test(taskGraphText) ||
    BOLD_TASKID_RE.test(taskGraphText) ||
    BARE_TASKID_LINE_RE.test(taskGraphText);
}

let input = '';
input = readHookInputRaw();
if (input.length > MAX_INPUT_BYTES) {
  process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}
setImmediate(() => {
  try {
    const event = JSON.parse(input);
    const cwd = resolveSafeCwd(event.cwd);

    // N3.b config gate: if agent_teams.enabled is false (or absent), exit 0
    // silently without emitting any teammate_idle event.
    if (!_isAgentTeamsEnabled(cwd)) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

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
      if (_hasPendingTasks(taskGraph)) {
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

// Export for tests.
module.exports = { _isAgentTeamsEnabled, _hasPendingTasks };
