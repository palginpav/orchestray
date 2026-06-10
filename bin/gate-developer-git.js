#!/usr/bin/env node
'use strict';

/**
 * gate-developer-git.js — PreToolUse:Bash hook (v2.2.9 B-2.5).
 *
 * Blocks dangerous git commands when the agent role is "developer":
 *   - git push --force / git push -f
 *   - git reset --hard origin/<branch>
 *   - git commit -m "release:..." (release commits are release-manager's job)
 *
 * v2.2.15 FN-46: also blocks any developer `git commit -m` whose inline
 * message contains `Co[-\s]?Authored[-\s]?By:` (canonical OR no-hyphen
 * variants) or "Generated with Claude" / "Generated with [Claude" trailers
 * (per `feedback_commit_style.md` user memory — concise commits, no
 * co-authoring trailers).
 *
 * v2.2.15 W9 F-3: the `-F <file>` branch is hint-only — the regex cannot
 * read file contents to enforce the trailer rules, so a stderr advisory is
 * emitted recommending `-m` instead. The previous `-F`-globbing branch
 * over-blocked any commit-from-file and was removed.
 *
 * v2.2.15 FN-48: when the resolved role is "release-manager", additionally
 * block ANY `git push` form (not just --force) and any `git tag -a`/`-s` write.
 * Per the release-manager invariant: never push, never tag (the operator
 * authorises those steps explicitly per `feedback_release_actions_explicit_permission.md`).
 *
 * v2.3.8 wt_destructive_git: blocks git stash/clean/checkout-files/restore/reset
 * (except --soft) that could silently revert uncommitted work in the shared main
 * checkout (v2.3.7 silent-revert incident).
 *   - Read-only roles (reviewer, debugger, researcher, ux-critic, platform-oracle,
 *     project-intent): blocked ALWAYS regardless of cwd.
 *   - All other roles: blocked when the effective target repo is the shared main
 *     checkout (detected via git-common-dir == git-dir).
 *   - Evasion via `git -C <path>` is covered by resolving the explicit path arg.
 *   - `git stash list` and `git stash show` remain allowed (non-destructive).
 *   - `git reset --soft` remains allowed.
 *   - Read-only roles fail CLOSED (exit 2) on parse uncertainty.
 *
 * Kill switch: ORCHESTRAY_GIT_GATE_DISABLED=1 — disables all checks (subsumes
 * FN-46 and FN-48).
 *
 * Contract:
 *   - exit 2 + emit git_destructive_blocked or developer_git_violation when a
 *     forbidden pattern is matched
 *   - exit 0 always otherwise (fail-open on unexpected errors)
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { writeEvent }        = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

// ---------------------------------------------------------------------------
// Read-only roles: always block destructive git regardless of cwd.
// ---------------------------------------------------------------------------

const READ_ONLY_ROLES = new Set([
  'reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent',
]);

// ---------------------------------------------------------------------------
// Forbidden git command patterns (developer role only).
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  {
    id: 'force_push',
    // git push --force or git push -f (with any remote/branch args)
    regex: /\bgit\s+push\b[^|;&\n]*?(?:--force|-f)\b/,
    description: 'force push is forbidden for developer agents — use regular push',
    roles: ['developer', 'release-manager'],
  },
  {
    id: 'hard_reset_origin',
    // git reset --hard origin/<anything>
    regex: /\bgit\s+reset\s+--hard\s+origin\//,
    description: 'git reset --hard origin/<branch> is forbidden for developer agents',
    roles: ['developer', 'release-manager'],
  },
  {
    id: 'release_commit',
    // git commit -m "release: ..." or git commit -m 'release: ...'
    regex: /\bgit\s+commit\b[^|;&\n]*?-m\s+['"]release:/,
    description: 'release: commits are owned by release-manager, not developer',
    roles: ['developer'],
  },
  // FN-46 (v2.2.15) + F-3 (v2.2.15 W9 follow-up): Co-Authored-By trailer in
  // commit message body. The regex tolerates the canonical hyphenated form
  // AND the no-hyphen / spaced variants (`Co Authored By`, `Co-Authored By`,
  // `Co Authored-By`) that bare-text rendering of trailers can produce.
  // The -F branch was previously globbed into this rule and over-blocked
  // ANY `git commit -F file` regardless of message content (regex cannot
  // read file contents). The -F branch is now handled separately as a
  // hint-only WARN below; the structural -F overblock is gone.
  {
    id: 'co_authored_by_trailer',
    // -m only — message text is inline and content-checkable.
    regex: /\bgit\s+commit\b[^|;&\n]*?-m\s+['"][\s\S]*?Co[-\s]?Authored[-\s]?By\s*:/i,
    description: 'commit messages must not include Co-Authored-By trailers (feedback_commit_style.md)',
    roles: ['developer', 'release-manager'],
  },
  // FN-46: "Generated with Claude" / "Generated with [Claude" trailer.
  {
    id: 'generated_with_claude_trailer',
    // Match BOTH bracketed and bare forms in inline -m messages.
    regex: /\bgit\s+commit\b[^|;&\n]*?-m\s+['"][\s\S]*?Generated\s+with\s+\[?Claude/i,
    description: 'commit messages must not include "Generated with Claude" trailers (feedback_commit_style.md)',
    roles: ['developer', 'release-manager'],
  },
  // FN-48: release-manager must not push at all (any form).
  {
    id: 'release_manager_push',
    regex: /\bgit\s+push\b/,
    description: 'release-manager must never `git push` — operator authorises pushes explicitly (feedback_release_actions_explicit_permission.md)',
    roles: ['release-manager'],
  },
  // FN-48: release-manager must not write annotated/signed tags.
  {
    id: 'release_manager_tag_write',
    // git tag -a <name> ... | git tag -s <name> ... | git tag --sign ... | git tag --annotate ...
    regex: /\bgit\s+tag\b[^|;&\n]*?(?:-a\b|-s\b|--annotate\b|--sign\b)/,
    description: 'release-manager must never write annotated/signed tags — operator authorises tags explicitly',
    roles: ['release-manager'],
  },
  // v2.3.8 wt_destructive_git: destructive working-tree ops.
  // read-only roles: blocked always (roles[] used for role-based check).
  // alsoBlockWhenMainCheckout: true — extends block to ALL roles when target is
  // the shared main checkout (not a linked worktree).
  {
    id: 'wt_destructive_git',
    // stash (except list/show), clean, checkout with pathspec/-- , restore, reset (except --soft).
    // The optional (?:-C\s+\S+\s+)? prefix handles `git -C <path> <subcommand>` evasion.
    regex: /\bgit\s+(?:-C\s+\S+\s+)?(?:stash(?!\s+(?:list|show)\b)|clean\b|checkout\s+(?:--|HEAD\s+--|[0-9a-f]{7,}\s+--|\S.*--\s)|restore\b|reset\s+(?!--soft\b))/,
    description: 'read-only agents must not mutate git state; use `git stash list` / `git show <sha>:<path>` for clean-baseline comparisons (v2.3.7 silent-revert incident)',
    roles: ['reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent'],
    alsoBlockWhenMainCheckout: true,
  },
];

// ---------------------------------------------------------------------------
// Main-checkout detection via git-common-dir == git-dir.
// Returns true when `dir` is the main (non-linked) worktree.
// ---------------------------------------------------------------------------

/**
 * @param {string} dir - directory to test
 * @returns {boolean}
 */
function isMainCheckout(dir) {
  try {
    const gitDir = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    const commonDir = spawnSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    if (gitDir.status !== 0 || commonDir.status !== 0) return false;
    const absGit = path.resolve(dir, gitDir.stdout.trim());
    const absCommon = path.resolve(dir, commonDir.stdout.trim());
    return absGit === absCommon;
  } catch (_) {
    return false;
  }
}

/**
 * Extract the explicit `git -C <dir>` path from a command string, if present.
 * Returns null when not found.
 *
 * @param {string} command
 * @returns {string|null}
 */
function extractGitCDir(command) {
  // Match `git -C <path>` — path may be quoted or unquoted
  const m = command.match(/\bgit\s+-C\s+(['"]?)([^\s'";&|]+)\1/);
  return m ? m[2] : null;
}

/**
 * Split a command string on shell chain operators (&&, ;, |) and return
 * individual segments. This allows checking each git sub-command independently.
 *
 * @param {string} command
 * @returns {string[]}
 */
function splitChained(command) {
  return command.split(/&&|;(?!;)|\|(?!\|)/).map(s => s.trim()).filter(Boolean);
}

/**
 * Find any forbidden pattern in a bash command string for the given role,
 * with optional main-checkout context for `alsoBlockWhenMainCheckout` rules.
 *
 * @param {string} command
 * @param {string} role - resolved agent role (lower-case)
 * @param {{ isMain: boolean, isReadOnly: boolean }} [ctx]
 * @returns {{id: string, description: string}|null}
 */
function findForbiddenPattern(command, role, ctx) {
  if (typeof command !== 'string') return null;
  const targetRole = (typeof role === 'string' ? role.toLowerCase() : '') || 'developer';
  const context = ctx || { isMain: false, isReadOnly: false };

  for (const pattern of FORBIDDEN_PATTERNS) {
    // Role-based check: pattern applies to this role.
    const allowedRoles = Array.isArray(pattern.roles) ? pattern.roles : ['developer'];
    const roleMatch = allowedRoles.includes(targetRole);

    // Context-based check: pattern fires for ALL roles when in main checkout.
    const mainMatch = pattern.alsoBlockWhenMainCheckout && context.isMain;

    if (!roleMatch && !mainMatch) continue;

    // For wt_destructive_git, split chains and check each segment.
    if (pattern.id === 'wt_destructive_git') {
      const segments = splitChained(command);
      for (const seg of segments) {
        if (pattern.regex.test(seg)) return { id: pattern.id, description: pattern.description };
      }
    } else if (pattern.regex.test(command)) {
      return { id: pattern.id, description: pattern.description };
    }
  }
  return null;
}

/**
 * Extract agent role from hook event. Checks known role-carrying keys.
 *
 * @param {object} event
 * @returns {string|null}
 */
function resolveRole(event) {
  const candidates = [
    event.agent_role,
    event.subagent_type,
    event.agent_type,
    event.role,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim().toLowerCase().replace(/[\s\x00-\x1F]+/g, '');
    }
  }
  return null;
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_) {}
    writeEvent(record, { cwd });
  } catch (err) {
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'gate-developer-git', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) {}
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
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    // Kill switch.
    if (process.env.ORCHESTRAY_GIT_GATE_DISABLED === '1') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only activate for Bash tool invocations.
    const toolName = event.tool_name || '';
    if (toolName !== 'Bash') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const role = resolveRole(event);
    const isReadOnly = READ_ONLY_ROLES.has(role);

    // For non-read-only roles that aren't developer/release-manager, we still
    // need to run the wt_destructive_git check (alsoBlockWhenMainCheckout).
    // For the existing role-specific checks (force_push etc.), we skip early
    // only if role is not developer/release-manager AND not read-only.
    const isRoleGated = role === 'developer' || role === 'release-manager';
    if (!isRoleGated && !isReadOnly) {
      // Not a role-gated role, not read-only — only check alsoBlockWhenMainCheckout.
      // We still need to check wt_destructive_git for any role in main checkout.
      // Fall through to the main check below; findForbiddenPattern handles it.
    }

    const command = (event.tool_input && typeof event.tool_input.command === 'string')
      ? event.tool_input.command
      : '';
    if (!command) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    // Determine the effective target directory for git operations.
    // Priority: explicit `git -C <dir>` arg > event.cwd.
    const explicitCDir = extractGitCDir(command);
    const targetDir = (explicitCDir && path.isAbsolute(explicitCDir))
      ? explicitCDir
      : explicitCDir
        ? path.resolve(cwd, explicitCDir)
        : cwd;

    // Determine context for pattern matching.
    const mainCheckout = isMainCheckout(targetDir);

    // Read-only roles with wt_destructive_git match: fail CLOSED on uncertainty.
    // For read-only roles we don't need main-checkout check — they're always blocked.
    // We pass isMain=true for read-only roles so the alsoBlockWhenMainCheckout logic
    // doesn't interfere with the role-based block.
    const ctx = {
      isMain: mainCheckout || isReadOnly,
      isReadOnly,
    };

    const violation = findForbiddenPattern(command, role, ctx);
    if (!violation) {
      // FN-46 follow-up (W9 F-3): emit a hint-only WARN when a developer/
      // release-manager pipes a commit message from a file (`git commit -F
      // <path>`). The regex cannot inspect file contents, so we cannot block
      // on the same trailer rules; the advisory reminds the agent that
      // inline `-m` is preferred per feedback_commit_style.md, but the spawn
      // is allowed to proceed.
      if ((isRoleGated) && /\bgit\s+commit\b[^|;&\n]*?-F\b/.test(command)) {
        process.stderr.write(
          '[orchestray] gate-developer-git: HINT — `git commit -F <file>` cannot be ' +
          'content-checked for Co-Authored-By / "Generated with Claude" trailers. ' +
          'Prefer inline `git commit -m "<msg>"` so the trailer gate can verify ' +
          'commit-style discipline (feedback_commit_style.md).\n'
        );
      }
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Use git_destructive_blocked event type for wt_destructive_git violations;
    // existing event type for other violations.
    const eventType = violation.id === 'wt_destructive_git'
      ? 'git_destructive_blocked'
      : 'developer_git_violation';

    emitAuditEvent(cwd, {
      timestamp: new Date().toISOString(),
      type: eventType,
      hook: 'gate-developer-git',
      agent_role: role,
      command: command.slice(0, 200),
      violation_type: violation.id,
      description: violation.description,
      session_id: event.session_id || null,
      target_repo: targetDir,
      is_main_checkout: mainCheckout,
    });

    process.stderr.write(
      '[orchestray] gate-developer-git: BLOCKED — ' + (role || 'unknown') +
      ' attempted forbidden git command: ' + violation.id + ': ' + violation.description + '.\n' +
      'Command: ' + command.slice(0, 120) + '\n' +
      'Kill switch: ORCHESTRAY_GIT_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: eventType + ':' + violation.id,
    }));
    process.exit(2);
  });
}

module.exports = {
  findForbiddenPattern,
  resolveRole,
  FORBIDDEN_PATTERNS,
  READ_ONLY_ROLES,
  isMainCheckout,
  extractGitCDir,
  splitChained,
};

if (require.main === module) {
  main();
}
