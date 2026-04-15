'use strict';

/**
 * `pattern_record_skip_reason` MCP tool.
 *
 * Records a structured "none of the returned patterns shaped this
 * decomposition" decision immediately after a `pattern_find` call. This
 * handler is a pure result emitter — it does NOT emit the `mcp_tool_call`
 * audit row itself. The central dispatcher in `server.js` (tools/call
 * dispatch block) emits that event for all non-ask_user tools. The audit
 * row will carry the `orchestration_id` from this tool's input (via the
 * T2 F4 override in server.js) rather than the filesystem marker.
 *
 * Per 2014-scope-proposal.md §W1.
 */

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');

// The four-value reason enum per scope-proposal §W1 R5 risk.
const SKIP_REASONS = ['all-irrelevant', 'all-low-confidence', 'all-stale', 'other'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['orchestration_id', 'reason'],
  properties: {
    orchestration_id: { type: 'string', minLength: 1, maxLength: 64 },
    reason: { type: 'string', enum: SKIP_REASONS },
    note: { type: 'string', maxLength: 500 },
  },
};

const definition = deepFreeze({
  name: 'pattern_record_skip_reason',
  description:
    'Record that none of the patterns returned by pattern_find shaped the ' +
    'current decomposition. Call once per orchestration immediately after a ' +
    'pattern_find call whose results were not applied. Produces an auditable ' +
    'mcp_tool_call row for the §22c false-positive analysis in 2.0.15. ' +
    'reason must be one of: all-irrelevant, all-low-confidence, all-stale, other. ' +
    'When reason is "other", note is required.',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, _context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_record_skip_reason: ' + validation.errors.join('; '));
  }

  // Extra rule: when reason is 'other', note is mandatory.
  if (input.reason === 'other' && (!input.note || input.note.trim().length === 0)) {
    return toolError(
      'pattern_record_skip_reason: note is required when reason is "other"'
    );
  }

  const result = {
    orchestration_id: input.orchestration_id,
    reason: input.reason,
    recorded: true,
  };

  if (input.note !== undefined && input.note !== null) {
    result.note = input.note;
  }

  return toolSuccess(result);
}

module.exports = {
  definition,
  handle,
  SKIP_REASONS,
};
