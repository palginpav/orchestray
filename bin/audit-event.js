#!/usr/bin/env node
'use strict';

/**
 * SubagentStart hook. Writes an agent_start audit event to events.jsonl.
 *
 * Thin wrapper around bin/_lib/audit-event-writer.js — the shared helper
 * handles stdin parsing, orchestration_id resolution, and appending to
 * events.jsonl. This script only supplies the event `type` and the
 * script-specific extra fields.
 *
 * Invoked by hooks/hooks.json as `audit-event.js start` — the positional
 * arg is accepted for future extensibility but not currently used.
 */

const writeAuditEvent = require('./_lib/audit-event-writer');

writeAuditEvent({
  type: 'agent_start',
  extraFieldsPicker: (payload) => ({
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || null,
    session_id: payload.session_id || null,
  }),
});
