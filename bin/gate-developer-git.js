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
 * Kill switch: ORCHESTRAY_GIT_GATE_DISABLED=1 — disables all checks.
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
  },
  {
    id: 'hard_reset_origin',
    // git reset --hard origin/<anything>
    regex: /\bgit\s+reset\s+--hard\s+origin\//,
    description: 'git reset --hard origin/<branch> is forbidden for developer agents',
  },
  {
    id: 'release_commit',
    // git commit -m "release: ..." or git commit -m 'release: ...'
    regex: /\bgit\s+commit\b[^|;&\n]*?-m\s+['"]release:/,
    description: 'release: commits are owned by release-manager, not developer',
  },
];

/**
 * Find any forbidden pattern in a bash command string.
 *
 * @param {string} command
 * @returns {{id: string, description: string}|null}
 */
function findForbiddenPattern(command) {
  if (typeof command !== 'string') return null;
  for (const pattern of FORBIDDEN_PATTERNS) {
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

    // Only gate the developer role.
    const role = resolveRole(event);
    if (role !== 'developer') {
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

    const violation = findForbiddenPattern(command);
    if (!violation) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    emitAuditEvent(cwd, {
      timestamp: new Date().toISOString(),
      type: 'developer_git_violation',
      hook: 'gate-developer-git',
      agent_role: 'developer',
      command: command.slice(0, 200),
      violation_type: violation.id,
      description: violation.description,
      session_id: event.session_id || null,
    });

    process.stderr.write(
      '[orchestray] gate-developer-git: BLOCKED — developer attempted forbidden git command: ' +
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
