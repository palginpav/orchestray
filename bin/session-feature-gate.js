#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * session-feature-gate.js — R-GATE-AUTO entry point (W7, v2.1.15).
 *
 * Auto-active replacement for the v2.1.14 shadow-mode advisory. Per locked
 * Q1 decision (aggressive default-on):
 *
 *   1. Default `feature_demand_gate.shadow_mode` is now `false`.
 *   2. On first session under v2.1.15, repos with explicit `shadow_mode: true`
 *      are MIGRATED in-place to `shadow_mode: false` and a one-time stderr
 *      banner names the override and the opt-out path. The banner copy is
 *      verbatim from the v2.1.15 CHANGELOG migration note.
 *   3. When shadow_mode is effectively false, this script auto-populates
 *      `feature_demand_gate.quarantine_candidates` with every wired-emitter
 *      protocol whose 14-day observation window shows zero tier2_invoked
 *      events.
 *   4. With `--dry-run`, the script lists candidates as JSON to stdout and
 *      makes no state changes (config and sentinel both untouched).
 *
 * Usage:
 *   node bin/session-feature-gate.js [--cwd /path] [--dry-run]
 *
 * Kill switches (any → no-op, exit 0):
 *   - process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1'
 *   - config.feature_demand_gate.enabled === false
 *
 * Fail-open: any error → exit 0, never blocks the session.
 *
 * Phase-3 G-OBSV-WINDOW interaction: this script ships in v2.1.15 but tag
 * prep is blocked until `bin/feature-gate-status.js --since v2.1.14-tag`
 * reports observation_days >= 14 (W15 release-manager runs the gate).
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }       = require('./_lib/resolve-project-cwd');
const { writeEvent }           = require('./_lib/audit-event-writer');
const {
  computeDemandReport,
  getEligibleGateSlugs,
  WIRED_EMITTER_PROTOCOLS,
}                               = require('./_lib/feature-demand-tracker');

// ---------------------------------------------------------------------------
// Migration banner — verbatim from v2.1.15 CHANGELOG migration note for
// R-GATE-AUTO. The locked Q1 decision (aggressive default-on) requires that
// the banner explicitly tell users that explicit shadow_mode:true settings
// are overridden, so opt-out users can re-set them after upgrade.
// ---------------------------------------------------------------------------

// Banner copy is duplicated in agents/pm.md §17 (lines 1221-1230) and CHANGELOG.md v2.1.15 entry.
// All three must match verbatim. (W10 F5, W11 F7)
const MIGRATION_BANNER_LINES = [
  '[orchestray] v2.1.15 R-GATE-AUTO: feature_demand_gate.shadow_mode flipped from true to false.',
  '[orchestray]   Your explicit `shadow_mode: true` setting was OVERRIDDEN by the aggressive-default migration.',
  '[orchestray]   Starting now, Orchestray automatically quarantines feature gates that haven\'t fired',
  '[orchestray]   on your repo for 14 days. You\'ll see a session-start banner naming any quarantined',
  '[orchestray]   features. Re-enable any one with `/orchestray:feature wake <name>` (session) or',
  '[orchestray]   `/orchestray:feature wake --persist <name>` (across sessions).',
  '[orchestray]   To fully restore v2.1.14 behavior — two steps required:',
  '[orchestray]   Step 1: set `feature_demand_gate.shadow_mode: true` in `.orchestray/config.json`.',
  '[orchestray]   Step 2: for each quarantined feature listed above, run:',
  '[orchestray]           /orchestray:feature wake --persist <name>',
  '[orchestray]   Skipping Step 2 leaves the feature quarantined even after Step 1.',
];

const MIGRATION_SENTINEL_REL = path.join('.orchestray', 'state', '.r-gate-auto-migration-2115');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let cwd     = process.cwd();
  let dryRun  = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) {
      cwd = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  return { cwd, dryRun };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readConfig(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_e) {
    return {};
  }
}

function writeConfig(cwd, config) {
  try {
    const cfgPath = path.join(cwd, '.orchestray', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Returns the effective shadow_mode for the feature_demand_gate, with the
 * v2.1.15 default applied (false).
 *
 * NOTE: this returns the RAW value from config (with default fallback). The
 * aggressive-default migration in applyMigrationIfNeeded() may overwrite
 * `shadow_mode: true` to `false` — after migration, this returns `false`.
 */
function getShadowMode(config) {
  const fdg = config && config.feature_demand_gate;
  if (!fdg || typeof fdg !== 'object') return false; // v2.1.15 default
  if (typeof fdg.shadow_mode !== 'boolean') return false; // v2.1.15 default
  return fdg.shadow_mode;
}

// ---------------------------------------------------------------------------
// Migration: aggressive default-on flip
// ---------------------------------------------------------------------------

/**
 * On first session under v2.1.15, if config has explicit
 * `feature_demand_gate.shadow_mode: true`, flip it to `false` and emit a
 * one-time stderr banner. Sentinel at .orchestray/state/.r-gate-auto-migration-2115
 * prevents re-emission on subsequent sessions.
 *
 * Returns { migrated: boolean, configMutated: boolean } so the caller can
 * choose to write the mutated config and continue with quarantine logic.
 */
function applyMigrationIfNeeded({ cwd, config, dryRun }) {
  const sentinelPath = path.join(cwd, MIGRATION_SENTINEL_REL);

  // Sentinel already present → migration ran in a prior session.
  if (fs.existsSync(sentinelPath)) {
    return { migrated: false, configMutated: false };
  }

  const fdg = config.feature_demand_gate;
  const hasExplicitTrue = fdg
    && typeof fdg === 'object'
    && fdg.shadow_mode === true;

  if (!hasExplicitTrue) {
    // No explicit shadow_mode:true to override. Still write the sentinel so
    // we don't re-evaluate every session, but skip the banner.
    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
        fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n', 'utf8');
      } catch (_e) {}
    }
    return { migrated: false, configMutated: false };
  }

  // OVERRIDE: flip shadow_mode to false.
  if (dryRun) {
    return { migrated: true, configMutated: false };
  }

  config.feature_demand_gate = Object.assign({}, fdg, { shadow_mode: false });

  // Emit one-time stderr banner.
  for (const line of MIGRATION_BANNER_LINES) {
    process.stderr.write(line + '\n');
  }

  // Audit event (best-effort).
  try {
    writeEvent({
      version: 1,
      type:    'feature_demand_gate_migrated',
      from:    { shadow_mode: true },
      to:      { shadow_mode: false },
      release: 'v2.1.15',
      reason:  'aggressive_default_on_q1',
    }, { cwd });
  } catch (_e) {}

  // Write the sentinel so the banner is one-time.
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n', 'utf8');
  } catch (_e) {}

  return { migrated: true, configMutated: true };
}

// ---------------------------------------------------------------------------
// Quarantine application: union the demand-tracker eligibility set into
// feature_demand_gate.quarantine_candidates. Idempotent.
// ---------------------------------------------------------------------------

function applyQuarantine({ cwd, config, dryRun }) {
  const eligibleSlugs = getEligibleGateSlugs(cwd);

  if (eligibleSlugs.length === 0) {
    return { applied: [], configMutated: false };
  }

  if (dryRun) {
    return { applied: eligibleSlugs, configMutated: false };
  }

  if (!config.feature_demand_gate || typeof config.feature_demand_gate !== 'object') {
    config.feature_demand_gate = {};
  }
  if (!Array.isArray(config.feature_demand_gate.quarantine_candidates)) {
    config.feature_demand_gate.quarantine_candidates = [];
  }

  const before = new Set(config.feature_demand_gate.quarantine_candidates);
  const added  = [];
  for (const slug of eligibleSlugs) {
    if (!before.has(slug)) {
      config.feature_demand_gate.quarantine_candidates.push(slug);
      added.push(slug);
    }
  }

  // Emit one feature_quarantine_applied event per added slug (best-effort).
  for (const slug of added) {
    try {
      writeEvent({
        version:   1,
        type:      'feature_quarantine_applied',
        gate_slug: slug,
        source:    'session_feature_gate_auto',
      }, { cwd });
    } catch (_e) {}
  }

  return { applied: eligibleSlugs, configMutated: added.length > 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  try {
    const { cwd: cwdArg, dryRun } = parseArgs(argv);
    const cwd = resolveSafeCwd(cwdArg);

    // Kill switches.
    if (process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1') {
      if (dryRun) process.stdout.write(JSON.stringify({ dry_run: true, candidates: [], reason: 'kill_switch_env' }) + '\n');
      return 0;
    }

    const config = readConfig(cwd);

    if (
      config.feature_demand_gate
      && typeof config.feature_demand_gate === 'object'
      && config.feature_demand_gate.enabled === false
    ) {
      if (dryRun) process.stdout.write(JSON.stringify({ dry_run: true, candidates: [], reason: 'gate_disabled' }) + '\n');
      return 0;
    }

    // Migration first — may flip shadow_mode:true → false.
    const mig = applyMigrationIfNeeded({ cwd, config, dryRun });
    let configMutated = mig.configMutated;

    // Effective shadow_mode AFTER the migration. If still true (i.e. user
    // explicitly set it back after a prior migration), skip auto-quarantine.
    const effectiveShadow = getShadowMode(config);
    if (effectiveShadow === true) {
      if (dryRun) process.stdout.write(JSON.stringify({
        dry_run: true,
        candidates: [],
        reason: 'shadow_mode_true_post_migration',
      }) + '\n');
      // Still persist any prior mutation (sentinel only — no config change in this branch).
      return 0;
    }

    // Auto-active path: compute eligible slugs and quarantine.
    const q = applyQuarantine({ cwd, config, dryRun });
    configMutated = configMutated || q.configMutated;

    if (dryRun) {
      process.stdout.write(JSON.stringify({
        dry_run: true,
        candidates: q.applied,
        wired_protocols: WIRED_EMITTER_PROTOCOLS,
      }) + '\n');
      return 0;
    }

    if (configMutated) {
      writeConfig(cwd, config);
    }

    return 0;
  } catch (_e) {
    // Fail-open.
    return 0;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  main,
  MIGRATION_BANNER_LINES,
  MIGRATION_SENTINEL_REL,
  // Exposed for tests:
  _internal: {
    applyMigrationIfNeeded,
    applyQuarantine,
    getShadowMode,
  },
};
