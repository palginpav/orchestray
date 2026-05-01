'use strict';

/**
 * install-path-priority.js — pre-fire dual-install dedup (v2.2.21 G3-W1-T1).
 *
 * Single source of truth for the question "should THIS hook script fire from
 * THIS install path right now?". Answer is `false` iff:
 *   1. The caller script lives under the GLOBAL install (`~/.claude/orchestray/...`).
 *   2. AND a LOCAL install (`<projectRoot>/.claude/orchestray/...`) also exists
 *      on disk (project-relative to `process.cwd()`).
 * Otherwise `true`.
 *
 * Closes T2 F-01 (CRITICAL): when both installs are present (the standing
 * configuration per `feedback_update_both_installs.md`), every Claude Code
 * hook event fires the same script TWICE — once via `~/.claude/orchestray/`
 * and once via `<project>/.claude/orchestray/` — 7-30 ms apart. The
 * post-fire `bin/_lib/double-fire-guard.js` catches the SECOND call inside
 * the same Node.js process via its module-scope cache, but each install is a
 * SEPARATE process, so the in-memory cache never sees the sibling fire. The
 * file-backed dedup journal catches it cross-process, but only AFTER the
 * second hook has already done partial work (parsing stdin, reading config,
 * sometimes emitting `audit_event_autofilled` surrogates with null payloads
 * that pollute events.jsonl). Net result: 4× audit-volume amplification,
 * 2-3× duplicate `delegation_delta_emit`, 2× `block_z_emit`, etc.
 *
 * This helper short-circuits the GLOBAL install BEFORE any work happens.
 * Callers wire it as the first thing inside their `process.stdin.on('end',...)`
 * handler (or main entrypoint for non-stdin hooks):
 *
 *   const { shouldFireFromThisInstall } = require('./_lib/install-path-priority');
 *   if (!shouldFireFromThisInstall(__filename)) {
 *     process.exit(0);
 *   }
 *
 * Kill switch:
 *   - ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1 → always returns true
 *     (reverts to v2.2.20 behaviour where both installs fire and the
 *     post-fire guard handles dedup). Documented in KILL_SWITCHES.md
 *     (added in a separate commit; this code-comment is the canonical
 *     spec — KILL_SWITCHES.md is outside this task's write scope).
 *
 * Fail-open: any unexpected exception → returns `true`. We must NEVER
 * silently kill a hook because of a probe error.
 *
 * Resolution rules:
 *   - "GLOBAL install" = canonical `scriptPath` is under
 *     `<homeDir>/.claude/orchestray/` (resolves `~`, follows symlinks).
 *   - "LOCAL install" = `<projectRoot>/.claude/orchestray/` exists where
 *     `<projectRoot>` is `process.cwd()`. We do NOT walk up the directory
 *     tree looking for `.orchestray/` markers — Claude Code always invokes
 *     hooks with cwd == project root. If this assumption changes the
 *     fail-open contract still leaves both installs firing (v2.2.20 baseline).
 *   - When `scriptPath` is under NEITHER install path (e.g. unit-test
 *     fixture or an installer-staging script), we return `true` — this
 *     helper is a deduplicator, not a global gate.
 *   - When `scriptPath` IS under the LOCAL install path: always `true`
 *     (LOCAL is the preferred fire path).
 *   - When `scriptPath` IS under the GLOBAL install path AND no LOCAL
 *     install exists: `true` (GLOBAL is the only install).
 *   - When `scriptPath` IS under the GLOBAL install path AND a LOCAL
 *     install also exists: `false` (suppress this fire; the LOCAL one
 *     will fire and do the work).
 *
 * Symlink handling: we use `fs.realpathSync` on both `scriptPath` and the
 * candidate install roots. If the GLOBAL install is symlinked to LOCAL
 * (a deliberate user-driven dedup config), both canonical paths collapse
 * to the same string and we treat the script as LOCAL — single fire, no
 * suppression needed.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ENV_KILL_SWITCH = 'ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED';

/**
 * Best-effort canonicalization. Returns the input unchanged if realpath
 * fails (file removed mid-flight, permission error, etc.) — failing open
 * here keeps the helper from killing hooks on filesystem hiccups.
 *
 * @param {string} p
 * @returns {string}
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_e) {
    return p;
  }
}

/**
 * Compute the canonical absolute path of the GLOBAL install root, or
 * `null` if the home directory cannot be resolved or the path does not
 * exist on disk.
 *
 * The return value is `<canonical(homeDir)>/.claude/orchestray`. We do
 * NOT require this directory to contain a `bin/` subdir — the existence
 * check happens at the caller via `fs.existsSync(globalRoot)`.
 *
 * @returns {string|null}
 */
function resolveGlobalInstallRoot() {
  let home;
  try {
    home = os.homedir();
  } catch (_e) {
    return null;
  }
  if (!home || typeof home !== 'string') return null;
  const root = path.join(safeRealpath(home), '.claude', 'orchestray');
  return root;
}

/**
 * Compute the canonical absolute path of the LOCAL install root for the
 * project rooted at `cwd`. We do NOT walk up — Claude Code invokes hooks
 * with cwd == project root.
 *
 * @param {string} cwd
 * @returns {string}
 */
function resolveLocalInstallRoot(cwd) {
  return path.join(safeRealpath(cwd), '.claude', 'orchestray');
}

/**
 * Test whether `child` is the same as or nested inside `parent`. Both
 * arguments must already be canonicalized (realpath applied). Path
 * separator-aware so we do not match `/foo/bar-baz/x` against parent
 * `/foo/bar` (a naive `startsWith` would).
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isPathInside(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const sep = path.sep;
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

/**
 * Decide whether the hook script at `scriptPath` should fire from THIS
 * install given the current dual-install layout on disk.
 *
 * @param {string} scriptPath — pass `__filename` from the calling hook.
 * @param {object} [opts]
 * @param {string} [opts.cwd] — defaults to `process.cwd()`. Override
 *   for unit tests; production hooks always use the default.
 * @returns {boolean}
 */
function shouldFireFromThisInstall(scriptPath, opts) {
  // Kill switch: revert to v2.2.20 behaviour (both installs fire; the
  // post-fire guard handles dedup). Documented at top of file; documented
  // for operators in KILL_SWITCHES.md.
  if (process.env[ENV_KILL_SWITCH] === '1') {
    return true;
  }

  try {
    if (!scriptPath || typeof scriptPath !== 'string') return true;

    const cwd = (opts && typeof opts.cwd === 'string' && opts.cwd)
      ? opts.cwd
      : process.cwd();

    const canonicalScript = safeRealpath(scriptPath);
    const globalRoot      = resolveGlobalInstallRoot();
    const localRoot       = resolveLocalInstallRoot(cwd);

    const canonicalLocalRoot  = safeRealpath(localRoot);
    const canonicalGlobalRoot = globalRoot ? safeRealpath(globalRoot) : null;

    const localExists  = fs.existsSync(localRoot);
    const globalExists = canonicalGlobalRoot
      ? fs.existsSync(canonicalGlobalRoot)
      : false;

    // Symlink dedup: if GLOBAL realpath collapses to LOCAL realpath, treat
    // the script as LOCAL — there is only one install on disk.
    if (canonicalGlobalRoot &&
        canonicalLocalRoot &&
        canonicalGlobalRoot === canonicalLocalRoot) {
      return true;
    }

    const inLocal  = isPathInside(canonicalScript, canonicalLocalRoot);
    const inGlobal = canonicalGlobalRoot
      ? isPathInside(canonicalScript, canonicalGlobalRoot)
      : false;

    // Caller is under LOCAL: always fire.
    if (inLocal) return true;

    // Caller is under GLOBAL: fire only if LOCAL doesn't exist.
    if (inGlobal) {
      if (!localExists) return true;
      return false; // both exist → suppress GLOBAL fire
    }

    // Caller is under NEITHER (test fixture, installer staging, etc.):
    // not our problem — fire.
    return true;
  } catch (_e) {
    // Fail-open: a probe error must NEVER kill a hook.
    return true;
  }
}

module.exports = {
  shouldFireFromThisInstall,
  // Internals exported for unit tests only — not a stable contract.
  __internal: {
    resolveGlobalInstallRoot,
    resolveLocalInstallRoot,
    isPathInside,
    safeRealpath,
    ENV_KILL_SWITCH,
  },
};
