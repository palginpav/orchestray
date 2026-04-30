#!/usr/bin/env node
'use strict';

/**
 * gate-role-write-paths.js — PreToolUse(Write|Edit|MultiEdit) hook (v2.2.9 B-2.4).
 *
 * Enforces per-role write-path allowlists. Replaces 5 prose prohibitions with
 * one mechanical gate.
 *
 * Gated roles: reviewer, tester, documenter, release-manager, debugger.
 * Ungated roles: developer, architect, inventor, refactorer, etc.
 *
 * Kill switch: ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1 — disables all checks.
 *
 * Role is read from spawn context injected by inject-delegation-delta.js or
 * from the `agent_role` / `subagent_type` key on the hook event.
 *
 * Contract:
 *   - exit 2 + emit role_write_path_blocked when out-of-scope write is attempted
 *   - exit 0 always otherwise (fail-open on unexpected errors)
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { writeEvent }         = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }    = require('./_lib/constants');
const { recordDegradation }  = require('./_lib/degraded-journal');
const { ROLE_WRITE_ALLOWLISTS, RESTRICTED_ROLES } = require('./_lib/role-write-allowlists');

// ---------------------------------------------------------------------------
// Glob-to-regex converter (no dependencies — minimatch is not in scope).
// Supports: ** (any segments), * (within one segment), plain strings.
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a RegExp.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  // Escape regex metacharacters except * and ?.
  let regStr = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*\*/g, '\x00')              // sentinel for **
    .replace(/\*/g, '[^/]*')              // * → any segment chars
    .replace(/\x00/g, '.*');              // ** → any chars (incl. /)
  // Anchor: must match full (relative) path, possibly with leading ./
  return new RegExp('^(?:\\./)?' + regStr + '$');
}

const _compiledAllowlists = {};

/**
 * Get the compiled (RegExp[]) allowlist for a role.
 *
 * @param {string} role
 * @returns {RegExp[]}
 */
function getAllowlistRegexes(role) {
  if (_compiledAllowlists[role]) return _compiledAllowlists[role];
  const patterns = ROLE_WRITE_ALLOWLISTS[role] || [];
  _compiledAllowlists[role] = patterns.map(globToRegex);
  return _compiledAllowlists[role];
}

/**
 * Check whether a candidate path is allowed for the given role.
 *
 * @param {string} role
 * @param {string} candidatePath - Relative path from project root.
 * @returns {boolean}
 */
function isPathAllowed(role, candidatePath) {
  const regexes = getAllowlistRegexes(role);
  for (const rx of regexes) {
    if (rx.test(candidatePath)) return true;
  }
  return false;
}

/**
 * Extract the write target path from the hook event's tool_input.
 * Handles Write, Edit, and MultiEdit shapes.
 *
 * @param {object} toolInput
 * @returns {string|null}
 */
function extractTargetPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  // Write: {file_path: string}
  // Edit:  {file_path: string}
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;

  // MultiEdit: {edits: [{file_path, ...}]}
  if (Array.isArray(toolInput.edits) && toolInput.edits.length > 0) {
    const first = toolInput.edits[0];
    if (first && typeof first.file_path === 'string') return first.file_path;
  }

  return null;
}

/**
 * Resolve agent role from the hook event. Checks several known keys in order.
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
      // FN-26 (v2.2.15): strip control characters only. Whitespace was being
      // stripped previously (`[\s\x00-\x1F]+` removed both internal whitespace
      // AND control bytes), but Claude Code never sends roles with whitespace —
      // the prior over-aggressive normalisation could only mask upstream
      // schema bugs. Trimming + control-char removal is the right discipline.
      return c.trim().toLowerCase().replace(/[\x00-\x1F]+/g, '');
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
        detail: { hook: 'gate-role-write-paths', err: String(err && err.message || err).slice(0, 80) },
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
    // Kill switch: global disable.
    if (process.env.ORCHESTRAY_ROLE_WRITE_GATE_DISABLED === '1') {
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

    const role = resolveRole(event);
    if (!role || !RESTRICTED_ROLES.has(role)) {
      // Not a gated role — pass through.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const targetPath = extractTargetPath(event.tool_input);
    if (!targetPath) {
      // Can't determine target — fail-open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    // Normalize path: make relative to project root.
    let relPath;
    try {
      const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
      relPath = path.relative(cwd, abs);
    } catch (_) {
      relPath = targetPath;
    }

    if (isPathAllowed(role, relPath)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Out-of-scope write — block.
    emitAuditEvent(cwd, {
      timestamp: new Date().toISOString(),
      type: 'role_write_path_blocked',
      hook: 'gate-role-write-paths',
      agent_role: role,
      attempted_path: relPath,
      allowlist_matched: false,
      allowlist: ROLE_WRITE_ALLOWLISTS[role] || [],
      session_id: event.session_id || null,
    });

    process.stderr.write(
      '[orchestray] gate-role-write-paths: BLOCKED — ' + role + ' attempted to write "' + relPath + '" ' +
      'which is outside its allowed paths ' + JSON.stringify(ROLE_WRITE_ALLOWLISTS[role] || []) + '.\n' +
      'Kill switch: ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({ continue: false, reason: 'role_write_path_blocked:' + role }));
    process.exit(2);
  });
}

module.exports = {
  isPathAllowed,
  extractTargetPath,
  resolveRole,
  globToRegex,
};

if (require.main === module) {
  main();
}
