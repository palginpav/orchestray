#!/usr/bin/env node
'use strict';

/**
 * inject-spawn-agent-hint.js — PreToolUse:Agent hook (v2.2.9 B-5.1).
 *
 * Mechanical reach for `mcp__orchestray__spawn_agent`. Per W3 G-3 + W4 RCA-7,
 * the MCP tool exists and is fully wired but produced ZERO non-test fires
 * across 5 v2.2.8 orchestrations because no agent prompt mechanically reached
 * it — discovery was prose-only.
 *
 * This hook appends a one-line escalation hint to delegation prompts targeting
 * write-capable specialist roles (developer, refactorer, security-engineer).
 * The hint is mechanically injected (operator cannot forget it) and points the
 * specialist at the supported escalation path.
 *
 * Targeted roles (write-capable specialists who legitimately discover follow-up
 * tasks needing other specialists):
 *   - developer
 *   - refactorer
 *   - security-engineer
 *
 * Read-only / no-spawn roles are NOT targeted (architect, reviewer, ux-critic,
 * researcher, platform-oracle, project-intent, debugger, tester, documenter,
 * inventor — they either don't escalate or have other paths).
 *
 * Behaviour:
 *   - On PreToolUse:Agent for one of the targeted subagent_types, append the
 *     hint to `tool_input.prompt` if not already present.
 *   - Idempotent: skips if hint substring is already in the prompt.
 *   - Fail-open: any error → emit allow with original input.
 *
 * Kill switch: ORCHESTRAY_SPAWN_AGENT_HINT_DISABLED=1 (default-on).
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 * Output: { hookSpecificOutput: { hookEventName, permissionDecision: 'allow',
 *            updatedInput }, continue: true }
 *         OR { continue: true } when not applicable.
 */

const { MAX_INPUT_BYTES } = require('./_lib/constants');

const TARGETED_ROLES = new Set(['developer', 'refactorer', 'security-engineer']);

const HINT_TEXT =
  '\n\n## Escalation path (mechanical)\n' +
  'If you discover a follow-up task that requires a different specialist agent ' +
  '(e.g., reviewer audit, architect redesign, security review), call ' +
  '`mcp__orchestray__spawn_agent({...})` to escalate via the reactive-spawn queue. ' +
  "See `mcp__orchestray__schema_get(slug='spawn_requested')` for the schema. " +
  'Do NOT shell out to `Agent(`, `claude-code`, or `node -e` — those paths are blocked.\n';

const HINT_SENTINEL = '## Escalation path (mechanical)';

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function emitAllowUpdated(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }));
}

function runMain() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => { emitContinue(); process.exit(0); });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write(
        '[orchestray] inject-spawn-agent-hint: stdin exceeded ' +
        MAX_INPUT_BYTES + ' bytes; failing open\n'
      );
      emitContinue();
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
  try {
    if (process.env.ORCHESTRAY_SPAWN_AGENT_HINT_DISABLED === '1') {
      emitContinue();
      process.exit(0);
    }

    const event = JSON.parse(input || '{}');
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') { emitContinue(); process.exit(0); }

    const toolInput = event.tool_input || {};
    const subagentType = String(toolInput.subagent_type || '');
    if (!TARGETED_ROLES.has(subagentType)) { emitContinue(); process.exit(0); }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    if (!prompt) { emitContinue(); process.exit(0); }

    // Idempotent — already injected.
    if (prompt.includes(HINT_SENTINEL)) { emitContinue(); process.exit(0); }

    const updatedInput = Object.assign({}, toolInput, {
      prompt: prompt + HINT_TEXT,
    });
    emitAllowUpdated(updatedInput);
    process.exit(0);
  } catch (_e) {
    emitContinue();
    process.exit(0);
  }
  });
}

if (require.main === module) {
  runMain();
}

module.exports = {
  TARGETED_ROLES,
  HINT_TEXT,
  HINT_SENTINEL,
};
