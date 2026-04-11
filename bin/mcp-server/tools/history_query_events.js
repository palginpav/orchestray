'use strict';

/**
 * `history_query_events` MCP tool.
 *
 * Filtered query over the live audit and every archived orchestration's
 * events.jsonl. Per v2011b-architecture.md §3.2.3 and
 * v2011c-stage2-plan.md §4/§7.
 */

const path = require('node:path');

const { queryEvents } = require('../lib/history_scan');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');

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
    agent_role: { type: 'string' },
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

function toolSuccess(structuredContent) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

module.exports = {
  definition,
  handle,
};
