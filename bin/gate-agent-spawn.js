#!/usr/bin/env node
'use strict';

/**
 * PreToolUse:Agent hook — enforces model routing during orchestrations.
 *
 * Blocks any Agent() call that omits the `model` parameter or uses
 * model="inherit" while an orchestration is active. Fails open on all
 * unexpected errors so a broken hook never blocks legitimate work.
 *
 * 2.0.12 additions:
 *   - Explicit dispatch allowlist replaces the `toolName !== 'Agent'` fast-exit.
 *     Known agent-dispatch names: {Agent, Explore, Task}.
 *     Known skip names: {Bash, Read, Edit, Glob, Grep, Write, NotebookEdit,
 *       WebFetch, WebSearch, TodoWrite}. Unknown names are handled by
 *     `mcp_enforcement.unknown_tool_policy` (default: "block").
 *   - `global_kill_switch` short-circuits before ANY 2.0.12 check. Routing.jsonl
 *     (2.0.11) validation still runs on known dispatch names.
 *   - MCP checkpoint pre-decomposition gate: after routing.jsonl validation,
 *     verifies that the PM called the required pre-decomposition MCP tools
 *     (pattern_find, kb_search, history_find_similar_tasks) for this
 *     orchestration_id before the first Agent() spawn.
 *
 * Input:  JSON on stdin (Claude Code PreToolUse hook payload)
 * Output: exit 0 (allow) or exit 2 (block) with stderr message
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { getRoutingFilePath, findRoutingEntry } = require('./_lib/routing-lookup');
const { loadMcpEnforcement } = require('./_lib/config-schema');
const {
  REQUIRED_PRE_DECOMPOSITION_TOOLS,
  getCheckpointFilePath,
  findCheckpointsForOrchestration,
  missingRequiredToolsFromRows,
} = require('./_lib/mcp-checkpoint');

const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

function isValidModel(model) {
  const m = model.toLowerCase();
  return VALID_TIERS.some(tier => m.includes(tier));
}

const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB cap — guards against runaway payloads OOMing the hook (T14 audit I14)

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);

    // Explicit dispatch allowlist. 2.0.12 closes the Explore/Task bypass by routing
    // known agent-dispatch tool names through this gate. Anything else is either a
    // known non-agent built-in (Bash, Read, Edit, Glob, Grep, Write — skip) or an
    // unknown name (fail-closed by default per unknown_tool_policy; user can
    // override in .orchestray/config.json).
    const toolName = event.tool_name || (event.tool_input && event.tool_input.tool) || '';

    const AGENT_DISPATCH_ALLOWLIST = new Set(['Agent', 'Explore', 'Task']);
    const SKIP_ALLOWLIST = new Set([
      'Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Write',
      'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
    ]);

    if (SKIP_ALLOWLIST.has(toolName)) {
      process.exit(0);
    }

    // Not a known agent-dispatch OR skip tool — defer decision to unknown_tool_policy
    // AFTER config is loaded (see below).
    const isKnownDispatch = AGENT_DISPATCH_ALLOWLIST.has(toolName);

    const cwd = resolveSafeCwd(event.cwd);
    const mcpEnforcement = loadMcpEnforcement(cwd);

    // Global kill switch — short-circuits before ANY 2.0.12 check. Routing.jsonl
    // (2.0.11) validation still runs on known dispatches. D5 property.
    if (mcpEnforcement.global_kill_switch === true && isKnownDispatch) {
      // In kill-switch mode, we still enforce 2.0.11 model-validity checks on
      // known dispatches but skip the new 2.0.12 MCP-checkpoint gate entirely.
      // Fall through to the existing routing.jsonl validation below.
    } else if (mcpEnforcement.global_kill_switch === true) {
      // Kill switch on AND unknown tool — just exit 0 (degraded to 2.0.11 behavior).
      process.exit(0);
    } else {
      // Unknown-tool policy (only when NOT in kill-switch mode)
      if (!isKnownDispatch) {
        const policy = mcpEnforcement.unknown_tool_policy || 'block';
        if (policy === 'allow') {
          process.exit(0);
        }
        if (policy === 'warn') {
          process.stderr.write(
            "[orchestray] unknown tool name '" + toolName + "' in PreToolUse — " +
            "allowing per unknown_tool_policy=warn. Add to AGENT_DISPATCH_ALLOWLIST " +
            "or SKIP_ALLOWLIST in bin/gate-agent-spawn.js to silence.\n"
          );
          process.exit(0);
        }
        // policy === 'block' (default per Q1)
        process.stderr.write(
          "[orchestray] unknown tool name '" + toolName + "' in PreToolUse — " +
          "blocking per unknown_tool_policy=block. If this is a legitimate Claude Code " +
          "built-in, add it to AGENT_DISPATCH_ALLOWLIST (to gate it) or SKIP_ALLOWLIST " +
          "(to skip gating) in bin/gate-agent-spawn.js. Emergency override: set " +
          "mcp_enforcement.unknown_tool_policy to 'warn' in .orchestray/config.json.\n"
        );
        process.exit(2);
      }
    }

    // From here on: toolName is a known agent-dispatch name (Agent, Explore, or Task),
    // or kill-switch mode is active. Proceed with 2.0.11 routing.jsonl validation.

    const orchFile = getCurrentOrchestrationFile(cwd);

    // Not in an orchestration — no gating, allow freely
    if (!fs.existsSync(orchFile)) {
      process.exit(0);
    }

    // Inside an orchestration — enforce model parameter
    const toolInput = event.tool_input || {};
    const model = toolInput.model;

    if (model === undefined || model === null || model === '') {
      process.stderr.write(
        "[orchestray] Agent() call missing required 'model' parameter. " +
        "Per Section 19, every orchestration spawn must route to haiku/sonnet/opus. " +
        "Re-spawn with model set explicitly.\n"
      );
      process.exit(2);
    }

    if (model === 'inherit') {
      process.stderr.write(
        "[orchestray] Agent() model=\"inherit\" is forbidden during orchestrations. " +
        "Route to haiku/sonnet/opus per Section 19.\n"
      );
      process.exit(2);
    }

    if (!isValidModel(model)) {
      process.stderr.write(
        "[orchestray] Agent() model=\"" + model + "\" is not a recognized routing tier. " +
        "Must contain haiku, sonnet, or opus (full model IDs accepted, e.g. claude-sonnet-4-6). " +
        "Route to haiku/sonnet/opus per Section 19.\n"
      );
      process.exit(2);
    }

    // routing.jsonl validation — check spawn against stored routing decisions
    const routingFile = getRoutingFilePath(cwd);
    if (fs.existsSync(routingFile)) {
      try {
        const agentType = toolInput.subagent_type || '';
        const descRaw = toolInput.description || (toolInput.prompt && toolInput.prompt.substring(0, 80)) || '';
        const entry = findRoutingEntry(cwd, agentType, descRaw);

        if (entry === null) {
          const descPreview = descRaw.substring(0, 80);
          process.stderr.write(
            '[orchestray] no routing entry found for this spawn (agent=' + agentType +
            ', desc=' + JSON.stringify(descPreview) + '). ' +
            'Per Section 19, the PM must write a routing decision to ' +
            '.orchestray/state/routing.jsonl before spawning. ' +
            'Re-read the file or re-decompose the task.\n'
          );
          process.exit(2);
        }

        // Normalize the tool_input model to a tier name for comparison
        const modelNormalized = VALID_TIERS.find(tier => model.toLowerCase().includes(tier));
        if (modelNormalized !== entry.model) {
          process.stderr.write(
            '[orchestray] model routing mismatch: routing.jsonl says ' + entry.model +
            ' for task ' + (entry.task_id || '(unknown)') +
            ' but Agent() was called with model=' + model + '. ' +
            'The PM must pass the model recorded at decomposition time. ' +
            'Re-read routing.jsonl.\n'
          );
          process.exit(2);
        }

        // Entry matches and model is correct — allow the spawn
      } catch (_routingErr) {
        // Fail-open: corrupted file, permission denied, or any unexpected error
        process.stderr.write(
          '[orchestray] gate-agent-spawn: routing.jsonl validation error (' +
          (_routingErr && _routingErr.message) + '); failing open\n'
        );
        // Fall through to allow
      }
    }
    // If routing.jsonl does not exist — pre-decomposition or non-orchestration spawn
    // The existing model-validity checks above have already run, so allow.

    // 2.0.12: MCP checkpoint pre-decomposition gate (only when kill switch is off).
    // Verifies that the PM called the required MCP retrieval tools
    // (pattern_find, kb_search, history_find_similar_tasks) before the first
    // orchestration Agent() spawn. Per-tool enforcement can be toggled off via
    // mcp_enforcement.<tool>: "prompt"|"off" in .orchestray/config.json.
    if (mcpEnforcement.global_kill_switch !== true) {
      try {
        const orchId = (() => {
          try {
            const orchFileContent = fs.readFileSync(orchFile, 'utf8');
            const parsed = JSON.parse(orchFileContent);
            return parsed && parsed.orchestration_id;
          } catch (_e) {
            return null;
          }
        })();

        if (orchId) {
          const checkpointPath = getCheckpointFilePath(cwd);
          const fileExists = fs.existsSync(checkpointPath);

          if (!fileExists) {
            // File absent — upgrade window or pre-decomposition. Fail-open per D6 step 1.
            // Fall through to allow.
          } else {
            // File exists — check if we have any rows for this orchestration.
            const rowsForThisOrch = findCheckpointsForOrchestration(cwd, orchId);

            if (rowsForThisOrch.length === 0) {
              // Zero rows for this orch — cross-orchestration fail-open per D6 step 3
              // bullet 2 and T4 Review Finding C3. Fall through to allow.
            } else {
              // Rows exist — compute required tools that are missing, filtered
              // by per-tool config (only tools set to "hook" are enforced).
              const enforcedTools = REQUIRED_PRE_DECOMPOSITION_TOOLS.filter(
                tool => mcpEnforcement[tool] === 'hook'
              );

              if (enforcedTools.length > 0) {
                const missing = missingRequiredToolsFromRows(rowsForThisOrch, enforcedTools);

                if (missing.length > 0) {
                  // Fail-closed: the enforcement target case.
                  process.stderr.write(
                    "[orchestray] mcp checkpoint gate: missing MCP checkpoint for " +
                    missing.join(', ') + " in orchestration " + orchId + ". " +
                    "Per Section 22b, the PM must call " + missing.join(', ') +
                    " before the first Agent() spawn. Re-run §22b for the missing " +
                    "tool(s) — see tier1-orchestration.md §22b.R for the re-entry " +
                    "protocol — then retry this spawn. To disable enforcement for a " +
                    "specific tool, set mcp_enforcement.<tool> to 'prompt' in " +
                    ".orchestray/config.json. Emergency rollback: set " +
                    "mcp_enforcement.global_kill_switch=true.\n"
                  );
                  process.exit(2);
                }
                // All enforced tools present — allow.
              }
            }
          }
        }
      } catch (mcpErr) {
        // Fail-open: any unexpected error in the checkpoint gate matches the
        // routing.jsonl validation discipline (fail-open on corruption/error).
        process.stderr.write(
          '[orchestray] gate-agent-spawn: mcp checkpoint validation error (' +
          (mcpErr && mcpErr.message) + '); failing open\n'
        );
        // Fall through to allow.
      }
    }

    // Valid model + routing entry + MCP checkpoints — allow the spawn.
    process.exit(0);

  } catch (_e) {
    // Fail open: malformed JSON, missing stdin, or any other unexpected error
    process.stderr.write('[orchestray] gate-agent-spawn: unexpected error (' + (_e && _e.message) + '); failing open\n');
    process.exit(0);
  }
});
