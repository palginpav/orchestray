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

const FLAG_REL_PATH = path.join('.orchestray', 'state', 'plugin-tools-changed.flag');

// ─── Stdin reader ─────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.exit(0);
  }
});
process.stdin.on('end', () => {
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
    const cwd      = resolveSafeCwd(event && event.cwd);
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
