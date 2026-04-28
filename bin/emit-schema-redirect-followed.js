#!/usr/bin/env node
'use strict';

/**
 * emit-schema-redirect-followed.js — PostToolUse:mcp__orchestray__schema_get hook (v2.2.8).
 *
 * When an agent calls mcp__orchestray__schema_get after being redirected by
 * context-shield.js, this hook pairs the call against the pending sentinel
 * written by context-shield and emits a `schema_redirect_followed` event with
 * conversion metadata (time_to_follow_ms, called_slug, suggested_slug, slug_match).
 *
 * Input:  JSON on stdin (Claude Code PostToolUse hook payload)
 * Output: none (observability only; always exits 0)
 *
 * Fail-open contract: ANY unexpected error → exit 0 so a hook bug never
 * disrupts normal mcp__orchestray__schema_get calls.
 *
 * Sentinel file: .orchestray/state/schema-redirect-pending.jsonl
 *   Each line: { orchestration_id, agent_type, ts, suggested_slug }
 *   Consumed: on match, the file is truncated (all consumed entries removed).
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }           = require('./_lib/resolve-project-cwd');
const { writeEvent }               = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }          = require('./_lib/constants');

if (process.env.ORCHESTRAY_SHIELD_DISABLED === '1') {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the pending sentinel file and return its lines as parsed objects.
 * Returns [] on any error.
 * @param {string} sentinelPath
 * @returns {Array<{orchestration_id:string, agent_type:string|null, ts:string, suggested_slug:string}>}
 */
function readPendingEntries(sentinelPath) {
  try {
    const raw = fs.readFileSync(sentinelPath, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(Boolean);
  } catch (_e) {
    return [];
  }
}

/**
 * Resolve the orchestration_id from state, fail-open to 'unknown'.
 * @param {string} cwd
 * @returns {string}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData && orchData.orchestration_id) return orchData.orchestration_id;
  } catch (_e) {}
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main stdin processing
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    const cwd = resolveSafeCwd(event.cwd);

    // Only act on mcp__orchestray__schema_get PostToolUse events.
    const toolName = event.tool_name || '';
    if (!toolName.includes('schema_get')) {
      process.exit(0);
    }

    // Extract the slug the agent actually called with.
    const toolInput = event.tool_input || {};
    const calledSlug = toolInput.slug || toolInput.event_type || '';

    const sentinelPath = path.join(cwd, '.orchestray', 'state', 'schema-redirect-pending.jsonl');
    const entries = readPendingEntries(sentinelPath);
    if (entries.length === 0) {
      // No pending redirect — nothing to pair.
      process.exit(0);
    }

    const oid = resolveOrchestrationId(cwd);
    const agentType = event.agent_type || null;
    const now = new Date();

    // Find the most recent matching entry (same orchestration_id and agent_type).
    // Fall back to the most recent entry if no exact match.
    let matched = entries.find(
      e => e.orchestration_id === oid && (!agentType || e.agent_type === agentType)
    );
    if (!matched) matched = entries[entries.length - 1];

    const suggestedSlug = matched.suggested_slug || 'agent_start';
    const emitTs = new Date(matched.ts);
    const timeToFollowMs = isNaN(emitTs.getTime()) ? null : (now.getTime() - emitTs.getTime());
    const slugMatch = calledSlug === suggestedSlug;

    try {
      writeEvent({
        version: 1,
        schema_version: 1,
        timestamp: now.toISOString(),
        type: 'schema_redirect_followed',
        orchestration_id: oid,
        agent_type: agentType,
        time_to_follow_ms: timeToFollowMs,
        called_slug: calledSlug,
        suggested_slug: suggestedSlug,
        slug_match: slugMatch,
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    // Consume matched entries from sentinel (keep unmatched ones).
    try {
      const remaining = entries.filter(e => e !== matched);
      if (remaining.length === 0) {
        fs.unlinkSync(sentinelPath);
      } else {
        const newContent = remaining.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.writeFileSync(sentinelPath, newContent, 'utf8');
      }
    } catch (_e) { /* fail-open */ }

    process.exit(0);
  } catch (_e) {
    process.exit(0);
  }
});
