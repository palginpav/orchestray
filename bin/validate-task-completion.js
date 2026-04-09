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

    // Validation gate: block if task_id or task_subject is missing
    if (!event.task_id || !event.task_subject) {
      process.stderr.write(
        'Task completion rejected: missing task_id or task_subject. ' +
        'Ensure task has proper identification before marking complete.'
      );
      process.exit(2);
    }

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
      type: 'task_completed',
      mode: 'teams',
      orchestration_id: orchestrationId,
      task_id: event.task_id,
      task_subject: event.task_subject,
      task_description: event.task_description || null,
      teammate_name: event.teammate_name || null,
      team_name: event.team_name || null,
      session_id: event.session_id || null,
    };

    // Append to events.jsonl
    fs.appendFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify(auditEvent) + '\n'
    );

    // Allow completion
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (_e) {
    // Never block due to unexpected handler errors
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
