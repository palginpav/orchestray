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
const { readHookInputRaw } = require('./_lib/hook-stdin');
const {
  ROLE_WRITE_ALLOWLISTS,
  RESTRICTED_ROLES,
  COMPILED_ALLOWLISTS,
  compileGlob,
  isSubstrateDenied,
  RESTRICTED_WRITE_DENYLIST,
  isWriteRestricted,
} = require('./_lib/role-write-allowlists');

// ---------------------------------------------------------------------------
// Glob-to-regex converter (no dependencies — minimatch is not in scope).
// Compilation lives in `_lib/role-write-allowlists.js` so the unit test can
// inspect the compiled regex map directly. `globToRegex` is re-exported here
// for backward compat with existing call sites.
// ---------------------------------------------------------------------------

const globToRegex = compileGlob;

/**
 * Get the compiled (RegExp[]) allowlist for a role.
 *
 * @param {string} role
 * @returns {RegExp[]}
 */
function getAllowlistRegexes(role) {
  return COMPILED_ALLOWLISTS[role] || [];
}

// ---------------------------------------------------------------------------
// v2.2.21 T8 — pre-allowlist path-traversal hardening (CWE-22).
// ---------------------------------------------------------------------------

// Canonical regex from agents/pm.md §0.5 outcome-probe scan AND
// bin/_lib/sentinel-probes.js _DOTDOT_RE. Three independent uses of the same
// pattern stay in sync because they all describe the same invariant.
const _CHAR_ALLOWLIST_RE = /^[a-zA-Z0-9_./-]+$/;
const _DOTDOT_SEGMENT_RE = /(^|\/)\.\.(\/|$)/;

/**
 * Pre-allowlist path validation. Returns a {ok, reason} envelope.
 *
 * Two rejections, both hard-block — both operate on relPath, the cwd-relative
 * form produced by `path.relative(cwd, path.resolve(cwd, originalTarget))`:
 *   - `invalid_chars`             — relPath contains chars outside [A-Za-z0-9_./-]
 *   - `traversal_segment_present` — relPath contains a `..` path segment
 *
 * Absolute-path inputs are NOT rejected as such — Claude Code's Edit/Write/
 * MultiEdit tools always pass absolute paths in `tool_input.file_path`, so a
 * blanket absolute-path block would make the gate unusable for documenter,
 * tester, reviewer, release-manager, and debugger (the gated roles). What we
 * actually need to catch is traversal — and that is fully covered by the
 * relPath dotdot check: an absolute path inside cwd produces a clean relPath;
 * an absolute path outside cwd (e.g. `/etc/passwd`) produces a relPath that
 * starts with `..` segments and trips `_DOTDOT_SEGMENT_RE`. The role allowlist
 * check then runs as the second gate.
 *
 * Skipped entirely when `ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED=1` is set;
 * the rest of the gate (allowlist enforcement) continues regardless.
 *
 * History: the original v2.2.21 T8 implementation also rejected absolute
 * paths outright as belt-and-suspenders defense-in-depth. v2.3.0 Wave 5
 * removed that block after observing it made all gated roles unable to use
 * Edit/Write (issue surfaced in W-DOC-1, W-DOC-4 documenter spawns). The
 * relPath dotdot check is the load-bearing traversal protection; the
 * absolute-path block was redundant and security-equivalent to its absence
 * given the pre-existing relPath check.
 *
 * @param {string} originalTarget - The raw `tool_input.file_path` value (pre-resolve).
 * @param {string} relPath        - The cwd-relative form derived from originalTarget.
 * @returns {{ok: boolean, reason: string|null}}
 */
function validatePathPreAllowlist(originalTarget, relPath) {
  if (process.env.ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED === '1') {
    return { ok: true, reason: null };
  }
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (!_CHAR_ALLOWLIST_RE.test(relPath)) {
    // v2.3.31 W2: locate the first offending character so the block message
    // can echo the matched fragment instead of a leading slice of relPath.
    const m = /[^a-zA-Z0-9_./-]/.exec(relPath);
    return { ok: false, reason: 'invalid_chars', matchedText: m ? m[0] : relPath, matchIndex: m ? m.index : 0 };
  }
  const dd = _DOTDOT_SEGMENT_RE.exec(relPath);
  if (dd) {
    return { ok: false, reason: 'traversal_segment_present', matchedText: dd[0], matchIndex: dd.index };
  }
  return { ok: true, reason: null };
}

/**
 * Build a bounded excerpt of `text` centered on the matched fragment, marking
 * elision with `…`. Falls back to a marked leading slice when no match
 * location is known.
 *
 * v2.3.31 W2: replaces `String(targetPath).slice(0, 200)`, which could
 * truncate BEFORE the offending traversal segment on a long path, hiding the
 * actual reason for the block.
 *
 * @param {string} text
 * @param {string} [matchedText]
 * @param {number} [matchIndex]
 * @param {number} [radius]
 * @returns {string}
 */
function extractPathFragment(text, matchedText, matchIndex, radius) {
  const r = typeof radius === 'number' ? radius : 40;
  const str = String(text);
  if (typeof matchIndex !== 'number' || matchIndex < 0 || typeof matchedText !== 'string') {
    const MAX = 200;
    return str.length > MAX ? str.slice(0, MAX) + '…' : str;
  }
  const start = Math.max(0, matchIndex - r);
  const end = Math.min(str.length, matchIndex + matchedText.length + r);
  let frag = str.slice(start, end);
  if (start > 0) frag = '…' + frag;
  if (end < str.length) frag = frag + '…';
  return frag;
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
  const all = extractTargetPaths(toolInput);
  return all.length > 0 ? all[0] : null;
}

/**
 * Extract ALL write target paths from the hook event's tool_input.
 * Handles Write, Edit, and MultiEdit shapes.
 *
 * A2 (v2.3.10): MultiEdit carries an `edits[]` array — the gate must check
 * EVERY edit's file_path, not just edits[0]. A MultiEdit whose first edit
 * targets an allowed path but whose later edits target out-of-scope paths
 * previously slipped through. Returns the de-duplicated list of all targets.
 *
 * @param {object} toolInput
 * @returns {string[]}
 */
function extractTargetPaths(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out = [];

  // Write / Edit: {file_path: string}
  if (typeof toolInput.file_path === 'string' && toolInput.file_path) {
    out.push(toolInput.file_path);
  }

  // MultiEdit: {edits: [{file_path, ...}]} — check ALL edits.
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.file_path === 'string' && edit.file_path) {
        out.push(edit.file_path);
      }
    }
  }

  // De-dupe while preserving order.
  return Array.from(new Set(out));
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
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    // A1 (v2.3.10): a security gate MUST fail CLOSED on stdin overflow. An
    // oversized payload could bury an out-of-scope write target past the
    // parse window; block rather than pass.
    process.stderr.write(
      '[orchestray] gate-role-write-paths: BLOCKED — stdin exceeded ' +
      MAX_INPUT_BYTES + ' bytes; failing closed (security gate).\n' +
      'Kill switch: ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'role_write_gate_input_overflow',
    }));
    process.exit(2);
  }
  setImmediate(() => {
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
    // v2.3.31 W9: isWriteRestricted() layers the per-widening kill switch
    // (ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED) on top of RESTRICTED_ROLES
    // membership — a plain RESTRICTED_ROLES.has(role) check would ignore it.
    if (!role || !isWriteRestricted(role)) {
      // Not a gated role — pass through.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // A2 (v2.3.10): check ALL target paths (MultiEdit has many). Block if ANY
    // fails — pre-allowlist traversal hardening OR the role allowlist.
    const targetPaths = extractTargetPaths(event.tool_input);
    if (targetPaths.length === 0) {
      // Can't determine target — fail-open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    for (const targetPath of targetPaths) {
      // Normalize path: make relative to project root.
      let relPath;
      try {
        const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
        relPath = path.relative(cwd, abs);
      } catch (_) {
        relPath = targetPath;
      }

      // v2.2.21 T8 — Pre-allowlist hardening (CWE-22). MUST run BEFORE the
      // allowlist regex check.
      const pre = validatePathPreAllowlist(targetPath, relPath);
      if (!pre.ok) {
        emitAuditEvent(cwd, {
          timestamp: new Date().toISOString(),
          type: 'role_write_path_blocked',
          hook: 'gate-role-write-paths',
          agent_role: role,
          attempted_path: relPath,
          allowlist_matched: false,
          allowlist: ROLE_WRITE_ALLOWLISTS[role] || [],
          reason: pre.reason,
          session_id: event.session_id || null,
        });
        const relFragment = extractPathFragment(relPath, pre.matchedText, pre.matchIndex);
        const targetFragment = extractPathFragment(targetPath);
        const offsetNote = typeof pre.matchIndex === 'number' ? ' (matched at offset ' + pre.matchIndex + ' in relPath)' : '';
        process.stderr.write(
          '[orchestray] gate-role-write-paths: BLOCKED — ' + role + ' attempted to write "' +
          targetFragment + '"; reason=' + pre.reason + offsetNote + '.\n' +
          'Matched fragment (relPath): ' + relFragment + '\n' +
          'Path-traversal hardening: hardcoded reject before allowlist check.\n' +
          'Kill switch (this check only): ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED=1\n' +
          'Kill switch (entire gate):     ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1\n'
        );
        process.stdout.write(JSON.stringify({
          continue: false,
          reason: 'role_write_path_blocked:' + role + ':' + pre.reason,
        }));
        process.exit(2);
      }

      // v2.3.12 W14 (M2): hard-deny the enforcement substrate (agents/*.md,
      // CLAUDE.md) for ALL restricted roles, checked BEFORE the per-role
      // allowlist so no role allowlist can re-grant it.
      if (isSubstrateDenied(relPath)) {
        emitAuditEvent(cwd, {
          timestamp: new Date().toISOString(),
          type: 'role_write_path_blocked',
          hook: 'gate-role-write-paths',
          agent_role: role,
          attempted_path: relPath,
          allowlist_matched: false,
          allowlist: ROLE_WRITE_ALLOWLISTS[role] || [],
          reason: 'substrate_write_denied',
          session_id: event.session_id || null,
        });
        process.stderr.write(
          '[orchestray] gate-role-write-paths: BLOCKED — ' + role + ' attempted to write "' + relPath + '" ' +
          'which is the protected enforcement substrate ' + JSON.stringify(RESTRICTED_WRITE_DENYLIST) + '.\n' +
          'Agent definition prompts (agents/*.md) and CLAUDE.md cannot be written by doc/test/review-tier roles.\n' +
          'Kill switch (this check only): ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED=1\n' +
          'Kill switch (entire gate):     ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1\n'
        );
        process.stdout.write(JSON.stringify({
          continue: false,
          reason: 'role_write_path_blocked:' + role + ':substrate_write_denied',
        }));
        process.exit(2);
      }

      if (isPathAllowed(role, relPath)) continue; // this target ok — check next

      // Out-of-scope write — block (ANY failing target blocks the whole call).
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
    }

    // All targets passed.
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  isPathAllowed,
  extractTargetPath,
  extractTargetPaths,
  resolveRole,
  globToRegex,
  validatePathPreAllowlist,
};

if (require.main === module) {
  main();
}
