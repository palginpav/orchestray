#!/usr/bin/env node
'use strict';

/**
 * PostToolUse:Agent hook — appends a routing_outcome event after each Agent() spawn.
 *
 * Captures the model and effort assigned at spawn time and writes the event to
 * .orchestray/audit/events.jsonl so collect-agent-metrics.js can resolve costs
 * without relying on the PM to emit the event manually.
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

const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

function normalizeModel(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const tier of VALID_TIERS) {
    if (m.includes(tier)) return tier;
  }
  return model; // Return as-is if unrecognized (shouldn't reach here past the gate)
}

const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB cap — guards against runaway payloads OOMing the hook (T14 audit I14)

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

    // Defensive: only process Agent tool calls.
    // hooks.json matcher: "Agent" should already filter this, but the guard is
    // load-bearing if the matcher is ignored or the hook fires on all PostToolUse
    // events. Without this, every Bash/Read/Edit call during an orchestration
    // would write a bogus routing_outcome event to the audit trail.
    // Ref: https://code.claude.com/docs/en/hooks — matcher filters by tool_name
    // for PreToolUse/PostToolUse; exact string match when only letters/digits/_.
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') {
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
      model_assigned: normalizedModel,
      effort_assigned: effort,
      description: description,
      score: null, // reserved: filled by PM supplemental event post-task; null until then
      source: 'hook',
    };

    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening; chmod may fail on exotic filesystems */ }
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), routingEvent);

  } catch (_e) {
    // Fail open — never block agent completion due to audit failure
    process.stderr.write('[orchestray] emit-routing-outcome: unexpected error (' + (_e && _e.message) + '); failing open\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
