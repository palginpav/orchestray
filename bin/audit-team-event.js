#!/usr/bin/env node
'use strict';

/**
 * TaskCreated hook. Writes a task_created audit event to events.jsonl.
 *
 * Thin wrapper around bin/_lib/audit-event-writer.js — the shared helper
 * handles stdin parsing, orchestration_id resolution, and appending to
 * events.jsonl. This script only supplies the event `type`, `mode`, and the
 * script-specific extra fields.
 *
 * Invoked by hooks/hooks.json as `audit-team-event.js created` — the
 * positional arg is accepted for future extensibility but not currently used.
 */

const writeAuditEvent = require('./_lib/audit-event-writer');

writeAuditEvent({
  type: 'task_created',
  mode: 'teams',
  extraFieldsPicker: (payload) => ({
    task_id: payload.task_id || null,
    task_subject: payload.task_subject || null,
    task_description: payload.task_description || null,
    teammate_name: payload.teammate_name || null,
    team_name: payload.team_name || null,
    session_id: payload.session_id || null,
  }),
});
