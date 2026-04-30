#!/usr/bin/env node
'use strict';

/**
 * capture-tokenwright-realized.js — SubagentStop + TaskCompleted hook (v2.2.8).
 *
 * After a subagent stops, correlate its actual input_tokens against the
 * pre-compression estimate stashed in `.orchestray/state/tokenwright-pending.jsonl`
 * by inject-tokenwright.js.
 *
 * v2.2.6 fixes:
 *   B1 (CRITICAL) — Replace silent zero-token skip with transcript-first
 *                   resolveActualTokens(); always emit a paired event.
 *   B2            — Replace reference-equality removePendingEntry filter with
 *                   key-tuple equality so removal actually works.
 *   B4            — Sweep journal on read (TTL + size/count caps).
 *
 * v2.2.8 fixes:
 *   Issue A — Add TaskCompleted branch for Agent Teams true-teammate capture.
 *             Teammates complete via TaskCompleted (not SubagentStop), so their
 *             pending journal entries previously accumulated forever. This branch
 *             matches by orchestration_id + agent_type and emits realized savings
 *             with usage_source: 'task_completed_metrics'.
 *   Issue B — resolveActualTokens now aligns scope with the estimate: reads the
 *             first user message (delegation prompt) via bytes/4 instead of summing
 *             all assistant input_tokens, eliminating the 1461–1655% error_pct.
 *
 * New instrumentation:
 *   - emitTokenwrightRealizedUnknown when tokens === 0
 *   - emitTokenwrightEstimationDrift when |err| > budget
 *   - emitCompressionDoubleFireDetected via double-fire guard
 *   - emitTokenwrightJournalTruncated when sweep triggers truncation
 *
 * Fail-safe contract: any exception → stderr only; always emit { continue: true }.
 * routing.jsonl is never opened, read, or written by this hook.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }               = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }              = require('./_lib/constants');
const { getCurrentOrchestrationFile }  = require('./_lib/orchestration-state');
const {
  emitTokenwrightRealizedSavings,
  emitTokenwrightRealizedUnknown,
  emitTokenwrightEstimationDrift,
  emitCompressionDoubleFireDetected,
  emitTokenwrightJournalTruncated,
} = require('./_lib/tokenwright/emit');
const { resolveActualTokens }          = require('./_lib/tokenwright/resolve-actual-tokens');
const { sweepJournal }                 = require('./_lib/tokenwright/journal-sweep');
const { checkDoubleFire }              = require('./_lib/tokenwright/double-fire-guard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return (orchData && typeof orchData.orchestration_id === 'string')
      ? orchData.orchestration_id : null;
  } catch (_e) { return null; }
}

/**
 * Read + parse pending journal. Returns [] on any error.
 * Does NOT re-read inside removal — callers pass the already-read entries.
 *
 * @param {string} pendingPath
 * @returns {object[]}
 */
function readPending(pendingPath) {
  try {
    if (!fs.existsSync(pendingPath)) return [];
    const lines = fs.readFileSync(pendingPath, 'utf8').split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
                .filter(Boolean);
  } catch (_e) { return []; }
}

/**
 * Write kept entries back to the journal.
 * Fail-open: on error, journal accumulates stale entries (harmless).
 *
 * @param {string}   pendingPath
 * @param {object[]} kept
 */
function writePending(pendingPath, kept) {
  try {
    const content = kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : '');
    fs.writeFileSync(pendingPath, content, 'utf8');
  } catch (_e) {
    try {
      process.stderr.write('[capture-tokenwright-realized] failed to rewrite pending journal: ' + String(_e) + '\n');
    } catch (_inner) { /* swallow */ }
  }
}

/**
 * B2 fix: key-tuple equality for pending entry removal.
 * Computes a stable string key from identity fields.
 *
 * @param {object} e
 * @returns {string}
 */
function entryKey(e) {
  return `${e.spawn_key || ''}|${e.orchestration_id || ''}|${e.agent_type || ''}|${e.timestamp || ''}`;
}

/**
 * Load config gates for this script.
 * All gates default-on per feedback_default_on_shipping.md.
 *
 * @param {string} cwd
 * @returns {object}
 */
function loadConfig(cwd) {
  const defaults = {
    realized_savings_no_silent_skip:   true,
    estimation_drift_enabled:          true,
    estimation_drift_budget_pct:       15,
    pending_journal_ttl_hours:         24,
    pending_journal_max_bytes:         10240,
    pending_journal_max_entries:       100,
    transcript_token_resolution_enabled: true,
    double_fire_guard_enabled:         true,
  };

  // Env-var kill switches override config
  const envOverrides = {
    realized_savings_no_silent_skip:   process.env.ORCHESTRAY_DISABLE_REALIZED_NO_SKIP !== '1',
    estimation_drift_enabled:          process.env.ORCHESTRAY_DISABLE_DRIFT_DETECT !== '1',
    double_fire_guard_enabled:         process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD !== '1',
  };

  let fileConfig = {};
  try {
    const cfgPath = path.join(cwd, '.orchestray', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const compression = (raw && typeof raw.compression === 'object' && raw.compression) || {};
      fileConfig = {
        realized_savings_no_silent_skip:     compression.realized_savings_no_silent_skip,
        estimation_drift_enabled:            compression.estimation_drift_enabled,
        estimation_drift_budget_pct:         compression.estimation_drift_budget_pct,
        pending_journal_ttl_hours:           compression.pending_journal_ttl_hours,
        pending_journal_max_bytes:           compression.pending_journal_max_bytes,
        pending_journal_max_entries:         compression.pending_journal_max_entries,
        transcript_token_resolution_enabled: compression.transcript_token_resolution_enabled,
        double_fire_guard_enabled:           compression.double_fire_guard_enabled,
      };
      // Strip undefined keys so Object.assign works correctly
      Object.keys(fileConfig).forEach(k => {
        if (fileConfig[k] === undefined) delete fileConfig[k];
      });
    }
  } catch (_e) { /* fall through to defaults */ }

  // Merge: defaults < file config < env overrides
  return Object.assign({}, defaults, fileConfig, envOverrides);
}

// ---------------------------------------------------------------------------
// Issue A: TaskCompleted handler (Agent Teams true-teammate capture)
// ---------------------------------------------------------------------------

/**
 * Handle a TaskCompleted event from an Agent Teams true-teammate.
 *
 * True teammates complete via TaskCompleted (not SubagentStop), so their
 * pending journal entries are never consumed by the SubagentStop branch.
 * This handler matches by orchestration_id + agent_type (LIFO), emits
 * tokenwright_realized_savings with usage_source: 'task_completed_metrics',
 * and removes the matched pending entry.
 *
 * Fail-safe: any exception emits { continue: true } and exits. This hook
 * MUST NOT block Agent Teams task completion.
 *
 * @param {object} event   — TaskCompleted hook payload
 * @param {string} cwd     — resolved project root
 * @param {object} cfg     — loaded config
 */
function handleTaskCompleted(event, cwd, cfg) {
  try {
    const pendingPath = path.join(cwd, '.orchestray', 'state', 'tokenwright-pending.jsonl');
    const stateDir    = path.join(cwd, '.orchestray', 'state');

    // Extract agent_type from TaskCompleted payload (field name varies by Claude Code version)
    const agentType = (
      (event.task_completed_metrics && event.task_completed_metrics.agent_type) ||
      event.agent_type ||
      event.subagent_type ||
      'unknown'
    );
    const orchestrationId = resolveOrchestrationId(cwd);

    // --- Read + sweep journal ---
    const rawEntries = readPending(pendingPath);
    const { kept: sweptEntries, truncationEvent } = sweepJournal({
      entries:    rawEntries,
      ttlHours:   cfg.pending_journal_ttl_hours,
      maxBytes:   cfg.pending_journal_max_bytes,
      maxEntries: cfg.pending_journal_max_entries,
    });

    if (truncationEvent) {
      emitTokenwrightJournalTruncated(Object.assign(
        { orchestration_id: orchestrationId },
        truncationEvent
      ));
      writePending(pendingPath, sweptEntries);
    }

    if (sweptEntries.length === 0) {
      emitContinue();
      process.exit(0);
      return;
    }

    // --- Correlation: orchestration_id + agent_type, LIFO ---
    let matched = null;
    for (let i = sweptEntries.length - 1; i >= 0; i--) {
      const e = sweptEntries[i];
      if (e.agent_type === agentType &&
          (e.orchestration_id === orchestrationId ||
           (!e.orchestration_id && !orchestrationId))) {
        matched = e;
        break;
      }
    }

    // Fallback: any entry for this agent_type
    if (!matched) {
      for (let i = sweptEntries.length - 1; i >= 0; i--) {
        if (sweptEntries[i].agent_type === agentType) {
          matched = sweptEntries[i];
          break;
        }
      }
    }

    if (!matched) {
      // Orphan TaskCompleted — no pending entry to match. Exit cleanly.
      emitContinue();
      process.exit(0);
      return;
    }

    // --- Remove matched entry ---
    const matchedKey  = entryKey(matched);
    const afterRemove = sweptEntries.filter(e => entryKey(e) !== matchedKey);
    let removedPendingEntry = false;
    try {
      writePending(pendingPath, afterRemove);
      removedPendingEntry = true;
    } catch (_e) { /* writePending already logs */ }

    // --- Extract tokens from task_completed_metrics ---
    let metrics = event.task_completed_metrics;
    const driftBudgetPct = cfg.estimation_drift_budget_pct;
    const estimatedPre   = matched.input_token_estimate || 0;

    // v2.2.17 W7a: when SubagentStop fires without task_completed_metrics
    // (~50 events/install per W6 §2.8), fall back to the metrics ledger
    // written by bin/collect-agent-metrics.js. The ledger is populated by an
    // earlier hook in the same SubagentStop chain so the file is on disk by
    // the time we look. This converts the no_task_completed_metrics path
    // from a 100% "unknown" emit into an actionable lookup.
    if (!metrics) {
      try {
        const metricsPath = require('node:path').join(cwd, '.orchestray/metrics/agent_metrics.jsonl');
        const fsLocal = require('node:fs');
        if (fsLocal.existsSync(metricsPath)) {
          const lines = fsLocal.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
          const wantSpawnKey = matched.spawn_key || '';
          // Walk newest-first; pick a row matching our agent_type + agentMatchPossiblyByOrch.
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const row = JSON.parse(lines[i]);
              if (row && row.agent_type === agentType && row.orchestration_id === orchestrationId) {
                if (typeof row.input_tokens === 'number' && row.input_tokens > 0) {
                  metrics = { input_tokens: row.input_tokens, output_tokens: row.output_tokens || 0 };
                  break;
                }
              }
            } catch (_e) { /* skip malformed line */ }
            if (i < lines.length - 50) break; // bounded scan; never walk full file
          }
        }
      } catch (_e) { /* fail-open — fallback never blocks */ }
    }

    if (!metrics) {
      // No metrics object — unknown realized status
      emitTokenwrightRealizedSavings({
        orchestration_id:           orchestrationId,
        task_id:                    matched.task_id || null,
        agent_type:                 agentType,
        estimated_input_tokens_pre: estimatedPre,
        actual_input_tokens:        null,
        actual_savings_tokens:      null,
        estimation_error_pct:       null,
        technique_tag:              matched.technique_tag || 'safe-l1',
        realized_status:            'unknown',
        usage_source:               'task_completed_metrics',
        drift_exceeded:             false,
        drift_budget_pct:           driftBudgetPct,
        removed_pending_entry:      removedPendingEntry,
      });
      emitTokenwrightRealizedUnknown({
        orchestration_id:           orchestrationId,
        task_id:                    matched.task_id || null,
        agent_type:                 agentType,
        spawn_key:                  matched.spawn_key || '',
        estimated_input_tokens_pre: estimatedPre,
        reason:                     'no_task_completed_metrics',
        transcript_path_present:    false,
        hook_usage_present:         false,
      });
      emitContinue();
      process.exit(0);
      return;
    }

    // Extract input_tokens from metrics — accept either sum_of_input_tokens or input_tokens
    const rawTokens = (typeof metrics.input_tokens === 'number' && metrics.input_tokens > 0)
      ? metrics.input_tokens
      : (typeof metrics.sum_of_input_tokens === 'number' && metrics.sum_of_input_tokens > 0)
        ? metrics.sum_of_input_tokens
        : 0;

    if (rawTokens > 0) {
      const actualSavings    = estimatedPre - rawTokens;
      const rawErrPct        = estimatedPre > 0
        ? Math.abs(rawTokens - estimatedPre) / estimatedPre * 100
        : 0;
      const estimationErrPct = Math.round(rawErrPct * 100) / 100;
      const direction        = rawTokens > estimatedPre ? 'underestimate' : 'overestimate';
      const driftExceeded    = Math.abs(rawErrPct) > driftBudgetPct;

      emitTokenwrightRealizedSavings({
        orchestration_id:           orchestrationId,
        task_id:                    matched.task_id || null,
        agent_type:                 agentType,
        estimated_input_tokens_pre: estimatedPre,
        actual_input_tokens:        rawTokens,
        actual_savings_tokens:      actualSavings,
        estimation_error_pct:       estimationErrPct,
        technique_tag:              matched.technique_tag || 'safe-l1',
        realized_status:            'measured',
        usage_source:               'task_completed_metrics',
        drift_exceeded:             driftExceeded,
        drift_budget_pct:           driftBudgetPct,
        removed_pending_entry:      removedPendingEntry,
      });

      if (driftExceeded && cfg.estimation_drift_enabled) {
        emitTokenwrightEstimationDrift({
          orchestration_id:           orchestrationId,
          agent_type:                 agentType,
          estimated_input_tokens_pre: estimatedPre,
          actual_input_tokens:        rawTokens,
          estimation_error_pct:       estimationErrPct,
          drift_budget_pct:           driftBudgetPct,
          direction,
        });
      }
    } else {
      // Metrics present but no usable input_tokens value
      emitTokenwrightRealizedSavings({
        orchestration_id:           orchestrationId,
        task_id:                    matched.task_id || null,
        agent_type:                 agentType,
        estimated_input_tokens_pre: estimatedPre,
        actual_input_tokens:        null,
        actual_savings_tokens:      null,
        estimation_error_pct:       null,
        technique_tag:              matched.technique_tag || 'safe-l1',
        realized_status:            'unknown',
        usage_source:               'task_completed_metrics',
        drift_exceeded:             false,
        drift_budget_pct:           driftBudgetPct,
        removed_pending_entry:      removedPendingEntry,
      });
      emitTokenwrightRealizedUnknown({
        orchestration_id:           orchestrationId,
        task_id:                    matched.task_id || null,
        agent_type:                 agentType,
        spawn_key:                  matched.spawn_key || '',
        estimated_input_tokens_pre: estimatedPre,
        reason:                     'no_task_completed_metrics',
        transcript_path_present:    false,
        hook_usage_present:         false,
      });
    }

    emitContinue();
    process.exit(0);

  } catch (_taskErr) {
    try {
      process.stderr.write(
        '[capture-tokenwright-realized] TaskCompleted handler error=' +
        String(_taskErr && _taskErr.message ? _taskErr.message : _taskErr) + '\n'
      );
    } catch (_e) { /* swallow */ }
    // Fail-safe: MUST NOT block Agent Teams task completion
    emitContinue();
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Main stdin processor
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { emitContinue(); process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[capture-tokenwright-realized] stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n');
    emitContinue();
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    let event;
    try {
      event = JSON.parse(input || '{}');
    } catch (_e) {
      emitContinue();
      process.exit(0);
      return;
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

    // --- Issue A: TaskCompleted branch (Agent Teams true-teammate capture) ---
    // True teammates complete via TaskCompleted (not SubagentStop), so their
    // pending journal entries are never consumed by the SubagentStop branch below.
    // Delegate to handleTaskCompleted which emits realized savings and removes
    // the pending entry. This handler must not block task completion on error.
    if (event.hook_event_name === 'TaskCompleted') {
      const cfg_ = loadConfig(cwd);
      handleTaskCompleted(event, cwd, cfg_);
      return; // handleTaskCompleted calls emitContinue + process.exit
    }

    // --- Load config ---
    const cfg = loadConfig(cwd);

    const pendingPath = path.join(cwd, '.orchestray', 'state', 'tokenwright-pending.jsonl');
    const stateDir    = path.join(cwd, '.orchestray', 'state');

    // --- Read + sweep journal (B4) ---
    const rawEntries = readPending(pendingPath);
    const { kept: sweptEntries, truncationEvent } = sweepJournal({
      entries:    rawEntries,
      ttlHours:   cfg.pending_journal_ttl_hours,
      maxBytes:   cfg.pending_journal_max_bytes,
      maxEntries: cfg.pending_journal_max_entries,
    });

    // Emit truncation event if sweep removed entries
    if (truncationEvent) {
      const orchIdForTrunc = resolveOrchestrationId(cwd);
      emitTokenwrightJournalTruncated(Object.assign(
        { orchestration_id: orchIdForTrunc },
        truncationEvent
      ));
      // Write swept result immediately so we don't re-process expired entries
      writePending(pendingPath, sweptEntries);
    }

    if (sweptEntries.length === 0) {
      // No pending entries — spawn wasn't compressed (or journal was cleared).
      emitContinue();
      process.exit(0);
      return;
    }

    const agentType        = typeof event.subagent_type === 'string' ? event.subagent_type
                           : (event.agent_type || 'unknown');
    const orchestrationId  = resolveOrchestrationId(cwd);

    // --- Correlation: orchestration_id + agent_type, LIFO ---
    let matched = null;
    for (let i = sweptEntries.length - 1; i >= 0; i--) {
      const e = sweptEntries[i];
      if (e.agent_type === agentType &&
          (e.orchestration_id === orchestrationId ||
           (!e.orchestration_id && !orchestrationId))) {
        matched = e;
        break;
      }
    }

    // Fallback: any entry for this agent_type (last resort)
    if (!matched) {
      for (let i = sweptEntries.length - 1; i >= 0; i--) {
        if (sweptEntries[i].agent_type === agentType) {
          matched = sweptEntries[i];
          break;
        }
      }
    }

    if (!matched) {
      // No match — not a tokenwright-compressed spawn or different type key.
      emitContinue();
      process.exit(0);
      return;
    }

    // --- Double-fire guard (B3) ---
    if (cfg.double_fire_guard_enabled) {
      const dedupToken = `${agentType}:${matched.spawn_key || ''}:${matched.timestamp || ''}`;
      const { shouldFire, doubleFireEvent } = checkDoubleFire({
        dedupToken,
        callerPath:      __filename,
        stateDir,
        orchestrationId: orchestrationId || 'unknown',
      });

      if (!shouldFire) {
        if (doubleFireEvent) {
          emitCompressionDoubleFireDetected(Object.assign(
            { agent_type: agentType },
            doubleFireEvent
          ));
        }
        emitContinue();
        process.exit(0);
        return;
      }
    }

    // --- Resolve actual tokens (B1 fix) ---
    const { tokens, source } = resolveActualTokens(event, cwd);

    const estimatedPre   = matched.input_token_estimate || 0;
    const driftBudgetPct = cfg.estimation_drift_budget_pct;

    // --- B2 fix: key-tuple removal ---
    const matchedKey  = entryKey(matched);
    const afterRemove = sweptEntries.filter(e => entryKey(e) !== matchedKey);
    let removedPendingEntry = false;
    try {
      writePending(pendingPath, afterRemove);
      removedPendingEntry = true;
    } catch (_e) {
      // writePending already logs; removedPendingEntry stays false
    }

    // --- Branch on token count ---
    if (tokens > 0) {
      // --- tokens > 0: measured path ---
      const actualSavings     = estimatedPre - tokens;
      const rawErrPct         = estimatedPre > 0
        ? Math.abs(tokens - estimatedPre) / estimatedPre * 100
        : 0;
      const estimationErrPct  = Math.round(rawErrPct * 100) / 100;
      const direction         = tokens > estimatedPre ? 'underestimate' : 'overestimate';
      const driftExceeded     = Math.abs(rawErrPct) > driftBudgetPct;

      emitTokenwrightRealizedSavings({
        orchestration_id:           orchestrationId,
        task_id:                    matched.task_id || null,
        agent_type:                 agentType,
        estimated_input_tokens_pre: estimatedPre,
        actual_input_tokens:        tokens,
        actual_savings_tokens:      actualSavings,
        estimation_error_pct:       estimationErrPct,
        technique_tag:              matched.technique_tag || 'safe-l1',
        realized_status:            'measured',
        usage_source:               source,
        drift_exceeded:             driftExceeded,
        drift_budget_pct:           driftBudgetPct,
        removed_pending_entry:      removedPendingEntry,
      });

      if (driftExceeded && cfg.estimation_drift_enabled) {
        emitTokenwrightEstimationDrift({
          orchestration_id:           orchestrationId,
          agent_type:                 agentType,
          estimated_input_tokens_pre: estimatedPre,
          actual_input_tokens:        tokens,
          estimation_error_pct:       estimationErrPct,
          drift_budget_pct:           driftBudgetPct,
          direction,
        });
      }

    } else {
      // --- tokens === 0 path ---

      if (cfg.realized_savings_no_silent_skip) {
        // B1 fix: always emit, even with no token source
        emitTokenwrightRealizedSavings({
          orchestration_id:           orchestrationId,
          task_id:                    matched.task_id || null,
          agent_type:                 agentType,
          estimated_input_tokens_pre: estimatedPre,
          actual_input_tokens:        null,
          actual_savings_tokens:      null,
          estimation_error_pct:       null,
          technique_tag:              matched.technique_tag || 'safe-l1',
          realized_status:            'unknown',
          usage_source:               source,
          drift_exceeded:             false,
          drift_budget_pct:           driftBudgetPct,
          removed_pending_entry:      removedPendingEntry,
        });

        // Determine reason for dashboard visibility
        let reason = 'no_token_source';
        if (source === 'transcript') {
          // Transcript was read but produced 0 tokens — parse succeeded but no assistant usage
          reason = 'parse_failure';
        } else if (typeof event.agent_transcript_path === 'string' && event.agent_transcript_path) {
          // Path was present but not usable (containment rejection or unreadable)
          reason = 'transcript_unreadable';
        }

        emitTokenwrightRealizedUnknown({
          orchestration_id:           orchestrationId,
          task_id:                    matched.task_id || null,
          agent_type:                 agentType,
          spawn_key:                  matched.spawn_key || '',
          estimated_input_tokens_pre: estimatedPre,
          reason,
          transcript_path_present:    !!(event.agent_transcript_path),
          hook_usage_present:         !!(event.usage && event.usage.input_tokens),
        });

      }
      // else: legacy v2.2.5 silent-skip mode (ORCHESTRAY_DISABLE_REALIZED_NO_SKIP=1)
      // pending entry already removed above — no emit
    }

    emitContinue();
    process.exit(0);

  } catch (_outerErr) {
    try {
      process.stderr.write(
        '[capture-tokenwright-realized] error=' +
        String(_outerErr && _outerErr.message ? _outerErr.message : _outerErr) + '\n'
      );
    } catch (_e) { /* swallow */ }
    emitContinue();
    process.exit(0);
  }
});
