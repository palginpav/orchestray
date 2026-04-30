#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * bin/audit-zero-read-patterns.js (R-CAT v2.1.14)
 *
 * On-demand soft audit: lists pattern slugs that appear frequently in catalog
 * results (`pattern_find` calls with mode=catalog) but have never been fetched
 * via `pattern_read` in the trailing 30-day window.
 *
 * High catalog-return count + zero reads = the context_hook for that pattern
 * is not compelling enough to prompt agents to read it. These slugs are
 * candidates for hook rewording (manual action — this script only reports).
 *
 * Output is informational. No automatic changes are made.
 *
 * Usage:
 *   node bin/audit-zero-read-patterns.js [--window-days <N>] [--min-returns <N>]
 *
 * Options:
 *   --window-days <N>   Look-back window in days (default: 30).
 *   --min-returns <N>   Minimum catalog return count to flag (default: 3).
 *   --project-root <d>  Project root to use (default: cwd).
 *   --json              Output as JSON instead of human-readable text.
 *
 * Data sources:
 *   - .orchestray/audit/events.jsonl — mcp_tool_call events (pattern_find)
 *     and pattern_read events emitted by the pattern_read tool.
 *
 * Limitations:
 *   - Only counts events in events.jsonl; rotated files are not scanned.
 *   - Catalog-return counts are inferred: each `pattern_find` call that
 *     appears in events.jsonl is treated as one catalog call. Actual per-slug
 *     return counts are not currently stored in the event log (pattern_find
 *     does not emit per-slug events). This script therefore flags slugs with
 *     zero pattern_read events in the window — a necessary but not sufficient
 *     signal for hook quality.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let windowDays   = 30;
let minReturns   = 3;
let projectRoot  = process.cwd();
let jsonOutput   = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--window-days' && args[i + 1]) {
    windowDays = parseInt(args[++i], 10) || 30;
  } else if (args[i] === '--min-returns' && args[i + 1]) {
    minReturns = parseInt(args[++i], 10) || 3;
  } else if (args[i] === '--project-root' && args[i + 1]) {
    projectRoot = args[++i];
  } else if (args[i] === '--json') {
    jsonOutput = true;
  }
}

// ---------------------------------------------------------------------------
// Event log reader
// ---------------------------------------------------------------------------

function readEvents(eventsFile, sinceMs) {
  let content;
  try {
    content = fs.readFileSync(eventsFile, 'utf8');
  } catch (_e) {
    return [];
  }

  const events = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch (_e) { continue; }
    if (!evt || typeof evt.timestamp !== 'string') continue;
    const ts = Date.parse(evt.timestamp);
    if (isNaN(ts) || ts < sinceMs) continue;
    events.push(evt);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sinceMs     = Date.now() - windowDays * 24 * 60 * 60 * 1000;
const eventsFile  = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');

const events = readEvents(eventsFile, sinceMs);

// Count catalog calls (pattern_find events in the window).
let catalogCallCount = 0;
for (const evt of events) {
  if (evt.type === 'mcp_tool_call' && evt.tool === 'pattern_find') {
    catalogCallCount++;
  }
}

// Count pattern_read calls per slug.
/** @type {Map<string, number>} */
const readCounts = new Map();
for (const evt of events) {
  if (evt.type === 'pattern_read' && typeof evt.slug === 'string') {
    readCounts.set(evt.slug, (readCounts.get(evt.slug) || 0) + 1);
  }
}

// Enumerate all local patterns and flag zero-read ones.
const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
let patternFiles;
try {
  patternFiles = fs.readdirSync(patternsDir).filter((n) => n.endsWith('.md')).sort();
} catch (_e) {
  patternFiles = [];
}

/** @type {Array<{slug: string, read_count: number, catalog_calls_in_window: number}>} */
const flagged = [];

for (const name of patternFiles) {
  const slug = name.slice(0, -3);
  const readCount = readCounts.get(slug) || 0;
  // Flag: zero reads AND catalog_calls_in_window >= minReturns threshold.
  // Since we don't track per-slug catalog return counts, we use the total
  // catalog call count as a proxy: if there were >= minReturns catalog calls
  // in the window and this slug was never read, flag it.
  if (readCount === 0 && catalogCallCount >= minReturns) {
    flagged.push({
      slug,
      read_count: 0,
      catalog_calls_in_window: catalogCallCount,
    });
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const report = {
  window_days: windowDays,
  since: new Date(sinceMs).toISOString(),
  catalog_calls_in_window: catalogCallCount,
  min_returns_threshold: minReturns,
  zero_read_patterns: flagged,
  total_patterns: patternFiles.length,
};

if (jsonOutput) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write('Audit: zero-read patterns (last ' + windowDays + ' days)\n');
  process.stdout.write('  Catalog calls in window: ' + catalogCallCount + '\n');
  process.stdout.write('  Total patterns: ' + patternFiles.length + '\n');
  process.stdout.write('  Min-returns threshold: ' + minReturns + '\n\n');

  if (flagged.length === 0) {
    process.stdout.write('No zero-read patterns flagged. All slugs in the corpus were read at least once,\n');
    process.stdout.write('or there were fewer than ' + minReturns + ' catalog calls in the window.\n');
  } else {
    process.stdout.write('Zero-read slugs (context_hook may not be compelling):\n');
    for (const { slug } of flagged) {
      process.stdout.write('  - ' + slug + '\n');
    }
    process.stdout.write(
      '\n' + flagged.length + ' slug(s) flagged. ' +
      'Review and reword their context_hook fields, then re-run backfill-pattern-hooks.js.\n'
    );
  }
}
