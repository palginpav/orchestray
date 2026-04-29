#!/usr/bin/env node
'use strict';

/**
 * prefetch-mcp-grounding.js — PreToolUse:Agent hook (v2.2.10 M1).
 *
 * Server-side MCP grounding prefetch. For each spawn whose `subagent_type`
 * appears in the per-role grounding map (§11.1), invokes the listed tool
 * handler modules directly (no MCP RPC), aggregates results, and returns
 * a `<mcp-grounding>` fence as `additionalContext` injected into Block-A.
 *
 * Events emitted per spawn:
 *   - 1 × `mcp_tool_call`   per tool successfully invoked
 *   - 1 × `mcp_grounding_prefetched`   on overall success
 *   - 1 × `mcp_grounding_prefetch_failed`  on unexpected error (fail-open)
 *
 * Kill switch: ORCHESTRAY_MCP_PREFETCH_DISABLED=1 → exit 0, no injection.
 *
 * Fail-open contract: this hook NEVER blocks a spawn. On any error, emit
 * `mcp_grounding_prefetch_failed` and return empty additionalContext.
 *
 * Input:  Claude Code PreToolUse:Agent JSON payload on stdin
 * Output: exit 0 always; hookSpecificOutput JSON on stdout when grounding fires
 */

const path = require('path');

const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { appendCheckpointEntry }       = require('./_lib/mcp-checkpoint');

// ---------------------------------------------------------------------------
// § 11.1 Per-role MCP-grounding prefetch map (single source of truth).
// Every role in F2's hard-block allowlist MUST appear here with ≥1 tool.
// ---------------------------------------------------------------------------
const ROLE_TOOL_MAP = {
  pm:         ['pattern_find', 'kb_search'],
  researcher: ['pattern_find', 'kb_search', 'history_find_similar_tasks'],
  architect:  ['pattern_find', 'kb_search', 'history_find_similar_tasks', 'routing_lookup'],
  debugger:   ['pattern_find', 'kb_search', 'history_find_similar_tasks', 'history_query_events'],
};

// ---------------------------------------------------------------------------
// Default inputs per tool (minimal valid input — enough to return results)
// ---------------------------------------------------------------------------
const DEFAULT_TOOL_INPUTS = {
  pattern_find:               { task_summary: 'grounding prefetch', mode: 'catalog', max_results: 5 },
  kb_search:                  { query: 'grounding prefetch context', limit: 5 },
  history_find_similar_tasks: { task_summary: 'grounding prefetch', limit: 3 },
  history_query_events:       { limit: 10 },
  routing_lookup:             { limit: 10 },
};

// ---------------------------------------------------------------------------
// Tool handler cache — lazy-require on first use
// ---------------------------------------------------------------------------
const _handlers = {};

function getHandler(toolName) {
  if (!_handlers[toolName]) {
    const modPath = path.join(__dirname, 'mcp-server', 'tools', toolName + '.js');
    _handlers[toolName] = require(modPath);
  }
  return _handlers[toolName];
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) { process.exit(0); }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    main(event).catch(() => process.exit(0));
  } catch (_e) {
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeAndExit(data) {
  process.stdout.write(data, () => process.exit(0));
}

function exitEmpty() {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(hookEvent) {
  // Kill switch
  if (process.env.ORCHESTRAY_MCP_PREFETCH_DISABLED === '1') {
    exitEmpty();
    return;
  }

  // Resolve cwd and role
  const cwd = resolveSafeCwd(hookEvent && hookEvent.cwd);

  // Extract subagent_type from the hook payload
  // Claude Code PreToolUse:Agent payload: { tool_input: { subagent_type, ... }, ... }
  const toolInput = (hookEvent && hookEvent.tool_input) || {};
  const role = typeof toolInput.subagent_type === 'string'
    ? toolInput.subagent_type.toLowerCase()
    : null;

  // Role not in grounding map → no prefetch needed
  const tools = role ? ROLE_TOOL_MAP[role] : null;
  if (!tools || tools.length === 0) {
    exitEmpty();
    return;
  }

  try {
    await runPrefetch(cwd, role, tools, hookEvent);
  } catch (err) {
    // Fail-open: emit failure event, return empty additionalContext
    try {
      writeEvent({
        type: 'mcp_grounding_prefetch_failed',
        role,
        error: (err && err.message ? err.message : String(err)).slice(0, 200),
      }, { cwd });
    } catch (_e) { /* double-fail-open */ }
    exitEmpty();
  }
}

// ---------------------------------------------------------------------------
// Prefetch runner
// ---------------------------------------------------------------------------

async function runPrefetch(cwd, role, tools, hookEvent) {
  // Build context for tool handlers (matches the MCP server context shape)
  const toolContext = { projectRoot: cwd };

  const sections = [];
  const toolsSucceeded = [];
  const toolsPrefetched = [...tools];

  for (const toolName of tools) {
    const t0 = Date.now();
    let outcome = 'error';
    let resultText = '';

    try {
      const handler = getHandler(toolName);
      const toolInput = DEFAULT_TOOL_INPUTS[toolName] || {};
      const result = await handler.handle(toolInput, toolContext);

      if (result && !result.isError && result.structuredContent) {
        outcome = 'answered';
        resultText = JSON.stringify(result.structuredContent, null, 2);
        toolsSucceeded.push(toolName);
      } else if (result && result.isError) {
        outcome = 'error';
        const errContent = Array.isArray(result.content) ? result.content[0] : null;
        resultText = errContent ? errContent.text : 'tool error';
      } else {
        outcome = 'answered';
        resultText = result ? JSON.stringify(result) : '{}';
        toolsSucceeded.push(toolName);
      }
    } catch (err) {
      outcome = 'error';
      resultText = err && err.message ? err.message.slice(0, 200) : 'unknown error';
    }

    const duration_ms = Date.now() - t0;

    // Emit mcp_tool_call per tool (mirrors MCP server audit.js shape)
    try {
      writeEvent({
        type: 'mcp_tool_call',
        tool: toolName,
        duration_ms,
        outcome,
        form_fields_count: 0,
        source: 'prefetch',
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    // Append checkpoint entry so gate-agent-spawn.js sees pre-decomposition rows
    try {
      appendCheckpointEntry(cwd, {
        timestamp:        new Date().toISOString(),
        tool:             toolName,
        outcome,
        phase:            'pre-decomposition',
        result_count:     null,
        fields_used:      false,
      });
    } catch (_e) { /* fail-open */ }

    sections.push(`## ${toolName} results\n${resultText}`);
  }

  // Build the <mcp-grounding> fence
  const timestamp = new Date().toISOString();
  const fence = [
    `<mcp-grounding cache_hint="transient">`,
    `[role: ${role} | timestamp: ${timestamp}]`,
    ...sections,
    `</mcp-grounding>`,
    '',
  ].join('\n');

  // Emit mcp_grounding_prefetched summary event
  try {
    writeEvent({
      type:                 'mcp_grounding_prefetched',
      role,
      tools_prefetched:     toolsPrefetched,
      tools_succeeded:      toolsSucceeded,
      injected_into_block_a: true,
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  // Return additionalContext to Claude Code
  writeAndExit(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: fence,
    },
    continue: true,
  }) + '\n');
}
