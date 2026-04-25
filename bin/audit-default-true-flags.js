#!/usr/bin/env node
'use strict';

/**
 * audit-default-true-flags.js — R-FLAGS (v2.1.14)
 *
 * One-shot script that audits all top-level boolean flags whose current
 * install default is `true`. For each flag, queries recent .orchestray/
 * state files for demand evidence (feature_gate_eval events with the flag
 * in gates_true, and tier2_invoked events whose protocol matches the flag).
 *
 * Output: a markdown table to stdout with columns:
 *   Flag | Current default | Last 30d invocation count | Last fired | Notes
 *
 * Usage:
 *   node bin/audit-default-true-flags.js [--cwd /path/to/project]
 *
 * Defaults to process.cwd() if --cwd is not specified. If .orchestray/
 * directories are absent, event counts will be 0 and last-fired will be
 * "never" — the table is still valid.
 *
 * Exit code 0 always (audit failures are non-fatal).
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Install-default map — SINGLE SOURCE OF TRUTH for this script.
// A flag listed here is the value written to a fresh config.
// When a default is flipped (as with enable_drift_sentinel in v2.1.14),
// update this map and add a note in the Notes column below.
// ---------------------------------------------------------------------------

const INSTALL_DEFAULTS = {
  // Top-level boolean flags present in the fresh-install config or whose
  // absence implies true per the PM agent's dispatch table.
  // Format: flagName -> { default: bool, notes: string }
  enable_introspection:    { default: true,  notes: 'Haiku trace distiller; low cost, common load' },
  enable_backpressure:     { default: true,  notes: 'Confidence-based PM gating; fires frequently' },
  surface_disagreements:   { default: true,  notes: 'Reviewer design-tradeoff surfacing; fires on reviewer runs' },
  enable_drift_sentinel:   { default: false, notes: 'DEFAULT FLIPPED TO FALSE in v2.1.14 (R-FLAGS). Restore: set true in .orchestray/config.json' },
  enable_threads:          { default: true,  notes: 'Cross-session thread creation; fires on every orchestration' },
  enable_personas:         { default: true,  notes: 'Project-tuned agent personas; fires after 3+ orchestrations' },
  enable_replay_analysis:  { default: true,  notes: 'Counterfactual analysis on friction orchestrations' },
  auto_review:             { default: true,  notes: 'Auto-spawn reviewer after developer; very common load' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse command-line args. Supports: --cwd <path>
 * @returns {{ cwd: string }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      cwd = path.resolve(args[i + 1]);
      i++;
    }
  }
  return { cwd };
}

/**
 * Read a .jsonl file and return parsed lines (skips malformed).
 * Returns [] if the file does not exist.
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(l => l !== null);
  } catch (_e) {
    return [];
  }
}

/**
 * Collect all .jsonl lines from a directory pattern.
 * Scans the given files array and also checks history/ subdirectories.
 * @param {string[]} filePaths - Absolute paths to candidate jsonl files.
 * @returns {object[]}
 */
function readMultipleJsonl(filePaths) {
  const lines = [];
  for (const fp of filePaths) {
    lines.push(...readJsonl(fp));
  }
  return lines;
}

/**
 * Build a list of candidate events.jsonl paths including history archives
 * from the last 30 days.
 * @param {string} orchDir - .orchestray/ directory path.
 * @returns {string[]}
 */
function buildEventsPaths(orchDir) {
  const paths = [path.join(orchDir, 'audit', 'events.jsonl')];

  const historyDir = path.join(orchDir, 'history');
  if (!fs.existsSync(historyDir)) return paths;

  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = fs.readdirSync(historyDir); } catch (_e) { return paths; }

  for (const entry of entries) {
    // History dir names are epoch-seconds timestamps: e.g. 1744197600-orchestration
    const epochSec = parseInt(entry.split('-')[0], 10);
    if (!isNaN(epochSec) && epochSec * 1000 >= cutoffMs) {
      const evPath = path.join(historyDir, entry, 'events.jsonl');
      if (fs.existsSync(evPath)) paths.push(evPath);
    }
  }
  return paths;
}

/**
 * Build a list of candidate routing.jsonl paths including routing-pending.
 * @param {string} orchDir
 * @returns {string[]}
 */
function buildRoutingPaths(orchDir) {
  return [
    path.join(orchDir, 'state', 'routing.jsonl'),
    path.join(orchDir, 'state', 'routing-pending.jsonl'),
  ];
}

/**
 * Compute demand stats for a single flag from pre-loaded event arrays.
 * @param {string} flag
 * @param {object[]} events  - All events (feature_gate_eval + tier2_invoked).
 * @param {object[]} routing - All routing entries.
 * @returns {{ count: number, lastFired: string|null }}
 */
function computeStats(flag, events, routing) {
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  let lastFiredTs = null;

  for (const ev of events) {
    const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
    if (ts < cutoffMs) continue;

    // feature_gate_eval events: flag in gates_true means it fired
    if (ev.type === 'feature_gate_eval' && Array.isArray(ev.gates_true)) {
      if (ev.gates_true.includes(flag)) {
        count++;
        if (!lastFiredTs || ts > new Date(lastFiredTs).getTime()) {
          lastFiredTs = ev.timestamp;
        }
      }
    }

    // tier2_invoked events: protocol field maps to flag name
    // The protocol name is the flag without the prefix (e.g., enable_drift_sentinel → drift_sentinel)
    // OR the full flag name if the protocol field matches directly.
    if (ev.type === 'tier2_invoked' && ev.protocol) {
      const proto = ev.protocol;
      if (proto === flag || proto === flag.replace(/^(enable_|auto_)/, '')) {
        count++;
        if (!lastFiredTs || ts > new Date(lastFiredTs).getTime()) {
          lastFiredTs = ev.timestamp;
        }
      }
    }
  }

  // Also count routing entries that reference the flag in their protocol
  for (const entry of routing) {
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    if (ts < cutoffMs) continue;
    const proto = entry.protocol || entry.gate || '';
    if (proto === flag || proto === flag.replace(/^(enable_|auto_)/, '')) {
      count++;
      if (!lastFiredTs || ts > new Date(lastFiredTs).getTime()) {
        lastFiredTs = entry.timestamp;
      }
    }
  }

  return { count, lastFired: lastFiredTs };
}

/**
 * Format an ISO timestamp as a short date string (YYYY-MM-DD), or "never".
 * @param {string|null} ts
 * @returns {string}
 */
function fmtDate(ts) {
  if (!ts) return 'never';
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch (_e) {
    return 'never';
  }
}

/**
 * Pad a string to a minimum width with spaces on the right.
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
function pad(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { cwd } = parseArgs();
  const orchDir = path.join(cwd, '.orchestray');

  // Load all events and routing entries once (shared across all flags).
  const eventsPaths  = buildEventsPaths(orchDir);
  const routingPaths = buildRoutingPaths(orchDir);
  const allEvents    = readMultipleJsonl(eventsPaths);
  const allRouting   = readMultipleJsonl(routingPaths);

  // Build rows: one per flag.
  const rows = [];
  for (const [flag, meta] of Object.entries(INSTALL_DEFAULTS)) {
    const { count, lastFired } = computeStats(flag, allEvents, allRouting);
    rows.push({
      flag,
      defaultVal: meta.default,
      count,
      lastFired: fmtDate(lastFired),
      notes: meta.notes,
    });
  }

  // Sort: default-true flags first (most relevant to audit), then alpha.
  rows.sort((a, b) => {
    if (a.defaultVal !== b.defaultVal) return b.defaultVal - a.defaultVal;
    return a.flag.localeCompare(b.flag);
  });

  // Compute column widths.
  const COL_FLAG    = Math.max('Flag'.length,    ...rows.map(r => r.flag.length));
  const COL_DEFAULT = Math.max('Current default'.length, 'false'.length);
  const COL_COUNT   = Math.max('Last 30d invocations'.length, 5);
  const COL_LAST    = Math.max('Last fired'.length, 'never'.length);
  const COL_NOTES   = 'Notes'.length; // variable — no padding needed for last col

  const hr = '| ' + '-'.repeat(COL_FLAG) + ' | ' + '-'.repeat(COL_DEFAULT) + ' | ' +
             '-'.repeat(COL_COUNT) + ' | ' + '-'.repeat(COL_LAST) + ' | ' + '-'.repeat(COL_NOTES) + ' |';

  const header = '| ' + pad('Flag', COL_FLAG) + ' | ' + pad('Current default', COL_DEFAULT) + ' | ' +
                 pad('Last 30d invocations', COL_COUNT) + ' | ' + pad('Last fired', COL_LAST) + ' | Notes |';

  const lines = [
    '## v2.1.14 Default-true flags audit',
    '',
    `_Generated: ${new Date().toISOString().slice(0, 10)} from ${orchDir}_`,
    '',
    header,
    hr,
  ];

  for (const r of rows) {
    const line =
      '| ' + pad(r.flag, COL_FLAG) +
      ' | ' + pad(String(r.defaultVal), COL_DEFAULT) +
      ' | ' + pad(String(r.count), COL_COUNT) +
      ' | ' + pad(r.lastFired, COL_LAST) +
      ' | ' + r.notes + ' |';
    lines.push(line);
  }

  process.stdout.write(lines.join('\n') + '\n');
}

main();
