#!/usr/bin/env node
'use strict';

/**
 * sweep-orphaned-agents-on-pm-stop.js — Stop hook (PM-level), v2.3.29 Fix C.
 *
 * See `bin/_lib/orphan-agent-sweep.js` for the full design rationale (why
 * `reconciled_orphan` had zero writers, the quiescence threshold, and the
 * fail-toward-not-quiescent liveness policy). This file is the thin
 * hook-payload/kill-switch wrapper, mirroring
 * `bin/sweep-dirty-worktrees-on-pm-stop.js`.
 *
 * Kill switch: ORCHESTRAY_ORPHAN_AGENT_SWEEP_DISABLED=1
 *
 * Fail-open contract: every error path is swallowed and this script always
 * exits 0 so it never blocks PM shutdown.
 */

const { resolveSafeCwd }      = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }     = require('./_lib/constants');
const { readHookInputRaw }    = require('./_lib/hook-stdin');
const { sweepOrphanedAgents } = require('./_lib/orphan-agent-sweep');

function logStderr(msg) {
  try { process.stderr.write('[orchestray/orphan-agent-sweep] ' + msg + '\n'); } catch (_e) {}
}

if (process.env.ORCHESTRAY_ORPHAN_AGENT_SWEEP_DISABLED === '1') {
  process.exit(0);
}

let _stdinBuffer = '';
_stdinBuffer = readHookInputRaw();
if (_stdinBuffer.length > MAX_INPUT_BYTES) {
  logStderr('stdin exceeded MAX_INPUT_BYTES; aborting');
  process.exit(0);
}

setImmediate(() => {
  let event = {};
  try {
    event = JSON.parse(_stdinBuffer);
  } catch (_e) {
    // Malformed stdin — fail-open with empty event.
  }

  const cwd = resolveSafeCwd(event && event.cwd);

  try {
    const result = sweepOrphanedAgents(cwd);
    if (result.ran && (result.reconciled > 0)) {
      logStderr('sweep: scanned=' + result.scanned + ' reconciled=' + result.reconciled + ' elapsedMs=' + result.elapsedMs);
    }
  } catch (_e) {
    logStderr('sweep threw: ' + (_e && _e.message ? _e.message : _e));
  }

  process.exit(0);
});
