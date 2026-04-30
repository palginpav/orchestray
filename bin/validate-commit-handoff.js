#!/usr/bin/env node
'use strict';

/**
 * validate-commit-handoff.js — PostToolUse:Agent hook.
 *
 * v2.2.11 W2-10 / B4 fix (commit_handoff_validation_failed).
 * v2.2.15 FN-45: added exit-2 branch + 3-spawn soft-warn ramp when developer or
 * release-manager reports `status:success` AND head commit lacks `## Handoff`.
 *
 * Fires after a developer or release-manager agent stops. Parses the
 * structured-result from the agent's response and checks for required
 * commit-handoff metadata fields:
 *
 *   release-manager: commit_hash, branch, files_changed[].path
 *   developer:       files_changed[].path  (for every entry in the array)
 *
 * v2.2.15 FN-45 also enforces the `## Handoff` body subsection mandated by
 * agents/pm-reference/agent-common-protocol.md §Commit Message Discipline.
 * The check runs `git log -1 --format=%B HEAD` in the project cwd and looks
 * for a `## Handoff` heading. Soft-warn ramps for the first 3 missing-handoff
 * spawns per orchestration; the 4th hard-blocks at exit 2.
 *
 * Only activates when `files_changed.length > 0`. Emits one
 * `commit_handoff_validation_failed` event per missing structured-result field
 * AND a `commit_handoff_body_missing` event when the `## Handoff` block is
 * absent.
 *
 * Kill switches:
 *   - ORCHESTRAY_COMMIT_HANDOFF_CHECK_DISABLED=1 — full bypass (legacy).
 *   - ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED=1  — disables the FN-45 exit-2
 *     branch (event still fires for telemetry; falls back to warn-only).
 *
 * Contract:
 *   - Exit 0 when fields and `## Handoff` block are present, OR within ramp window.
 *   - Exit 2 once ramp window is exhausted and `## Handoff` is still missing.
 *   - Fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const { resolveSafeCwd }            = require('./_lib/resolve-project-cwd');
const { writeEvent }                = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }           = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// ---------------------------------------------------------------------------
// FN-45 — handoff-body soft-warn ramp threshold (per orch).
// ---------------------------------------------------------------------------
const HANDOFF_RAMP_DEFAULT = 3;

// Roles this validator watches.
const WATCHED_ROLES = new Set(['release-manager', 'developer']);

// Short-hash: 7–12 hex chars.
const COMMIT_HASH_RE = /^[0-9a-f]{7,12}$/;

// ---------------------------------------------------------------------------
// Structured-result extraction
// ---------------------------------------------------------------------------

/**
 * Extract the Structured Result JSON object from the PostToolUse:Agent
 * event payload.
 *
 * Claude Code delivers the agent's text response in:
 *   event.tool_response.output  (preferred)
 *   event.tool_response.text    (fallback)
 *
 * Looks for a ```json … ``` block after "## Structured Result".
 *
 * @param {object} event
 * @returns {object|null}
 */
function extractStructuredResult(event) {
  if (!event) return null;

  // Direct object on payload (TaskCompleted variant).
  if (event.structured_result && typeof event.structured_result === 'object') {
    return event.structured_result;
  }

  // PostToolUse:Agent — agent text is in tool_response.
  const raw = (event.tool_response && (event.tool_response.output || event.tool_response.text))
    || event.result
    || event.output
    || null;
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Restrict to the last 64 KB.
  const tail = raw.slice(-65536);

  // Find "## Structured Result" then the first ```json ... ``` block.
  const re = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = tail.match(re);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_) { /* fall through */ }
  }

  // Last-resort: bare {"status":...} JSON at end of output.
  const braceIdx = tail.lastIndexOf('{"status"');
  if (braceIdx !== -1) {
    let depth = 0, endIdx = -1;
    const cand = tail.slice(braceIdx);
    for (let i = 0; i < cand.length; i++) {
      if (cand[i] === '{') depth++;
      else if (cand[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx !== -1) {
      try { return JSON.parse(cand.slice(0, endIdx + 1)); } catch (_) { /* fall through */ }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Role identification
// ---------------------------------------------------------------------------

/**
 * @param {object} event
 * @returns {string|null}
 */
function identifyRole(event) {
  if (!event) return null;
  const candidates = [
    event.subagent_type,
    event.agent_type,
    event.agent_role,
    event.role,
    event.tool_input && event.tool_input.subagent_type,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * Validate a developer structured-result.
 * Checks that every entry in files_changed has a non-empty `path` field.
 *
 * @param {object} sr      - Structured result object.
 * @returns {string[]}     - Missing-field descriptors (one per offending entry).
 */
function validateDeveloper(sr) {
  const missing = [];
  const fc = sr.files_changed;
  if (!Array.isArray(fc) || fc.length === 0) return missing;

  fc.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path.trim().length === 0) {
      missing.push('files_changed[' + idx + '].path');
    }
  });
  return missing;
}

/**
 * Validate a release-manager structured-result.
 * Checks commit_hash, branch, and files_changed[].path.
 *
 * @param {object} sr
 * @returns {string[]}
 */
function validateReleaseManager(sr) {
  const missing = [];

  // commit_hash: required, must match short-hash pattern.
  const ch = sr.commit_hash;
  if (typeof ch !== 'string' || !COMMIT_HASH_RE.test(ch.trim())) {
    missing.push('commit_hash');
  }

  // branch: required, non-empty string.
  const br = sr.branch;
  if (typeof br !== 'string' || br.trim().length === 0) {
    missing.push('branch');
  }

  // files_changed[].path — same check as developer.
  missing.push(...validateDeveloper(sr));

  return missing;
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {string} orchestrationId
 * @param {string} missingField
 */
function emitEvent(cwd, orchestrationId, missingField) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_) { /* best-effort */ }
    writeEvent({
      version:        1,
      type:           'commit_handoff_validation_failed',
      release_id:     orchestrationId,
      missing_field:  missingField,
      schema_version: 1,
    }, { cwd });
  } catch (err) {
    // Fail-open: emit errors must never block Claude Code.
    process.stderr.write(
      '[orchestray] validate-commit-handoff: emit error: ' +
      String(err && err.message || err).slice(0, 120) + '\n'
    );
  }
}

// ---------------------------------------------------------------------------
// Exports (for unit tests)
// ---------------------------------------------------------------------------

module.exports = {
  extractStructuredResult,
  identifyRole,
  validateDeveloper,
  validateReleaseManager,
  WATCHED_ROLES,
  COMMIT_HASH_RE,
  // FN-45 exports for unit tests
  // (defined below main(); referenced via module.exports re-bind in main scope)
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Kill switch.
  if (process.env.ORCHESTRAY_COMMIT_HANDOFF_CHECK_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    // Only watch the relevant roles.
    const role = identifyRole(event);
    if (!role || !WATCHED_ROLES.has(role)) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    // Extract structured result.
    const sr = extractStructuredResult(event);
    if (!sr || typeof sr !== 'object') {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    // Only validate when files_changed is non-empty.
    const fc = sr.files_changed;
    if (!Array.isArray(fc) || fc.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    // Resolve orchestration_id for release_id.
    let orchestrationId = null;
    try {
      const stateFile = getCurrentOrchestrationFile(cwd);
      if (stateFile) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        orchestrationId = parsed.orchestration_id || parsed.id || null;
      }
    } catch (_) { /* best-effort */ }
    if (!orchestrationId) {
      orchestrationId = event.orchestration_id || event.session_id || 'unknown';
    }

    // Run role-specific validation.
    const missingFields = role === 'release-manager'
      ? validateReleaseManager(sr)
      : validateDeveloper(sr);

    // Emit one event per missing field.
    for (const field of missingFields) {
      emitEvent(cwd, orchestrationId, field);
      process.stderr.write(
        '[orchestray] validate-commit-handoff: WARN — ' + role +
        ' structured-result missing "' + field + '" (commit handoff discipline). ' +
        'See agents/pm-reference/agent-common-protocol.md §Commit Message Discipline.\n'
      );
    }

    // -----------------------------------------------------------------------
    // FN-45 (v2.2.15) — head-commit `## Handoff` body check.
    //   Activates when role ∈ {developer, release-manager} AND status:success.
    //   Soft-warn ramp for first HANDOFF_RAMP_DEFAULT missing spawns per orch;
    //   exit 2 thereafter. Kill switch: ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED=1.
    // -----------------------------------------------------------------------
    const status = (typeof sr.status === 'string') ? sr.status.toLowerCase() : '';
    if (status === 'success' && WATCHED_ROLES.has(role)) {
      const headBody = readHeadCommitBody(cwd);

      // W1 auto-commits (v2.2.18) carry this trailer; their bodies are intentionally
      // minimal and do not include a `## Handoff` block. Exempting them prevents
      // `commit_handoff_body_missing` false positives.
      const AUTO_COMMIT_TRAILER = 'Generated-By: orchestray-auto-commit-worktree';
      if (headBody !== null && headBody.includes(AUTO_COMMIT_TRAILER)) {
        process.stdout.write(JSON.stringify({ continue: true }) + '\n');
        process.exit(0);
      }

      if (headBody !== null && !/^##\s+Handoff\b/m.test(headBody)) {
        const gateDisabled = process.env.ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED === '1';
        const threshold = (() => {
          const env = process.env.ORCHESTRAY_COMMIT_HANDOFF_RAMP_THRESHOLD;
          const n = parseInt(env, 10);
          return Number.isFinite(n) && n >= 0 ? n : HANDOFF_RAMP_DEFAULT;
        })();
        const { count } = bumpHandoffWarnCount(cwd, orchestrationId, threshold);

        // Always emit the body-missing telemetry.
        try {
          writeEvent({
            version:        1,
            schema_version: 1,
            type:           'commit_handoff_body_missing',
            release_id:     orchestrationId,
            agent_role:     role,
            ramp_count:     count,
            ramp_threshold: threshold,
            gate_disabled:  gateDisabled,
          }, { cwd });
        } catch (_e) { /* fail-open */ }

        if (!gateDisabled && count > threshold) {
          process.stderr.write(
            '[orchestray] validate-commit-handoff: BLOCKED — head commit body lacks `## Handoff` ' +
            'subsection (' + count + ' missing-handoff commits this orchestration; threshold=' + threshold + '). ' +
            'Add a `## Handoff` block per agents/pm-reference/agent-common-protocol.md §Commit Message ' +
            'Discipline (files changed, test delta, invariants, downstream cues). ' +
            'Kill switch: ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED=1\n'
          );
          process.stdout.write(JSON.stringify({
            continue: false,
            reason: 'commit_handoff_body_missing_after_ramp',
          }) + '\n');
          process.exit(2);
        }

        process.stderr.write(
          '[orchestray] validate-commit-handoff: WARN (' + count + '/' + threshold + ') — head ' +
          'commit body lacks `## Handoff` subsection. ' +
          (gateDisabled
            ? '(kill switch active; not blocking) '
            : 'After ' + threshold + ' such commits this orchestration will hard-block. ') +
          'See agents/pm-reference/agent-common-protocol.md §Commit Message Discipline.\n'
        );
      }
    }

    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// FN-45 helpers
// ---------------------------------------------------------------------------

/**
 * Read the body (subject + body) of HEAD commit. Returns null when the cwd
 * is not a git repo or the read fails for any reason (fail-open).
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function readHeadCommitBody(cwd) {
  try {
    const out = cp.execFileSync('git', ['log', '-1', '--format=%B', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return typeof out === 'string' ? out : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Per-orchestration counter file path.
 */
function handoffCounterPath(cwd, orchestrationId) {
  return path.join(cwd, '.orchestray', 'state', `commit-handoff-warn-count-${orchestrationId}.txt`);
}

/**
 * Read+increment+persist the missing-handoff counter for this orchestration.
 *
 * @returns {{ count: number, threshold: number }}
 */
function bumpHandoffWarnCount(cwd, orchestrationId, threshold) {
  const filePath = handoffCounterPath(cwd, orchestrationId || 'unknown');
  let count = 0;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n >= 0) count = n;
  } catch (_e) { /* fresh */ }
  count += 1;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(count) + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }
  return { count, threshold };
}

// Re-bind module.exports so FN-45 helpers are testable.
Object.assign(module.exports, {
  readHeadCommitBody,
  handoffCounterPath,
  bumpHandoffWarnCount,
  HANDOFF_RAMP_DEFAULT,
});

if (require.main === module) {
  main();
}
