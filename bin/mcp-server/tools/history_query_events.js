'use strict';

/**
 * `history_query_events` MCP tool.
 *
 * Filtered query over the live audit and every archived orchestration's
 * events.jsonl. See CHANGELOG.md §2.0.11 (Stage 2 MCP tools & resources) for design context.
 */

const path = require('node:path');

const { queryEvents } = require('../lib/history_scan');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { AGENT_ROLES } = require('../lib/constants');
// NOTE: emitHandlerEntry intentionally omitted for history_query_events — instrumenting
// this tool creates a feedback loop (the entry event becomes part of the events it reads).

const EVENT_TYPES = [
  'agent_start',
  'agent_stop',
  'task_created',
  'task_completed',
  'task_completed_metrics',
  'orchestration_start',
  'orchestration_end',
  'orchestration_complete',
  'elicitation_requested',
  'elicitation_answered',
  'routing_outcome',
  'replan',
  'verify_fix_attempt',
  'verify_fix_fail',
  'mcp_tool_call',
  'mcp_resource_read',
];

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    since: {
      type: 'string',
      maxLength: 32,
      description:
        'ISO-8601 UTC timestamp: YYYY-MM-DDTHH:MM:SS[.sss]Z. Other forms ' +
        '(date-only, local time, +00:00 offset) are rejected to avoid ' +
        'silent mis-comparison against archived event timestamps.',
    },
    until: {
      type: 'string',
      maxLength: 32,
      description:
        'ISO-8601 UTC timestamp: YYYY-MM-DDTHH:MM:SS[.sss]Z. See `since`.',
    },
    orchestration_ids: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 50,
    },
    event_types: {
      type: 'array',
      items: { type: 'string', enum: EVENT_TYPES },
    },
    // T3 D2: enum constraint prevents silent zero-result typos.
    // Exact equality is used in history_scan._matches so a bad value returns no events.
    agent_role: { type: 'string', enum: AGENT_ROLES },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
  },
};

const definition = deepFreeze({
  name: 'history_query_events',
  description:
    'Query archived orchestration events with structured filters. Use ' +
    'instead of parsing events.jsonl in an LLM turn.',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  // No emitHandlerEntry: avoids feedback-loop pollution of the events corpus this tool reads.
  const validation = validateAgainstSchema(input || {}, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('history_query_events: ' + validation.errors.join('; '));
  }

  // Build scan-options roots from context.projectRoot when provided
  // (fixture strategy). Otherwise let history_scan resolve via paths.js.
  let options;
  if (context && context.projectRoot) {
    options = {
      roots: {
        liveAudit: path.join(context.projectRoot, '.orchestray', 'audit', 'events.jsonl'),
        historyDir: path.join(context.projectRoot, '.orchestray', 'history'),
      },
    };
  }

  try {
    const result = await queryEvents(input || {}, options);
    return toolSuccess(result);
  } catch (err) {
    return toolError('history_query_events: ' + (err && err.message ? err.message : String(err)));
  }
}

module.exports = {
  definition,
  handle,
};
