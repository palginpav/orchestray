#!/usr/bin/env node
'use strict';

/**
 * calibrate-role-budgets.js — Per-role budget recalibration tool (v2.1.16 actor).
 *
 * IMPORTANT: This script is a v2.1.16 actor. It does NOT run automatically in
 * v2.1.15. It is shipped in v2.1.15 for operator use only — run it on demand
 * after at least 14 days of telemetry have accumulated.
 *
 * Purpose:
 *   Reads `.orchestray/audit/events.jsonl`, computes p50/p75/p95 per agent role
 *   from `budget_warn` and `pre_spawn_payload_tokens` telemetry, and prints a
 *   recommendation table of `1.2× p95` values. The operator reviews the output
 *   and commits the updated `budget_tokens` values to `.orchestray/config.json`
 *   by hand.
 *
 *   Does NOT write to config.json directly. Operator-driven by design (v2.1.15
 *   commitment: no auto-mutation of budget values).
 *
 * Usage:
 *   node bin/calibrate-role-budgets.js [--window-days N] [--cwd /path/to/project]
 *   node bin/calibrate-role-budgets.js --emit-cache [--window-days N] [--cwd ...]
 *   node bin/calibrate-role-budgets.js --emit-cache --if-stale [--quiet] [--cwd ...]
 *
 * Options:
 *   --window-days N    Look back N days of events (default: 14)
 *   --cwd /path        Project root (default: process.cwd())
 *   --min-samples N    Minimum sample count per role before making recommendation
 *                      (default: 10; roles below threshold get model-tier default)
 *   --emit-cache       Write the recommendations to
 *                      .orchestray/state/role-budgets.json in the wrapped form
 *                      that bin/_lib/output-shape.js consumes (W7 F-003 fix,
 *                      v2.2.0). Without this flag the tool prints to stdout only.
 *   --if-stale         Skip recompute if role-budgets.json mtime is newer than
 *                      window-days. Exits 0 silently when cache is fresh.
 *                      Forces recompute when cache is missing or older than window.
 *                      (v2.2.14 G-02 — fixes SessionStart cache-budget burn)
 *   --quiet            Suppress the recommendation table on stdout. When combined
 *                      with --emit-cache, the cache file is the sole deliverable.
 *                      Exits 0 with no stdout in --quiet --emit-cache mode.
 *
 * Output:
 *   A recommendation table printed to stdout. No files are written unless
 *   --emit-cache is supplied (in which case role-budgets.json is overwritten
 *   atomically). Exit 0 on success; exit 1 on unrecoverable error
 *   (missing events file, etc.).
 *
 * Telemetry source:
 *   Reads `event_type: "budget_warn"` rows from events.jsonl. For roles that
 *   never triggered a warning, falls back to model-tier defaults:
 *     haiku roles: 30K, sonnet roles: 50K, opus roles: 80K.
 *
 * Thin-telemetry guard (W5 F-03):
 *   Refuses to recommend for roles with fewer than --min-samples observations.
 *   Falls back to the current configured value unchanged.
 *
 * Auto-run in v2.1.15: NO.
 * Auto-run in v2.1.16: Planned — trigger: 14-day window closes with N≥30 samples
 *   for all roles. See v2.1.16 planning for the auto-apply protocol.
 *
 * v2.1.15 — W6 R-BUDGET (ships as v2.1.16 actor per task brief).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

function hasFlag(flag) {
  return args.includes(flag);
}

const windowDays  = parseInt(getArg('--window-days', '14'), 10);
const minSamples  = parseInt(getArg('--min-samples', '10'), 10);
const cwdArg      = getArg('--cwd', process.cwd());
const emitCache   = hasFlag('--emit-cache');
const ifStale     = hasFlag('--if-stale');
const quiet       = hasFlag('--quiet');

if (hasFlag('--help') || hasFlag('-h')) {
  process.stdout.write(`
calibrate-role-budgets.js — Per-role budget recalibration tool (v2.1.16 actor)

IMPORTANT: Does NOT auto-run in v2.1.15. Run on demand after 14+ days of telemetry.

Usage:
  node bin/calibrate-role-budgets.js [options]

Options:
  --window-days N    Look back N days of events (default: 14)
  --cwd /path        Project root (default: cwd)
  --min-samples N    Min samples per role before recommending (default: 10)
  --emit-cache       Write .orchestray/state/role-budgets.json from the
                     recommendations (wrapped form consumed by
                     bin/_lib/output-shape.js getRoleLengthCap()).
  --if-stale         Skip recompute when cache is fresher than window-days.
                     Exit 0 silently. Recompute when cache missing or stale.
  --quiet            Suppress recommendation table. Cache file is deliverable.
  --help             Show this help

Output: recommendation table to stdout. Does NOT write to config.json.
With --emit-cache, also writes role-budgets.json (atomic replace).
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Model-tier defaults (fallback for thin telemetry)
// ---------------------------------------------------------------------------

const MODEL_TIER_DEFAULTS = {
  haiku:  30000,
  sonnet: 50000,
  opus:   80000,
};

// Role → model tier mapping (mirrors CLAUDE.md / agents/ frontmatter defaults)
const ROLE_MODEL_TIER = {
  'pm':               'opus',
  'architect':        'opus',
  'developer':        'sonnet',
  'refactorer':       'sonnet',
  'reviewer':         'sonnet',
  'debugger':         'sonnet',
  'tester':           'sonnet',
  'documenter':       'sonnet',
  'inventor':         'opus',
  'researcher':       'sonnet',
  'security-engineer':'sonnet',
  'release-manager':  'sonnet',
  'ux-critic':        'sonnet',
  'project-intent':   'haiku',
  'platform-oracle':  'sonnet',
};

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cwd = path.resolve(cwdArg);

  // --if-stale: exit 0 silently when cache is fresher than window-days.
  // Prevents unconditional recompute on every SessionStart (v2.2.14 G-02).
  if (ifStale) {
    const cachePath = path.join(cwd, '.orchestray', 'state', 'role-budgets.json');
    const windowMs  = windowDays * 24 * 60 * 60 * 1000;
    try {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < windowMs) {
        // Cache is fresh — skip recompute entirely. No stdout, no stderr.
        process.exit(0);
      }
    } catch (_e) {
      // File missing or unreadable — fall through to recompute.
    }
  }

  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

  if (!fs.existsSync(eventsPath)) {
    process.stderr.write(
      `[calibrate-role-budgets] ERROR: events.jsonl not found at ${eventsPath}\n` +
      `Ensure Orchestray has been running and audit events are being recorded.\n`
    );
    process.exit(1);
  }

  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const raw = fs.readFileSync(eventsPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Collect computed_size samples per role from budget_warn events
  // and any pre_spawn_payload_tokens telemetry events.
  const samplesByRole = {};

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch (_e) { continue; }

    // Only look at budget_warn for now (v2.1.15 emits these on over-budget spawns).
    // In v2.1.16, also include context_telemetry events with pre_spawn_payload_tokens.
    if (ev.event_type !== 'budget_warn') continue;

    // Window filter
    if (ev.timestamp) {
      const ts = Date.parse(ev.timestamp);
      if (!isNaN(ts) && ts < cutoffMs) continue;
    }

    const role = ev.agent_role;
    const size = ev.computed_size;
    if (!role || typeof size !== 'number') continue;

    if (!samplesByRole[role]) samplesByRole[role] = [];
    samplesByRole[role].push(size);
  }

  // Build recommendation table
  const allRoles = Object.keys(ROLE_MODEL_TIER);
  const rows = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const role of allRoles) {
    const samples = samplesByRole[role] || [];
    samples.sort((a, b) => a - b);
    const n = samples.length;
    const tier = ROLE_MODEL_TIER[role] || 'sonnet';
    const tierDefault = MODEL_TIER_DEFAULTS[tier];

    if (n < minSamples) {
      rows.push({
        role,
        n,
        p50: null,
        p75: null,
        p95: null,
        recommended: null,
        source: n === 0 ? 'no_data_model_tier_default' : `thin_telemetry_n${n}_model_tier_default`,
        tier_default: tierDefault,
        note: `N=${n} < min_samples=${minSamples}; keeping tier default`,
      });
    } else {
      const p50 = percentile(samples, 50);
      const p75 = percentile(samples, 75);
      const p95 = percentile(samples, 95);
      const recommended = Math.ceil(p95 * 1.2 / 1000) * 1000; // round up to nearest 1K

      rows.push({
        role,
        n,
        p50,
        p75,
        p95,
        recommended,
        source: `1.2x_p95_n${n}_window${windowDays}d`,
        tier_default: tierDefault,
        note: null,
      });
    }
  }

  // Print report (suppressed when --quiet is set)
  if (!quiet) {
    process.stdout.write(`\n=== calibrate-role-budgets.js ===\n`);
    process.stdout.write(`v2.1.16 actor — does NOT auto-run in v2.1.15\n`);
    process.stdout.write(`Window: last ${windowDays} days | min_samples: ${minSamples} | date: ${today}\n\n`);

    process.stdout.write(
      `${'Role'.padEnd(20)} ${'N'.padStart(5)} ${'p50'.padStart(8)} ${'p75'.padStart(8)} ${'p95'.padStart(8)} ${'Recommended'.padStart(12)} Note\n`
    );
    process.stdout.write(`${'-'.repeat(85)}\n`);

    for (const r of rows) {
      const p50s = r.p50 !== null ? String(r.p50) : '-';
      const p75s = r.p75 !== null ? String(r.p75) : '-';
      const p95s = r.p95 !== null ? String(r.p95) : '-';
      const recs = r.recommended !== null ? String(r.recommended) : String(r.tier_default) + '*';
      const note = r.note || '';

      process.stdout.write(
        `${r.role.padEnd(20)} ${String(r.n).padStart(5)} ${p50s.padStart(8)} ${p75s.padStart(8)} ${p95s.padStart(8)} ${recs.padStart(12)} ${note}\n`
      );
    }

    process.stdout.write(`\n* = tier default (thin/no telemetry); value unchanged from current config.\n\n`);

    process.stdout.write(`To apply recommendations, update .orchestray/config.json role_budgets manually:\n`);
    for (const r of rows) {
      if (r.recommended !== null) {
        process.stdout.write(`  "${r.role}": { "budget_tokens": ${r.recommended}, "source": "${r.source}", "calibrated_at": "${today}" },\n`);
      }
    }

    process.stdout.write(`\nThis script does NOT write to config.json. Operator must commit the changes.\n`);
  }

  // --emit-cache: write the wrapped form consumed by bin/_lib/output-shape.js.
  // Atomic replace via temp-file + rename so a partial write cannot corrupt
  // the cache. Roles that fell back to tier defaults still emit a row (with
  // budget_tokens = tier_default) so getRoleLengthCap() returns a real value
  // for every role rather than mixing cache hits with tier_default fallbacks.
  if (emitCache) {
    const stateDir   = path.join(cwd, '.orchestray', 'state');
    const cachePath  = path.join(stateDir, 'role-budgets.json');
    const tmpPath    = path.join(stateDir, 'role-budgets.json.tmp');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const role_budgets = {};
    for (const r of rows) {
      const budgetTokens = r.recommended !== null ? r.recommended : r.tier_default;
      const source = r.recommended !== null
        ? r.source
        : (r.n === 0 ? 'no_data_model_tier_default' : 'thin_telemetry_n' + r.n + '_model_tier_default');
      const entry = {
        budget_tokens: budgetTokens,
        source,
        calibrated_at: today,
      };
      if (r.p95 !== null) entry.p95 = r.p95;
      if (r.p75 !== null) entry.p75 = r.p75;
      if (r.p50 !== null) entry.p50 = r.p50;
      if (typeof r.n === 'number') entry.n = r.n;
      role_budgets[r.role] = entry;
    }

    const cacheBody = {
      _comment: 'Written by bin/calibrate-role-budgets.js --emit-cache. ' +
                'Consumed by bin/_lib/output-shape.js getRoleLengthCap(). ' +
                'Wrapped form: prefer cache.role_budgets[role].p95 over budget_tokens.',
      calibrated_at: today,
      window_days: windowDays,
      min_samples: minSamples,
      source: 'calibrate-role-budgets.js --emit-cache',
      role_budgets,
    };

    fs.writeFileSync(tmpPath, JSON.stringify(cacheBody, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, cachePath);
    if (!quiet) {
      process.stdout.write('\n[--emit-cache] wrote ' + cachePath + ' (' +
        Object.keys(role_budgets).length + ' roles).\n');
    }
  }
}

// Allow programmatic invocation (tests, follow-on tools). When the file is
// imported (require.main !== module) the CLI does NOT auto-run.
module.exports = {
  MODEL_TIER_DEFAULTS,
  ROLE_MODEL_TIER,
  percentile,
  main,
  // Exported for tests that need to inspect parsed flag state.
  _flags: { emitCache, ifStale, quiet, windowDays, minSamples },
};

if (require.main === module) {
  main();
}
