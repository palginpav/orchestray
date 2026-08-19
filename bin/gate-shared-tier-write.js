#!/usr/bin/env node
'use strict';

/**
 * gate-shared-tier-write.js — PreToolUse(Write|Edit|MultiEdit) hook (v2.3.30 W1 D7).
 *
 * Blocks any subagent from writing the cross-project shared tier
 * (~/.orchestray/shared/patterns/) directly with Write/Edit/MultiEdit. The
 * ONLY sanctioned write path is mcp__orchestray__pattern_promote, which runs
 * the full sanitization pipeline before touching the filesystem. Without this
 * gate the curator (or any other agent) can bypass sanitization entirely by
 * calling Write on the shared dir, which is exactly how all 72 pre-W1 shared
 * files ended up unsanitized.
 *
 * Scope: fires only when the hook event carries an agent role. A top-level
 * operator session (no role) is NEVER blocked — the operator must retain the
 * ability to hand-edit their own shared tier.
 *
 * Kill switches:
 *   - ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED=1
 *   - .orchestray/config.json -> shared_tier_write_gate.enabled: false
 * Default: ON.
 *
 * Contract:
 *   - exit 2 + emit shared_tier_write_blocked when a role attempts a direct
 *     write under the resolved shared root.
 *   - exit 0 in every other case (fail-open on unexpected errors, no shared
 *     dir configured, federation disabled, unparseable JSON).
 *   - Fail CLOSED on stdin overflow (MAX_INPUT_BYTES) — this is a security
 *     gate; an oversized payload must not pass silently.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { resolveRole, extractTargetPaths } = require('./gate-role-write-paths');

/**
 * Resolve the shared-tier root directory (the parent of the patterns dir), or
 * null if federation/shared-dir is not configured. Never throws.
 *
 * @returns {string|null}
 */
function resolveSharedRoot() {
  try {
    // Lazy require: this module belongs to the MCP-server surface (owned by
    // a parallel workstream); we only ever read its exported resolver here.
    const { getSharedPatternsDir } = require('./mcp-server/lib/paths.js');
    const patternsDir = getSharedPatternsDir();
    if (!patternsDir || typeof patternsDir !== 'string') return null;
    const root = path.dirname(patternsDir);
    try {
      // Resolve symlinks when the path already exists so a symlinked shared
      // dir can't be used to dodge the containment check.
      return fs.realpathSync(root);
    } catch (_e) {
      return path.resolve(root);
    }
  } catch (_e) {
    return null;
  }
}

/**
 * Boundary-safe containment check: `target` is under `root` iff it equals
 * `root` or starts with `root + path.sep`. A plain string `startsWith(root)`
 * would let `~/.orchestray/shared-old/` slip through a check for
 * `~/.orchestray/shared` — this does not.
 *
 * @param {string} target - absolute, resolved path
 * @param {string} root   - absolute, resolved path
 * @returns {boolean}
 */
function isUnderRoot(target, root) {
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

/**
 * Resolve a candidate write-target path to an absolute, symlink-resolved
 * form for the containment check. Falls back to path.resolve() when the
 * target doesn't exist yet (a new file under an existing shared dir).
 *
 * @param {string} targetPath
 * @param {string} cwd
 * @returns {string}
 */
function resolveTarget(targetPath, cwd) {
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  try {
    return fs.realpathSync(abs);
  } catch (_e) {
    return path.resolve(abs);
  }
}

/**
 * Read the local kill switch from .orchestray/config.json without depending
 * on the config-schema module (owned by another workstream; unknown top-level
 * keys are advisory pass-throughs there anyway). Defaults to enabled=true.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isGateEnabledInConfig(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.shared_tier_write_gate &&
      typeof parsed.shared_tier_write_gate === 'object' &&
      parsed.shared_tier_write_gate.enabled === false
    ) {
      return false;
    }
  } catch (_e) {
    // Missing/unparseable config -> gate stays on (fail-open on config read,
    // fail-closed on the actual security decision below).
  }
  return true;
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
        detail: { hook: 'gate-shared-tier-write', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) {}
  }
}

function main() {
  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    // Security gate: fail CLOSED on stdin overflow — an oversized payload
    // could bury a shared-tier write target past the parse window.
    process.stderr.write(
      '[orchestray] gate-shared-tier-write: BLOCKED — stdin exceeded ' +
      MAX_INPUT_BYTES + ' bytes; failing closed (security gate).\n' +
      'Kill switch: ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'shared_tier_write_gate_input_overflow',
    }));
    process.exit(2);
  }

  setImmediate(() => {
    if (process.env.ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED === '1') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      // Unparseable JSON -> fail open. A crashing/confused hook must never
      // wedge unrelated writes.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    if (!isGateEnabledInConfig(cwd)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Operator (top-level) sessions carry no role and are never blocked.
    const role = resolveRole(event);
    if (!role) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const targetPaths = extractTargetPaths(event.tool_input);
    if (targetPaths.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const sharedRoot = resolveSharedRoot();
    if (!sharedRoot) {
      // No shared dir configured / federation disabled -> nothing to guard.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    for (const targetPath of targetPaths) {
      let resolvedTarget;
      try {
        resolvedTarget = resolveTarget(targetPath, cwd);
      } catch (_e) {
        continue; // Can't resolve this one -> don't block on it.
      }

      if (!isUnderRoot(resolvedTarget, sharedRoot)) continue;

      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'shared_tier_write_blocked',
        hook: 'gate-shared-tier-write',
        agent_role: role,
        tool_name: event.tool_name || null,
        attempted_path: resolvedTarget,
        session_id: event.session_id || null,
      });

      process.stderr.write(
        '[orchestray] gate-shared-tier-write: BLOCKED — ' + role + ' attempted to write "' +
        resolvedTarget + '" directly under the shared tier (' + sharedRoot + ').\n' +
        'The shared tier may only be written via mcp__orchestray__pattern_promote, which runs ' +
        'the sanitization pipeline before writing.\n' +
        'Kill switch: ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({
        continue: false,
        reason: 'shared_tier_write_blocked:' + role,
      }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  resolveSharedRoot,
  isUnderRoot,
  resolveTarget,
  isGateEnabledInConfig,
};

if (require.main === module) {
  main();
}
