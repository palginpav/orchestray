#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): not a stdin-reading hook handler. See script header docstring.
'use strict';

/**
 * emit-event-activation-ratio.js — per-orchestration event activation ratio (v2.2.10 N1).
 *
 * What it does
 * ------------
 * Reads the per-orch archived events slice at
 *   `.orchestray/history/<orch_id>/events.jsonl`
 * counts distinct event types that fired at least once, divides by the
 * declared non-optional count from event-schemas.shadow.json, and emits
 * one `event_activation_ratio` row with fields:
 *   numerator, denominator, ratio, dark_count, window_label="per-orch",
 *   orchestration_id.
 *
 * Invoked by
 * ----------
 * Called at the end of `bin/audit-on-orch-complete.js` (extension approach).
 * The caller passes: { cwd, orchId } or leaves the module to resolve them.
 *
 * Kill switch
 * -----------
 * `ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED=1` — exits without emit.
 * Default-on per feedback_default_on_shipping.md.
 *
 * Fail-open
 * ---------
 * Missing archive, bad JSON, unknown shadow → log stderr, exit 0.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { loadShadow, computeRatios } = require('./_lib/firing-audit-roll');
const { writeEvent }                = require('./_lib/audit-event-writer');
const { resolveSafeCwd }            = require('./_lib/resolve-project-cwd');

const KILL_SWITCH = 'ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED';

// ---------------------------------------------------------------------------
// Core logic — exported for tests
// ---------------------------------------------------------------------------

/**
 * Count distinct event types that fired in the per-orch archive.
 *
 * @param {string} archivePath - Absolute path to per-orch events.jsonl
 * @param {string[]} eventTypes - Shadow-declared event types to count
 * @returns {Map<string, number>} event_type → fire count (0 for unfired)
 */
function tallyOrchFires(archivePath, eventTypes) {
  const counts = new Map();
  for (const t of eventTypes) counts.set(t, 0);

  let stat;
  try {
    stat = fs.statSync(archivePath);
  } catch (_e) {
    // Archive absent — return all zeros.
    return counts;
  }
  if (stat.size === 0) return counts;

  let text;
  try {
    text = fs.readFileSync(archivePath, 'utf8');
  } catch (_e) {
    return counts;
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const typeMatch = line.match(/"(?:event|type)"\s*:\s*"([^"]+)"/);
    if (!typeMatch) continue;
    const et = typeMatch[1];
    if (!counts.has(et)) continue;
    counts.set(et, (counts.get(et) || 0) + 1);
  }

  return counts;
}

/**
 * Main entry point — can be called programmatically (by audit-on-orch-complete)
 * or as a standalone script.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]     - Project root (defaults to resolveSafeCwd())
 * @param {string} [opts.orchId]  - orchestration_id (required)
 * @returns {number} 1 if event emitted, 0 otherwise
 */
function run({ cwd: cwdArg, orchId } = {}) {
  if (process.env[KILL_SWITCH] === '1') return 0;

  const cwd = resolveSafeCwd(cwdArg);

  if (!orchId) {
    process.stderr.write('[emit-event-activation-ratio] orchId required\n');
    return 0;
  }

  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');

  // Check archive exists.
  try {
    fs.statSync(archivePath);
  } catch (_e) {
    process.stderr.write(
      `[emit-event-activation-ratio] archive missing: ${archivePath}\n`,
    );
    return 0;
  }

  const shadow = loadShadow(cwd);
  if (!shadow) {
    process.stderr.write('[emit-event-activation-ratio] shadow load failed\n');
    return 0;
  }

  const eventTypes = Array.from(shadow.entries.keys());
  const fireMap    = tallyOrchFires(archivePath, eventTypes);
  const { numerator, denominator, ratio, darkCount } = computeRatios(shadow, fireMap);

  try {
    writeEvent(
      {
        type:             'event_activation_ratio',
        numerator,
        denominator,
        ratio:            Math.round(ratio * 10000) / 10000, // 4 dp
        dark_count:       darkCount,
        window_label:     'per-orch',
        orchestration_id: orchId,
      },
      { cwd },
    );
  } catch (e) {
    process.stderr.write(
      '[emit-event-activation-ratio] writeEvent failed: ' + (e && e.message) + '\n',
    );
    return 0;
  }

  return 1;
}

module.exports = { run, tallyOrchFires };

// ---------------------------------------------------------------------------
// Standalone entry (invoked directly by a hook or test runner)
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw); } catch (_e) { /* ignore */ }
      }
      const cwd    = resolveSafeCwd(payload && payload.cwd);
      const orchId = payload && payload.orchestration_id;
      run({ cwd, orchId });
    } catch (e) {
      process.stderr.write('[emit-event-activation-ratio] standalone error: ' + (e && e.message) + '\n');
    }
    process.exit(0);
  })();
}
