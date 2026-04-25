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
 *
 * Options:
 *   --window-days N    Look back N days of events (default: 14)
 *   --cwd /path        Project root (default: process.cwd())
 *   --min-samples N    Minimum sample count per role before making recommendation
 *                      (default: 10; roles below threshold get model-tier default)
 *
 * Output:
 *   A recommendation table printed to stdout. No files are written.
 *   Exit 0 on success; exit 1 on unrecoverable error (missing events file, etc.).
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
  --help             Show this help

Output: recommendation table to stdout. Does NOT write to config.json.
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

  // Print report
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

main();
