#!/usr/bin/env node
'use strict';

/**
 * PreToolUse:Agent hook — enforces model routing during orchestrations.
 *
 * Blocks any Agent() call that omits the `model` parameter or uses
 * model="inherit" while an orchestration is active. Fails open on all
 * unexpected errors so a broken hook never blocks legitimate work.
 *
 * Input:  JSON on stdin (Claude Code PreToolUse hook payload)
 * Output: exit 0 (allow) or exit 2 (block) with stderr message
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { getRoutingFilePath, findRoutingEntry } = require('./_lib/routing-lookup');

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

    // Defensive: only gate Agent tool calls (hooks.json matcher should already filter)
    const toolName = event.tool_name || (event.tool_input && event.tool_input.tool) || '';
    if (toolName !== 'Agent') {
      process.exit(0);
    }

    const cwd = resolveSafeCwd(event.cwd);
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

    // Valid model — allow the spawn
    process.exit(0);

  } catch (_e) {
    // Fail open: malformed JSON, missing stdin, or any other unexpected error
    process.stderr.write('[orchestray] gate-agent-spawn: unexpected error (' + (_e && _e.message) + '); failing open\n');
    process.exit(0);
  }
});
