#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook — reset the context-telemetry cache to a fresh skeleton.
 *
 * Runs on every new Claude Code session start. Truncates the cache and writes
 * a skeleton with the new session_id so the statusline renderer does not show
 * stale counts from a prior session.
 *
 * Fail-open contract: any error → log stderr → exit 0 (never block SessionStart).
 * W3 / v2.0.19 Pillar B.
 */

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { resetCache }     = require('./_lib/context-telemetry-cache');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

/**
 * v2.0.20 hotfix: advisory check that the user-scope `~/.claude/settings.json`
 * wires Orchestray's `bin/statusline.js` as the session-scope `statusLine`.
 * Plugin `settings.json` cannot register a session-scope statusLine (Claude Code
 * honors only `agent` and `subagentStatusLine` from a plugin), so the main-session
 * status bar requires a user-scope entry. Fail-open: any error → silent skip.
 */
function checkUserStatusline() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    let raw;
    try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch (_) { return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    const cmd = parsed && parsed.statusLine && typeof parsed.statusLine.command === 'string'
      ? parsed.statusLine.command
      : '';
    if (cmd.indexOf('orchestray/bin/statusline.js') !== -1) return;
    process.stderr.write('orchestray: status bar not configured at user scope — see README "Enable context status bar"\n');
  } catch (_) {
    // fail-open; never crash SessionStart
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] reset-context-telemetry: stdin exceeded limit; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event  = JSON.parse(input || '{}');
    const cwd    = resolveSafeCwd(event.cwd);
    const sessId = event.session_id || null;

    resetCache(cwd, sessId);
    checkUserStatusline();
  } catch (err) {
    process.stderr.write('[orchestray] reset-context-telemetry: error (fail-open): ' + String(err) + '\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
