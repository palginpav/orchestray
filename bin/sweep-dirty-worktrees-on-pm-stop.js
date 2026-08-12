#!/usr/bin/env node
'use strict';

/**
 * sweep-dirty-worktrees-on-pm-stop.js — Stop hook (PM-level), V3 (v2.3.27).
 *
 * See `bin/_lib/dirty-worktree-sweep.js` for the full design rationale
 * (why this exists independent of `auto-commit-worktree-on-subagent-stop.js`,
 * the quiescence liveness heuristic, and the debounce strategy). This file
 * is the thin hook-payload/kill-switch wrapper around that module.
 *
 * Kill switch: ORCHESTRAY_DIRTY_WORKTREE_SWEEP_DISABLED=1
 *
 * Fail-open contract: every error path is swallowed and this script always
 * exits 0 so it never blocks PM shutdown.
 */

const { resolveSafeCwd }      = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }     = require('./_lib/constants');
const { readHookInputRaw }    = require('./_lib/hook-stdin');
const { sweepDirtyWorktrees } = require('./_lib/dirty-worktree-sweep');

function logStderr(msg) {
  try { process.stderr.write('[orchestray/dirty-worktree-sweep] ' + msg + '\n'); } catch (_e) {}
}

if (process.env.ORCHESTRAY_DIRTY_WORKTREE_SWEEP_DISABLED === '1') {
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
    const result = sweepDirtyWorktrees(cwd);
    if (result.ran && (result.captured > 0 || result.captureFailed > 0 || result.staleDetected > 0)) {
      logStderr(
        'sweep: scanned=' + result.scanned +
        ' captured=' + result.captured +
        ' captureFailed=' + result.captureFailed +
        ' staleDetected=' + result.staleDetected +
        ' elapsedMs=' + result.elapsedMs,
      );
    }
  } catch (_e) {
    logStderr('sweep threw: ' + (_e && _e.message ? _e.message : _e));
  }

  process.exit(0);
});
