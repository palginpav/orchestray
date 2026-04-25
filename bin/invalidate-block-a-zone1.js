#!/usr/bin/env node
'use strict';

/**
 * invalidate-block-a-zone1.js — Manual Zone 1 invalidation script (R-PIN, v2.1.14).
 *
 * Use case: user edits CLAUDE.md or handoff-contract.md mid-session. Running
 * this script clears the recorded Zone 1 hash so the next compose-block-a.js
 * run mints a fresh breakpoint with the correct content.
 *
 * Also re-enables the auto-disable sentinel if it was set.
 *
 * CLI:
 *   node bin/invalidate-block-a-zone1.js [reason]
 *
 * Emits block_a_zone1_invalidated audit event.
 *
 * Exit codes:
 *   0 — success (or no-op if zones file not found)
 *   1 — unexpected error (still emits audit event if possible)
 */

const fs     = require('fs');
const path   = require('path');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');

const STATE_DIR      = path.join('.orchestray', 'state');
const ZONES_FILE     = 'block-a-zones.json';
const SENTINEL_FILE  = '.block-a-zone-caching-disabled';

// ---------------------------------------------------------------------------
// Audit event helper
// ---------------------------------------------------------------------------

function emitAuditEvent(cwd, eventType, extra) {
  try {
    const entry = Object.assign({ version: 1, type: eventType }, extra);
    writeEvent(entry, { cwd });
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  try {
    const cwd    = resolveSafeCwd(process.env.ORCHESTRAY_CWD || process.cwd());
    const reason = process.argv[2] || 'manual invalidation';

    const stateDir   = path.join(cwd, STATE_DIR);
    const zonesPath  = path.join(stateDir, ZONES_FILE);
    const sentinelPath = path.join(stateDir, SENTINEL_FILE);

    // Read prior hash before clearing
    let priorHash = null;
    try {
      const raw    = fs.readFileSync(zonesPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.zone1_hash) priorHash = parsed.zone1_hash;
    } catch (_e) {
      // No zones file — nothing to invalidate
    }

    if (!priorHash) {
      process.stdout.write('[invalidate-block-a-zone1] No Zone 1 hash stored; nothing to clear.\n');
      process.exit(0);
      return;
    }

    // Clear the Zone 1 hash (write zones file with cleared zone1_hash)
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(zonesPath, 'utf8'));
      } catch (_e) {}

      const updated = Object.assign({}, existing, {
        zone1_hash:   null,
        invalidated_at: new Date().toISOString(),
        invalidation_reason: reason,
      });
      fs.writeFileSync(zonesPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write('[invalidate-block-a-zone1] Failed to clear zones file: ' + err.message + '\n');
      process.exit(1);
      return;
    }

    // Clear auto-disable sentinel if present (re-enable caching)
    let sentinelCleared = false;
    try {
      if (fs.existsSync(sentinelPath)) {
        fs.unlinkSync(sentinelPath);
        sentinelCleared = true;
      }
    } catch (_e) {}

    // Emit audit event
    emitAuditEvent(cwd, 'block_a_zone1_invalidated', {
      reason,
      prior_hash: priorHash.substring(0, 12),
      sentinel_cleared: sentinelCleared,
    });

    process.stdout.write(
      '[invalidate-block-a-zone1] Zone 1 hash cleared (was ' +
      priorHash.substring(0, 8) + '). Reason: ' + reason +
      (sentinelCleared ? ' [sentinel re-enabled]' : '') + '\n' +
      'Next compose-block-a.js run will mint a fresh breakpoint.\n'
    );

    process.exit(0);

  } catch (err) {
    process.stderr.write('[invalidate-block-a-zone1] Unexpected error: ' + err.message + '\n');
    process.exit(1);
  }
}

main();
