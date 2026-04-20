#!/usr/bin/env node
'use strict';

/**
 * PostToolUse:Agent hook — appends a routing_outcome event after each Agent() spawn.
 *
 * Captures the model and effort assigned at spawn time and writes the event to
 * .orchestray/audit/events.jsonl so collect-agent-metrics.js can resolve costs
 * without relying on the PM to emit the event manually.
 *
 * LL6 addition: also emits a merged `routing_decision` event when stop-side data
 * is available in .orchestray/state/routing-pending.jsonl. The pending file is
 * written by collect-agent-metrics.js at SubagentStop time (which fires before
 * PostToolUse:Agent). Correlation key: (orchestration_id, agent_type).
 *
 * Fails open on all errors — a broken hook must not block agent completion.
 *
 * Input:  JSON on stdin (Claude Code PostToolUse hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Per-model output token caps used to compute completion_volume_ratio.
// completion_volume_ratio = output_tokens / MODEL_OUTPUT_CAPS[model]
// A ratio > 1.0 is possible if the cap is a typical-run ceiling, not a hard
// API limit. Label it a volume signal, not a quality score (LL6 design note).
// ---------------------------------------------------------------------------
const MODEL_OUTPUT_CAPS = {
  haiku:  32768,
  sonnet: 32768,
  opus:   32768,
};

/**
 * Compute completion_volume_ratio for a given output_tokens count and model.
 * Returns null if the model is unrecognized or output_tokens is not a positive number.
 *
 * @param {number} outputTokens
 * @param {string|null} model  Normalized model tier string ('haiku'|'sonnet'|'opus')
 * @returns {number|null}
 */
function completionVolumeRatio(outputTokens, model) {
  if (typeof outputTokens !== 'number' || outputTokens <= 0) return null;
  const cap = model && MODEL_OUTPUT_CAPS[model];
  if (!cap) return null;
  return Math.round((outputTokens / cap) * 10000) / 10000; // 4 decimal places
}

// ---------------------------------------------------------------------------
// Pending-file helpers for LL6 spawn/stop correlation.
//
// routing-pending.jsonl is written by collect-agent-metrics.js at SubagentStop
// time. PostToolUse:Agent fires after SubagentStop, so the pending entry is
// already present when we need it.
//
// Correlation: find the OLDEST unmatched entry for (orchestration_id, agent_type)
// (oldest = most likely to correspond to this spawn). Remove it from the file
// after reading so the next spawn of the same agent_type in the same orch gets
// a fresh entry.
// ---------------------------------------------------------------------------

const MAX_PENDING_READ = 512 * 1024; // 512 KB — pending file should be tiny

/**
 * Attempt to pop (read + remove) the oldest pending entry matching
 * (orchestration_id, agent_type) from routing-pending.jsonl.
 *
 * Returns the matched entry object, or null if not found or on any error.
 * Fail-open: never throws.
 *
 * @param {string} pendingPath
 * @param {string} orchestrationId
 * @param {string|null} agentType
 * @returns {object|null}
 */
function popPendingEntry(pendingPath, orchestrationId, agentType) {
  try {
    if (!fs.existsSync(pendingPath)) return null;
    const stat = fs.statSync(pendingPath);
    if (stat.size > MAX_PENDING_READ) {
      process.stderr.write('[orchestray] routing-pending.jsonl too large (' + stat.size + ' bytes); skipping merge\n');
      return null;
    }
    const raw = fs.readFileSync(pendingPath, 'utf8');
    const lines = raw.split('\n');
    let matchIdx = -1;
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) { parsed.push(null); continue; }
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { parsed.push(null); continue; }
      parsed.push(obj);
      // Find oldest (first) match for (orchestration_id, agent_type)
      if (
        matchIdx === -1 &&
        obj.orchestration_id === orchestrationId &&
        obj.agent_type === agentType
      ) {
        matchIdx = i;
      }
    }
    if (matchIdx === -1) return null;
    const matched = parsed[matchIdx];

    // Rewrite the pending file without the matched entry (compaction)
    const remaining = parsed
      .filter((_, i) => i !== matchIdx && parsed[i] !== null)
      .map(obj => JSON.stringify(obj))
      .join('\n');
    fs.writeFileSync(pendingPath, remaining ? remaining + '\n' : '');

    return matched;
  } catch (_e) {
    // Fail open — any error in pending-file manipulation must not block the hook.
    return null;
  }
}

const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

function normalizeModel(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const tier of VALID_TIERS) {
    if (m.includes(tier)) return tier;
  }
  return model; // Return as-is if unrecognized (shouldn't reach here past the gate)
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);

    // Defensive: only process known agent-dispatch tool calls. The 2.0.12
    // matcher in hooks.json expanded from "Agent" to "Agent|Explore|Task"
    // so built-in Claude Code dispatches flow through this hook too — this
    // guard is the in-script twin of that matcher. Anything else (Bash,
    // Read, Edit, etc.) exits without writing a bogus routing_outcome row.
    const AGENT_DISPATCH_NAMES = new Set(['Agent', 'Explore', 'Task']);
    const toolName = event.tool_name || '';
    if (!AGENT_DISPATCH_NAMES.has(toolName)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const cwd = resolveSafeCwd(event.cwd);
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    const orchFile = getCurrentOrchestrationFile(cwd);

    // No-op outside orchestrations
    if (!fs.existsSync(orchFile)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Read orchestration_id
    let orchestrationId = 'unknown';
    try {
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) { /* use default */ }

    const toolInput = event.tool_input || {};

    const rawModel = toolInput.model || null;
    const normalizedModel = normalizeModel(rawModel);
    const effort = toolInput.effort || null;
    const agentType = toolInput.subagent_type || toolInput.agent_type || null;
    const rawDescription = toolInput.description || toolInput.prompt || '';
    const description = rawDescription.slice(0, 200) || null;

    const routingEvent = {
      timestamp: new Date().toISOString(),
      type: 'routing_outcome',
      orchestration_id: orchestrationId,
      agent_type: agentType,
      tool_name: toolName, // 2.0.12 Variant A extension — distinguishes Agent/Explore/Task dispatches
      model_assigned: normalizedModel,
      effort_assigned: effort,
      description: description,
      score: null, // reserved: filled by PM supplemental event post-task; null until then
      source: 'hook',
    };

    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening; chmod may fail on exotic filesystems */ }
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), routingEvent);

    // Fix A (v2.1.8): write spawn-accepted sentinel so remind-model-before-spawn.js
    // knows a spawn has completed in this orchestration and stops reminding.
    // Idempotent: skip if already exists (EEXIST on wx). Fail-open on any other error.
    if (orchestrationId !== 'unknown') {
      try {
        const spawnAcceptedDir = path.join(cwd, '.orchestray', 'state', 'spawn-accepted');
        const spawnAcceptedPath = path.join(spawnAcceptedDir, orchestrationId);
        if (!fs.existsSync(spawnAcceptedPath)) {
          fs.mkdirSync(spawnAcceptedDir, { recursive: true });
          fs.writeFileSync(spawnAcceptedPath, '', { flag: 'wx' });
        }
      } catch (_sentinelErr) {
        // EEXIST on wx = already written by a concurrent call; any other error is non-fatal (fail-open).
        process.stderr.write('[orchestray] emit-routing-outcome: spawn-accepted sentinel write failed (' + (_sentinelErr && _sentinelErr.message) + '); continuing\n');
      }
    }

    // LL6: attempt to emit a merged routing_decision event.
    // SubagentStop fires before PostToolUse:Agent, so collect-agent-metrics.js
    // has already written the stop-side data to routing-pending.jsonl. Pop the
    // matching entry and merge it with the spawn-side data from this hook.
    // Idempotency: popPendingEntry removes the entry atomically, so a second
    // PostToolUse for the same agent never sees the same pending row.
    try {
      const pendingPath = path.join(cwd, '.orchestray', 'state', 'routing-pending.jsonl');
      const stopSide = popPendingEntry(pendingPath, orchestrationId, agentType);
      if (stopSide) {
        const spawnTs = routingEvent.timestamp;
        const stopTs = stopSide.stop_timestamp || new Date().toISOString();
        const durationMs = Math.max(0, Date.parse(stopTs) - Date.parse(spawnTs));
        const mergedEvent = {
          timestamp: stopTs,
          type: 'routing_decision',
          orchestration_id: orchestrationId,
          agent_id: stopSide.agent_id || null,
          agent_type: agentType,
          tool_name: toolName,
          description: description,
          model_assigned: normalizedModel,
          effort_assigned: effort,
          turns_used: stopSide.turns_used || 0,
          input_tokens: stopSide.input_tokens || 0,
          output_tokens: stopSide.output_tokens || 0,
          result: stopSide.result || null,
          completion_volume_ratio: completionVolumeRatio(stopSide.output_tokens || 0, normalizedModel),
          spawn_timestamp: spawnTs,
          duration_ms: durationMs,
        };
        atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), mergedEvent);
      } else {
        // No matching stop-side entry: orphaned spawn (agent may not have started,
        // or pending file was unavailable). No merged event emitted. This is normal
        // for agents that fail immediately (pre-start). No warning needed here —
        // the stop-side will emit an "unmatched" warning if it ever fires without
        // a matching spawn.
      }
    } catch (_mergeErr) {
      // Fail open — merge failure must never block the routing_outcome write.
    }

  } catch (_e) {
    // Fail open — never block agent completion due to audit failure
    process.stderr.write('[orchestray] emit-routing-outcome: unexpected error (' + (_e && _e.message) + '); failing open\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
