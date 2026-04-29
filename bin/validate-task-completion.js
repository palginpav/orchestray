#!/usr/bin/env node
'use strict';

/**
 * validate-task-completion.js — TaskCompleted hook.
 *
 * v2.1.9 Bundle B1 / Intervention I-12 (pre-done checklist T15).
 *
 * Two responsibilities:
 *
 * 1. LEGACY (Agent Teams): block TaskCompleted events missing `task_id` or
 *    `task_subject`. Preserved from v2.0.x for team-mode orchestrations.
 *
 * 2. NEW (T15 pre-done): if the payload includes a `structured_result`
 *    (Structured Result block from the agent's response) AND the spawning
 *    agent role is known, validate the required sections.
 *
 *    Hard-tier agents (exit 2 on violation):
 *      developer, architect, reviewer, refactorer, tester, release-manager, documenter
 *
 *    Warn-tier agents (exit 0 + warn event on violation):
 *      researcher, debugger, inventor, security-engineer, ux-critic, platform-oracle
 *
 *    Required sections in Structured Result:
 *      - status         (one of success | partial | failure)
 *      - summary        (non-empty string)
 *      - files_changed  (array, may be empty)
 *      - files_read     (array, may be empty)
 *      - issues         (array, may be empty)
 *
 * Contract:
 *   - Always emit a JSON continuation payload.
 *   - Fail-open on any unexpected error (block only on the specific rule).
 */

const fs = require('fs');
const path = require('path');
const { writeEvent } = require('./_lib/audit-event-writer');
// v2.2.9 B-2.1: per-role schema map (16/38 W2 findings collapse here).
const { validateRoleSchema, isRoleHardDisabled } = require('./_lib/role-schemas');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');
const { loadHandoffBodyCapConfig } = require('./_lib/config-schema');
// v2.2.11 W2-4: cross-field invariant checker (R1/R2/R3 per handoff-contract.md §2).
const { validateCrossField } = require('./_lib/t15-cross-field');
// v2.2.2 Fix #7: REQUIRED_SECTIONS shares its source with the C2 hook's
// HANDOFF_CONTRACT_SUFFIX so the agent-side prompt and the hook-side
// enforcement can never drift apart.
const { HANDOFF_REQUIRED_SECTIONS } = require('./_lib/handoff-contract-text');

// ---------------------------------------------------------------------------
// R-DX2 (v2.1.11): Artifact-path fields and placeholder rejection
// ---------------------------------------------------------------------------

// Top-level fields in Structured Result that must point to real files on disk.
// When any of these fields contains a placeholder value, the hook rejects.
const ARTIFACT_PATH_FIELDS = [
  'findings_path',
  'design_artifact',
  'diagnosis_artifact',
  'artifact',
  'artifact_location',
  'report_path',
  'output_path',
  'doc_paths',
  'prototype_location',
];

// P2.2 (v2.2.0): read-only contract enforcement for the haiku-scout agent
// (and any future read-only-tier agent). Per
// `~/.claude/projects/-home-palgin-orchestray/memory/feedback_explore_agent_readonly.md`:
// tool drift on read-only roles must be observable. The forbidden-tool set
// enforces the frontmatter `tools:` whitelist at runtime — three-layer
// defense: (a) frontmatter declarative, (b) THIS rejection, (c) the
// `bin/__tests__/p22-scout-whitelist-frozen.test.js` byte-equality check.
//
// P3.3 (v2.2.0): adds `orchestray-housekeeper` with a STRICTER forbidden set
// that includes `Grep`. Scout permits Grep; housekeeper does NOT. Per Clause 1
// of the locked-scope D-5 hardening contract. The literal `SCOUT_FORBIDDEN_TOOLS
// = new Set([...])` declaration is preserved (rather than aliased through the
// per-agent map) so the p22 frozen-baseline byte-equality test continues to
// regex-match the source.
const SCOUT_FORBIDDEN_TOOLS = new Set(['Edit', 'Write', 'Bash']);
const HOUSEKEEPER_FORBIDDEN_TOOLS = new Set(['Edit', 'Write', 'Bash', 'Grep']);
const READ_ONLY_AGENT_FORBIDDEN_TOOLS = {
  'haiku-scout':            SCOUT_FORBIDDEN_TOOLS,
  'orchestray-housekeeper': HOUSEKEEPER_FORBIDDEN_TOOLS,
};
const READ_ONLY_AGENTS = new Set(Object.keys(READ_ONLY_AGENT_FORBIDDEN_TOOLS));

// Patterns that indicate the agent returned a placeholder instead of a real path.
const PLACEHOLDER_PATTERNS = [
  /^none\b/i,
  /returned as/i,
  /\binline\b/i,
  /^not written/i,
  /^n\/?a$/i,
  /^skipped\b/i,
];

/**
 * Returns true if the value looks like a file path (contains '/' or a known
 * file extension). Used to skip the placeholder heuristics for real paths that
 * may contain placeholder-like substrings (e.g. "anonymize-none.md").
 * AC-05 false-positive protection.
 */
function looksLikePath(v) {
  return typeof v === 'string' && (v.includes('/') || /\.(md|json|jsonl|txt|yaml|yml)$/i.test(v));
}

/**
 * Validate artifact-path fields in a Structured Result.
 *
 * @param {object} structuredResult
 * @param {string} projectRoot
 * @returns {{ rejected: boolean, field?: string, value?: string, reason?: string }}
 */
function validateArtifactPaths(structuredResult, projectRoot) {
  if (!structuredResult || typeof structuredResult !== 'object') return { rejected: false };

  for (const field of ARTIFACT_PATH_FIELDS) {
    if (!(field in structuredResult)) continue;
    let values = structuredResult[field];
    if (values == null) continue;
    if (!Array.isArray(values)) values = [values];

    for (const v of values) {
      if (typeof v !== 'string' || !v.trim()) continue;

      const trimmed = v.trim();

      // AC-05 false-positive protection: if the value looks like a real file path
      // (contains '/' or has a known extension), skip the placeholder heuristics
      // and go straight to file-existence verification.
      if (!looksLikePath(trimmed)) {
        for (const pat of PLACEHOLDER_PATTERNS) {
          if (pat.test(trimmed)) {
            return { rejected: true, field, value: v, reason: 'matches placeholder pattern ' + pat };
          }
        }
        // Non-path, non-placeholder: skip (not a file reference).
        continue;
      }

      // File-existence verification (symlink-escape guard via realpathSync).
      try {
        const resolved = fs.realpathSync(path.resolve(projectRoot, trimmed));
        const rel = path.relative(projectRoot, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return { rejected: true, field, value: v, reason: 'path outside project root: ' + resolved };
        }
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          return { rejected: true, field, value: v, reason: 'not a regular file: ' + resolved };
        }
      } catch (e) {
        return { rejected: true, field, value: v, reason: 'path does not resolve on disk: ' + e.message };
      }
    }
  }
  return { rejected: false };
}

// ---------------------------------------------------------------------------
// R1 AC-05 (v2.1.11): Audit event schema validation
// ---------------------------------------------------------------------------

// Known event types extracted from agents/pm-reference/event-schemas.md §Summary Index.
// This list is the allowlist — unknown event types are rejected (exit 2).
// Honor ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1 kill switch (skip validation if set).
const KNOWN_EVENT_TYPES = new Set([
  'routing_outcome',
  'agent_start',
  'agent_stop',
  'task_created',
  'task_completed',
  'task_validation_failed',
  'teammate_idle',
  'pattern_skip_enriched',
  'auto_extract_quarantine_skipped',
  'routing_decision',
  'invariant_extracted',
  'introspection_trace',
  'confidence_signal',
  'visual_review',
  'consequence_forecast',
  'drift_check',
  'resilience_block_triggered',
  'resilience_block_suppressed',
  'resilience_block_suppressed_inactive',
  'state_cancel_aborted',
  'mcp_checkpoint_missing',
  'kill_switch_activated',
  'kill_switch_deactivated',
  'model_auto_resolved',
  'pre_compact_archive',
  'cite_cache_hit',
  'spec_sketch_generated',
  'repo_map_delta_injected',
  // Additional types from the full schema body:
  'pattern_collision_resolved',
  'pre_done_checklist_failed',
  'pre_done_checklist_warn',
  'task_completion_warn',
  'dynamic_agent_spawn',
  'specialist_saved',
  'specialist_promoted',
  'specialist_reused',
  'pattern_pruned',
  'contract_check',
  'orchestration_roi',
  'disagreement_surfaced',
  'fts5_fallback',
  'thread_created',
  'thread_matched',
  'thread_updated',
  'persona_generated',
  'persona_injected',
  'probe_created',
  'probe_validated',
  'replay_analysis',
  'mcp_checkpoint_recorded',
  'pattern_record_skipped',
  'anti_pattern_advisory_shown',
  'pause_sentinel_detected',
  'cancel_sentinel_detected',
  'state_gc_run',
  'state_gc_discarded',
  'redo_requested',
  'config_key_stripped',
  'orchestration_start',
  'orchestration_complete',
  'degraded_journal_entry',
  'pattern_index_rebuilt',
  'pattern_index_build_failed',
  'scorer_structural_result',
  // R-HCAP (v2.1.14): handoff body cap events
  'handoff_body_warn',
  'handoff_body_block',
  // P2.2 (v2.2.0): Haiku scout audit events
  'scout_spawn',
  'scout_forbidden_tool_blocked',
  'scout_files_changed_blocked',
  // P3.3 (v2.2.0): Background-housekeeper Haiku audit events
  'housekeeper_action',
  'housekeeper_drift_detected',
  'housekeeper_forbidden_tool_blocked',
  'housekeeper_baseline_missing',
  // S-008 (v2.2.0 fix-pass): verify_fix_* trigger events for the P3.1
  // audit-round archive. Without these rows in the allowlist, the
  // schema-emit validator rejected them as unknown — silently disabling
  // P3.1 in default installs.
  'verify_fix_start',
  'verify_fix_pass',
  'verify_fix_fail',
  'verify_fix_oscillation',
]);

/**
 * Validate the event type in an audit event payload.
 * Returns { rejected: true, reason } if the type is unknown, else { rejected: false }.
 *
 * @param {object} event - The parsed hook event.
 * @returns {{ rejected: boolean, reason?: string }}
 */
function validateAuditEventType(event) {
  // Kill switch: if set, skip validation (legacy behavior).
  if (process.env.ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD === '1') return { rejected: false };

  // Only validate events that have a 'type' field (audit events).
  const eventType = event && event.type;
  if (typeof eventType !== 'string' || !eventType) return { rejected: false };

  if (!KNOWN_EVENT_TYPES.has(eventType)) {
    return {
      rejected: true,
      reason: 'event type "' + eventType + '" not in event-schemas.md allowlist. ' +
        'Either add it to the schema or use an approved event type. ' +
        'See agents/pm-reference/event-schemas.md.',
    };
  }
  return { rejected: false };
}

// ---------------------------------------------------------------------------
// v2.1.9 I-12 agent tiers (§5 I-12 tier table).
// ---------------------------------------------------------------------------

// v2.2.9 B-2.1: 6 prior warn-tier roles (researcher, debugger, inventor,
// security-engineer, ux-critic, platform-oracle) promoted to hard-tier.
// Per-role kill switches (`ORCHESTRAY_T15_<ROLE>_HARD_DISABLED=1`) demote a
// single role back to warn behavior for emergency pinning. No grace flag.
const HARD_TIER = new Set([
  'developer',
  'architect',
  'reviewer',
  'refactorer',
  'tester',
  'release-manager',
  'documenter',
  'researcher',
  'debugger',
  'inventor',
  'security-engineer',
  'ux-critic',
  'platform-oracle',
  'project-intent',
]);
const WARN_TIER = new Set([]);

// Per v2.1.9 design-spec §5 I-12 item (c): `assumptions` is required even when
// empty — the section must appear in every Structured Result so downstream
// consumers can distinguish "no assumptions made" from "assumptions omitted".
//
// v2.2.2 Fix #7: sourced from bin/_lib/handoff-contract-text.js so the
// agent-prompt suffix (HANDOFF_CONTRACT_SUFFIX) and this hook-side enforcement
// list cannot drift apart. Edit there, not here.
const REQUIRED_SECTIONS = HANDOFF_REQUIRED_SECTIONS;

/**
 * Try several strategies to extract a Structured Result JSON object from the
 * hook payload. Returns null if none is present/parseable.
 *
 * @param {object} event
 * @returns {object|null}
 */
/**
 * v2.2.9 B-5.1 — escalation-hint detector.
 *
 * Scans the agent's transcript text for "TODO escalate to <role>" /
 * "needs <role> review" / "should be reviewed by <role>" / "follow-up:
 * <role>" patterns. When detected, signals that the agent identified a
 * follow-up task requiring another specialist but did NOT call
 * `mcp__orchestray__spawn_agent` to escalate.
 *
 * Returns the highest-confidence match: { regex_match, suggested_agent }
 * or null.
 *
 * Kill switch: ORCHESTRAY_SPAWN_ESCALATION_HINT_TRACK_DISABLED=1.
 *
 * @param {string|null} rawText - The agent's full output transcript.
 * @param {object|null} structuredResult
 * @returns {{ regex_match: string, suggested_agent: string }|null}
 */
const ESCALATION_AGENT_ROLES = [
  'reviewer', 'architect', 'security-engineer', 'tester', 'documenter',
  'debugger', 'refactorer', 'developer', 'researcher', 'inventor',
  'ux-critic', 'platform-oracle', 'release-manager',
];

function detectEscalationHint(rawText, structuredResult) {
  if (process.env.ORCHESTRAY_SPAWN_ESCALATION_HINT_TRACK_DISABLED === '1') return null;

  // Prefer structuredResult.summary + .issues[].description for narrow scan.
  const haystacks = [];
  if (structuredResult && typeof structuredResult === 'object') {
    if (typeof structuredResult.summary === 'string') haystacks.push(structuredResult.summary);
    if (Array.isArray(structuredResult.issues)) {
      for (const iss of structuredResult.issues) {
        if (iss && typeof iss === 'object') {
          if (typeof iss.description === 'string') haystacks.push(iss.description);
          if (typeof iss.recommendation === 'string') haystacks.push(iss.recommendation);
        }
      }
    }
    if (Array.isArray(structuredResult.recommendations)) {
      for (const r of structuredResult.recommendations) {
        if (typeof r === 'string') haystacks.push(r);
      }
    }
  }
  if (typeof rawText === 'string' && rawText) {
    // Last 8 KB of raw text — escalation hints are usually near the end.
    haystacks.push(rawText.slice(-8192));
  }

  if (haystacks.length === 0) return null;

  // Patterns (ordered by specificity — first match wins).
  const ROLE_RE = new RegExp(
    '(' + ESCALATION_AGENT_ROLES.map(r => r.replace(/-/g, '\\-')).join('|') + ')',
    'i'
  );
  const PATTERNS = [
    new RegExp('TODO[: ]\\s*escalate\\s+to\\s+' + ROLE_RE.source, 'i'),
    new RegExp('escalat\\w*\\s+to\\s+' + ROLE_RE.source, 'i'),
    new RegExp('needs?\\s+' + ROLE_RE.source + '\\s+(review|audit|inspection)', 'i'),
    new RegExp('should\\s+be\\s+(reviewed|audited|inspected)\\s+by\\s+' + ROLE_RE.source, 'i'),
    new RegExp('follow[- ]up\\s*:\\s*(spawn\\s+)?' + ROLE_RE.source, 'i'),
    new RegExp('hand\\s+off\\s+to\\s+' + ROLE_RE.source, 'i'),
  ];

  for (const text of haystacks) {
    for (const re of PATTERNS) {
      const m = text.match(re);
      if (m) {
        // Find the role group — different patterns put it in different positions.
        let suggestedAgent = null;
        for (let i = 1; i < m.length; i++) {
          if (m[i] && ESCALATION_AGENT_ROLES.indexOf(m[i].toLowerCase()) !== -1) {
            suggestedAgent = m[i].toLowerCase();
            break;
          }
        }
        if (!suggestedAgent) continue;
        return {
          regex_match: m[0].slice(0, 200),
          suggested_agent: suggestedAgent,
        };
      }
    }
  }
  return null;
}

function extractStructuredResult(event) {
  if (!event) return null;

  // Direct object on payload.
  if (event.structured_result && typeof event.structured_result === 'object') {
    return event.structured_result;
  }

  // Flat object on agent_output_json / result (some variants).
  const direct = event.agent_output_json || event.result_json;
  if (direct && typeof direct === 'object') return direct;

  // Try to find the ```json block under "## Structured Result" in the raw text.
  const raw = [event.result, event.output, event.agent_output]
    .find(v => typeof v === 'string' && v.length > 0);
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Restrict scan to the last 64 KB of the output.
  const tail = raw.slice(-65536);
  const re = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = tail.match(re);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch (_) {
      // fall through to next strategy
    }
  }

  // Last resort: bare `{"status":...}` JSON block at end of output.
  const braceIdx = tail.lastIndexOf('{"status"');
  if (braceIdx !== -1) {
    const candidate = tail.slice(braceIdx);
    // Find the last balanced closing brace.
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx !== -1) {
      try {
        return JSON.parse(candidate.slice(0, endIdx + 1));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

/**
 * Validate a Structured Result against the T15 checklist.
 *
 * @param {object} result
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validateStructuredResult(result) {
  if (!result || typeof result !== 'object') {
    return { valid: false, missing: REQUIRED_SECTIONS.slice() };
  }
  const missing = [];
  for (const key of REQUIRED_SECTIONS) {
    if (!(key in result)) {
      missing.push(key);
      continue;
    }
    const val = result[key];
    if (key === 'summary') {
      if (typeof val !== 'string' || val.trim().length === 0) missing.push(key);
    } else if (key === 'status') {
      if (typeof val !== 'string' || val.trim().length === 0) missing.push(key);
    } else {
      // files_changed / files_read / issues must be arrays (empty allowed).
      if (!Array.isArray(val)) missing.push(key);
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Identify the agent role from the hook payload. Checks multiple keys because
 * Claude Code's TaskCompleted schema has varied across versions.
 *
 * @param {object} event
 * @returns {string|null}
 */
function identifyAgentRole(event) {
  if (!event) return null;
  // NOTE: teammate_name is deliberately excluded — in Agent-Teams mode it is
  // an operator-chosen label, not a subagent role, and conflating the two
  // causes the T15 gate to fire on well-formed team TaskCompleted events.
  const candidates = [
    event.subagent_type,
    event.agent_type,
    event.agent_role,
    event.role,
    event.agent && event.agent.type,
    event.tool_input && event.tool_input.subagent_type,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      // S-001 (v2.2.0 fix-pass): trim whitespace AND strip embedded NUL/zero-width
      // bytes so a near-equivalent like 'haiku-scout ' or 'haiku-scout '
      // does not silently bypass READ_ONLY_AGENTS strict-equality Set membership.
      // Defensive against future Claude Code payload-shape changes (CWE-178).
      // S-001 (v2.2.0 fix-pass round 2): NFKC-normalize first, then strip
      //   - \s             ASCII whitespace (incl. tab, LF, CR, FF, VT, space),
      //   - \x00-\x1F      ASCII control bytes including NUL,
      //   - \u00A0         non-breaking space,
      //   - \u200B-\u200F  zero-width chars + LRM/RLM,
      //   - \u202A-\u202E  bidi override controls,
      //   - \u2060-\u206F  word joiner / invisible-times family,
      //   - \uFEFF         BOM / ZWNBSP.
      // The earlier `replace(/\x00/g, '').trim()` only stripped ASCII NUL
      // and the comment overstated coverage (CWE-178). This is what the
      // comment promised: defence-in-depth against future Claude Code
      // payload-shape changes that might pad subagent_type with
      // mojibake-friendly invisibles.
      return c
        .normalize('NFKC')
        .replace(/[\s\x00-\x1F\u00A0\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
        .toLowerCase();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// P2.2 (v2.2.0): read-only contract helpers for haiku-scout
// ---------------------------------------------------------------------------

/**
 * Walk the event's `tool_calls` array (when present) and return any tool
 * names that are in the forbidden set. Tolerant to varied payload shapes.
 *
 * @param {Array} transcriptToolCalls
 * @param {Set<string>} forbiddenSet
 * @returns {string[]} Forbidden tool names found, in transcript order. Empty
 *                     when none found (including when input is missing).
 */
function findForbiddenToolCalls(transcriptToolCalls, forbiddenSet) {
  const found = [];
  if (!Array.isArray(transcriptToolCalls)) return found;
  for (const tc of transcriptToolCalls) {
    if (!tc) continue;
    // Tolerate {name}, {tool_name}, {type, name} shapes.
    const name = (typeof tc === 'string' ? tc : (tc.name || tc.tool_name || ''));
    if (typeof name === 'string' && name && forbiddenSet.has(name)) {
      found.push(name);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// R-HCAP (v2.1.14): Artifact body-size cap validation
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a string using the 4-bytes-per-token heuristic
 * (per W2 internal-token-profile conventions).
 *
 * @param {string} content
 * @returns {number}
 */
function estimateTokens(content) {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 4);
}

/**
 * Artifact-path fields that should be measured for body size.
 * Includes all fields from ARTIFACT_PATH_FIELDS plus detail_artifact itself.
 */
const BODY_SIZE_FIELDS = ARTIFACT_PATH_FIELDS.concat(['detail_artifact']);

/**
 * Check artifact body sizes in a Structured Result against the handoff_body_cap
 * config thresholds.
 *
 * Returns an array of check results, one per artifact file found (empty if
 * body-cap is disabled or no artifact paths are present).
 *
 * @param {object} structuredResult
 * @param {string} projectRoot
 * @param {object} capConfig - As returned by loadHandoffBodyCapConfig()
 * @returns {Array<{file: string, body_tokens: number, has_detail_artifact: boolean, action: 'pass'|'warn'|'block_would_have_fired'|'block'}>}
 */
function checkArtifactBodySizes(structuredResult, projectRoot, capConfig) {
  if (!capConfig.enabled) return [];
  if (!structuredResult || typeof structuredResult !== 'object') return [];

  const hasDetailArtifact = typeof structuredResult.detail_artifact === 'string' &&
    structuredResult.detail_artifact.trim().length > 0;

  const results = [];

  for (const field of BODY_SIZE_FIELDS) {
    // detail_artifact itself is the overflow pointer — don't measure it for size
    // (it's small by definition). Only measure the primary artifact fields.
    if (field === 'detail_artifact') continue;
    if (!(field in structuredResult)) continue;

    let values = structuredResult[field];
    if (values == null) continue;
    if (!Array.isArray(values)) values = [values];

    for (const v of values) {
      if (typeof v !== 'string' || !v.trim()) continue;
      if (!looksLikePath(v.trim())) continue;

      // Try to read the file — wrap in try/catch (non-fatal per contract).
      let content;
      try {
        const resolved = path.resolve(projectRoot, v.trim());
        content = fs.readFileSync(resolved, 'utf8');
      } catch (_) {
        // Missing or unreadable file: not a block trigger per spec.
        continue;
      }

      const bodyTokens = estimateTokens(content);
      let action;

      if (bodyTokens <= capConfig.warn_tokens) {
        action = 'pass';
      } else if (bodyTokens <= capConfig.block_tokens) {
        // 2,501 – 5,000: always warn
        action = 'warn';
      } else {
        // > 5,000
        if (hasDetailArtifact) {
          // detail_artifact present: warn only
          action = 'warn';
        } else if (capConfig.hard_block) {
          action = 'block';
        } else {
          action = 'block_would_have_fired';
        }
      }

      results.push({ file: v.trim(), body_tokens: bodyTokens, has_detail_artifact: hasDetailArtifact, action });
    }
  }

  return results;
}

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return orchData.orchestration_id || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (err) {
    // DEF-10 semantics: stderr MUST report audit-write failures so operators
    // can distinguish "rejected cleanly" from "rejected but audit trail
    // broken". Also journal the degradation for offline analysis.
    process.stderr.write('[orchestray] validate-task-completion: audit write failed: ' + err.message + '\n');
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-task-completion', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) { /* last-resort */ }
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] validate-task-completion: stdin exceeded cap; fail-open\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    // Empty stdin: fail-open (historical behavior — some hook runners send
    // no payload in smoke tests). Invalid JSON: same.
    if (input.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    let event = {};
    try {
      event = JSON.parse(input);
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Accepted wiring: TaskCompleted (Agent Teams) and SubagentStop (normal
    // single-subagent orchestrations). Any other event name is a pass-through.
    // v2.1.9 design-spec §5 I-12 requires the T15 gate on SubagentStop so
    // normal orchestrations (not just Agent Teams) are covered.
    const hookEvent = event.hook_event_name || null;
    if (hookEvent && hookEvent !== 'TaskCompleted' && hookEvent !== 'SubagentStop') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    const isSubagentStop = hookEvent === 'SubagentStop';

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); }
    catch (_) { cwd = process.cwd(); }

    // ── Legacy Agent Teams gate (v2.0.x preserved).
    //
    // Historical behavior: TaskCompleted events that look like Agent-Teams
    // events but lack `task_id` or `task_subject` are rejected with exit 2
    // because those fields are mandatory for team-mode task accounting. The
    // v2.1.9 T15 checklist is additive, not replacement.
    //
    // An event is classified as an Agent-Teams event when ANY of these
    // signals fire:
    //   - a team-flavored key is present (task_id, task_subject,
    //     teammate_name, team_name, task_description)
    //   - the payload explicitly sets hook_event_name to TaskCompleted AND
    //     does NOT carry a subagent_type/output that identifies it as a
    //     v2.1.9 T15 single-agent completion event (the new path).
    //
    // Non-team payloads (subagent_type + output, typical of direct
    // SubagentStop replays used in T15 tests) fall through to the T15 block.
    const teamFlavoredKeys = ['task_id', 'task_subject', 'teammate_name', 'team_name', 'task_description'];
    const hasTeamKeys = teamFlavoredKeys.some(k => k in event);
    const hasT15Signals = !!(event.subagent_type || event.agent_type || event.agent_role ||
      event.structured_result || typeof event.output === 'string');
    // Default to the legacy team-event gate whenever we lack clear T15
    // signals. This preserves "TaskCompleted requires task_id + task_subject"
    // contract for any payload shape callers have relied on since v2.0.x.
    // SubagentStop events are NEVER Agent-Teams events — skip the teams gate
    // entirely and go straight to T15 classification.
    const looksLikeTeamEvent = !isSubagentStop && (hasTeamKeys || !hasT15Signals);

    if (looksLikeTeamEvent && (!event.task_id || !event.task_subject)) {
      const reason = !event.task_id && !event.task_subject
        ? 'missing task_id and task_subject'
        : (!event.task_id ? 'missing task_id' : 'missing task_subject');
      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'task_validation_failed',
        hook: 'validate-task-completion',
        orchestration_id: resolveOrchestrationId(cwd),
        reason,
        payload_keys: Object.keys(event).sort(),
      });
      process.stderr.write(
        'Task completion rejected: ' + reason + '. ' +
        'Ensure task has proper identification before marking complete.\n'
      );
      process.exit(2);
    }

    // ── v2.1.9 T15 pre-done checklist (I-12).
    const agentRole = identifyAgentRole(event);
    const structuredResult = extractStructuredResult(event);

    // ── v2.2.9 B-5.1 — escalation-hint backstop.
    // Scan transcript for "TODO escalate to <role>" / "needs <role> review"
    // patterns when the agent is a write-capable specialist (developer,
    // refactorer, security-engineer). Emits `spawn_escalation_hint_seen`
    // when detected — non-blocking observability so operators see when an
    // agent surfaced a follow-up but did NOT call mcp__orchestray__spawn_agent.
    try {
      const ESCALATION_TARGETED = new Set(['developer', 'refactorer', 'security-engineer']);
      if (agentRole && ESCALATION_TARGETED.has(agentRole)) {
        const rawText = [event.result, event.output, event.agent_output]
          .find(v => typeof v === 'string' && v.length > 0) || '';
        const hint = detectEscalationHint(rawText, structuredResult);
        if (hint) {
          emitAuditEvent(cwd, {
            version: 1,
            timestamp: new Date().toISOString(),
            type: 'spawn_escalation_hint_seen',
            hook: 'validate-task-completion',
            orchestration_id: resolveOrchestrationId(cwd),
            requester_agent: agentRole,
            suggested_agent: hint.suggested_agent,
            regex_match: hint.regex_match,
            session_id: event.session_id || null,
          });
        }
      }
    } catch (_eh) { /* fail-open — observability never blocks */ }

    // ── P2.2 (v2.2.0): read-only contract enforcement for haiku-scout.
    // ── P3.3 (v2.2.0): same enforcement extended to orchestray-housekeeper
    //    with a STRICTER forbidden set (also rejects Grep). Per-agent map at
    //    READ_ONLY_AGENT_FORBIDDEN_TOOLS.
    // Runs BEFORE the structured-result section check so any forbidden tool
    // call short-circuits to exit 2 even when the Structured Result is
    // otherwise well-formed. Two distinct event types so analytics can
    // distinguish "wrote forbidden tool" from "lied about files_changed",
    // plus a housekeeper-specific tool-blocked event so promotion-gate
    // analytics can isolate housekeeper violations from scout violations.
    if (agentRole && READ_ONLY_AGENTS.has(agentRole)) {
      const forbiddenSet = READ_ONLY_AGENT_FORBIDDEN_TOOLS[agentRole];
      const forbidden = findForbiddenToolCalls(event.tool_calls, forbiddenSet);
      if (forbidden.length > 0) {
        const blockedEventType = agentRole === 'orchestray-housekeeper'
          ? 'housekeeper_forbidden_tool_blocked'
          : 'scout_forbidden_tool_blocked';
        emitAuditEvent(cwd, {
          version: 1,
          timestamp: new Date().toISOString(),
          type: blockedEventType,
          hook: 'validate-task-completion',
          orchestration_id: resolveOrchestrationId(cwd),
          agent_role: agentRole,
          forbidden_tools: forbidden,
          session_id: event.session_id || null,
        });
        const frozenHint = agentRole === 'orchestray-housekeeper'
          ? ' tools list is FROZEN at [Read, Glob].'
          : ' tools list (frozen).';
        process.stderr.write(
          '[orchestray] validate-task-completion: read-only contract violation: ' +
          agentRole + ' called forbidden tool(s) ' + forbidden.join(',') + '. ' +
          'See agents/' + agentRole + '.md' + frozenHint + '\n'
        );
        process.stdout.write(JSON.stringify({ continue: false, reason: 'scout_forbidden_tool:' + agentRole }) + '\n');
        process.exit(2);
      }
      // Non-empty files_changed is also a contract violation for read-only roles.
      const fc = (structuredResult && structuredResult.files_changed) || [];
      if (Array.isArray(fc) && fc.length > 0) {
        emitAuditEvent(cwd, {
          version: 1,
          timestamp: new Date().toISOString(),
          type: 'scout_files_changed_blocked',
          hook: 'validate-task-completion',
          orchestration_id: resolveOrchestrationId(cwd),
          agent_role: agentRole,
          files_changed: fc,
          session_id: event.session_id || null,
        });
        process.stderr.write(
          '[orchestray] validate-task-completion: ' + agentRole +
          ' returned non-empty files_changed (' + fc.length + ' entries). ' +
          'Read-only agents must always return [].\n'
        );
        process.stdout.write(JSON.stringify({ continue: false, reason: 'scout_files_changed:' + agentRole }) + '\n');
        process.exit(2);
      }
    }

    if (agentRole && (HARD_TIER.has(agentRole) || WARN_TIER.has(agentRole))) {
      const check = validateStructuredResult(structuredResult);
      if (!check.valid) {
        const isHard = HARD_TIER.has(agentRole);
        const auditRecord = {
          timestamp: new Date().toISOString(),
          type: isHard ? 'pre_done_checklist_failed' : 'task_completion_warn',
          hook: 'validate-task-completion',
          orchestration_id: resolveOrchestrationId(cwd),
          agent_role: agentRole,
          tier: isHard ? 'hard' : 'warn',
          missing_sections: check.missing,
          session_id: event.session_id || null,
        };
        emitAuditEvent(cwd, auditRecord);

        if (isHard) {
          // I-12 rollback path: PRE_DONE_ENFORCEMENT=warn downgrades hard-tier
          // block to warn-only exit(0). Design-spec §5 I-12 rollback plan.
          if (process.env.PRE_DONE_ENFORCEMENT === 'warn') {
            emitAuditEvent(cwd, {
              timestamp: new Date().toISOString(),
              type: 'pre_done_checklist_warn',
              hook: 'validate-task-completion',
              orchestration_id: resolveOrchestrationId(cwd),
              agent_role: agentRole,
              enforcement_mode: 'warn',
              missing_sections: check.missing,
              session_id: event.session_id || null,
            });
            process.stderr.write(
              '[orchestray] validate-task-completion: WARN (PRE_DONE_ENFORCEMENT=warn): ' +
              agentRole + ' missing ' + check.missing.join(', ') +
              ' — would block in enforcement mode.\n'
            );
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }
          process.stderr.write(
            'Pre-done checklist failed for ' + agentRole + ': Structured Result is missing ' +
            'required section(s): ' + check.missing.join(', ') + '.\n' +
            'See agents/pm-reference/agent-common-protocol.md for the schema.\n'
          );
          process.stdout.write(JSON.stringify({ continue: false, reason: 'pre_done_checklist_failed:' + agentRole }));
          process.exit(2);
        } else {
          process.stderr.write(
            '[orchestray] validate-task-completion: WARN — ' + agentRole +
            ' Structured Result missing: ' + check.missing.join(', ') + ' (warn-tier, not blocking).\n'
          );
        }
      }

      // v2.2.9 B-2.1: per-role schema validation (16/38 W2 findings collapse here).
      // Runs AFTER the generic-section check above so missing-section rejections take
      // precedence. Applies role-specific required fields, enums, regex, sections,
      // and `files_changed_implies` cross-checks from `bin/_lib/role-schemas.js`.
      if (agentRole && !isRoleHardDisabled(agentRole, process.env)) {
        const rawAgentText = [event.result, event.output, event.agent_output]
          .find(v => typeof v === 'string' && v.length > 0) || '';
        const violations = validateRoleSchema(agentRole, structuredResult, rawAgentText);
        if (violations.length > 0) {
          emitAuditEvent(cwd, {
            timestamp: new Date().toISOString(),
            type: 't15_role_schema_violation',
            hook: 'validate-task-completion',
            orchestration_id: resolveOrchestrationId(cwd),
            agent_role: agentRole,
            violations: violations.map(v => ({ field: v.field, reason: v.reason })),
            session_id: event.session_id || null,
          });
          process.stderr.write(
            '[orchestray] validate-task-completion: ROLE-SCHEMA violation for ' + agentRole + ':\n' +
            violations.map(v => '  - ' + v.field + ': ' + v.reason).join('\n') + '\n' +
            'See bin/_lib/role-schemas.js for the per-role contract.\n'
          );
          process.stdout.write(JSON.stringify({ continue: false, reason: 't15_role_schema_violation:' + agentRole }));
          process.exit(2);
        }
      }

      // v2.2.11 W2-4: cross-field invariant checks (R1/R2/R3).
      // Runs after per-role schema check so field-level failures take precedence.
      // Non-blocking observability: emits t15_role_schema_violation with
      // violation_kind:"cross_field" but does NOT exit 2 (fail-open per contract).
      if (structuredResult) {
        try {
          const cfResult = validateCrossField(structuredResult);
          if (!cfResult.valid && cfResult.violations.length > 0) {
            emitAuditEvent(cwd, {
              timestamp: new Date().toISOString(),
              type: 't15_role_schema_violation',
              violation_kind: 'cross_field',
              hook: 'validate-task-completion',
              orchestration_id: resolveOrchestrationId(cwd),
              agent_role: agentRole,
              violations: cfResult.violations.map(v => ({
                field: v.field,
                rule: v.rule,
                expected: v.expected,
                actual: v.actual,
              })),
              session_id: event.session_id || null,
            });
            process.stderr.write(
              '[orchestray] validate-task-completion: CROSS-FIELD violation for ' +
              (agentRole || 'unknown') + ':\n' +
              cfResult.violations.map(v => '  - ' + v.rule + ' (' + v.field + '): ' + v.actual).join('\n') + '\n' +
              'See agents/pm-reference/handoff-contract.md §2 for cross-field rules.\n'
            );
          }
        } catch (_cfErr) { /* fail-open — cross-field check must never block */ }
      }

      // R-DX2 (v2.1.11): Validate artifact-path fields to catch placeholder values.
      // This check runs after the structured-result section check so missing-section
      // rejections take precedence. Only validates when structured result is present.
      if (structuredResult) {
        const artifactCheck = validateArtifactPaths(structuredResult, cwd);
        if (artifactCheck.rejected) {
          const warnMode = process.env.ORCHESTRAY_ARTIFACT_PATH_ENFORCEMENT === 'warn';
          const stderrMsg =
            '[orchestray] T15 block: agent ' + (agentRole || 'unknown') +
            ' declared ' + artifactCheck.field + '="' + artifactCheck.value + '"' +
            ' but ' + artifactCheck.reason + '.' +
            ' The agent must write the artifact file and cite its real path.\n';
          process.stderr.write(stderrMsg);
          if (warnMode) {
            // Kill switch: emit warning but do not block.
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }
          process.stdout.write(JSON.stringify({ continue: false, reason: 'artifact_path_invalid:' + artifactCheck.field }));
          process.exit(2);
        }
      }
    }

    // R-HCAP (v2.1.14): Artifact body-size cap validation.
    // Runs after artifact-path validation so missing-file blocks take precedence.
    if (structuredResult) {
      try {
        const capConfig = loadHandoffBodyCapConfig(cwd);
        const sizeChecks = checkArtifactBodySizes(structuredResult, cwd, capConfig);
        const orchId = resolveOrchestrationId(cwd);
        const taskId = event.task_id || null;

        for (const check of sizeChecks) {
          if (check.action === 'pass') continue;

          if (check.action === 'block') {
            emitAuditEvent(cwd, {
              timestamp: new Date().toISOString(),
              type: 'handoff_body_block',
              orchestration_id: orchId,
              task_id: taskId,
              file: check.file,
              body_tokens: check.body_tokens,
              has_detail_artifact: check.has_detail_artifact,
              threshold_breached: 'block',
            });
            process.stderr.write(
              '[orchestray] T15 R-HCAP block: artifact "' + check.file + '" has ' +
              check.body_tokens + ' tokens (limit: ' + capConfig.block_tokens + ').\n' +
              'Remediation: split overflow content into a separate file and cite it via\n' +
              '  "detail_artifact": "<path>" in the Structured Result.\n' +
              'See agents/pm-reference/handoff-contract.md §10 for details.\n'
            );
            process.stdout.write(JSON.stringify({ continue: false, reason: 'handoff_body_cap_exceeded:' + check.file }));
            process.exit(2);
          }

          // action is 'warn' or 'block_would_have_fired'
          const thresholdBreached = check.action === 'block_would_have_fired'
            ? 'block_would_have_fired'
            : 'warn';
          emitAuditEvent(cwd, {
            timestamp: new Date().toISOString(),
            type: 'handoff_body_warn',
            orchestration_id: orchId,
            task_id: taskId,
            file: check.file,
            body_tokens: check.body_tokens,
            has_detail_artifact: check.has_detail_artifact,
            threshold_breached: thresholdBreached,
          });
          process.stderr.write(
            '[orchestray] T15 R-HCAP warn: artifact "' + check.file + '" has ' +
            check.body_tokens + ' tokens (warn_threshold: ' + capConfig.warn_tokens + ').' +
            (thresholdBreached === 'block_would_have_fired'
              ? ' hard_block is false — would have blocked in v2.1.15. Consider adding detail_artifact.'
              : '') +
            '\n'
          );
        }
      } catch (_hcapErr) {
        // Body-cap check must never block on unexpected error — fail-open.
      }
    }

    // R1 AC-05 (v2.1.11): Validate audit event type when event carries a 'type' field.
    // This covers SubagentStop events that embed an audit event in their payload.
    if (event.type) {
      const eventTypeCheck = validateAuditEventType(event);
      if (eventTypeCheck.rejected) {
        process.stderr.write(
          '[orchestray] validate-task-completion: audit event validator: ' + eventTypeCheck.reason + '\n'
        );
        // Exit 2 blocks the event. Kill switch: ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1 disables this check.
        process.stdout.write(JSON.stringify({ continue: false, reason: 'unknown_audit_event_type' }));
        process.exit(2);
      }
    }

    // ── Write the standard team-mode TaskCompleted audit row (preserved).
    if (event.task_id || event.task_subject || event.teammate_name) {
      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'task_completed',
        mode: 'teams',
        orchestration_id: resolveOrchestrationId(cwd),
        task_id: event.task_id || null,
        task_subject: event.task_subject || null,
        task_description: event.task_description || null,
        teammate_name: event.teammate_name || null,
        team_name: event.team_name || null,
        session_id: event.session_id || null,
      });
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  extractStructuredResult,
  validateStructuredResult,
  identifyAgentRole,
  validateArtifactPaths,
  validateAuditEventType,
  looksLikePath,
  ARTIFACT_PATH_FIELDS,
  PLACEHOLDER_PATTERNS,
  KNOWN_EVENT_TYPES,
  HARD_TIER,
  WARN_TIER,
  REQUIRED_SECTIONS,
  READ_ONLY_AGENTS,
  READ_ONLY_AGENT_FORBIDDEN_TOOLS,
  SCOUT_FORBIDDEN_TOOLS,
  // R-HCAP (v2.1.14): body-size cap exports
  estimateTokens,
  checkArtifactBodySizes,
  BODY_SIZE_FIELDS,
  // v2.2.9 B-5.1: escalation-hint detector
  detectEscalationHint,
  ESCALATION_AGENT_ROLES,
  // v2.2.11 W2-4: cross-field invariant checker
  validateCrossField,
};

if (require.main === module) {
  main();
}
