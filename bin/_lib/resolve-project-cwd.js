'use strict';

/**
 * Safe cwd resolution for hook scripts (W4 fix).
 *
 * Hook scripts receive `event.cwd` from the Claude Code hook payload. This
 * helper normalizes that input into an absolute path suitable for constructing
 * audit/state paths, with minimal defensive validation.
 *
 * Resolution order:
 *   1. If `eventCwd` is a non-empty string without null bytes, resolve it
 *      to an absolute path and return.
 *   2. Fall back to `process.cwd()` as a fail-open default.
 *
 * Design notes:
 *
 * - Hooks must work on the FIRST run in a fresh project, where no
 *   `.orchestray/` directory exists yet — so we cannot require any on-disk
 *   marker file as a "valid project root" signal. An earlier stricter
 *   implementation of this helper demanded `.orchestray/audit/` pre-exist,
 *   which broke every first-ever hook invocation (and every test that used
 *   a fresh tmpdir). That failure mode silently routed writes to the
 *   ancestor project instead, poisoning audit trails — the exact opposite
 *   of what a "safe" helper should do.
 *
 * - The stronger containment the audit flagged (MED1 in audit-security.md)
 *   would require a mechanism the hook contract doesn't expose: a trusted
 *   "expected project root" known out-of-band. Claude Code's hook payload
 *   IS the source of truth for cwd. Our threat model is a local plugin
 *   with a trusted client — a fully-compromised client can already inject
 *   arbitrary stdin frames and has broader capabilities than redirecting
 *   audit writes.
 *
 * - We do reject input containing null bytes (node fs rejects these with
 *   ENOENT anyway, but catching them here gives a cleaner fallback) and
 *   non-string values. Anything else Claude Code gives us, we trust.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const GIT_COMMON_DIR_TIMEOUT_MS = 3000;

/**
 * Resolve a safe absolute cwd for hook scripts.
 *
 * @param {string|undefined|null} eventCwd - The `cwd` field from the hook payload.
 * @returns {string} An absolute path — either the resolved eventCwd or process.cwd().
 */
function resolveSafeCwd(eventCwd) {
  if (
    typeof eventCwd === 'string' &&
    eventCwd.length > 0 &&
    !eventCwd.includes('\0')
  ) {
    try {
      return path.resolve(eventCwd);
    } catch (_e) {
      // path.resolve is synchronous and essentially cannot throw for valid
      // strings, but belt-and-suspenders: fall through to process.cwd().
    }
  }
  return process.cwd();
}

/**
 * Resolve the MAIN project root for a cwd that may be inside a git worktree
 * (e.g. `.claude/worktrees/<agent>/`).
 *
 * Why this exists (v2.3.28 W1, re-scoped): agent lifecycle hooks fire at
 * three different stages of a spawn, and two of them (SubagentStart,
 * SubagentStop) run with cwd already switched to the worktree, while the
 * third (PreToolUse, which carries the model) runs before the worktree
 * exists. Callers that write agent lifecycle/cost records need ONE cwd for
 * all three stages or the same agent_id splits its transitions across two
 * separate `.orchestray/state/agent-registry.jsonl` files and never
 * resolves. See `.orchestray/kb/decisions/v2328-scope-locked.md` §W1.
 *
 * `git rev-parse --git-common-dir` is git's own answer to "what is the
 * shared repo directory for this checkout" — for an ordinary checkout it is
 * that checkout's own `.git`; for ANY worktree of that checkout (regardless
 * of where it lives or how it's named) it resolves to the SAME path as the
 * main checkout's `.git`. That makes it a more reliable signal than
 * string-matching a `.claude/worktrees/` path convention (which
 * `bin/_lib/dirty-worktree-sweep.js` does for a different purpose — listing
 * known worktree directories to sweep, not resolving an arbitrary cwd back
 * to its main tree). The main root is simply the parent of that path.
 *
 * Fails safe: not a git repo, git absent, or a timeout all fall through to
 * returning `cwd` unchanged — identical to pre-fix behavior. Callers should
 * pass an already-`resolveSafeCwd`-resolved cwd.
 *
 * @param {string} cwd - Absolute cwd (typically the output of resolveSafeCwd).
 * @returns {string} The main project root, or `cwd` if it could not be determined.
 */
function resolveMainProjectRoot(cwd) {
  try {
    const result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: GIT_COMMON_DIR_TIMEOUT_MS },
    );
    if (result.status !== 0 || result.error) return cwd;
    const commonDir = (result.stdout || '').trim();
    if (!commonDir) return cwd;
    const mainRoot = path.dirname(commonDir);
    return mainRoot || cwd;
  } catch (_e) {
    return cwd;
  }
}

module.exports = { resolveSafeCwd, resolveMainProjectRoot };
