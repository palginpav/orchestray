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
 *   (See KILL_SWITCHES.md for the kill-switch registry.)
 * v2.3.18 W3 Q2: auto-inject, not block. `## Git Diff` absent → compute one
 *   with `git diff HEAD` (capped, falls back to `git diff --stat HEAD` on
 *   overflow) and inject it into the prompt via `updatedInput` — see
 *   inject-delegation-delta.js for the same PreToolUse `updatedInput` pattern.
 *   Blocks ONLY when no diff can be produced at all (git unavailable / not a
 *   repo). Also fixes `spawn_id` being null on 30/30 telemetry rows: this hook
 *   runs at PreToolUse, before the spawned agent has an agent_id/task_id —
 *   `event.tool_use_id` is the correct identifier at this point (see
 *   inject-review-dimensions.js).
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. Checks the
 * spawn prompt for a `## Git Diff` section (case-sensitive match).
 *
 * Rationale: delegation-templates.md:113 specifies that reviewer prompts must
 * include a `## Git Diff` section for token-efficient context handoff. Without
 * it, reviewers must fetch the diff themselves, wasting context budget. Per
 * `feedback_mechanical_over_prose.md`, when the hook can produce the section
 * itself it does so rather than blocking the spawn.
 *
 * Behaviour:
 *   - Section absent → attempt auto-inject (see computeGitDiffInjection).
 *     Success: emit `reviewer_git_diff_auto_injected`, pass updatedInput, exit 0.
 *     Failure (no diff producible at all): emit `reviewer_git_diff_section_missing`,
 *     block, exit 2.
 *   - Exit 0 when section is present (including audit-mode marker) or kill switch is active.
 *   - Fail-open on any internal error.
 *   - Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1 → reverts the
 *     block-on-failure path to warn-only (auto-inject still attempted).
 *   - Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_AUTOINJECT_DISABLED=1 (or config
 *     `reviewer_git_diff_autoinject.enabled: false`) → disables auto-inject,
 *     restores the pre-v2.3.18 straight block-on-missing behaviour.
 *   - Kill switch: ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1 → disables audit-mode acceptance.
 *   - Legacy kill switch ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED=1 still
 *     short-circuits the check entirely (skipped, no emit, no block).
 *
 * Input:  Claude Code PreToolUse:Agent JSON payload on stdin
 * Output: { continue: true|false, ... } on stdout; exit 0 or 2.
 */

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');

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
// v2.3.18 W3 Q2 — auto-inject helpers
// ---------------------------------------------------------------------------

const DIFF_MAX_CHARS = 8000; // size cap on the injected diff body

/**
 * Run `git <args>` in `cwd`. Never throws.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ok: boolean, stdout?: string, reason?: string}}
 */
function tryGitDiff(cwd, args) {
  let r;
  try {
    r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 20 * 1024 * 1024 });
  } catch (_e) {
    return { ok: false, reason: 'git_spawn_threw' };
  }
  if (r.error) return { ok: false, reason: 'git_unavailable' };
  if (r.status !== 0) return { ok: false, reason: 'git_diff_exit_' + r.status };
  return { ok: true, stdout: r.stdout || '' };
}

/**
 * Compute a `## Git Diff` body for auto-injection.
 *
 * Tries `git diff HEAD` first (captures staged + unstaged changes against the
 * last commit). Falls back to plain `git diff` when HEAD is unresolvable
 * (e.g. a brand-new repo with zero commits). On overflow (> DIFF_MAX_CHARS)
 * degrades to the `--stat` summary — a compact, always-affordable fallback.
 * Returns `{ok: false}` ONLY when no diff can be produced at all (git missing,
 * not a repo) — that is now the sole remaining block condition.
 *
 * @param {string} cwd
 * @returns {{ok: true, body: string, source: string} | {ok: false, reason: string}}
 */
function computeGitDiffInjection(cwd) {
  let res = tryGitDiff(cwd, ['diff', 'HEAD']);
  if (!res.ok) res = tryGitDiff(cwd, ['diff']);
  if (!res.ok) return { ok: false, reason: res.reason };

  const stdout = res.stdout;
  if (stdout.trim().length === 0) {
    return { ok: true, source: 'empty', body: '_n/a — auto-injected, no diff produced by `git diff` (clean tree)_' };
  }
  if (stdout.length <= DIFF_MAX_CHARS) {
    return { ok: true, source: 'full', body: '```diff\n' + stdout.replace(/\s+$/, '') + '\n```' };
  }

  const stat = tryGitDiff(cwd, ['diff', '--stat', 'HEAD']);
  const statOk = stat.ok && stat.stdout.trim().length > 0;
  const statBody = statOk
    ? stat.stdout.replace(/\s+$/, '')
    : stdout.slice(0, DIFF_MAX_CHARS) + '\n... (truncated)';
  return {
    ok: true,
    source: statOk ? 'stat_overflow' : 'full_truncated',
    body: `_full diff exceeded ${DIFF_MAX_CHARS} chars — showing summary_\n\n` + '```\n' + statBody + '\n```',
  };
}

/**
 * Kill switch for the v2.3.18 auto-inject path. When disabled, a missing
 * `## Git Diff` section reverts to the pre-v2.3.18 straight block.
 * Config key: `reviewer_git_diff_autoinject.enabled` (default true).
 * Env: ORCHESTRAY_REVIEWER_GIT_DIFF_AUTOINJECT_DISABLED=1
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isAutoInjectDisabled(cwd) {
  if (process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_AUTOINJECT_DISABLED === '1') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    if (cfg && cfg.reviewer_git_diff_autoinject && cfg.reviewer_git_diff_autoinject.enabled === false) {
      return true;
    }
  } catch (_e) { /* fail-open: treat as enabled */ }
  return false;
}

/**
 * Resolve the spawn identifier at PreToolUse time. `event.agent_id` /
 * `event.task_id` are SubagentStop-time fields and are ALWAYS null here
 * (bug fixed v2.3.18 W3 — 30/30 telemetry rows had spawn_id: null).
 * `event.tool_use_id` is the correct identifier at PreToolUse (see
 * inject-review-dimensions.js). The old fields are kept as a defensive
 * fallback only.
 *
 * @param {object} event
 * @returns {string|null}
 */
function resolveSpawnId(event) {
  return (
    (typeof event.tool_use_id === 'string' && event.tool_use_id) ||
    event.agent_id ||
    event.task_id ||
    (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) ||
    null
  );
}

function emitAllowWithUpdatedInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }));
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
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
  setImmediate(() => {
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

    const spawnId = resolveSpawnId(event); // v2.3.18 W3: fixes 30/30 null spawn_id rows

    // v2.2.21 T7 (PM-4): If ## Git Diff is present AND the body matches the
    // audit-mode marker, emit accepted event and pass through.
    if (hasGitDiffSection(promptBody) && isAuditModeBody(promptBody)) {
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
      try {
        writeEvent({
          version:        SCHEMA_VERSION,
          schema_version: SCHEMA_VERSION,
          type:           'reviewer_git_diff_section_missing',
          spawn_id:       spawnId,
        }, { cwd });
      } catch (_e) { /* fail-open */ }

      // v2.3.18 W3 Q2: auto-inject, not block. Escape hatch retained for
      // straight legacy block-on-missing (kill switch ONLY, no attempt).
      if (!isAutoInjectDisabled(cwd)) {
        const injection = computeGitDiffInjection(cwd);
        if (injection.ok) {
          const injectedPrompt = promptBody.replace(/\s*$/, '') +
            '\n\n## Git Diff\n\n' + injection.body + '\n';
          try {
            writeEvent({
              version:        SCHEMA_VERSION,
              schema_version: SCHEMA_VERSION,
              type:           'reviewer_git_diff_auto_injected',
              spawn_id:       spawnId,
              source:         injection.source,
              bytes:          Buffer.byteLength(injection.body, 'utf8'),
            }, { cwd });
          } catch (_e) { /* fail-open */ }
          process.stderr.write(
            '[orchestray] validate-reviewer-git-diff: auto-injected `## Git Diff` ' +
            `(source=${injection.source}) — reviewer prompt lacked one ` +
            '(delegation-templates.md:113). To disable: ORCHESTRAY_REVIEWER_GIT_DIFF_AUTOINJECT_DISABLED=1.\n'
          );
          const newToolInput = Object.assign({}, event.tool_input, { prompt: injectedPrompt });
          emitAllowWithUpdatedInput(newToolInput);
          process.exit(0);
        }
        // Injection genuinely failed (no git / not a repo) — fall through to block.
      }

      // FN-42 (v2.2.15): hard-block unless GATE kill switch active.
      const gateDisabled = process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED === '1';

      if (gateDisabled) {
        process.stderr.write(
          '[orchestray] validate-reviewer-git-diff: WARN (kill switch active) — reviewer prompt ' +
          'lacks `## Git Diff` (delegation-templates.md:113) and no diff could be produced. Not ' +
          'blocking (ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1).\n'
        );
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      process.stderr.write(
        '[orchestray] validate-reviewer-git-diff: BLOCKED — reviewer delegation prompt is missing ' +
        '`## Git Diff` section (delegation-templates.md:113) and no diff could be auto-produced ' +
        '(not a git repo, or git unavailable). Add a `## Git Diff` section manually, or fix the ' +
        'repo context. Kill switch: ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1\n'
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
  tryGitDiff,
  computeGitDiffInjection,
  isAutoInjectDisabled,
  resolveSpawnId,
  DIFF_MAX_CHARS,
};

if (require.main === module) {
  main();
}
