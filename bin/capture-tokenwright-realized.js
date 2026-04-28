#!/usr/bin/env node
'use strict';

/**
 * capture-tokenwright-realized.js — SubagentStop hook (v2.2.5, tokenwright).
 *
 * After a subagent stops, correlate its actual input_tokens (from hook payload
 * or transcript) against the pre-compression estimate stashed in
 * `.orchestray/state/tokenwright-pending.jsonl` by inject-tokenwright.js.
 *
 * Correlation key: spawn_key = agentType + ':' + sha256(originalPrompt)[0..32].
 * Because the hook receives the compressed prompt (not the original), correlation
 * falls back to orchestration_id + agent_type when no spawn_key match is found
 * (picks the most-recent unmatched entry for that pair).
 *
 * Emits a `tokenwright_realized_savings` audit event with:
 *   estimated_input_tokens_pre  — from pending journal
 *   actual_input_tokens         — from SubagentStop hook payload
 *   actual_savings_tokens       — estimated - actual
 *   estimation_error_pct        — |actual - estimated| / actual * 100
 *
 * Removes the matched entry from the pending journal (rewrite-without-matched).
 *
 * Fail-safe contract: any exception → stderr only; always emit { continue: true }.
 * routing.jsonl is never opened, read, or written by this hook.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }     = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }    = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { emitTokenwrightRealizedSavings } = require('./_lib/tokenwright/emit');

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
 * Rewrite the pending journal without the matched entry.
 * Fail-open: if rewrite fails, the journal accumulates stale entries
 * (harmless — realized-savings hook just won't find another match).
 */
function removePendingEntry(pendingPath, matchedEntry) {
  try {
    const entries = readPending(pendingPath);
    const kept = entries.filter(e => e !== matchedEntry);
    const content = kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : '');
    fs.writeFileSync(pendingPath, content, 'utf8');
  } catch (_e) {
    try {
      process.stderr.write('[capture-tokenwright-realized] failed to rewrite pending journal: ' + String(_e) + '\n');
    } catch (_inner) { /* swallow */ }
  }
}

/**
 * Extract actual input_tokens from SubagentStop hook payload.
 * Claude Code passes usage in the top-level `usage` field of the hook event.
 * Fallback: event.tool_response.usage (variant seen in some versions).
 * Returns 0 if not found (caller will skip emit for zero).
 */
function resolveActualTokens(event) {
  // Primary: top-level usage (matches collect-agent-metrics.js line 389)
  const topUsage = event.usage;
  if (topUsage && (topUsage.input_tokens || topUsage.input_tokens === 0)) {
    return Number(topUsage.input_tokens) || 0;
  }
  // Secondary: tool_response.usage (some Claude Code variants)
  try {
    const trUsage = event.tool_response && event.tool_response.usage;
    if (trUsage && trUsage.input_tokens) return Number(trUsage.input_tokens) || 0;
  } catch (_e) { /* fall through */ }
  return 0;
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

    const pendingPath = path.join(cwd, '.orchestray', 'state', 'tokenwright-pending.jsonl');
    const entries     = readPending(pendingPath);
    if (entries.length === 0) {
      // No pending entries — this spawn wasn't compressed (or journal was cleared).
      emitContinue();
      process.exit(0);
      return;
    }

    const agentType       = typeof event.subagent_type === 'string' ? event.subagent_type
                          : (event.agent_type || 'unknown');
    const orchestrationId = resolveOrchestrationId(cwd);

    // Attempt correlation 1: orchestration_id + agent_type (most reliable since
    // inject-tokenwright.js doesn't have access to the compressed prompt to re-hash).
    let matched = null;
    // Prefer the most-recent entry for this orch+agent pair (LIFO).
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.agent_type === agentType &&
          (e.orchestration_id === orchestrationId ||
           (!e.orchestration_id && !orchestrationId))) {
        matched = e;
        break;
      }
    }

    // Fallback: any unmatched entry for this agent_type (last resort).
    if (!matched) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].agent_type === agentType) { matched = entries[i]; break; }
      }
    }

    if (!matched) {
      // No match — this subagent either wasn't compressed or used a different type key.
      emitContinue();
      process.exit(0);
      return;
    }

    const actualInputTokens = resolveActualTokens(event);

    // Don't emit if we have no actual token data — would produce misleading savings.
    if (actualInputTokens === 0) {
      // Still remove the pending entry to avoid stale accumulation.
      removePendingEntry(pendingPath, matched);
      emitContinue();
      process.exit(0);
      return;
    }

    const estimatedPre      = matched.input_token_estimate || 0;
    const actualSavings     = estimatedPre - actualInputTokens;
    const estimationErrPct  = actualInputTokens > 0
      ? Math.abs(actualInputTokens - estimatedPre) / actualInputTokens * 100
      : 0;

    // Emit realized-savings event (fail-safe internally via emit.js).
    emitTokenwrightRealizedSavings({
      orchestration_id:            orchestrationId,
      task_id:                     matched.task_id || null,
      agent_type:                  agentType,
      estimated_input_tokens_pre:  estimatedPre,
      actual_input_tokens:         actualInputTokens,
      actual_savings_tokens:       actualSavings,
      estimation_error_pct:        Math.round(estimationErrPct * 100) / 100,
      technique_tag:               matched.technique_tag || 'safe-l1',
    });

    // Remove matched entry from the pending journal.
    removePendingEntry(pendingPath, matched);

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
