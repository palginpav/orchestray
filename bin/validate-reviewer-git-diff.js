#!/usr/bin/env node
'use strict';

/**
 * validate-reviewer-git-diff.js — PreToolUse:Agent hook.
 *
 * v2.2.11 W2-1: introduced as warn-only.
 * v2.2.15 FN-42: flipped to exit 2 (hard-block) on missing `## Git Diff` section.
 * v2.2.21 T7 (PM-4): audit-mode acceptance. A `## Git Diff` section whose body
 *   contains `_n/a — audit-mode dispatch_` or `_n/a, audit-mode_` is accepted as
 *   a valid empty-diff marker. Emits `reviewer_git_diff_audit_mode_accepted` event.
 *   Kill switch: ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1 reverts this exemption.
 *   (See KILL_SWITCHES.md for the kill-switch registry — do not edit that file from
 *   this hook; W3-T15 owns KILL_SWITCHES.md.)
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. Checks the
 * spawn prompt for a `## Git Diff` section (case-sensitive match). If absent,
 * emits a `reviewer_git_diff_section_missing` audit event and blocks the spawn.
 *
 * Rationale: delegation-templates.md:113 specifies that reviewer prompts must
 * include a `## Git Diff` section for token-efficient context handoff. Without
 * it, reviewers must fetch the diff themselves, wasting context budget. The
 * v2.2.11 warn-only ramp telemetry confirmed steady fire rate; per
 * `feedback_mechanical_over_prose.md` we promote to exit 2.
 *
 * Behaviour:
 *   - Exit 2 (block) when `## Git Diff` section is absent.
 *   - Exit 0 when section is present (including audit-mode marker) or kill switch is active.
 *   - Fail-open on any internal error.
 *   - Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1 → reverts to warn-only.
 *   - Kill switch: ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1 → disables audit-mode acceptance.
 *   - Legacy kill switch ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED=1 still
 *     short-circuits the check entirely (skipped, no emit, no block).
 *
 * Input:  Claude Code PreToolUse:Agent JSON payload on stdin
 * Output: { continue: true|false, ... } on stdout; exit 0 or 2.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const GIT_DIFF_RE    = /^## Git Diff/m; // case-sensitive per spec

// v2.2.21 T7 (PM-4): Audit-mode body markers. A `## Git Diff` section whose
// body matches one of these patterns is accepted as a valid empty-diff.
// Kill switch: ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1
//
// Note: the markers may appear inside italics (_text_) so no leading \b is used
// (underscore is a word character — \b would fail to match after _).
const AUDIT_MODE_MARKERS = [
  /n\/a\s*[—–-]\s*audit[-_ ]mode\s+dispatch/i,
  /n\/a,?\s+audit[-_ ]mode/i,
];

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Return true if the text after the `## Git Diff` heading matches one of the
 * audit-mode body markers (_n/a — audit-mode dispatch_ or _n/a, audit-mode_).
 *
 * Only called after GIT_DIFF_RE confirms the heading is present.
 *
 * @param {string} promptBody
 * @returns {boolean}
 */
function isAuditModeBody(promptBody) {
  if (process.env.ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED === '1') return false;
  // Extract text after the ## Git Diff heading (up to the next ## heading or end).
  const headingIdx = promptBody.search(GIT_DIFF_RE);
  if (headingIdx === -1) return false;
  const afterHeading = promptBody.slice(headingIdx);
  // Limit to next heading boundary or 500 chars — the marker is always on the
  // first line or two following the heading.
  const nextHeadingMatch = afterHeading.slice(4).search(/^##\s/m);
  const body = nextHeadingMatch === -1
    ? afterHeading.slice(0, 500)
    : afterHeading.slice(0, nextHeadingMatch + 4);
  return AUDIT_MODE_MARKERS.some(rx => rx.test(body));
}

/**
 * Return true if the spawn prompt contains a `## Git Diff` section.
 *
 * @param {string} promptBody
 * @returns {boolean}
 */
function hasGitDiffSection(promptBody) {
  if (typeof promptBody !== 'string' || promptBody.length === 0) return false;
  return GIT_DIFF_RE.test(promptBody);
}

/**
 * Return true if this event should trigger the check.
 *
 * @param {object} event
 * @returns {boolean}
 */
function shouldValidate(event) {
  if (!event) return false;
  const toolName = event.tool_name || event.hook_event_matcher || '';
  if (toolName !== 'Agent') return false;
  const toolInput = event.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return false;
  return toolInput.subagent_type === 'reviewer';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Legacy short-circuit: skip the check entirely (no emit, no block).
  if (process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!shouldValidate(event)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    const promptBody = (event.tool_input && typeof event.tool_input.prompt === 'string')
      ? event.tool_input.prompt
      : '';

    // v2.2.21 T7 (PM-4): If ## Git Diff is present AND the body matches the
    // audit-mode marker, emit accepted event and pass through.
    if (hasGitDiffSection(promptBody) && isAuditModeBody(promptBody)) {
      const spawnId =
        event.agent_id ||
        event.task_id ||
        (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) ||
        null;
      try {
        writeEvent({
          version:        SCHEMA_VERSION,
          schema_version: SCHEMA_VERSION,
          type:           'reviewer_git_diff_audit_mode_accepted',
          spawn_id:       spawnId,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!hasGitDiffSection(promptBody)) {
      // FN-36 (v2.2.15): spawn_id resolves from event TOP-LEVEL fields first.
      const spawnId =
        event.agent_id ||
        event.task_id ||
        (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) ||
        null;
      try {
        writeEvent({
          version:        SCHEMA_VERSION,
          schema_version: SCHEMA_VERSION,
          type:           'reviewer_git_diff_section_missing',
          spawn_id:       spawnId,
        }, { cwd });
      } catch (_e) { /* fail-open */ }

      // FN-42 (v2.2.15): hard-block unless GATE kill switch active.
      const gateDisabled = process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED === '1';

      if (gateDisabled) {
        process.stderr.write(
          '[orchestray] validate-reviewer-git-diff: WARN (kill switch active) — reviewer prompt ' +
          'lacks `## Git Diff` (delegation-templates.md:113). Not blocking ' +
          '(ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1).\n'
        );
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      process.stderr.write(
        '[orchestray] validate-reviewer-git-diff: BLOCKED — reviewer delegation prompt is missing ' +
        '`## Git Diff` section (delegation-templates.md:113). Without it the reviewer must re-fetch ' +
        'the diff, wasting context. Add a `## Git Diff` section with the output of ' +
        '`git diff <base>..HEAD` (or equivalent) to the delegation prompt. ' +
        'Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({
        continue: false,
        reason: 'reviewer_git_diff_section_missing',
      }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  hasGitDiffSection,
  isAuditModeBody,
  shouldValidate,
  GIT_DIFF_RE,
  AUDIT_MODE_MARKERS,
};

if (require.main === module) {
  main();
}
