#!/usr/bin/env node
'use strict';

/**
 * inject-housekeeper-pending.js — DEPRECATED v2.2.9 B-1.1 SHIM.
 *
 * In v2.2.8 this hook prepended a *prose nudge* to non-housekeeper Agent
 * prompts whenever `.orchestray/state/housekeeper-pending.json` existed.
 * The prose-only enforcement produced ZERO `housekeeper_action` events
 * across 5 v2.2.8 orchestrations (W3 G-1, W4 RCA-1, W1 F-PM-3) — the
 * canonical "prose-only auto-delegation" anti-pattern that the v2.2.9
 * theme exists to kill.
 *
 * v2.2.9 routes the same trigger through the reactive-spawn queue
 * (`bin/spawn-housekeeper-on-trigger.js` writes a synthetic
 * `spawn-requests.jsonl` row with `auto_approve: true`; the existing
 * `bin/process-spawn-requests.js` PreToolUse:Agent hook approves it on
 * the next turn). The prose-nudge step is no longer needed.
 *
 * This file remains as a no-op shim for ONE release (v2.2.9) so that:
 *   - any session still wired to the legacy hooks.json entry continues to
 *     boot cleanly,
 *   - operators who imported the module from a debug script see a clear
 *     deprecation message rather than an unexplained behaviour change.
 *
 * v2.2.10 deletes this file and removes the hooks.json entry.
 *
 * Behaviour: drains stdin, emits `{continue: true}`, exits 0.
 *
 * Output: { continue: true }
 */

const { MAX_INPUT_BYTES } = require('./_lib/constants');

let _warned = false;
function warnDeprecated() {
  if (_warned) return;
  _warned = true;
  // One-shot stderr line per process so logs don't spam.
  process.stderr.write(
    '[inject-housekeeper-pending] DEPRECATED — replaced by spawn-queue ' +
    'path in v2.2.9 (B-1.1). This shim is a no-op and will be removed in v2.2.10.\n'
  );
}

(async () => {
  try {
    // Drain stdin (required so Claude Code does not hit EPIPE).
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) break;
    }
  } catch (_e) { /* fail-open */ }
  warnDeprecated();
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
})();

module.exports = {
  // Exported only for tests asserting the shim is a no-op.
  warnDeprecated,
};
