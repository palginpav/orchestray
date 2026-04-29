'use strict';

/**
 * mcp-handler-entry.js — shared helper for MCP tool handler-entry instrumentation.
 *
 * Emits one `mcp_tool_call` event with `phase: "entry"` at the start of each
 * MCP tool handler invocation. This gives the audit log a record of when a tool
 * was invoked (not just when it completed) so timing, ordering, and drop-rate
 * analysis is possible even if the handler never finishes.
 *
 * Kill switch: `ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1`
 * disables ALL handler-entry emits without touching the exit-time emit that
 * server.js already fires for every non-ask_user tool.
 *
 * Double-fire guard: the function checks `_selfEmitted` on the context object
 * (set by the helper on the first call for a given invocation) so callers that
 * accidentally call the helper twice per invocation only produce one row.
 *
 * Contract:
 *   - NEVER throws. All failure modes are swallowed — audit must never block
 *     the tool handler.
 *   - Emits via the central `writeEvent` gateway in audit-event-writer.js, not
 *     via direct atomicAppendJsonl.
 *   - Uses `peekOrchestrationId(projectRoot)` from the shared W0d helper;
 *     returns `null` when no active orchestration is found (null propagates to
 *     the event, which the autofill may promote to "unknown").
 *
 * Usage (in each tool's handle function, first line):
 *
 *   const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');
 *   async function handle(input, context) {
 *     emitHandlerEntry('tool_name', context);
 *     // ... rest of handler
 *   }
 */

const { writeEvent }             = require('./audit-event-writer');
const { peekOrchestrationId }    = require('./peek-orchestration-id');
const { resolveSafeCwd }         = require('./resolve-project-cwd');

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

function _isDisabled() {
  return process.env.ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED === '1';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit one `mcp_tool_call` event with `phase: "entry"` at the start of a
 * MCP tool handler.
 *
 * @param {string} toolName - The MCP tool name (e.g. 'kb_search').
 * @param {object|null|undefined} context - The handler context object (may contain
 *   `projectRoot` for test isolation). May be null/undefined in minimal test setups.
 * @param {object} [opts]
 * @param {boolean} [opts._selfEmittedGuard=true] - When true (default), marks a
 *   `_handlerEntryEmitted` flag on the context object to prevent double-fire if
 *   the helper is called twice with the same context reference.
 */
function emitHandlerEntry(toolName, context, opts) {
  if (_isDisabled()) return;

  // Double-fire guard: if the same context object was already marked, skip.
  if (opts === undefined) opts = {};
  const useGuard = (opts._selfEmittedGuard !== false);
  if (useGuard && context && context._handlerEntryEmitted === toolName) {
    return;
  }

  // Resolve cwd for peekOrchestrationId and writeEvent.
  // Prefer context.projectRoot (injected in tests); fall back to resolveSafeCwd.
  let cwd;
  try {
    if (context && typeof context.projectRoot === 'string' && context.projectRoot.length > 0) {
      cwd = context.projectRoot;
    } else {
      cwd = resolveSafeCwd();
    }
  } catch (_e) {
    cwd = process.cwd();
  }

  // Mark the context object to prevent double-fire.
  if (useGuard && context && typeof context === 'object') {
    context._handlerEntryEmitted = toolName;
  }

  try {
    const orchId = peekOrchestrationId(cwd);
    writeEvent(
      {
        type: 'mcp_tool_call',
        tool: typeof toolName === 'string' && toolName.length > 0 ? toolName : 'unknown',
        orchestration_id: orchId !== null ? orchId : undefined,
        phase: 'entry',
        outcome: 'in_progress',
        duration_ms: 0,
        form_fields_count: 0,
      },
      { cwd }
    );
  } catch (_e) {
    // Fail-open: audit must never block tool execution.
  }
}

module.exports = { emitHandlerEntry };
