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
 * Kill switch: ORCHESTRAY_GIT_GATE_DISABLED=1 — disables all checks (subsumes
 * FN-46 and FN-48).
 *
 * Contract:
 *   - exit 2 + emit developer_git_violation when a forbidden pattern is matched
 *   - exit 0 always otherwise (fail-open on unexpected errors)
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { writeEvent }        = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

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
];

/**
 * Find any forbidden pattern in a bash command string for the given role.
 *
 * @param {string} command
 * @param {string} role - resolved agent role (lower-case)
 * @returns {{id: string, description: string}|null}
 */
function findForbiddenPattern(command, role) {
  if (typeof command !== 'string') return null;
  const targetRole = (typeof role === 'string' ? role.toLowerCase() : '') || 'developer';
  for (const pattern of FORBIDDEN_PATTERNS) {
    const allowedRoles = Array.isArray(pattern.roles) ? pattern.roles : ['developer'];
    if (!allowedRoles.includes(targetRole)) continue;
    if (pattern.regex.test(command)) {
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

    // FN-48 (v2.2.15): also gate the release-manager role.
    const role = resolveRole(event);
    if (role !== 'developer' && role !== 'release-manager') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const command = (event.tool_input && typeof event.tool_input.command === 'string')
      ? event.tool_input.command
      : '';
    if (!command) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const violation = findForbiddenPattern(command, role);
    if (!violation) {
      // FN-46 follow-up (W9 F-3): emit a hint-only WARN when a developer/
      // release-manager pipes a commit message from a file (`git commit -F
      // <path>`). The regex cannot inspect file contents, so we cannot block
      // on the same trailer rules; the advisory reminds the agent that
      // inline `-m` is preferred per feedback_commit_style.md, but the spawn
      // is allowed to proceed.
      if (/\bgit\s+commit\b[^|;&\n]*?-F\b/.test(command)) {
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

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    emitAuditEvent(cwd, {
      timestamp: new Date().toISOString(),
      type: 'developer_git_violation',
      hook: 'gate-developer-git',
      agent_role: role,
      command: command.slice(0, 200),
      violation_type: violation.id,
      description: violation.description,
      session_id: event.session_id || null,
    });

    process.stderr.write(
      '[orchestray] gate-developer-git: BLOCKED — ' + role + ' attempted forbidden git command: ' +
      violation.id + ': ' + violation.description + '.\n' +
      'Command: ' + command.slice(0, 120) + '\n' +
      'Kill switch: ORCHESTRAY_GIT_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'developer_git_violation:' + violation.id,
    }));
    process.exit(2);
  });
}

module.exports = {
  findForbiddenPattern,
  resolveRole,
  FORBIDDEN_PATTERNS,
};

if (require.main === module) {
  main();
}
