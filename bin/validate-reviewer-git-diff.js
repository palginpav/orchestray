#!/usr/bin/env node
'use strict';

/**
 * validate-reviewer-git-diff.js — PreToolUse:Agent hook (v2.2.11 W2-1).
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. Checks the
 * spawn prompt for a `## Git Diff` section (case-sensitive match). If absent,
 * emits a `reviewer_git_diff_section_missing` audit event.
 *
 * Rationale: delegation-templates.md:113 specifies that reviewer prompts must
 * include a `## Git Diff` section for token-efficient context handoff. Without
 * it, reviewers must fetch the diff themselves, wasting context budget.
 *
 * Behaviour:
 *   - Warn-only (exit 0). Never blocks a reviewer spawn.
 *   - Emits `reviewer_git_diff_section_missing` when the section is absent.
 *   - Fail-open on any internal error.
 *   - Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED=1
 *
 * Input:  Claude Code PreToolUse:Agent JSON payload on stdin
 * Output: { continue: true } on stdout always; exit 0 always
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

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

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

    if (!hasGitDiffSection(promptBody)) {
      const spawnId = (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) || null;
      try {
        writeEvent({
          version:        SCHEMA_VERSION,
          schema_version: SCHEMA_VERSION,
          type:           'reviewer_git_diff_section_missing',
          spawn_id:       spawnId,
        }, { cwd });
      } catch (_e) { /* fail-open */ }

      process.stderr.write(
        '[orchestray] validate-reviewer-git-diff: WARN — reviewer spawn lacks ## Git Diff section. ' +
        'Include a `## Git Diff` section in the delegation prompt for token-efficient context handoff. ' +
        'Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED=1\n'
      );
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  hasGitDiffSection,
  shouldValidate,
  GIT_DIFF_RE,
};

if (require.main === module) {
  main();
}
