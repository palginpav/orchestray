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

// v2.0.21: canonical agent set for dynamic-agent detection.
// Includes the 13 Orchestray cores plus Claude Code built-in agent types we do
// NOT consider "dynamic" (they are platform primitives, not user inventions).
const CANONICAL_AGENTS = new Set([
  'pm', 'architect', 'developer', 'refactorer', 'inventor', 'reviewer',
  'debugger', 'tester', 'documenter', 'security-engineer',
  'release-manager', 'ux-critic', 'platform-oracle',
  'Explore', 'Plan', 'general-purpose', 'Task',
]);

writeAuditEvent({
  type: 'agent_start',
  extraFieldsPicker: (payload) => ({
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || null,
    session_id: payload.session_id || null,
  }),
  additionalEventsPicker: (payload, ctx) => {
    // Emit dynamic_agent_spawn for any non-canonical agent_type so the
    // specialist registry can be measured. event-schemas.md defines the type;
    // pre-v2.0.21 it was never emitted because no detection wired up.
    const at = payload.agent_type || null;
    if (!at || CANONICAL_AGENTS.has(at)) return [];
    return [{
      timestamp:        ctx.baseTimestamp,
      type:             'dynamic_agent_spawn',
      orchestration_id: ctx.orchestrationId,
      agent_id:         payload.agent_id || null,
      agent_type:       at,
      session_id:       payload.session_id || null,
      paired_with:      'agent_start',
    }];
  },
});
