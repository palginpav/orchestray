#!/usr/bin/env node
'use strict';

/**
 * flush-dossier-on-session-end.js — SessionEnd hook (v2.3.18 W3, new).
 *
 * `SessionEnd` is a documented, previously-unused Claude Code hook event
 * firing on session termination with a `reason` field: `clear`, `resume`,
 * `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`
 * (2026-07-platform-capability-gaps.md §4). `Stop` and `PreCompact` already
 * trigger a resilience-dossier flush, but neither covers `/clear` or logout
 * the same way — this is the final flush point so the dossier the PM
 * re-hydrates from after a session-boundary event is as fresh as possible.
 *
 * Reuses `writeDossierSnapshot` from write-resilience-dossier.js unchanged —
 * this hook is a thin trigger, not a reimplementation. All of that function's
 * own gating (resilience.enabled, kill_switch, ORCHESTRAY_RESILIENCE_DISABLED,
 * no-active-orchestration skip, fail-open on any error) applies here too.
 *
 * Kill switch: ORCHESTRAY_SESSION_END_DOSSIER_DISABLED=1 (this hook only —
 * Stop/SubagentStop/PreCompact flushes are unaffected).
 * Config key:  session_end_dossier.enabled (default true)
 *
 * Contract:
 *   - Always exits 0 (SessionEnd is advisory; the session is already ending).
 *   - Fail-open on any internal error.
 *
 * Input:  Claude Code SessionEnd JSON payload on stdin ({ reason, cwd, ... })
 * Output: { continue: true } on stdout; exit 0 always.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { readHookInputRaw }  = require('./_lib/hook-stdin');
const { writeDossierSnapshot } = require('./write-resilience-dossier');

const VALID_REASONS = new Set([
  'clear', 'resume', 'logout', 'prompt_input_exit', 'bypass_permissions_disabled', 'other',
]);

/**
 * Kill switch. Env takes precedence over config.
 * @param {string} cwd
 * @returns {boolean}
 */
function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_SESSION_END_DOSSIER_DISABLED === '1') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    if (cfg && cfg.session_end_dossier && cfg.session_end_dossier.enabled === false) return true;
  } catch (_e) { /* fail-open: treat as enabled */ }
  return false;
}

function main() {
  if (process.env.ORCHESTRAY_SESSION_END_DOSSIER_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let input = '';
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
  setImmediate(() => {
    try {
      let event = {};
      try { event = input.length > 0 ? JSON.parse(input) : {}; } catch (_e) { event = {}; }

      let cwd;
      try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

      if (!isDisabled(cwd)) {
        const reason = VALID_REASONS.has(event.reason) ? event.reason : 'other';
        writeDossierSnapshot(cwd, { trigger: 'session_end:' + reason });
      }
    } catch (_e) {
      // Fail-open — SessionEnd must never throw a hook error at session teardown.
    }
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e) { /* swallow */ }
    process.exit(0);
  });
}

module.exports = { isDisabled, VALID_REASONS };

if (require.main === module) {
  main();
}
