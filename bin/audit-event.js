#!/usr/bin/env node
'use strict';

/**
 * SubagentStart hook. Writes an agent_start audit event to events.jsonl.
 *
 * Thin wrapper around bin/_lib/audit-event-writer.js — the shared helper
 * handles stdin parsing, orchestration_id resolution, and appending to
 * events.jsonl. This script only supplies the event `type` and the
 * script-specific extra fields.
 *
 * Runs on SubagentStart only. SubagentStop is intentionally handled by a
 * different hook script (bin/collect-agent-metrics.js) because that script
 * needs to compute cost/token metrics that aren't available at start time.
 *
 * Always emits `type: 'agent_start'`; argv is ignored. Earlier versions of
 * hooks.json passed a decorative `start` positional arg that was never
 * parsed; v2.2.15 FN-25 removed it from the canonical entry. Per T13 audit
 * I10 and T15 audit.
 */

const writeAuditEvent = require('./_lib/audit-event-writer');
const { readCache }   = require('./_lib/context-telemetry-cache');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');

// v2.3.1: canonical agent set imported from single source of truth.
// Previously a literal Set duplicated in three files; consolidated to prevent
// privilege-escalation drift (audit-event vs gate disagreeing on membership).
const { CANONICAL_AGENTS } = require('./_lib/canonical-agents');

/**
 * R-RV-DIMS-CAPTURE (v2.1.17): peek at a `_spawn_staging` entry to recover
 * `review_dimensions` for reviewer agent_start events.
 *
 * The PreToolUse:Agent hook (`collect-context-telemetry.js pre-spawn`) parses
 * the delegation prompt's `## Dimensions to Apply` block and stages the result
 * keyed by `tool_use_id` (or a synthetic spawn-* key when no id is present).
 * The SubagentStart payload does NOT carry `tool_use_id` — Claude Code does
 * not include it on SubagentStart per platform-oracle review (v2.1.17 W9).
 * Without a payload-side correlation key, the emitter must peek at the
 * cache by reviewer order.
 *
 * v2.1.17 W9-fix F-004 — race-window fix:
 *   1. Filter to reviewer-typed staging entries only.
 *   2. Drop entries older than RECENT_TTL_MS (5 s — well under any plausible
 *      pre→start gap, but tight enough to bound cross-spawn leakage during
 *      back-to-back reviewer spawns).
 *   3. Pick the OLDEST reviewer entry (FIFO). PreToolUse fires in spawn-
 *      submission order, so reviewer A (staged first) corresponds to the
 *      first SubagentStart, reviewer B (staged later) to the second. Picking
 *      the oldest means each SubagentStart sees the right entry. (We do NOT
 *      delete here — `collect-context-telemetry.js start` is the consumer.
 *      v2.1.17 W11-fix F-W11-01 brought the consume side into agreement with
 *      this peek by mirroring the same FIFO order, the same 5 s TTL drop,
 *      and a reviewer-typed candidate filter that prevents a reviewer
 *      SubagentStart from consuming an interleaved non-reviewer entry.)
 *
 * Returns: "all" | string[] | null
 *
 * Reviewer-only contract: the caller must already have agent_type=reviewer.
 * Fail-open: any read error returns null. Never throws.
 *
 * @param {string} cwd
 * @returns {"all" | string[] | null}
 */
const RECENT_TTL_MS = 5000;

function peekStagedReviewDimensions(cwd) {
  try {
    const cache = readCache(cwd);
    const staging = cache && cache._spawn_staging;
    if (!staging || typeof staging !== 'object') return null;
    // Find the OLDEST reviewer entry that hasn't gone stale.
    const now = Date.now();
    let oldest = null;
    let oldestTime = Infinity;
    for (const v of Object.values(staging)) {
      if (!v || typeof v !== 'object') continue;
      // Reviewer-only: skip non-reviewer spawns. Prevents cross-spawn leakage
      // when a non-reviewer spawn runs interleaved with reviewers.
      if (v.agent_type && v.agent_type !== 'reviewer') continue;
      const t = v.staged_at ? Date.parse(v.staged_at) : 0;
      if (!Number.isFinite(t) || t === 0) continue;
      // Skip stale entries — bounds the cross-spawn race window.
      if ((now - t) > RECENT_TTL_MS) continue;
      if (t < oldestTime) {
        oldestTime = t;
        oldest = v;
      }
    }
    if (!oldest) return null;
    const v = oldest.review_dimensions;
    if (v === 'all') return 'all';
    if (Array.isArray(v) && v.length > 0) return v;
    return null;
  } catch (_e) {
    return null;
  }
}

writeAuditEvent({
  type: 'agent_start',
  extraFieldsPicker: (payload) => {
    // R-RV-DIMS-CAPTURE (v2.1.17): schema bumped to v2 to advertise the
    // optional `review_dimensions` field. The bump is additive — pre-v2
    // consumers ignore the new field per R-EVENT-NAMING.
    const fields = {
      version: 2,
      agent_id: payload.agent_id || null,
      agent_type: payload.agent_type || null,
      session_id: payload.session_id || null,
    };
    // Optional, reviewer-only field. Pulled from the PreToolUse staging
    // cache (the SubagentStart payload does not carry the prompt body).
    if (fields.agent_type === 'reviewer') {
      const cwd = resolveSafeCwd(payload.cwd);
      const dims = peekStagedReviewDimensions(cwd);
      if (dims !== null) fields.review_dimensions = dims;
    }
    return fields;
  },
  additionalEventsPicker: (payload, ctx) => {
    // Emit dynamic_agent_spawn for any non-canonical agent_type so the
    // specialist registry can be measured. event-schemas.md defines the type;
    // pre-v2.0.21 it was never emitted because no detection wired up.
    const at = payload.agent_type || null;
    if (!at || CANONICAL_AGENTS.has(at)) return [];
    return [{
      timestamp:        ctx.baseTimestamp,
      type:             'dynamic_agent_spawn',
      orchestration_id: ctx.orchestrationId,
      agent_id:         payload.agent_id || null,
      agent_type:       at,
      session_id:       payload.session_id || null,
      paired_with:      'agent_start',
    }];
  },
});
