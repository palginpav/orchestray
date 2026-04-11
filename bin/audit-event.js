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
 * Runs on SubagentStart only. SubagentStop is intentionally handled by a
 * different hook script (bin/collect-agent-metrics.js) because that script
 * needs to compute cost/token metrics that aren't available at start time.
 * The positional 'start' arg in hooks.json is decorative — this script
 * always emits type: 'agent_start' regardless of argv. Per T13 audit I10
 * and T15 audit.
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
