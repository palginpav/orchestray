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
      type: 'agent_start',
      orchestration_id: orchestrationId,
      agent_id: event.agent_id || null,
      agent_type: event.agent_type || null,
      session_id: event.session_id || null,
    };

    // Append to events.jsonl
    fs.appendFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify(auditEvent) + '\n'
    );
  } catch (_e) {
    // Never block agent start due to audit failure
  }

  // Always allow the agent to continue
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
