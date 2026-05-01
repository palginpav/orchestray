#!/usr/bin/env node
'use strict';

/**
 * validate-hook-order.js — SessionStart hook: drift validator for hook-chain ordering.
 *
 * v2.2.13 W3 (G-03): Compares canonical hook order (from hooks/hooks.json in the
 * plugin root) against the live order in the active settings.json. On mismatch per
 * (event, matcher) group, emits `hook_chain_drift_detected` (warn-only, exit 0).
 *
 * This is intentionally WARN-ONLY — SessionStart fires on every launch, and
 * auto-fixing settings.json from a SessionStart hook would interact unpredictably
 * with concurrent sessions. The install-time reorder (G-04, bin/install.js) is the
 * authoritative fix path.
 *
 * Fail-open on any I/O or parse error (per SessionStart hook convention).
 *
 * Kill switch: ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED=1 → exits 0 immediately.
 */

const fs   = require('fs');
const path = require('path');

// Kill switch: bail immediately, no-op.
if (process.env.ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED === '1') {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the script basename from a hook command string.
 * Matches `/bin/<script>` (handles spaces in parent dirs via the /bin/ anchor).
 */
function hookBasename(h) {
  const m = (h.command || '').match(/\/bin\/([^\s"']+)/);
  return m ? path.basename(m[1]) : null;
}

/**
 * Returns true if this hook is an orchestray-origin hook.
 */
function isOurs(h) {
  return (h.command || '').includes('orchestray');
}

/**
 * Find smallest index where canBasenames[i] !== liveBasenames[i], or null if
 * arrays match element-wise but lengths differ → first out-of-bounds index,
 * or null if lengths are equal (exact match case, caller must not call).
 */
function computeDivergenceAt(canBasenames, liveBasenames) {
  for (let i = 0; i < Math.min(canBasenames.length, liveBasenames.length); i++) {
    if (canBasenames[i] !== liveBasenames[i]) return i;
  }
  return canBasenames.length === liveBasenames.length
    ? null
    : Math.min(canBasenames.length, liveBasenames.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(function main() {
  try {
    // Locate the plugin root (directory containing this script → bin/ → parent).
    const pluginRoot = path.resolve(__dirname, '..');

    // Resolve project cwd from stdin (Claude Code passes hook payload as JSON on stdin).
    let cwd = process.cwd();
    try {
      const payload = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
      if (payload && typeof payload.cwd === 'string') cwd = payload.cwd;
    } catch (_) { /* fail-open: use process.cwd() */ }

    // Load canonical hooks from the plugin's hooks/hooks.json.
    const canonicalFile = path.join(pluginRoot, 'hooks', 'hooks.json');
    let canonicalData = {};
    try {
      canonicalData = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
    } catch (_) {
      // Cannot read canonical hooks; nothing to compare.
      process.exit(0);
    }
    const orchestrayHooks = canonicalData.hooks || canonicalData;

    // Load live settings.json. Try project-local first, then global.
    const localSettingsFile  = path.join(cwd, '.claude', 'settings.json');
    const globalSettingsFile = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.claude', 'settings.json'
    );
    let liveSettings = null;
    for (const candidate of [localSettingsFile, globalSettingsFile]) {
      try {
        liveSettings = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        break;
      } catch (_) { /* try next */ }
    }
    if (!liveSettings || !liveSettings.hooks) {
      // No settings.json or no hooks block; nothing to validate.
      process.exit(0);
    }

    // Load writeEvent (best-effort; fail-open if unavailable).
    let writeEvent = null;
    try {
      writeEvent = require('./_lib/audit-event-writer').writeEvent;
    } catch (_) { /* fail-open */ }

    let driftFound = false;

    for (const event of Object.keys(orchestrayHooks)) {
      const liveEntries      = liveSettings.hooks[event] || [];
      const canonicalEntries = orchestrayHooks[event]   || [];

      // Aggregate canonical hooks by (event, matcher) across all canonical entries.
      // hooks.json uses one entry per script for readability, but install.js merges
      // them all into a single entry per matcher in settings.json. Comparing per-entry
      // would always detect false drift for no-matcher groups with multiple entries.
      const canonicalByMatcher = new Map();
      for (const canEntry of canonicalEntries) {
        const key = canEntry.matcher === undefined ? null : canEntry.matcher;
        const existing = canonicalByMatcher.get(key) || [];
        canonicalByMatcher.set(key, existing.concat(canEntry.hooks || []));
      }

      // Aggregate live orchestray hooks by (event, matcher) across all live entries.
      // settings.json may have one entry per canonical group (fresh install preserves
      // the 1-hook-per-entry structure from hooks.json) or one merged entry per matcher
      // (upgrade install). Either way, aggregating gives the right picture.
      const liveByMatcher = new Map();
      for (const liveEntry of liveEntries) {
        const key = liveEntry.matcher === undefined ? null : liveEntry.matcher;
        const existing = liveByMatcher.get(key) || [];
        liveByMatcher.set(key, existing.concat((liveEntry.hooks || []).filter(isOurs)));
      }

      for (const [matcher, canonicalHooks] of canonicalByMatcher) {
        const liveHooks = liveByMatcher.get(matcher);
        if (!liveHooks) continue;

        const canBasenames = canonicalHooks.map(hookBasename).filter(Boolean);
        const liveOurNames = liveHooks.map(hookBasename).filter(Boolean);

        // Already canonical — skip.
        if (JSON.stringify(canBasenames) === JSON.stringify(liveOurNames)) continue;

        driftFound = true;
        const divergenceAt = computeDivergenceAt(canBasenames, liveOurNames);

        if (writeEvent) {
          try {
            writeEvent({
              event_type:          'hook_chain_drift_detected',
              version:             1,
              event,
              matcher:             matcher,
              canonical_basenames: canBasenames,
              live_basenames:      liveOurNames,
              divergence_at_index: divergenceAt,
              schema_version:      1,
            }, { cwd });
          } catch (_) { /* fail-open */ }
        }
      }
    }

    if (driftFound) {
      process.stderr.write(
        '[orchestray] Hook chain order drift detected (warn-only, session is functional). ' +
        'Run `/orchestray:update` to restore canonical order — out-of-order hooks may miss events ' +
        'in future versions. To silence until next install, set ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED=1.\n'
      );
    }

    process.exit(0);
  } catch (_) {
    // Fail-open: any top-level error must not block the session.
    process.exit(0);
  }
})();
