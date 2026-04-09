#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const cwd = event.cwd || process.cwd();
    const auditDir = path.join(cwd, '.orchestray', 'audit');

    // Read orchestration_id from current-orchestration.json if available
    let orchestrationId = 'unknown';
    try {
      const orchFile = path.join(auditDir, 'current-orchestration.json');
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData.orchestration_id) {
        orchestrationId = orchData.orchestration_id;
      }
    } catch (_e) {
      // File missing or unreadable -- use default
    }

    // Ensure audit directory exists
    fs.mkdirSync(auditDir, { recursive: true });

    // Construct audit event
    const auditEvent = {
      timestamp: new Date().toISOString(),
      type: 'teammate_idle',
      mode: 'teams',
      orchestration_id: orchestrationId,
      session_id: event.session_id || null,
    };

    // Append to events.jsonl
    fs.appendFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify(auditEvent) + '\n'
    );

    // Reassignment logic: check for pending tasks in task-graph.md
    const taskGraphPath = path.join(cwd, '.orchestray', 'state', 'task-graph.md');
    if (fs.existsSync(taskGraphPath)) {
      const taskGraph = fs.readFileSync(taskGraphPath, 'utf8');
      // Look for unchecked tasks (- [ ]) or status: pending/not started
      const hasPendingTasks =
        /- \[ \]/.test(taskGraph) ||
        /status:\s*(pending|not started)/i.test(taskGraph);

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
