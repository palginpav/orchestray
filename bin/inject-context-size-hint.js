#!/usr/bin/env node
'use strict';

/**
 * inject-context-size-hint.js — PreToolUse:Agent hook (v2.2.12 W1a).
 *
 * Parses a `context_size_hint:` line from the agent prompt body and stages
 * the parsed values into `tool_input.context_size_hint` so that the
 * downstream `preflight-spawn-budget.js` gate can read them.
 *
 * Behaviour:
 *   - On `tool_name === 'Agent'`, read stdin, extract tool_input.prompt.
 *   - Parse `context_size_hint: system=N tier2=N handoff=N` (optional total=N).
 *   - If parsed AND tool_input.context_size_hint is not already set:
 *       - Stage { system, tier2, handoff } into tool_input.context_size_hint.
 *       - Emit audit event `context_size_hint_staged`.
 *       - Return updatedInput with the staged field.
 *   - If NOT parsed: emit `context_size_hint_missing`, exit 0 (let preflight decide).
 *   - If tool_input.context_size_hint already has non-zero values: pass through
 *     unchanged (backward compat — do not overwrite existing hint).
 *   - Kill switch: ORCHESTRAY_CTX_HINT_STAGER_DISABLED=1 → exit 0, no parsing.
 *   - Fail-open: any error → exit 0, stderr, original prompt unchanged.
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 * Output: { hookSpecificOutput: { hookEventName, permissionDecision, updatedInput }, continue: true }
 *         OR { continue: true }
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }            = require('./_lib/resolve-project-cwd');
const { writeEvent }                = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }           = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// ---------------------------------------------------------------------------
// Regex — accepts optional backtick wrapping and optional total= field
// context_size_hint: system=N tier2=N handoff=N [total=N]
// ---------------------------------------------------------------------------
const HINT_RE = /^\s*`?context_size_hint:\s*system=(\d+)\s+tier2=(\d+)\s+handoff=(\d+)/m;

// ---------------------------------------------------------------------------
// stdout helpers
// ---------------------------------------------------------------------------

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function emitAllowWithUpdatedInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }));
}

// ---------------------------------------------------------------------------
// Orchestration ID lookup (for audit correlation)
// ---------------------------------------------------------------------------

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return orchData && typeof orchData.orchestration_id === 'string'
      ? orchData.orchestration_id
      : null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Kill switch
  if (process.env.ORCHESTRAY_CTX_HINT_STAGER_DISABLED === '1') {
    emitContinue();
    return;
  }

  let raw = '';
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) { emitContinue(); return; }
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (_e) {
    process.stderr.write('[inject-context-size-hint] stdin read error\n');
    emitContinue();
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (_e) {
    process.stderr.write('[inject-context-size-hint] invalid JSON on stdin\n');
    emitContinue();
    return;
  }

  if (!event || event.tool_name !== 'Agent') {
    emitContinue();
    return;
  }

  const toolInput = event.tool_input || {};
  const cwd = resolveSafeCwd(event.cwd);

  try {
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';

    // Backward compat: if tool_input already carries a non-zero context_size_hint,
    // do not overwrite it — the caller explicitly staged it.
    const existing = toolInput.context_size_hint;
    if (existing && typeof existing === 'object' &&
        ((existing.system || 0) + (existing.tier2 || 0) + (existing.handoff || 0)) > 0) {
      emitContinue();
      return;
    }

    const match = HINT_RE.exec(prompt);
    const orchId = resolveOrchestrationId(cwd);
    const role   = toolInput.subagent_type || toolInput.agent_type || '';

    if (!match) {
      // Emit missing event; let preflight-spawn-budget.js make the block decision.
      try {
        writeEvent({
          event_type:       'context_size_hint_missing',
          version:          1,
          orchestration_id: orchId,
          subagent_type:    role,
          task_id:          toolInput.task_id || null,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
      emitContinue();
      return;
    }

    const system  = parseInt(match[1], 10);
    const tier2   = parseInt(match[2], 10);
    const handoff = parseInt(match[3], 10);

    const updatedInput = {
      ...toolInput,
      context_size_hint: { system, tier2, handoff },
    };

    try {
      writeEvent({
        event_type:       'context_size_hint_staged',
        version:          1,
        orchestration_id: orchId,
        subagent_type:    role,
        task_id:          toolInput.task_id || null,
        system,
        tier2,
        handoff,
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    emitAllowWithUpdatedInput(updatedInput);
  } catch (err) {
    process.stderr.write(`[inject-context-size-hint] unexpected error: ${err.message}\n`);
    emitContinue();
  }
}

main().catch(err => {
  process.stderr.write(`[inject-context-size-hint] fatal: ${err.message}\n`);
  emitContinue();
});
