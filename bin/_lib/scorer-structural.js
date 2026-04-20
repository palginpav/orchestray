'use strict';

/**
 * scorer-structural.js — B4 Eval Layer 1: deterministic Structured Result scorer.
 *
 * Reads each agent's Structured Result from SubagentStop events and evaluates
 * a 6-item checklist. Returns a score (0.0–1.0) with failure details.
 *
 * This scorer does NOT call any LLM and does NOT replay the file system.
 * Zero model cost.
 *
 * Checklist:
 *   1. Structured Result block is parseable JSON.
 *   2. `status` ∈ { "success", "partial", "failure" }.
 *   3. `assumptions` array is present (non-empty required for hard-tier agents only).
 *   4. If files_changed.length > 0, then files_read.length > 0 (CRITIC evidence).
 *   5. If issues[] contains {severity:"error"}, then status !== "success".
 *   6. Rubric score block is present when spawning agent is architect or developer
 *      AND a design exists upstream (detected via prior agent_start events in the
 *      same orchestration_id in .orchestray/audit/events.jsonl).
 *
 * Hard-tier agents (non-empty assumptions required): architect, developer, reviewer.
 * Warn-tier agents (empty assumptions accepted): all others.
 *
 * @module scorer-structural
 */

const fs   = require('fs');
const path = require('path');

const SCORER_NAME    = 'structural';
const SCORER_VERSION = 1;

/** Agent roles that require non-empty assumptions (hard-tier). */
const HARD_TIER_AGENTS = new Set(['architect', 'developer', 'reviewer']);

/** Agent roles for which we check rubric score block. */
const RUBRIC_AGENTS = new Set(['architect', 'developer']);

const VALID_STATUSES = new Set(['success', 'partial', 'failure']);

// ---------------------------------------------------------------------------
// Structured Result extraction
// ---------------------------------------------------------------------------

/**
 * Extract the Structured Result JSON from an agent's last_assistant_message.
 * Looks for a ```json ... ``` block after "## Structured Result".
 *
 * @param {string} text
 * @returns {{ ok: true, result: object } | { ok: false, reason: string }}
 */
function extractStructuredResult(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, reason: 'no_text' };
  }

  // Find the ## Structured Result section first
  const srIdx = text.indexOf('## Structured Result');
  const searchText = srIdx >= 0 ? text.slice(srIdx) : text;

  // Find a JSON code block
  const jsonFenceRe = /```json\s*\n([\s\S]*?)\n```/;
  const match = searchText.match(jsonFenceRe);
  if (!match) {
    // Try without the language tag
    const plainFenceRe = /```\s*\n(\{[\s\S]*?\})\s*\n```/;
    const plainMatch = searchText.match(plainFenceRe);
    if (!plainMatch) {
      return { ok: false, reason: 'no_json_fence' };
    }
    try {
      return { ok: true, result: JSON.parse(plainMatch[1]) };
    } catch (_e) {
      return { ok: false, reason: 'parse_error:' + (_e.message || 'unknown').slice(0, 80) };
    }
  }

  try {
    return { ok: true, result: JSON.parse(match[1]) };
  } catch (_e) {
    return { ok: false, reason: 'parse_error:' + (_e.message || 'unknown').slice(0, 80) };
  }
}

// ---------------------------------------------------------------------------
// Upstream architect detection (for check 6)
// ---------------------------------------------------------------------------

/**
 * Check whether an architect agent_start event exists earlier in the same
 * orchestration's audit/events.jsonl, indicating a design exists upstream.
 *
 * Fail-open: if the file cannot be read, returns false (skips check 6).
 *
 * @param {string} projectRoot
 * @param {string} orchestrationId
 * @returns {boolean}
 */
function hasUpstreamArchitect(projectRoot, orchestrationId) {
  try {
    if (!orchestrationId || orchestrationId === 'unknown') return false;
    const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return false;
    const stat = fs.statSync(eventsPath);
    // Cap at 32 MB to avoid blocking on huge files
    if (stat.size > 32 * 1024 * 1024) return false;

    const content = fs.readFileSync(eventsPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line || !line.includes('"agent_start"') || !line.includes('architect')) continue;
      try {
        const ev = JSON.parse(line);
        if (
          ev.type === 'agent_start' &&
          ev.orchestration_id === orchestrationId &&
          (ev.agent_type === 'architect' || (typeof ev.agent_type === 'string' && ev.agent_type.includes('architect')))
        ) {
          return true;
        }
      } catch (_e) { /* skip malformed */ }
    }
    return false;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main scorer function
// ---------------------------------------------------------------------------

/**
 * Score a SubagentStop event deterministically against the 6-item checklist.
 *
 * @param {object} event - The SubagentStop hook event from Claude Code.
 * @param {{ projectRoot?: string }} [opts]
 * @returns {{ score: number, passed: number, total: number, failures: string[] }}
 */
function scoreStructural(event, opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || (event.cwd ? event.cwd : process.cwd());

  // Resolve orchestration_id from event or state file
  let orchestrationId = event.orchestration_id || 'unknown';
  if (orchestrationId === 'unknown') {
    try {
      const { getCurrentOrchestrationFile } = require('./orchestration-state');
      const orchFile = getCurrentOrchestrationFile(projectRoot);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) { /* best-effort */ }
  }

  const agentType = (event.agent_type || '').toLowerCase();
  const text = event.last_assistant_message || '';

  const failures = [];
  let total  = 0;
  let passed = 0;

  // ------------------------------------------------------------------
  // Check 1: Structured Result block parseable JSON
  // ------------------------------------------------------------------
  total++;
  const extracted = extractStructuredResult(text);
  if (!extracted.ok) {
    failures.push('check1_unparseable_structured_result:' + extracted.reason);
  } else {
    passed++;
  }

  // All subsequent checks depend on a parsed result
  const sr = extracted.ok ? extracted.result : null;

  // ------------------------------------------------------------------
  // Check 2: status ∈ { "success", "partial", "failure" }
  // ------------------------------------------------------------------
  total++;
  if (!sr) {
    failures.push('check2_status_missing:no_parsed_result');
  } else if (!VALID_STATUSES.has(sr.status)) {
    failures.push('check2_invalid_status:' + String(sr.status).slice(0, 30));
  } else {
    passed++;
  }

  // ------------------------------------------------------------------
  // Check 3: assumptions array present; non-empty for hard-tier
  // ------------------------------------------------------------------
  total++;
  if (!sr) {
    failures.push('check3_assumptions_missing:no_parsed_result');
  } else if (!Array.isArray(sr.assumptions)) {
    failures.push('check3_assumptions_not_array');
  } else {
    const isHardTier = HARD_TIER_AGENTS.has(agentType);
    if (isHardTier && sr.assumptions.length === 0) {
      failures.push('check3_assumptions_empty_hard_tier:' + agentType);
    } else {
      passed++;
    }
  }

  // ------------------------------------------------------------------
  // Check 4: if files_changed.length > 0 then files_read.length > 0
  // ------------------------------------------------------------------
  total++;
  if (!sr) {
    failures.push('check4_critic_evidence:no_parsed_result');
  } else {
    const changedLen = Array.isArray(sr.files_changed) ? sr.files_changed.length : 0;
    const readLen    = Array.isArray(sr.files_read)    ? sr.files_read.length    : 0;
    if (changedLen > 0 && readLen === 0) {
      failures.push('check4_files_changed_without_files_read:changed=' + changedLen);
    } else {
      passed++;
    }
  }

  // ------------------------------------------------------------------
  // Check 5: if issues[] has severity=error then status !== "success"
  // ------------------------------------------------------------------
  total++;
  if (!sr) {
    failures.push('check5_inconsistent_status:no_parsed_result');
  } else {
    const issues = Array.isArray(sr.issues) ? sr.issues : [];
    const hasErrorIssue = issues.some(
      (iss) => iss && (iss.severity === 'error' || iss.severity === 'critical')
    );
    if (hasErrorIssue && sr.status === 'success') {
      failures.push('check5_status_success_with_error_issues');
    } else {
      passed++;
    }
  }

  // ------------------------------------------------------------------
  // Check 6: rubric score block present when architect/developer AND
  //          upstream architect exists in this orchestration
  // ------------------------------------------------------------------
  total++;
  const needsRubric = RUBRIC_AGENTS.has(agentType);
  if (!needsRubric) {
    // Not applicable — skip automatically counts as passed
    passed++;
  } else {
    const upstreamArch = hasUpstreamArchitect(projectRoot, orchestrationId);
    if (!upstreamArch) {
      // No upstream design detected — skip this check
      passed++;
    } else {
      // Upstream design exists — require rubric_score block
      if (!sr) {
        failures.push('check6_rubric_score_missing:no_parsed_result');
      } else if (!sr.rubric_score && sr.rubric_score !== 0) {
        failures.push('check6_rubric_score_missing:field_absent');
      } else {
        passed++;
      }
    }
  }

  const score = total > 0 ? passed / total : 1.0;

  return {
    score: Math.round(score * 1000) / 1000,
    passed,
    total,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Metrics append helper
// ---------------------------------------------------------------------------

/**
 * Append structural_score to agent_metrics.jsonl.
 * Appends a dedicated structural_score row (row_type: 'structural_score').
 *
 * @param {string} projectRoot
 * @param {string} orchestrationId
 * @param {string|null} agentId
 * @param {string|null} agentType
 * @param {{ score: number, passed: number, total: number, failures: string[] }} scoreResult
 */
function appendStructuralScore(projectRoot, orchestrationId, agentId, agentType, scoreResult) {
  try {
    const { appendJsonlWithRotation } = require('./jsonl-rotate');
    const metricsDir  = path.join(projectRoot, '.orchestray', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    const metricsPath = path.join(metricsDir, 'agent_metrics.jsonl');

    const row = {
      row_type:         'structural_score',
      schema_version:   1,
      timestamp:        new Date().toISOString(),
      orchestration_id: orchestrationId,
      agent_id:         agentId || null,
      agent_type:       agentType || null,
      structural_score: scoreResult.score,
      checks_passed:    scoreResult.passed,
      checks_total:     scoreResult.total,
      failures:         scoreResult.failures,
    };

    appendJsonlWithRotation(metricsPath, row);
  } catch (_e) {
    // Fail-open: metrics write must never block hook processing
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  scoreStructural,
  appendStructuralScore,
  // Exported for tests
  _internal: {
    extractStructuredResult,
    hasUpstreamArchitect,
    HARD_TIER_AGENTS,
    RUBRIC_AGENTS,
    VALID_STATUSES,
  },
};
