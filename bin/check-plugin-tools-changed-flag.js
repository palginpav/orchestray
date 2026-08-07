#!/usr/bin/env node
'use strict';

/**
 * check-plugin-tools-changed-flag.js — UserPromptSubmit hook (v2.3.0 W-LISTCH-2).
 *
 * Fallback path for the dual-strategy plugin-tools-changed detection.
 * When bin/_lib/plugin-loader.js mutates the plugin overlay mid-session,
 * it writes a sentinel at .orchestray/state/plugin-tools-changed.flag.
 * This hook fires on every UserPromptSubmit, detects the flag, emits a
 * "Restart Claude Code" advisory as additionalContext, and removes the flag
 * so the hint fires exactly once per session.
 *
 * Kill switch: config key plugin_loader.restart_flag_check === false in
 * .orchestray/config.json disables the check (default-on when key absent).
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: exit 0 always.
 *         When flag present: hookSpecificOutput.additionalContext on stdout.
 *         When flag absent or error: no output.
 */

const fs   = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES }  = require('./_lib/constants');
const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { readHookInputRaw } = require('./_lib/hook-stdin');

const FLAG_REL_PATH = path.join('.orchestray', 'state', 'plugin-tools-changed.flag');

/**
 * Resolve the canonical project root for flag lookup (v2.3.7 path-unification,
 * BUG-1 secondary fix). The MCP server writes the flag under
 * paths.getProjectRoot() (CLAUDE_PROJECT_DIR → `.orchestray` walk-up). This
 * hook MUST read from the SAME directory or the banner never fires (or fires on
 * a stale file). We mirror that precedence here:
 *   1. CLAUDE_PROJECT_DIR, if it contains a `.orchestray/` dir.
 *   2. Walk up from the hook's resolved cwd looking for `.orchestray/`.
 *   3. Fall back to resolveSafeCwd(event.cwd) (legacy behavior, fail-open).
 * @param {string|undefined|null} eventCwd
 * @returns {string}
 */
function resolveFlagRoot(eventCwd) {
  // Step 1: CLAUDE_PROJECT_DIR (same hint Claude Code feeds the server).
  const fromClaude = process.env.CLAUDE_PROJECT_DIR;
  if (fromClaude && fromClaude.length > 0) {
    try {
      const resolved = path.resolve(fromClaude);
      if (fs.existsSync(path.join(resolved, '.orchestray'))) return resolved;
    } catch (_e) { /* fall through */ }
  }
  // Step 2: walk up from the resolved cwd for a `.orchestray/` marker.
  // F3 (v2.3.9): exclude $HOME from the walk-up hit. `~/.orchestray/` is the
  // GLOBAL Orchestray state dir, not a project root. Accepting $HOME as a
  // project root causes every CLAUDE_PROJECT_DIR-unset session in an
  // unrelated cwd to read/write $HOME/.orchestray/ — which contains the
  // pre-fix orphan flag (and, more broadly, misroutes all state writes to
  // the global dir instead of the project dir). A project's `.orchestray`
  // is always inside the project tree, never literally at `$HOME`.
  const homeDir = (() => {
    try { return path.resolve(process.env.HOME || require('os').homedir()); } catch (_e) { return null; }
  })();
  const base = resolveSafeCwd(eventCwd);
  try {
    let dir = path.resolve(base);
    // Bounded walk (depth cap mirrors the server's walkUpFor safety).
    for (let i = 0; i < 64; i++) {
      // Skip $HOME itself — its .orchestray is the global state dir, not a project.
      const isHome = homeDir !== null && dir === homeDir;
      if (!isHome && fs.existsSync(path.join(dir, '.orchestray'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (_e) { /* fall through */ }
  // Step 3: fail-open to the resolved cwd.
  return base;
}

// ─── Stdin reader ─────────────────────────────────────────────────────────────

let input = '';
input = readHookInputRaw();
if (input.length > MAX_INPUT_BYTES) {
  process.exit(0);
}
setImmediate(() => {
  try {
    const event = JSON.parse(input || '{}');
    handleUserPromptSubmit(event);
  } catch (_e) {
    process.exit(0);
  }
});

// ─── Main handler ─────────────────────────────────────────────────────────────

function handleUserPromptSubmit(event) {
  try {
    // Resolve the SAME root the MCP server writes the flag under (v2.3.7
    // path-unification). The kill-switch config is read from the same root.
    const cwd      = resolveFlagRoot(event && event.cwd);
    const flagPath = path.join(cwd, FLAG_REL_PATH);

    // Kill switch: plugin_loader.restart_flag_check === false → no-op
    if (isKillSwitchActive(cwd)) {
      process.exit(0);
      return;
    }

    // No flag → nothing to do
    if (!fs.existsSync(flagPath)) {
      process.exit(0);
      return;
    }

    // F3 (v2.3.9): self-heal for orphan flags.
    // A pre-fix (< v2.3.8) boot wrote this flag even for non-mutation events;
    // such flags can survive for weeks if no session reads them. A flag older
    // than 7 days is definitionally stale (v2.3.8 servers do not re-write it
    // on boot, so no legitimate flag should ever be that old). Delete silently
    // without emitting the banner — the user's session is not affected.
    const FLAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    try {
      const st = fs.statSync(flagPath);
      if (Date.now() - st.mtimeMs > FLAG_MAX_AGE_MS) {
        try { fs.unlinkSync(flagPath); } catch (_e) { /* ignore */ }
        process.exit(0);
        return;
      }
    } catch (_statErr) { /* flag may have just been removed; fall through */ }

    // Delete flag first so we don't re-fire if emission fails mid-way.
    // Ignore unlink errors — flag may have been removed by a concurrent process.
    try { fs.unlinkSync(flagPath); } catch (_e) { /* ignore */ }

    const msg =
      '[orchestray] Plugin tools changed mid-session. ' +
      'Restart Claude Code (or run /orchestray:plugin reload) to refresh the tool list.';

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: msg,
        },
      }) + '\n',
      () => process.exit(0)
    );
  } catch (_e) {
    // Fail-open
    process.exit(0);
  }
}

// ─── Config kill switch ───────────────────────────────────────────────────────

/**
 * Return true when config explicitly disables restart_flag_check.
 * Default-on: absent key or any non-false value → check is active.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isKillSwitchActive(cwd) {
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    if (!fs.existsSync(configPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const pl = parsed && parsed.plugin_loader;
    return pl && pl.restart_flag_check === false;
  } catch (_e) {
    return false; // fail-open
  }
}

module.exports = { isKillSwitchActive, FLAG_REL_PATH };
