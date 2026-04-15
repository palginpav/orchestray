'use strict';

/**
 * Shared tool-result helper functions for Orchestray MCP tools.
 *
 * Extracted from per-tool duplicates (pattern_find, kb_search,
 * history_query_events, history_find_similar_tasks, cost_budget_check,
 * pattern_record_skip_reason, pattern_record_application) to a single
 * source of truth. All seven prior copies (six tool files + server.js) were byte-for-byte identical.
 *
 * Per T3 X1 (v2.0.15 reviewer audit).
 */

/**
 * Build a successful MCP tool result.
 *
 * @param {object} structuredContent - The JSON-serialisable result payload.
 * @returns {{ isError: false, content: Array<{type: 'text', text: string}>, structuredContent: object }}
 */
function toolSuccess(structuredContent) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * Build an error MCP tool result.
 *
 * @param {string} message - Human-readable error description.
 * @returns {{ isError: true, content: Array<{type: 'text', text: string}> }}
 */
function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

module.exports = { toolSuccess, toolError };
