'use strict';

/**
 * install-path-priority.js — where the installs are (v2.2.21 G3-W1-T1).
 *
 * Locates the GLOBAL (`~/.claude/orchestray/`) and LOCAL
 * (`<projectRoot>/.claude/orchestray/`) install roots and reports which of them
 * exist. Consumers: the tokenwright self-probe, which reports install topology
 * to the user.
 *
 * ## This file no longer decides whether a hook fires (v2.3.18 W9)
 *
 * It used to own `shouldFireFromThisInstall`: when both installs were present,
 * the GLOBAL copy suppressed itself so the LOCAL one could do the work. That is
 * a PREDICTION about another process, and it was refined five times — presence
 * on disk, then registration in a settings file, then home-prefix expansion,
 * then per-script completeness — each refinement fixing one blackout and
 * opening another. The failure is always the same and always invisible: both
 * installs conclude the other will handle the event, so neither does.
 *
 * Dual-install dedup now happens in `hook-stdin.js#dedupDecision` with an
 * atomic claim file, which observes what actually happened instead of
 * predicting it: whoever claims the payload key first runs, and a lone caller
 * always wins an uncontested claim. Do not reintroduce an install-topology
 * predicate in a firing decision — that is the deleted class of bug.
 *
 * The probes that remain are informational. `resolveActiveInstallBin` still
 * prefers LOCAL when both exist, because for "which copy of this file is the
 * live one?" a preference is an answer, not a guess about a race.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

/**
 * Best-effort canonicalization. Returns the input unchanged if realpath
 * fails (file removed mid-flight, permission error, etc.) — a probe error
 * must degrade to a plain path, never to an exception.
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
 * Returns true iff the GLOBAL install (~/.claude/orchestray/bin/inject-tokenwright.js)
 * exists on disk. v2.2.21 W5-T26 — used by tokenwright self-probe.
 */
function isGlobalInstallPresent() {
  try {
    const fs = require('fs');
    const path = require('path');
    const sentinel = path.join(resolveGlobalInstallRoot(), 'bin', 'inject-tokenwright.js');
    return fs.existsSync(sentinel);
  } catch (_e) {
    return false;
  }
}

/**
 * Returns true iff a LOCAL install
 * (`<projectRoot>/.claude/orchestray/bin/inject-tokenwright.js`) exists on disk.
 * v2.2.21 W5-T26 — accepts an explicit projectRoot so callers can pass
 * process.cwd() or event.cwd. Falls back to process.cwd() if omitted.
 */
function isLocalInstallPresent(projectRoot) {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = projectRoot || process.cwd();
    const sentinel = path.join(root, '.claude', 'orchestray', 'bin', 'inject-tokenwright.js');
    return fs.existsSync(sentinel);
  } catch (_e) {
    return false;
  }
}

/**
 * Resolve the active install bin directory for the given project root.
 * Prefers LOCAL when both are present.
 * v2.2.21 W5-T26 — used by tokenwright self-probe to locate the canonical hook.
 */
function resolveActiveInstallBin(projectRoot) {
  const path = require('path');
  const root = projectRoot || process.cwd();
  if (isLocalInstallPresent(root)) {
    return path.join(root, '.claude', 'orchestray', 'bin');
  }
  if (isGlobalInstallPresent()) {
    return path.join(resolveGlobalInstallRoot(), 'bin');
  }
  return null;
}

module.exports = {
  // v2.2.21 W5-T26 (additive): individual probes for self-probe.js consumers.
  isGlobalInstallPresent,
  isLocalInstallPresent,
  resolveActiveInstallBin,
  // Internals exported for unit tests only — not a stable contract.
  __internal: {
    resolveGlobalInstallRoot,
    safeRealpath,
  },
};
