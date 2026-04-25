#!/usr/bin/env node
'use strict';

/**
 * generate-handoff-delta.js — Delta-only re-delegation payload generator.
 *
 * Given a reviewer's findings (summary, issues[], diff), returns a lean
 * `{summary, issues[], diff}` payload for re-delegation to a developer agent.
 * Full artifact stays in the KB; downstream agents fetch on demand only when
 * one of the three deterministic fallback triggers fires.
 *
 * Implements R-DELTA-HANDOFF (v2.1.15, W5) and the P-DELTA-FALLBACK heuristic
 * from W4 Gap 2.
 *
 * Exports:
 *   generateDelta(findings, opts)  → delta payload object
 *   shouldFetchFull(ctx)           → { fetch: bool, reason: string|null }
 *   buildFallbackEvent(params)     → delta_handoff_fallback event object
 *
 * No npm dependencies — Node.js stdlib only.
 */

// ── Hedge phrases that trigger Rule 2 (hedged_summary) ───────────────────────
// Keep in sync with delegation-templates.md § Fallback: full-artifact fetch.
const HEDGE_PHRASES = [
  'see details',
  'additional context',
  'depends on',
  'may need',
  'recommend reviewing',
];

// ---------------------------------------------------------------------------
// generateDelta
// ---------------------------------------------------------------------------

/**
 * Build a delta re-delegation payload from reviewer findings.
 *
 * @param {object} findings
 * @param {string}   findings.summary   - Reviewer summary text.
 * @param {Array}    findings.issues    - Array of reviewer issue objects.
 * @param {string}   findings.diff      - Git diff string (max ~2000 tokens).
 * @param {object} opts
 * @param {string|null} opts.artifactPath - KB path for full artifact, or null.
 * @returns {{ summary: string, issues: Array, diff: string, detail_artifact?: string }}
 */
function generateDelta(findings, opts = {}) {
  const payload = {
    summary: findings.summary || '',
    issues: Array.isArray(findings.issues) ? findings.issues : [],
    diff: findings.diff || '',
  };

  // Attach the detail_artifact pointer only when a path is provided.
  // The downstream agent uses this to fetch on demand (never injected wholesale).
  if (opts.artifactPath != null) {
    payload.detail_artifact = opts.artifactPath;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// shouldFetchFull
// ---------------------------------------------------------------------------

/**
 * Determine whether the developer agent should fetch the full artifact instead
 * of using the delta payload.
 *
 * Implements the three deterministic trigger rules from P-DELTA-FALLBACK (Gap 2):
 *   Rule 1 (issue_gap)      — issues[] empty AND planned change touches a
 *                             file/symbol the summary does not name.
 *   Rule 2 (hedged_summary) — summary contains one of the HEDGE_PHRASES.
 *   Rule 3 (cross_orch_scope) — planned Edit/Write targets a file whose last
 *                               commit predates the current orchestration start.
 *
 * Kill switch: config.delta_handoff.force_full=true forces fetch with
 * reason="force_config", skipping all rule evaluation.
 *
 * @param {object} ctx
 * @param {Array}  ctx.issues               - Reviewer issues[].
 * @param {string} ctx.summary              - Reviewer summary text.
 * @param {Array}  ctx.plannedFiles         - Files the developer plans to touch.
 * @param {object} ctx.config               - Parsed .orchestray/config.json.
 * @param {object} [ctx.fileLastCommitDates]- Map of file → ISO 8601 commit date.
 * @param {string} [ctx.orchestrationStartedAt] - ISO 8601 start time of orch.
 * @returns {{ fetch: boolean, reason: string|null }}
 */
function shouldFetchFull(ctx) {
  const {
    issues = [],
    summary = '',
    plannedFiles = [],
    config = {},
    fileLastCommitDates = {},
    orchestrationStartedAt = null,
  } = ctx;

  const deltaCfg = (config && config.delta_handoff) || {};

  // Kill switch — force full fetch regardless of rules.
  if (deltaCfg.force_full === true) {
    return { fetch: true, reason: 'force_config' };
  }

  // Rule 2: hedged_summary — evaluated first because hedge phrases in the
  // summary render issues[] content unreliable regardless of other context.
  const lowerSummary = summary.toLowerCase();
  for (const phrase of HEDGE_PHRASES) {
    if (lowerSummary.includes(phrase)) {
      return { fetch: true, reason: 'hedged_summary' };
    }
  }

  // Rule 3: cross_orch_scope — evaluated before issue_gap because a file that
  // predates the orchestration is a stronger signal than an empty issues list.
  // Planned Edit/Write targets a file whose last commit predates orch start.
  if (orchestrationStartedAt && Object.keys(fileLastCommitDates).length > 0) {
    const orchDate = new Date(orchestrationStartedAt);
    for (const f of plannedFiles) {
      const commitDateStr = fileLastCommitDates[f];
      if (!commitDateStr) continue; // no date info → do not trigger
      const commitDate = new Date(commitDateStr);
      if (commitDate < orchDate) {
        return { fetch: true, reason: 'cross_orch_scope' };
      }
    }
  }

  // Rule 1: issue_gap — issues[] empty AND planned file not named in summary.
  if (Array.isArray(issues) && issues.length === 0 && plannedFiles.length > 0) {
    const allFilesNamedInSummary = plannedFiles.every((f) =>
      summary.includes(f)
    );
    if (!allFilesNamedInSummary) {
      return { fetch: true, reason: 'issue_gap' };
    }
  }

  return { fetch: false, reason: null };
}

// ---------------------------------------------------------------------------
// buildFallbackEvent
// ---------------------------------------------------------------------------

/**
 * Build a delta_handoff_fallback audit event object.
 *
 * @param {object} params
 * @param {boolean} params.fetched           - Whether the full artifact was fetched.
 * @param {string|undefined} params.reason   - Trigger reason, or undefined.
 * @param {string} params.orchestrationId    - Current orchestration ID.
 * @param {string} params.taskId             - Subtask ID.
 * @param {string} params.agentType          - Agent role (e.g. "developer").
 * @param {number} params.summaryChars       - Length of summary string in chars.
 * @param {string} params.detailArtifact     - KB path for full artifact.
 * @returns {object} Event object ready for JSONL emit.
 */
function buildFallbackEvent(params) {
  const {
    fetched,
    reason,
    orchestrationId,
    taskId,
    agentType,
    summaryChars,
    detailArtifact,
  } = params;

  const evt = {
    event_type: 'delta_handoff_fallback',
    version: 1,
    timestamp: new Date().toISOString(),
    orchestration_id: orchestrationId || 'unknown',
    task_id: taskId || 'unknown',
    agent_type: agentType || 'developer',
    fetched: Boolean(fetched),
    reason: fetched ? (reason || null) : null,
    summary_chars: typeof summaryChars === 'number' ? summaryChars : 0,
    detail_artifact: detailArtifact || null,
  };

  return evt;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  generateDelta,
  shouldFetchFull,
  buildFallbackEvent,
  // Expose hedge phrases for tests/documentation
  HEDGE_PHRASES,
};
