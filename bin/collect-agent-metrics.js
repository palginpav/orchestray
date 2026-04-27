#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { writeEvent }        = require('./_lib/audit-event-writer');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { loadCostBudgetCheckConfig } = require('./_lib/config-schema');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { appendJsonlWithRotation } = require('./_lib/jsonl-rotate');
const { normalizeEvent } = require('./read-event');
const { resolveTeammateModel } = require('./_lib/team-config-resolve');

// ---------------------------------------------------------------------------
// P1.1 M0.1 — Variant-C duplicate-emit dedupe (W1 design §1.1).
//
// The same SubagentStop / TaskCompleted hook invocation writes BOTH an
// `agent_stop` row AND a Variant-C `routing_outcome` supplement. Downstream
// rollup conflated them as duplicates. Fix: gate Variant-C on the absence of
// any earlier Variant-A or Variant-B routing_outcome row for this
// (orchestration_id, agent_type). Variant A's hook (emit-routing-outcome.js)
// does NOT carry agent_id (verified W3 open-question 2 — read at
// emit-routing-outcome.js:191-202), so the dedupe predicate uses
// (orchestration_id, agent_type) only.
//
// Kill switch: ORCHESTRAY_DISABLE_VARIANT_C_DEDUP=1 disables the gate (Variant-C
// re-emits double, the v2.1.x status quo) for emergency rollback.
// ---------------------------------------------------------------------------

/**
 * Does any Variant-A / Variant-B routing_outcome row already cover this spawn?
 *
 * @param {Array}  routingOutcomes  - Already-loaded routing_outcome events.
 * @param {string} orchestrationId
 * @param {string} agentType
 * @returns {boolean}
 */
function hasExistingRoutingOutcome(routingOutcomes, orchestrationId, agentType) {
  if (!Array.isArray(routingOutcomes) || !orchestrationId || !agentType) return false;
  for (const ev of routingOutcomes) {
    if (
      ev &&
      ev.orchestration_id === orchestrationId &&
      ev.agent_type === agentType &&
      ev.source !== 'subagent_stop'  // Variant-C rows do not gate themselves
    ) {
      return true;
    }
  }
  return false;
}

// Per-process seen-set for metrics-row dedupe.
// Key: `${orchestrationId}|${agent_id}|${ts}`. Each hook invocation appends one
// row, so this set is always empty in normal flow — guard catches future
// regressions where someone adds a second appendJsonlWithRotation call.
const _seenMetricsKeys = new Set();

/**
 * Append a dropped row to `.orchestray/state/dropped-duplicates.jsonl` for
 * post-hoc audit. Fail-open — any error is swallowed. Uses
 * appendJsonlWithRotation (W3 open-question 3 resolution: yes, rotate, same
 * 50 MB / 5-generation policy as other JSONL files in the system).
 *
 * @param {string} cwd
 * @param {object} row
 * @param {string} reasonCode  - 'variant_c_suppressed' | 'metrics_dedup_collision'
 */
function appendDroppedDuplicate(cwd, row, reasonCode) {
  try {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const droppedPath = path.join(stateDir, 'dropped-duplicates.jsonl');
    appendJsonlWithRotation(droppedPath, {
      ts: new Date().toISOString(),
      reason_code: reasonCode,
      row,
    });
  } catch (_e) {
    // Fail-open audit channel.
  }
}

// Module-level fallback pricing per 1M tokens (current Anthropic rates as of 2026).
// Used ONLY when loadCostBudgetCheckConfig() fails (fail-open contract).
// The authoritative source is mcp_server.cost_budget_check.pricing_table in
// .orchestray/config.json; these values mirror that table to keep them in sync.
// Per 2014-scope-proposal.md §W3.
const PRICING = {
  opus:   { input: 5.00,  output: 25.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 1.00,  output: 5.00  },
};

/**
 * Build a normalized pricing lookup from a config pricing_table or the PRICING fallback.
 * Config table uses { input_per_1m, output_per_1m }; internal callers expect { input, output }.
 *
 * @param {object|null} configPricingTable - From loadCostBudgetCheckConfig().pricing_table, or null.
 * @returns {object} Map of tier → { input: number, output: number }
 */
function buildPricingMap(configPricingTable) {
  if (!configPricingTable || typeof configPricingTable !== 'object') return PRICING;
  const result = {};
  for (const [tier, entry] of Object.entries(configPricingTable)) {
    if (entry && typeof entry.input_per_1m === 'number' && typeof entry.output_per_1m === 'number') {
      result[tier] = { input: entry.input_per_1m, output: entry.output_per_1m };
    }
  }
  // Ensure all three tiers are populated; fall back to PRICING for any missing tier.
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    if (!result[tier]) result[tier] = PRICING[tier];
  }
  return result;
}

/**
 * Detect pricing tier from resolved model or agent_type string.
 * Explicit model assignment from routing takes priority over agent_type inference.
 * Default to sonnet rates for unknown agent types.
 *
 * @param {string} agentType
 * @param {string|null} modelUsed
 * @param {object} pricingMap - Normalized pricing map from buildPricingMap().
 */
function getPricing(agentType, modelUsed, pricingMap) {
  const p = pricingMap || PRICING;
  // Explicit model assignment from routing takes priority
  if (modelUsed) {
    const m = modelUsed.toLowerCase();
    if (m.includes('opus')) return p.opus;
    if (m.includes('haiku')) return p.haiku;
    if (m.includes('sonnet')) return p.sonnet;
  }
  // Fallback to agent_type detection (pre-routing compatibility)
  const t = (agentType || '').toLowerCase();
  if (t.includes('opus')) return p.opus;
  if (t.includes('haiku')) return p.haiku;
  // architect, developer, reviewer, and any unknown types use sonnet rates
  return p.sonnet;
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

// ---------------------------------------------------------------------------
// BUG-PERF-2.0.13: configurable events.jsonl scan cap (DESIGN §D5 phase 1).
//
// The old hard-coded 2 MB cap caused every agent_stop event to emit
// "routing scan skipped" once events.jsonl grew past 2 MB, degrading cost
// attribution to the sonnet heuristic fallback. The fix raises the default
// materially and makes it configurable via a three-source precedence chain:
//   1. env ORCHESTRAY_MAX_EVENTS_BYTES (integer bytes, >0, reject NaN/neg/zero)
//   2. config key audit.max_events_bytes_for_scan (positive integer or null)
//   3. MAX_EVENTS_BYTES_DEFAULT (built-in: 32 MB — large enough for typical
//      long-running sessions while remaining well inside Node's heap budget;
//      32 MB chosen as a safe midpoint of the 20–50 MB guidance range from
//      DESIGN §D5 phase 1; durable rotation in W6 will supersede this cap)
// ---------------------------------------------------------------------------
const { loadAuditConfig } = require('./_lib/config-schema');

const MAX_EVENTS_BYTES_DEFAULT = 32 * 1024 * 1024; // 32 MB — see BUG-PERF-2.0.13 comment above

/**
 * Resolve the effective scan cap from the precedence chain.
 * Called at module load so each fresh hook process picks up the latest config.
 *
 * @returns {number} Positive integer byte limit.
 */
function resolveMaxEventBytes() {
  // Source 1: environment variable
  const envVal = parseInt(process.env.ORCHESTRAY_MAX_EVENTS_BYTES, 10);
  if (!isNaN(envVal) && envVal > 0) {
    return envVal;
  }

  // Source 2: config key audit.max_events_bytes_for_scan
  try {
    // Use process.cwd() as a best-effort project root at load time.
    // In production hooks the cwd is the project root; in tests the caller
    // controls cwd or sets the env var directly.
    const auditCfg = loadAuditConfig(process.cwd());
    const cfgVal = auditCfg.max_events_bytes_for_scan;
    if (typeof cfgVal === 'number' && Number.isInteger(cfgVal) && cfgVal > 0) {
      return cfgVal;
    }
  } catch (_e) {
    // Config load failure — fall through to default
  }

  // Source 3: built-in default
  return MAX_EVENTS_BYTES_DEFAULT;
}

/**
 * Check whether events.jsonl contains an orchestration_complete event for
 * `orchestrationId`. Uses a cheap substring pre-filter before JSON parsing,
 * mirroring the routing_outcome scan pattern above.
 *
 * Returns false on any read error (fail-open).
 *
 * @param {string} eventsPath
 * @param {string} orchestrationId
 * @returns {boolean}
 */
function _hasOrchestrationComplete(eventsPath, orchestrationId) {
  try {
    if (!fs.existsSync(eventsPath)) return false;
    const stat = fs.statSync(eventsPath);
    // Cap at 50 MB to avoid blocking the hook budget on huge audit files.
    if (stat.size > 50 * 1024 * 1024) return false;
    const content = fs.readFileSync(eventsPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line || !line.includes('"orchestration_complete"')) continue;
      try {
        // R-EVENT-NAMING (v2.1.13): normalise legacy `event`/`ts` to canonical
        // `type`/`timestamp` so v2.1.12-era rows match here too.
        const ev = normalizeEvent(JSON.parse(line));
        if (ev.type === 'orchestration_complete' && ev.orchestration_id === orchestrationId) {
          return true;
        }
      } catch (_e) {}
    }
    return false;
  } catch (_e) {
    return false;
  }
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
    const cwd = resolveSafeCwd(event.cwd);
    const auditDir = path.join(cwd, '.orchestray', 'audit');

    // Detect event source: team event (TaskCompleted) vs subagent event (SubagentStop)
    const isTeamEvent = event.hook_event_name === 'TaskCompleted';

    // Read orchestration_id from current-orchestration.json if available
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
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
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening; chmod may fail on exotic filesystems */ }

    // Read routing_outcome events from events.jsonl for this orchestration only.
    // Configurable cap + cheap substring pre-filter keep this O(n) on line count and bound
    // memory so the hook cannot blow its 15s budget on a long-lived session.
    // Cap is resolved from env var → config key → built-in default (BUG-PERF-2.0.13).
    const MAX_EVENTS_BYTES = resolveMaxEventBytes();
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
              // R-EVENT-NAMING (v2.1.13): canonicalise legacy `event`/`ts` fields.
              const ev = normalizeEvent(JSON.parse(line));
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

    // Resolve model_used from routing_outcome events (NOT from hook payload).
    // P1.1 M0.2: when the routing_outcome lookup misses, fall back to the
    // agents/<name>.md frontmatter resolver so teammates and unknown agent
    // types are LABELED ('unknown_team_member' for total miss) instead of
    // silently priced as Sonnet.
    const agentType = isTeamEvent
      ? (event.teammate_name || 'teammate')
      : (event.agent_type || null);
    let resolvedModel = resolveModelUsed(routingOutcomes, orchestrationId, agentType);
    if (!resolvedModel && agentType) {
      resolvedModel = resolveTeammateModel(agentType, cwd);
    }

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
      modelResolutionNote = 'routing scan skipped: events.jsonl exceeds scan cap (' + MAX_EVENTS_BYTES + ' bytes); cost falls back to agent_type heuristic';
    }

    // P1.1 M0.2: when the resolver hit the unknown-team-member fallback,
    // flip cost_confidence so /orchestray:analytics surfaces these rows.
    // The pricing path itself is unchanged (Sonnet rates), per W1 §M0.2.
    if (resolvedModel === 'unknown_team_member') {
      costConfidence = 'estimated';
    }

    // Load pricing table from config (single source of truth per §W3).
    // Falls back to module-level PRICING constant if config is unavailable.
    let pricingMap = PRICING;
    try {
      const costCfg = loadCostBudgetCheckConfig(cwd);
      pricingMap = buildPricingMap(costCfg.pricing_table);
    } catch (_pricingErr) {
      // Fail-open: use module-level PRICING fallback
    }

    // Estimate cost based on resolved model (or agent_type fallback) and token usage
    const rates = getPricing(agentType, resolvedModel, pricingMap);
    const estimatedCostUsd = estimateCost(totalUsage, rates);
    const estimatedCostOpusBaselineUsd = estimateCost(totalUsage, pricingMap.opus);

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

    // Variant C: auto-emit a routing_outcome supplement on SubagentStop / TaskCompleted.
    // This guarantees a completion-time routing record exists even when the PM drifts
    // on Variant B (PM-supplemented). Only emit when inside an orchestration context —
    // skip orphan events (orchestrationId === 'unknown') to avoid polluting the audit trail.
    if (orchestrationId !== 'unknown') {
      try {
        // Derive result heuristically — the hook has no access to the reviewer verdict.
        // "success" here means "the subagent completed and produced tokens"; true
        // pass/fail quality is determined downstream by the reviewer (source: "subagent_stop").
        let variantCResult;
        if (totalUsage.output_tokens === 0 && turnsUsed === 0) {
          // Agent stopped without producing output — likely a crash or immediate abort.
          variantCResult = 'error';
        } else if (usageSource === 'estimated') {
          // Token counts were fabricated from turn count; cannot distinguish outcomes.
          variantCResult = 'unknown';
        } else {
          // Subagent completed and produced tokens. Quality unknown.
          variantCResult = 'success';
        }

        const variantCEvent = {
          timestamp: new Date().toISOString(),
          type: 'routing_outcome',
          orchestration_id: orchestrationId,
          agent_type: agentType,
          agent_id: isTeamEvent ? (event.task_id || null) : (event.agent_id || null),
          model_assigned: resolvedModel || null,
          result: variantCResult,
          turns_used: turnsUsed,
          input_tokens: totalUsage.input_tokens,
          output_tokens: totalUsage.output_tokens,
          source: 'subagent_stop',
        };

        // P1.1 M0.1: gate Variant-C on the absence of an earlier Variant-A/B
        // routing_outcome row for this (orch, agent_type). The W7 baseline
        // showed 59% of historical events.jsonl rows were Variant-A + Variant-C
        // pairs being double-counted downstream. Kill switch:
        // ORCHESTRAY_DISABLE_VARIANT_C_DEDUP=1 reverts to the v2.1.x behavior.
        const dedupDisabled = process.env.ORCHESTRAY_DISABLE_VARIANT_C_DEDUP === '1';
        let suppress = false;
        if (!dedupDisabled) {
          try {
            suppress = hasExistingRoutingOutcome(routingOutcomes, orchestrationId, agentType);
          } catch (_dedupErr) {
            suppress = false; // Fail-open: better a duplicate than a missing row.
          }
        }
        if (suppress) {
          appendDroppedDuplicate(cwd, variantCEvent, 'variant_c_suppressed');
        } else {
          writeEvent(variantCEvent, { cwd });
        }

        // LL6: write a pending entry to routing-pending.jsonl so that when
        // PostToolUse:Agent fires (after SubagentStop) it can correlate the
        // spawn-side data (model, description) with the stop-side data (tokens,
        // turns, result) and emit a merged routing_decision event.
        // Key: (orchestration_id, agent_type). PostToolUse matches by this pair
        // plus temporal proximity (nearest unmatched entry).
        // Team events are excluded — they correlate differently via task_id.
        if (!isTeamEvent) {
          try {
            const stateDir = path.join(cwd, '.orchestray', 'state');
            fs.mkdirSync(stateDir, { recursive: true });
            const pendingPath = path.join(stateDir, 'routing-pending.jsonl');
            const pendingEntry = {
              orchestration_id: orchestrationId,
              agent_id: event.agent_id || null,
              agent_type: agentType,
              stop_timestamp: variantCEvent.timestamp,
              turns_used: turnsUsed,
              input_tokens: totalUsage.input_tokens,
              output_tokens: totalUsage.output_tokens,
              result: variantCResult,
            };
            atomicAppendJsonl(pendingPath, pendingEntry);
          } catch (_pendingErr) {
            // Fail open — pending write must never block the agent_stop write.
          }
        }
      } catch (_variantCErr) {
        // Fail open — Variant C emission must never block the agent_stop write.
      }
    }

    // Append to events.jsonl via the gateway
    writeEvent(auditEvent, { cwd });

    // Emit per-spawn row to agent_metrics.jsonl (§4.2 S5 measurement surface).
    // Fail-open: any error here must never block the agent stop.
    if (process.env.ORCHESTRAY_METRICS_DISABLED !== '1') {
      try {
        const metricsDir  = path.join(cwd, '.orchestray', 'metrics');
        fs.mkdirSync(metricsDir, { recursive: true });
        const metricsPath = path.join(metricsDir, 'agent_metrics.jsonl');

        const metricsRow = {
          row_type:           'agent_spawn',
          schema_version:     1,
          timestamp:          auditEvent.timestamp,
          orchestration_id:   orchestrationId,
          agent_type:         agentType,
          agent_id:           auditEvent.agent_id,
          session_id:         auditEvent.session_id,
          model_used:         resolvedModel,
          turns_used:         turnsUsed,
          usage: {
            input_tokens:                   totalUsage.input_tokens,
            output_tokens:                  totalUsage.output_tokens,
            cache_read_input_tokens:        totalUsage.cache_read_input_tokens,
            cache_creation_input_tokens:    totalUsage.cache_creation_input_tokens,
          },
          usage_source:       usageSource,
          cost_confidence:    costConfidence,
          estimated_cost_usd: estimatedCostUsd,
        };
        if (modelResolutionNote) metricsRow.model_resolution_note = modelResolutionNote;

        // P1.1 M0.1: defence-in-depth metrics-row dedupe. Per-process seen-set
        // is empty in normal flow (one append per hook invocation by
        // construction); guards against future regressions where someone adds
        // a second appendJsonlWithRotation call to this code path.
        // Use JSON.stringify to compose the key so attacker-controlled
        // components (agent_id, etc.) cannot alias via injected `|`
        // separators (W6 S-005).
        const dedupKey = JSON.stringify([orchestrationId, auditEvent.agent_id, auditEvent.timestamp]);
        if (_seenMetricsKeys.has(dedupKey)) {
          appendDroppedDuplicate(cwd, metricsRow, 'metrics_dedup_collision');
        } else {
          _seenMetricsKeys.add(dedupKey);
          appendJsonlWithRotation(metricsPath, metricsRow);
        }

        // B4 Eval Layer 1: score the Structured Result the agent just emitted
        // and append a `row_type: structural_score` row alongside the spawn row.
        // Fail-open: any scorer error must never block the agent stop.
        try {
          const { scoreStructural, appendStructuralScore } = require('./_lib/scorer-structural');
          const scoreResult = scoreStructural(event, { projectRoot: cwd });
          appendStructuralScore(cwd, orchestrationId, auditEvent.agent_id, agentType, scoreResult);
        } catch (_scorerErr) {
          // Fail-open
        }
      } catch (_metricsErr) {
        // Fail-open: metrics write must never block agent stop
      }

      // Detect orchestration_complete in the just-written events.jsonl and
      // trigger a rollup if this event closes the orchestration.
      try {
        const eventsPath = path.join(auditDir, 'events.jsonl');
        // Quick substring pre-check to avoid a full parse on every agent stop.
        if (auditEvent.type === 'orchestration_complete' ||
            // Also check the newly written events for an orchestration_complete
            // that may have been emitted by the PM before this hook fired.
            _hasOrchestrationComplete(eventsPath, orchestrationId)) {
          const { emitRollup } = require('./emit-orchestration-rollup');
          emitRollup(cwd, orchestrationId);

          // CiteCache: clear pattern-seen-set for this orchestration on completion.
          try {
            const { clearForOrch } = require('./_lib/pattern-seen-set');
            clearForOrch(orchestrationId, cwd);
          } catch (_clearErr) {
            // Fail-open: cleanup must never block orchestration completion.
          }
        }
      } catch (_rollupErr) {
        // Fail-open: rollup trigger must never block agent stop
      }
    }
  } catch (_e) {
    // Never block agent stop due to audit failure
  }

  // Always allow the agent to continue
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
