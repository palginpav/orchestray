#!/usr/bin/env node
'use strict';

/**
 * emit-tier2-invoked.js — CLI wrapper for tier2-invoked-emitter.js (R-TGATE-PM, v2.1.15).
 *
 * Emits a `tier2_invoked` audit event for a prompt-only Tier-2 protocol.
 * Called via Bash by the PM agent at each protocol's primary action site,
 * as directed by pm.md section annotations.
 *
 * Unlike the hook-based emit paths (archetype_cache, pattern_extraction),
 * prompt-only protocols cannot call emitTier2Invoked() directly — the PM
 * agent must invoke this script via its Bash tool.
 *
 * Usage:
 *   node bin/emit-tier2-invoked.js --protocol <slug> --signal <text> [--cwd <dir>]
 *
 * Options:
 *   --protocol   Required. Protocol slug (e.g. 'drift_sentinel').
 *   --signal     Required. Human-readable reason the protocol fired.
 *   --cwd        Optional. Project root directory. Defaults to process.cwd().
 *
 * Exit codes:
 *   0  Always (fail-open: any error is swallowed, never blocks PM execution).
 *
 * Kill switches (inherited from tier2-invoked-emitter.js):
 *   ORCHESTRAY_METRICS_DISABLED=1
 *   ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1
 *   config.telemetry.tier2_tracking.enabled === false
 */

const path = require('path');
const { emitTier2Invoked } = require('./_lib/tier2-invoked-emitter');

// ---------------------------------------------------------------------------
// Argument parsing — minimal, no external deps
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--protocol' || a === '--signal' || a === '--cwd') && argv[i + 1]) {
      args[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    const protocol      = (args.protocol || '').trim();
    const trigger_signal = (args.signal   || '').trim();
    const cwd           = path.resolve(args.cwd || process.cwd());

    if (!protocol) {
      // No protocol supplied — nothing to emit. Exit cleanly (fail-open).
      process.exit(0);
    }

    emitTier2Invoked({ cwd, protocol, trigger_signal });
  } catch (_e) {
    // Fail-open: any unexpected error must not block PM execution.
  }
  process.exit(0);
})();
