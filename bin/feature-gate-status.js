#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * feature-gate-status.js — CLI for /orchestray:feature status (R-GATE, v2.1.14).
 *
 * Prints the current feature demand gate state: quarantine candidates, session wakes,
 * pinned wakes, and demand tracker report for eligible gates.
 *
 * Usage:
 *   node bin/feature-gate-status.js [--cwd /path]
 *
 * Exit code 0 always.
 */

const fs   = require('fs');
const path = require('path');

const {
  getQuarantineCandidates,
  readSessionWakes,
  readPinnedWakes,
}                               = require('./_lib/effective-gate-state');
const { computeDemandReport }   = require('./_lib/feature-demand-tracker');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      cwd = path.resolve(args[i + 1]);
      i++;
    }
  }
  return { cwd };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { cwd } = parseArgs(process.argv.slice(2));

  // Check kill switch
  if (process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1') {
    process.stdout.write(
      'Feature demand gate is disabled (ORCHESTRAY_DISABLE_DEMAND_GATE=1).\n' +
      'Unset the env var to enable.\n'
    );
    return;
  }

  let config = {};
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch (_e) {}
  if (typeof config !== 'object' || Array.isArray(config)) config = {};

  if (
    config.feature_demand_gate &&
    typeof config.feature_demand_gate === 'object' &&
    config.feature_demand_gate.enabled === false
  ) {
    process.stdout.write(
      'Feature demand gate is disabled (config.feature_demand_gate.enabled: false).\n' +
      'Set feature_demand_gate.enabled: true in .orchestray/config.json to enable.\n'
    );
    return;
  }

  const candidates   = getQuarantineCandidates(config);
  const sessionWakes = readSessionWakes(cwd);
  const pinnedWakes  = readPinnedWakes(cwd);
  const report       = computeDemandReport(cwd);

  const lines = [];
  lines.push('Feature Demand Gate Status');
  lines.push('==========================');

  lines.push(`Quarantine candidates (from config):  ${candidates.length > 0 ? candidates.join(', ') : '(none)'}`);
  lines.push(`Session wakes (override quarantine):  ${sessionWakes.size > 0 ? [...sessionWakes].join(', ') : '(none)'}`);
  lines.push(`Pinned wakes (30-day, override):      ${pinnedWakes.size > 0 ? [...pinnedWakes].join(', ') : '(none)'}`);
  lines.push('');

  const slugs = Object.keys(report);
  lines.push(`Eligible gate slugs:                  ${slugs.length > 0 ? slugs.join(', ') : '(none)'}`);
  for (const slug of slugs) {
    const r = report[slug];
    const eligStr = r.quarantine_eligible
      ? 'quarantine_eligible=true'
      : `quarantine_eligible=false (${r.ineligible_reason})`;
    lines.push(
      `  ${slug.padEnd(20)} eval_true_count=${r.gate_eval_true_count}, ` +
      `invoked_count=${r.tier2_invoked_count}, ` +
      `first_eval_at=${r.first_eval_at || 'never'}, ` +
      eligStr
    );
  }

  lines.push('');
  lines.push('Active quarantines this session:');
  const activeQuarantines = candidates.filter(slug => !sessionWakes.has(slug) && !pinnedWakes.has(slug));
  if (activeQuarantines.length === 0) {
    lines.push('  (none)');
  } else {
    for (const slug of activeQuarantines) {
      lines.push(`  - ${slug}  [opt-in via quarantine_candidates]`);
    }
  }

  lines.push('');
  lines.push('Re-enable with: /orchestray:feature wake <name>');
  lines.push('Persist for 30 days: /orchestray:feature wake --persist <name>');

  process.stdout.write(lines.join('\n') + '\n');
}

main();
