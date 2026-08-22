#!/usr/bin/env node
'use strict';

/**
 * validate-reviewer-scope.js — PreToolUse hook (matcher: "Agent").
 *
 * v2.1.9 Bundle B1 / Intervention I-03 (reviewer file-list scope).
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. Scans the
 * delegation prompt body for an explicit file list (markers: `files:`,
 * `scope:` section, or a bulleted list of repo-relative paths). If absent,
 * emits a `reviewer_scope_blocked` audit event and exits 2 (BLOCK).
 *
 * v2.2 promise fulfilled — flipped to exit-2 in v2.2.9 (B-2.3).
 * Kill switch: ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED=1 → reverts to warn-only.
 *
 * v2.3.31 W8B: before blocking on an unbound scope, derive a file list from
 * the working tree (`git diff --name-only HEAD`, falling back to `--cached
 * HEAD`) and autofill a `## Files to Review` section via `updatedInput`.
 * Only falls through to the hard block when the tree is genuinely clean —
 * that remaining case is the real turn-cap protection this gate exists for.
 * Emits `reviewer_scope_autofilled` on success.
 *
 * Contract:
 *   - exit 0 + updatedInput when scope is unbound but files can be derived
 *     from git (autofill)
 *   - exit 2 when scope is unbound and no files can be derived (clean tree)
 *   - exit 0 when scope is already bounded or kill switch is active
 *   - fail-open on any internal error
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');
const { readHookInputRaw } = require('./_lib/hook-stdin');

// v2.3.31 W8B: cap on the number of derived file paths injected into
// `## Files to Review` — bounds prompt growth for very large diffs.
const MAX_DERIVED_FILES = 40;

/**
 * Run `git diff --name-only [args]` in `cwd`. Fails safe: any error (git
 * missing, not a repo, timeout) is treated as "empty" so the caller falls
 * through to the next precedence tier.
 *
 * @param {string} cwd
 * @param {string[]} args - extra args appended after `diff --name-only`
 * @returns {string[]}
 */
function tryGitNameOnly(cwd, args) {
  try {
    const r = cp.spawnSync('git', ['diff', '--name-only'].concat(args), {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return [];
    return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  } catch (_e) {
    return [];
  }
}

/**
 * Derive a `## Files to Review` list from the working tree, in precedence
 * order: unstaged diff against HEAD, then staged diff against HEAD.
 * Returns an empty array when the tree is clean (or git is unavailable).
 *
 * @param {string} cwd
 * @returns {{ files: string[], truncated: boolean, source: string }}
 */
function deriveFilesFromGit(cwd) {
  let files = tryGitNameOnly(cwd, ['HEAD']);
  let source = 'git_diff_head';
  if (files.length === 0) {
    files = tryGitNameOnly(cwd, ['--cached', 'HEAD']);
    source = 'git_diff_cached_head';
  }
  if (files.length === 0) {
    return { files: [], truncated: false, source: 'empty' };
  }
  const truncated = files.length > MAX_DERIVED_FILES;
  return { files: files.slice(0, MAX_DERIVED_FILES), truncated, source };
}

/**
 * Build the `## Files to Review` block to append to a reviewer prompt.
 *
 * @param {string[]} files
 * @param {boolean} truncated
 * @returns {string}
 */
function buildFilesToReviewBlock(files, truncated) {
  const bulletList = files.map((f) => '- `' + f + '`').join('\n');
  const truncNote = truncated
    ? '\n\n_(list capped at ' + MAX_DERIVED_FILES + ' paths; additional changed files were truncated)_'
    : '';
  return '\n\n## Files to Review\n\n' + bulletList + truncNote;
}

// Heuristics for detecting an explicit file list in the prompt body.
// Any one of these signals is sufficient to treat the scope as bounded.
const FILE_MARKERS = [
  /(^|\n)\s*files\s*:/i,             // files: foo.ts
  /(^|\n)\s*scope\s*:/i,             // scope:
  /(^|\n)\s*in[-_ ]?scope\s*:/i,     // in-scope:
  /(^|\n)\s*review\s*:/i,            // review: (next line lists files)
  /(^|\n)\s*file[-_ ]?list\s*:/i,    // file-list:
  // v2.2.2 Fix A4: project's heading style for file-scoped reviewer prompts —
  // matches `## Verification`, `### Files to verify`, `## Files to read`, etc.
  /(^|\n)\s*#{1,3}\s*(verification|files?\s+to\s+(?:verify|read|review|check))\b/i,
];

// Count bulleted list items that look like repo paths. One or more is
// accepted as evidence of an explicit file list (W-CQ-6: lowered from 3 to 1
// in v2.2.21 to avoid false-rejecting 1-2 file hotfix/scoped reviews).
//
// v2.2.2 Fix A4: optional backticks on each side of the path token. The
// project's house style wraps paths in backticks (e.g. `` - `src/foo.ts` ``).
// Without this tolerance the regex matched 0 bullets in well-scoped operator
// prompts (false-positive rate was empirically 100% in v2.2.1 telemetry).
const BULLET_PATH_RE = /(?:^|\n)[\t ]*[-*][\t ]+`?[\w./-]+\.[a-z0-9]{1,6}`?(?:\b|$)/gi;
const BULLET_PATH_THRESHOLD = 1; // v2.2.21 W-CQ-6: was 3, now 1

/**
 * Determine whether the reviewer spawn has an explicit file list.
 *
 * @param {string} promptBody
 * @returns {{ scoped: boolean, evidence: string }}
 */
function evaluateScope(promptBody) {
  if (typeof promptBody !== 'string' || promptBody.length === 0) {
    return { scoped: false, evidence: 'empty prompt body' };
  }

  // Limit scan to the first 16 KB — the scope declaration is always early.
  const head = promptBody.slice(0, 16 * 1024);

  for (const rx of FILE_MARKERS) {
    if (rx.test(head)) {
      return { scoped: true, evidence: 'marker: ' + String(rx).replace(/\/\^|\$\/|\/gi|\/i$/g, '').slice(0, 40) };
    }
  }

  const bulletMatches = head.match(BULLET_PATH_RE);
  if (bulletMatches && bulletMatches.length >= BULLET_PATH_THRESHOLD) {
    return { scoped: true, evidence: 'bullet-list paths (' + bulletMatches.length + ')' };
  }

  return { scoped: false, evidence: 'no files:/scope: marker and no bullet-list paths found' };
}

function shouldValidate(event) {
  if (!event) return false;
  const toolName = event.tool_name || event.hook_event_matcher || '';
  if (toolName !== 'Agent') return false;
  const toolInput = event.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return false;
  return toolInput.subagent_type === 'reviewer';
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (err) {
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-reviewer-scope', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) { /* last resort */ }
  }
}

function main() {
  let input = '';
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
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
    const evaluation = evaluateScope(promptBody);

    // FN-41 (v2.2.15): the v2.2.10 B5 block (legacy `reviewer_dimensions_missing`
    // emit) was a duplicate of the W2-9 block below with a stricter regex that
    // missed legitimate prompts. Retired in favour of the W2-9 path which emits
    // `reviewer_dimensions_block_missing` (the canonical schema declared in
    // event-schemas.md). The hard gate is FN-43 (validate-reviewer-dimensions.js).

    // W2-9 (v2.2.11) + FN-36 (v2.2.15): warn-event when reviewer prompt lacks
    // ## Dimensions to Apply block. Warn-only here; FN-43 owns the hard block.
    // Kill switch: ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED=1
    //
    // FN-36: spawn_id resolves from event TOP-LEVEL fields (Claude Code never
    // places agent_id / task_id in tool_input). Falls back to tool_input only
    // for backward compatibility with synthetic test payloads.
    if (process.env.ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED !== '1') {
      const hasDimensionsBlock = /##\s+Dimensions\s+to\s+Apply/i.test(promptBody);
      if (!hasDimensionsBlock) {
        const spawnId =
          event.agent_id ||
          event.task_id ||
          (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) ||
          null;
        try {
          const auditDir = path.join(cwd, '.orchestray', 'audit');
          fs.mkdirSync(auditDir, { recursive: true });
          try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
          writeEvent({
            version:        1,
            schema_version: 1,
            type:           'reviewer_dimensions_block_missing',
            spawn_id:       spawnId,
          }, { cwd });
        } catch (_e) { /* fail-open */ }
      }
    }

    if (!evaluation.scoped) {
      // v2.3.31 W8B: derive a file list from the working tree instead of
      // blocking outright — the injector pattern (bin/inject-review-dimensions.js)
      // is dead for this exact reason (sibling PreToolUse hooks can't share
      // updatedInput), so autofill happens HERE, in the validator that gates
      // the spawn. Only genuinely falls through to the hard block below when
      // the tree is clean (nothing to scope to) — that is the real turn-cap
      // protection this gate exists for.
      const derived = deriveFilesFromGit(cwd);
      if (derived.files.length > 0) {
        emitAuditEvent(cwd, {
          timestamp: new Date().toISOString(),
          type: 'reviewer_scope_autofilled',
          hook: 'validate-reviewer-scope',
          spawn_target: event.tool_input && event.tool_input.subagent_type || 'reviewer',
          path_count: derived.files.length,
          truncated: derived.truncated,
          source: derived.source,
          session_id: event.session_id || null,
        });
        const block = buildFilesToReviewBlock(derived.files, derived.truncated);
        const newToolInput = Object.assign({}, event.tool_input, {
          prompt: promptBody + block,
        });
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: newToolInput,
          },
          continue: true,
        }));
        process.exit(0);
      }

      // v2.2.9 B-2.3: hard-reject unless kill switch is active.
      const hardDisabled = process.env.ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED === '1';

      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: hardDisabled ? 'reviewer_scope_warn' : 'reviewer_scope_blocked',
        hook: 'validate-reviewer-scope',
        spawn_target: event.tool_input && event.tool_input.subagent_type || 'reviewer',
        missing_block: '## Files to Review',
        guidance:
          'Reviewer spawned without an explicit file list. Include a `## Files to Review` ' +
          'section or a `files:` key in the delegation prompt to bound the review scope. ' +
          'See agents/pm.md §3.X.',
        evidence: evaluation.evidence,
        hard_disabled: hardDisabled,
        session_id: event.session_id || null,
      });

      if (hardDisabled) {
        process.stderr.write(
          '[orchestray] validate-reviewer-scope: WARN (kill switch active) — reviewer delegation lacks an explicit file list ' +
          '(evidence: ' + evaluation.evidence + '). Not blocking (ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED=1).\n'
        );
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      process.stderr.write(
        '[orchestray] validate-reviewer-scope: BLOCKED — reviewer delegation lacks an explicit file list ' +
        '(evidence: ' + evaluation.evidence + '). ' +
        'Add a `## Files to Review` section or `files:` key to the delegation prompt. ' +
        'Kill switch: ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: false, reason: 'reviewer_scope_missing_file_list' }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  evaluateScope,
  shouldValidate,
  FILE_MARKERS,
  BULLET_PATH_THRESHOLD,
  deriveFilesFromGit,
  buildFilesToReviewBlock,
  tryGitNameOnly,
  MAX_DERIVED_FILES,
};

if (require.main === module) {
  main();
}
