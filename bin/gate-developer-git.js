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
  //
  // v2.3.9 F2: detection uses a tokenizer (extractGitSubcommand) rather than a
  // single regex with an option prefix. The old regex only handled a single `-C`
  // before the subcommand; `git -c k=v stash`, `git --git-dir=X stash`, etc.
  // bypassed it entirely. Now all global options are stripped first so any
  // injection of options before the subcommand is covered.
  {
    id: 'wt_destructive_git',
    // regex field retained for non-wt_destructive_git patterns and as a
    // fallback stub; the actual check uses extractGitSubcommand() — see
    // findForbiddenPattern() which special-cases this id.
    regex: /\bgit\b/,
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
 * v2.3.9 F2: also honors `--git-dir=<x>` / `--git-dir <x>` and `GIT_DIR=<x>` env prefix.
 * When multiple target-redirectors are present, -C takes precedence (it overrides
 * --git-dir for working-tree resolution and is the more common explicit form).
 *
 * @param {string} command
 * @returns {string|null}
 */
function extractGitCDir(command) {
  // -C <path> (quoted or unquoted)
  const mC = command.match(/\bgit(?:\s+(?:-c\s+\S+|-c\S+|--no-pager|-p|--paginate|--namespace(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--git-dir(?:=\S+|\s+\S+)))*\s+-C\s+(['"]?)([^\s'";&|]+)\1/);
  if (mC) return mC[2];
  // --git-dir=<path> or --git-dir <path>
  const mGD = command.match(/\bgit\b[^|;&\n]*?--git-dir[= ](['"]?)([^\s'";&|]+)\1/);
  if (mGD) return null; // --git-dir sets .git path, not work-tree; return null (fail-closed handled separately)
  // GIT_DIR=<path> env prefix
  const mEnv = command.match(/(?:^|\s)GIT_DIR=(['"]?)([^\s'";&|]+)\1\s+git\b/);
  if (mEnv) return null; // same: not a work-tree path
  return null;
}

/**
 * v2.3.9 F2: tokenize a git command segment to extract the subcommand verb.
 * Strips all leading global options before the first non-option token.
 *
 * Global options consumed (per `git help`):
 *   -c <name>=<value>  or  -c<name>=<value>  (config override)
 *   -C <path>          (change directory)
 *   --git-dir[=]<path>
 *   --work-tree[=]<path>
 *   --namespace[=]<ns>
 *   -p / --paginate / --no-pager
 *   --no-replace-objects
 *   --bare / --literal-pathspecs / --glob-pathspecs / --noglob-pathspecs / --icase-pathspecs
 *   GIT_DIR=xxx / GIT_WORK_TREE=xxx env-var prefix tokens
 *
 * Also strips a leading env-var assignment block (VAR=val format).
 *
 * Returns { subcommand: string|null, gitDirRedirected: boolean }
 *   subcommand         — first non-option token after `git`, or null if unparseable
 *   gitDirRedirected   — true when --git-dir/GIT_DIR/GIT_WORK_TREE found (ambiguous target)
 *
 * @param {string} seg — a single (non-chained) command segment
 * @returns {{ subcommand: string|null, gitDirRedirected: boolean }}
 */
function extractGitSubcommand(seg) {
  if (typeof seg !== 'string') return { subcommand: null, gitDirRedirected: false };

  // Tokenise by whitespace, respecting simple quoting (no nested quotes).
  // We parse the token stream manually rather than splitting on /\s+/ so we
  // can handle `--git-dir=/path` (no space) alongside `--git-dir /path`.
  const tokens = [];
  let i = 0;
  while (i < seg.length) {
    // Skip whitespace
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) break;

    // Read one token (simple quote handling: single or double quote wraps content)
    let tok = '';
    const q = seg[i];
    if (q === '"' || q === "'") {
      i++;
      while (i < seg.length && seg[i] !== q) { tok += seg[i++]; }
      if (i < seg.length) i++; // skip closing quote
    } else {
      while (i < seg.length && !/[\s|&;]/.test(seg[i])) { tok += seg[i++]; }
    }
    if (tok) tokens.push(tok);
    // Stop at shell operators
    if (i < seg.length && /[|&;]/.test(seg[i])) break;
  }

  // Strip leading env-var assignments (VAR=val before the git token)
  let ti = 0;
  while (ti < tokens.length && /^\w+=/.test(tokens[ti])) ti++;

  // Find 'git' token
  const gitIdx = tokens.indexOf('git', ti);
  if (gitIdx === -1) return { subcommand: null, gitDirRedirected: false };

  let gitDirRedirected = false;
  // Check env-var prefix tokens for GIT_DIR / GIT_WORK_TREE
  for (let j = ti; j < gitIdx; j++) {
    if (/^GIT_DIR=|^GIT_WORK_TREE=/.test(tokens[j])) gitDirRedirected = true;
  }

  // Consume global options after 'git'
  let j = gitIdx + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    // -c key=val or -ckey=val
    if (t === '-c') { j += 2; continue; }
    if (/^-c\S/.test(t)) { j++; continue; }
    // -C <path>
    if (t === '-C') { j += 2; continue; }
    if (/^-C\S/.test(t)) { j++; continue; }
    // --git-dir[=]path
    if (t === '--git-dir') { j += 2; gitDirRedirected = true; continue; }
    if (/^--git-dir=/.test(t)) { j++; gitDirRedirected = true; continue; }
    // --work-tree[=]path
    if (t === '--work-tree') { j += 2; gitDirRedirected = true; continue; }
    if (/^--work-tree=/.test(t)) { j++; gitDirRedirected = true; continue; }
    // --namespace[=]ns
    if (t === '--namespace') { j += 2; continue; }
    if (/^--namespace=/.test(t)) { j++; continue; }
    // -p / --paginate / --no-pager
    if (t === '-p' || t === '--paginate' || t === '--no-pager') { j++; continue; }
    // --bare, --no-replace-objects, --literal-pathspecs, etc.
    if (/^--(bare|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs)$/.test(t)) { j++; continue; }
    // Unknown option — stop; treat next token as subcommand
    break;
  }

  const subcommand = j < tokens.length ? tokens[j] : null;
  return { subcommand, gitDirRedirected };
}

// Forbidden verb set for wt_destructive_git (mirrors original regex intent).
// stash: blocked except `list` and `show` subcommands.
// clean, restore: always blocked.
// checkout: blocked only with pathspec/-- (file-restore form).
// reset: blocked except --soft.
const WTD_FORBIDDEN_VERBS = new Set(['stash', 'clean', 'restore', 'checkout', 'reset']);

/**
 * Check whether a single (non-chained) git segment triggers wt_destructive_git.
 * Uses the tokenizer for robustness against option-evasion.
 *
 * @param {string} seg
 * @returns {boolean}
 */
function isWtDestructiveGit(seg) {
  // Fast-path: no 'git' word → skip
  if (!/\bgit\b/.test(seg)) return false;

  const { subcommand } = extractGitSubcommand(seg);
  if (!subcommand) return false; // unparseable — fail-open for non-read-only roles;
                                  // read-only fail-close is handled at call site

  if (!WTD_FORBIDDEN_VERBS.has(subcommand)) return false;

  // stash: allow 'list' and 'show' subforms
  if (subcommand === 'stash') {
    // Look for the first non-option token after 'stash'
    const afterStash = seg.match(/\bstash\s+(\S+)/);
    if (afterStash && (afterStash[1] === 'list' || afterStash[1] === 'show')) return false;
    return true;
  }

  // checkout: only block when used as file-restore (with pathspec or --)
  if (subcommand === 'checkout') {
    // Allow plain branch-switch forms; block `checkout -- <file>`, `checkout HEAD -- <file>`, etc.
    if (/\bcheckout\s+(?:--|HEAD\s+--|[0-9a-f]{7,}\s+--|\S.*--[\s$])/.test(seg)) return true;
    // checkout with pathspec but no branch: `git checkout <file>` (ambiguous — block to be safe
    // for read-only, and the original regex did too via the catch-all \S.*--\s form).
    // For non-read-only, only block when a `--` separator is present.
    return /\bcheckout\b.*--/.test(seg);
  }

  // reset: allow --soft
  if (subcommand === 'reset') {
    if (/\breset\s+--soft\b/.test(seg)) return false;
    return true;
  }

  // clean, restore: always blocked
  return true;
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

    // For wt_destructive_git, split chains and use the tokenizer (F2: option-evasion fix).
    if (pattern.id === 'wt_destructive_git') {
      const segments = splitChained(command);
      for (const seg of segments) {
        // Read-only roles: fail-closed on unparseable input (no 'git' or no subcommand after options).
        if (!/\bgit\b/.test(seg)) continue; // segment has no git at all
        const { subcommand, gitDirRedirected } = extractGitSubcommand(seg);
        if (!subcommand) {
          // Unparseable git invocation (e.g. stdin-piped subcommand).
          // Read-only roles fail closed; others fail open.
          const isRO = READ_ONLY_ROLES.has(targetRole);
          if (isRO || context.isMain) return { id: pattern.id, description: pattern.description };
          continue;
        }
        // When --git-dir/GIT_DIR redirect is present, target is ambiguous → fail-closed
        // for read-only roles (same as unparseable).
        if (gitDirRedirected && READ_ONLY_ROLES.has(targetRole)) {
          return { id: pattern.id, description: pattern.description };
        }
        if (isWtDestructiveGit(seg)) return { id: pattern.id, description: pattern.description };
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
  extractGitSubcommand,
  isWtDestructiveGit,
};

if (require.main === module) {
  main();
}
