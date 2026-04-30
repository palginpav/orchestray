#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
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
 * v2.2.0 (P2.1) extension: with `--watch-pm-md`, also re-checks the four
 * Block-Z component files (agents/pm.md, CLAUDE.md, handoff-contract.md,
 * phase-contract.md) and clears `.orchestray/state/cache-breakpoint-manifest.json`
 * `block_z_hash` if any component drifted. Emits the same `block_a_zone1_invalidated`
 * event, augmented with `block_z_invalidated` and `block_z_components_changed`.
 *
 * CLI:
 *   node bin/invalidate-block-a-zone1.js [reason] [--watch-pm-md]
 *
 * Emits block_a_zone1_invalidated audit event.
 *
 * Exit codes:
 *   0 — success (or no-op if zones file not found)
 *   1 — unexpected error (still emits audit event if possible)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { DEFAULT_COMPONENTS } = require('./_lib/block-z');

const STATE_DIR      = path.join('.orchestray', 'state');
const ZONES_FILE     = 'block-a-zones.json';
const MANIFEST_FILE  = 'cache-breakpoint-manifest.json';
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

/**
 * Compare current Block-Z component file SHAs against the persisted manifest.
 * Returns { changed: string[], hadManifest: boolean, priorBlockZHash: string|null }.
 */
function detectBlockZDrift(cwd) {
  const manifestPath = path.join(cwd, STATE_DIR, MANIFEST_FILE);
  const out = { changed: [], hadManifest: false, priorBlockZHash: null };
  let storedComponents = [];
  try {
    const raw    = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.block_z_components)) {
      storedComponents = parsed.block_z_components;
      out.hadManifest = true;
      if (parsed.block_z_hash) out.priorBlockZHash = parsed.block_z_hash;
    }
  } catch (_e) { /* no manifest yet */ }

  // Always compute current SHAs for the four components.
  const currentByName = {};
  for (const comp of DEFAULT_COMPONENTS) {
    try {
      const abs = path.isAbsolute(comp.rel) ? comp.rel : path.join(cwd, comp.rel);
      const buf = fs.readFileSync(abs);
      currentByName[comp.name] = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (_e) {
      currentByName[comp.name] = null;
    }
  }

  if (!out.hadManifest) return out; // nothing to compare against
  for (const stored of storedComponents) {
    if (!stored || !stored.name) continue;
    const cur = currentByName[stored.name];
    if (cur !== stored.sha) out.changed.push(stored.name);
  }
  return out;
}

/**
 * Clear `block_z_hash` (and reset components) in the persisted manifest.
 * The next compose-block-a run mints a fresh manifest.
 */
function clearManifestBlockZ(cwd) {
  const manifestPath = path.join(cwd, STATE_DIR, MANIFEST_FILE);
  try {
    if (!fs.existsSync(manifestPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    parsed.block_z_hash = null;
    parsed.block_z_components = [];
    parsed.invalidated_at = new Date().toISOString();
    const tmp = manifestPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, manifestPath);
    return true;
  } catch (_e) {
    return false;
  }
}

function main() {
  try {
    const cwd    = resolveSafeCwd(process.env.ORCHESTRAY_CWD || process.cwd());
    const argv   = process.argv.slice(2);
    const watchPmMd = argv.includes('--watch-pm-md');
    const positional = argv.filter((a) => !a.startsWith('--'));
    const reason = positional[0] || 'manual invalidation';

    const stateDir   = path.join(cwd, STATE_DIR);
    const zonesPath  = path.join(stateDir, ZONES_FILE);
    const sentinelPath = path.join(stateDir, SENTINEL_FILE);

    // P2.1 (v2.2.0): if --watch-pm-md, check for Block-Z drift first.
    let blockZInvalidated = false;
    let blockZComponentsChanged = [];
    let priorBlockZHash = null;
    if (watchPmMd) {
      const drift = detectBlockZDrift(cwd);
      if (drift.changed.length > 0) {
        blockZComponentsChanged = drift.changed;
        priorBlockZHash = drift.priorBlockZHash;
        blockZInvalidated = clearManifestBlockZ(cwd);
      }
    }

    // Read prior hash before clearing
    let priorHash = null;
    try {
      const raw    = fs.readFileSync(zonesPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.zone1_hash) priorHash = parsed.zone1_hash;
    } catch (_e) {
      // No zones file — nothing to invalidate
    }

    if (!priorHash && !blockZInvalidated) {
      process.stdout.write('[invalidate-block-a-zone1] No Zone 1 hash stored; nothing to clear.\n');
      process.exit(0);
      return;
    }

    // Clear the Zone 1 hash (write zones file with cleared zone1_hash)
    if (priorHash) {
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
    }

    // Clear auto-disable sentinel if present (re-enable caching)
    let sentinelCleared = false;
    try {
      if (fs.existsSync(sentinelPath)) {
        fs.unlinkSync(sentinelPath);
        sentinelCleared = true;
      }
    } catch (_e) {}

    // Emit audit event (extended in v2.2.0 with optional Block-Z fields)
    emitAuditEvent(cwd, 'block_a_zone1_invalidated', {
      reason,
      prior_hash: priorHash ? priorHash.substring(0, 12) : (priorBlockZHash ? priorBlockZHash.substring(0, 12) : null),
      sentinel_cleared: sentinelCleared,
      block_z_invalidated: blockZInvalidated,
      block_z_components_changed: blockZComponentsChanged,
    });

    process.stdout.write(
      '[invalidate-block-a-zone1] Zone 1 hash cleared' +
      (priorHash ? ' (was ' + priorHash.substring(0, 8) + ')' : ' (no prior hash)') +
      '. Reason: ' + reason +
      (sentinelCleared ? ' [sentinel re-enabled]' : '') +
      (blockZInvalidated ? ' [Block-Z hash cleared: ' + blockZComponentsChanged.join(', ') + ']' : '') +
      '\n' +
      'Next compose-block-a.js run will mint a fresh breakpoint.\n'
    );

    process.exit(0);

  } catch (err) {
    process.stderr.write('[invalidate-block-a-zone1] Unexpected error: ' + err.message + '\n');
    process.exit(1);
  }
}

main();
