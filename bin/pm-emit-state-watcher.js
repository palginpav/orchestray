#!/usr/bin/env node
'use strict';

/**
 * pm-emit-state-watcher.js — PostToolUse:Edit|Write|MultiEdit hook entry
 * (v2.2.9 B-8).
 *
 * Thin CLI wrapper around `bin/_lib/pm-emit-state-watcher.js`. Reads the
 * Claude Code PostToolUse JSON payload on stdin, hands it to `processEdit()`,
 * always exits 0.
 *
 * Mechanical backstop for 4 prose-only PM emits identified in W1
 * (F-PM-7 / F-PM-9 / F-PM-12 / F-PM-21). When the PM forgets to emit
 * `tier2_invoked`, `pattern_roi_snapshot`, `verify_fix_start`, or
 * `consequence_forecast` after mutating the corresponding state file,
 * this hook fires it on the PM's behalf and emits
 * `pm_emit_backstop_engaged` so the drift is observable.
 *
 * Kill switch: `ORCHESTRAY_PM_EMIT_WATCHER_DISABLED=1`.
 *
 * Fail-open: any error → stderr + exit 0. Never blocks Claude Code.
 */

const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { processEdit }       = require('./_lib/pm-emit-state-watcher');

// Always emit the continue envelope first so a mid-stream abort still
// produces a valid hook response.
process.stdout.write(JSON.stringify({ continue: true }));

(async () => {
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        process.stderr.write('[pm-emit-state-watcher] stdin too large; skipping\n');
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return;

    let event;
    try { event = JSON.parse(raw); }
    catch (_e) {
      process.stderr.write('[pm-emit-state-watcher] invalid JSON on stdin\n');
      return;
    }

    processEdit(event);
  } catch (e) {
    process.stderr.write('[pm-emit-state-watcher] uncaught: ' + (e && e.message) + '\n');
  }
})();
