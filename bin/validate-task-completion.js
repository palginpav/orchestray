#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);

    // If this isn't actually a TaskCompleted event, don't validate — Claude Code
    // may route other events through this hook if wiring changes, and silent
    // exit(2) on everything would lock up the team.
    if (event.hook_event_name && event.hook_event_name !== 'TaskCompleted') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const cwd = event.cwd || process.cwd();
    const auditDir = path.join(cwd, '.orchestray', 'audit');

    // Validation gate: block if task_id or task_subject is missing
    if (!event.task_id || !event.task_subject) {
      // Audit-log the rejection BEFORE exit(2) so operators have a debug trail.
      // We log only the TOP-LEVEL KEY NAMES from the payload — values may
      // contain sensitive task content we must not persist here.
      try {
        fs.mkdirSync(auditDir, { recursive: true });
        let orchestrationId = 'unknown';
        try {
          const orchFile = path.join(auditDir, 'current-orchestration.json');
          const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
          if (orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
        } catch (_e) { /* default id */ }
        const rejectionEvent = {
          timestamp: new Date().toISOString(),
          type: 'task_validation_failed',
          orchestration_id: orchestrationId,
          reason: !event.task_id && !event.task_subject
            ? 'missing task_id and task_subject'
            : (!event.task_id ? 'missing task_id' : 'missing task_subject'),
          payload_keys: Object.keys(event),
        };
        atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), rejectionEvent);
      } catch (auditErr) {
        // DEF-10: log the audit-write failure to stderr so operators see
        // it in the Claude Code hook log. The original rejection still
        // wins — we exit(2) below regardless of whether the audit log
        // was written, but operators can now distinguish "rejected cleanly"
        // from "rejected but audit trail is broken".
        console.error('[orchestray] audit write failed: ' + auditErr.message);
      }

      process.stderr.write(
        'Task completion rejected: missing task_id or task_subject. ' +
        'Ensure task has proper identification before marking complete.'
      );
      process.exit(2);
    }

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
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), auditEvent);

    // Allow completion
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (_e) {
    // Never block due to unexpected handler errors
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
