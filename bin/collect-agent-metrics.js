#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');

// Model-based pricing per 1M tokens (current Anthropic rates as of 2026)
const PRICING = {
  opus:   { input: 5.00,  output: 25.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 1.00,  output: 5.00  },
};

/**
 * Detect pricing tier from resolved model or agent_type string.
 * Explicit model assignment from routing takes priority over agent_type inference.
 * Default to sonnet rates for unknown agent types.
 */
function getPricing(agentType, modelUsed) {
  // Explicit model assignment from routing takes priority
  if (modelUsed) {
    const m = modelUsed.toLowerCase();
    if (m.includes('opus')) return PRICING.opus;
    if (m.includes('haiku')) return PRICING.haiku;
    if (m.includes('sonnet')) return PRICING.sonnet;
  }
  // Fallback to agent_type detection (pre-routing compatibility)
  const t = (agentType || '').toLowerCase();
  if (t.includes('opus')) return PRICING.opus;
  if (t.includes('haiku')) return PRICING.haiku;
  // architect, developer, reviewer, and any unknown types use sonnet rates
  return PRICING.sonnet;
}

/**
 * Resolve model_used for an agent_stop event by looking up the matching
 * routing_outcome event in the same events.jsonl file.
 *
 * UPPER-BOUND NOTE (DEF-2): when an agent was escalated mid-run (e.g., sonnet
 * then opus), this resolver returns the FINAL model. The emitted cost is
 * therefore an upper bound: pre-escalation tokens are billed at post-
 * escalation rates because we do not split tokens by timestamp. When an
 * escalation is detected (2+ routing_outcome events for the same orch_id +
 * agent_type), the caller sets a `model_resolution_note` field on the event
 * so downstream reporting can flag the row.
 *
 * @param {Array} allEvents - All parsed events from events.jsonl
 * @param {string} orchestrationId - The orchestration_id of the agent_stop event
 * @param {string} agentType - The agent_type of the agent_stop event
 * @returns {string|null} The model_assigned from the routing_outcome, or null if not found
 */
function resolveModelUsed(allEvents, orchestrationId, agentType) {
  if (!orchestrationId || !agentType) return null;

  // Find the routing_outcome event matching this orchestration + agent type.
  // Search in reverse order to get the most recent match (handles escalation:
  // if an agent was escalated, the last routing_outcome for that agent_type
  // reflects the final model used).
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const ev = allEvents[i];
    if (
      ev.type === 'routing_outcome' &&
      ev.orchestration_id === orchestrationId &&
      ev.agent_type === agentType
    ) {
      return ev.model_assigned || null;
    }
  }
  return null; // Pre-routing orchestration or no match
}

/**
 * Estimate cost in USD from token usage and model pricing.
 */
function estimateCost(usage, rates) {
  const inputCost = (usage.input_tokens / 1_000_000) * rates.input;
  const outputCost = (usage.output_tokens / 1_000_000) * rates.output;
  // Cache reads are ~90% cheaper than regular input tokens
  const cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * rates.input * 0.1;
  // Cache creation costs 25% more than regular input tokens
  const cacheCreateCost = (usage.cache_creation_input_tokens / 1_000_000) * rates.input * 1.25;
  const total = inputCost + outputCost + cacheReadCost + cacheCreateCost;
  return Math.round(total * 1_000_000) / 1_000_000; // 6 decimal places
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const cwd = event.cwd || process.cwd();
    const auditDir = path.join(cwd, '.orchestray', 'audit');

    // Detect event source: team event (TaskCompleted) vs subagent event (SubagentStop)
    const isTeamEvent = event.hook_event_name === 'TaskCompleted';

    // Read orchestration_id from current-orchestration.json if available
    let orchestrationId = 'unknown';
    try {
      const orchFile = path.join(auditDir, 'current-orchestration.json');
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData.orchestration_id) {
        orchestrationId = orchData.orchestration_id;
      }
    } catch (_e) {
      // File missing or unreadable -- use default
    }

    // Parse agent transcript for token usage
    const totalUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    // Team events use transcript_path; subagent events use agent_transcript_path
    let transcriptPath = isTeamEvent
      ? (event.transcript_path || null)
      : (event.agent_transcript_path || null);

    // Path containment: only allow reads from project dir or ~/.claude/.
    // DEF-1: resolve symlinks on both sides via fs.realpathSync so a cwd that
    // is a symlink to the real project dir does not trip the containment check
    // and unnecessarily kick in the estimated-cost fallback. realpathSync
    // throws on non-existent paths, so wrap each call and fall back to
    // path.resolve when the target does not yet exist (e.g., install-time
    // wiring). Allow resolved === cwdResolved (transcript exactly at cwd root).
    if (transcriptPath) {
      const safeRealpath = (p) => {
        try {
          return fs.realpathSync(p);
        } catch (_e) {
          return path.resolve(p);
        }
      };
      const resolved = safeRealpath(transcriptPath);
      const cwdResolved = safeRealpath(cwd);
      const claudeHome = safeRealpath(path.join(require('os').homedir(), '.claude'));
      const insideCwd =
        resolved === cwdResolved ||
        resolved.startsWith(cwdResolved + path.sep);
      const insideClaudeHome =
        resolved === claudeHome ||
        resolved.startsWith(claudeHome + path.sep);
      if (!insideCwd && !insideClaudeHome) {
        transcriptPath = null; // Block reads outside project dir and ~/.claude/
      }
    }

    let turnsUsed = 0;

    try {
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const role = entry.role || entry.type || (entry.message && entry.message.role);
            if (role === 'assistant') turnsUsed++;
            const usage = entry.usage || (entry.message && entry.message.usage);
            if (usage) {
              totalUsage.input_tokens += Number(usage.input_tokens) || 0;
              totalUsage.output_tokens += Number(usage.output_tokens) || 0;
              totalUsage.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
              totalUsage.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0;
            }
          } catch (_e) {
            // Skip malformed lines silently
          }
        }
      }
    } catch (_e) {
      // Transcript unavailable -- all usage fields remain 0, turnsUsed remains 0
    }

    let usageSource = 'transcript';
    // cost_confidence: "measured" when token counts came from the transcript
    // or the hook event payload; "estimated" when they were fabricated from
    // turn count. Downstream dashboards use this to flag fabricated rows.
    let costConfidence = 'measured';

    // Fallback: if transcript yielded zero tokens, check hook event payload
    if (totalUsage.input_tokens === 0 && totalUsage.output_tokens === 0) {
      const eventUsage = event.usage || {};
      if (eventUsage.input_tokens || eventUsage.output_tokens) {
        totalUsage.input_tokens = eventUsage.input_tokens || 0;
        totalUsage.output_tokens = eventUsage.output_tokens || 0;
        totalUsage.cache_read_input_tokens = eventUsage.cache_read_input_tokens || 0;
        totalUsage.cache_creation_input_tokens = eventUsage.cache_creation_input_tokens || 0;
        usageSource = 'event_payload';
      }
      // Second fallback: estimate from turns if we have turn count but no tokens.
      // The 2000/1000 multipliers are conservative rule-of-thumb averages for a
      // mid-length agent turn; they are NOT measured. cost_confidence flips to
      // "estimated" so /orchestray:analytics can flag these rows.
      if (totalUsage.input_tokens === 0 && totalUsage.output_tokens === 0 && turnsUsed > 0) {
        totalUsage.input_tokens = turnsUsed * 2000;
        totalUsage.output_tokens = turnsUsed * 1000;
        usageSource = 'estimated';
        costConfidence = 'estimated';
      }
    }

    // Ensure audit directory exists
    fs.mkdirSync(auditDir, { recursive: true });

    // Read routing_outcome events from events.jsonl for this orchestration only.
    // 2 MB cap + cheap substring pre-filter keep this O(n) on line count and bound
    // memory so the hook cannot blow its 15s budget on a long-lived session.
    const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
    const routingOutcomes = [];
    let routingCapHit = false;
    try {
      const eventsPath = path.join(auditDir, 'events.jsonl');
      if (fs.existsSync(eventsPath)) {
        const size = fs.statSync(eventsPath).size;
        if (size <= MAX_EVENTS_BYTES) {
          const eventsContent = fs.readFileSync(eventsPath, 'utf8');
          for (const line of eventsContent.split('\n')) {
            if (!line || !line.includes('"routing_outcome"')) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'routing_outcome' && ev.orchestration_id === orchestrationId) {
                routingOutcomes.push(ev);
              }
            } catch (_e) {
              // Skip malformed lines
            }
          }
        } else {
          routingCapHit = true;
          process.stderr.write(
            '[orchestray] events.jsonl exceeds ' + MAX_EVENTS_BYTES +
            ' bytes; skipping routing-outcome scan (cost falls back to agent_type heuristic)\n'
          );
        }
      }
    } catch (_e) {
      // events.jsonl unavailable -- routingOutcomes stays empty
    }

    // Resolve model_used from routing_outcome events (NOT from hook payload)
    const agentType = isTeamEvent
      ? (event.teammate_name || 'teammate')
      : (event.agent_type || null);
    const resolvedModel = resolveModelUsed(routingOutcomes, orchestrationId, agentType);

    // DEF-2: detect escalation by counting routing_outcome events for this
    // (orch_id, agent_type). 2+ means the agent was re-routed mid-run, so the
    // resolved model reflects the LAST assignment and pre-escalation tokens
    // are billed at post-escalation rates. Flag the event so downstream
    // reporting can display a disclaimer.
    let modelResolutionNote = null;
    if (orchestrationId && agentType) {
      let routingOutcomeCount = 0;
      for (const ev of routingOutcomes) {
        if (ev.agent_type === agentType) {
          routingOutcomeCount++;
          if (routingOutcomeCount >= 2) break;
        }
      }
      if (routingOutcomeCount >= 2) {
        modelResolutionNote = 'cost is upper bound: agent was escalated; pre-escalation tokens billed at post-escalation rate';
      }
    }
    if (routingCapHit && !modelResolutionNote) {
      modelResolutionNote = 'routing scan skipped: events.jsonl > 2MB; cost falls back to agent_type heuristic';
    }

    // Estimate cost based on resolved model (or agent_type fallback) and token usage
    const rates = getPricing(agentType, resolvedModel);
    const estimatedCostUsd = estimateCost(totalUsage, rates);
    const estimatedCostOpusBaselineUsd = estimateCost(totalUsage, PRICING.opus);

    // Construct audit event -- different shape for team vs subagent events
    let auditEvent;
    if (isTeamEvent) {
      auditEvent = {
        timestamp: new Date().toISOString(),
        type: 'task_completed_metrics',
        mode: 'teams',
        orchestration_id: orchestrationId,
        agent_id: event.task_id || null,
        agent_type: agentType,
        session_id: event.session_id || null,
        task_subject: event.task_subject || null,
        team_name: event.team_name || null,
        usage: totalUsage,
        usage_source: usageSource,
        cost_confidence: costConfidence,
        estimated_cost_usd: estimatedCostUsd,
        estimated_cost_opus_baseline_usd: estimatedCostOpusBaselineUsd,
        model_used: resolvedModel,
        turns_used: turnsUsed,
      };
    } else {
      auditEvent = {
        timestamp: new Date().toISOString(),
        type: 'agent_stop',
        orchestration_id: orchestrationId,
        agent_id: event.agent_id || null,
        agent_type: agentType,
        session_id: event.session_id || null,
        last_message_preview: (event.last_assistant_message || '').slice(0, 200),
        usage: totalUsage,
        usage_source: usageSource,
        cost_confidence: costConfidence,
        estimated_cost_usd: estimatedCostUsd,
        estimated_cost_opus_baseline_usd: estimatedCostOpusBaselineUsd,
        transcript_path: transcriptPath,
        model_used: resolvedModel,
        turns_used: turnsUsed,
      };
    }

    // DEF-2: only attach the note when escalation was actually detected.
    if (modelResolutionNote) {
      auditEvent.model_resolution_note = modelResolutionNote;
    }

    // Append to events.jsonl
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), auditEvent);
  } catch (_e) {
    // Never block agent stop due to audit failure
  }

  // Always allow the agent to continue
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
