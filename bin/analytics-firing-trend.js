#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * analytics-firing-trend.js — helper for SKILL.md Rollup H (v2.2.11 W4-3).
 *
 * Reads event_activation_ratio rows from events.jsonl and returns a structured
 * summary that the /orchestray:analytics SKILL renders as a firing-trend table.
 *
 * Exported functions
 * ------------------
 *   parseActivationRows(filePath) → Row[]
 *     Reads filePath, returns valid event_activation_ratio rows sorted ascending
 *     by timestamp. Malformed lines (bad JSON, wrong type, invalid ratio) are
 *     silently skipped. Missing file returns [].
 *
 *   computeFiringTrend(filePath) → TrendResult
 *     Wraps parseActivationRows and adds aggregate fields used by the dashboard.
 *
 * Row shape (after parsing)
 * -------------------------
 *   { orchestration_id, timestamp, ratio, numerator, denominator, dark_count }
 *
 * TrendResult shape
 * -----------------
 *   {
 *     rows:         Row[],       // all valid rows, ascending by timestamp
 *     rowsCount:    number,
 *     avgRatio:     number|null, // mean ratio across all rows; null if rowsCount=0
 *     avgRatio7d:   number|null, // mean ratio for rows within last 7 days; null if none
 *     count7d:      number,
 *     lastRow:      Row|null,    // most recent row by timestamp
 *   }
 */

const fs   = require('node:fs');
const path = require('node:path'); // eslint-disable-line no-unused-vars

const ACTIVATION_TYPE = 'event_activation_ratio';

// ---------------------------------------------------------------------------
// parseActivationRows
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath - Absolute path to events.jsonl
 * @returns {Array<object>} Valid rows sorted ascending by timestamp
 */
function parseActivationRows(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return [];
  }

  const rows = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_e) {
      continue; // malformed JSON — skip
    }

    // Accept both `type` and `event` fields (events.jsonl uses both conventions).
    const evtType = obj.type || obj.event;
    if (evtType !== ACTIVATION_TYPE) continue;

    // Validate ratio: must be a finite number in [0, 1].
    const ratio = obj.ratio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      continue;
    }

    rows.push({
      orchestration_id: typeof obj.orchestration_id === 'string' ? obj.orchestration_id : null,
      timestamp:        typeof obj.timestamp === 'string' ? obj.timestamp : null,
      ratio,
      numerator:        typeof obj.numerator  === 'number' ? obj.numerator  : null,
      denominator:      typeof obj.denominator === 'number' ? obj.denominator : null,
      dark_count:       typeof obj.dark_count  === 'number' ? obj.dark_count  : null,
    });
  }

  // Sort ascending by timestamp (lexicographic ISO-8601 sort is correct).
  rows.sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  return rows;
}

// ---------------------------------------------------------------------------
// computeFiringTrend
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath - Absolute path to events.jsonl
 * @returns {object} TrendResult
 */
function computeFiringTrend(filePath) {
  const rows = parseActivationRows(filePath);

  if (rows.length === 0) {
    return { rows: [], rowsCount: 0, avgRatio: null, avgRatio7d: null, count7d: 0, lastRow: null };
  }

  const sum = rows.reduce((acc, r) => acc + r.ratio, 0);
  const avgRatio = sum / rows.length;

  // 7-day window: compare timestamps >= (now - 7 days).
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows7d = rows.filter(r => r.timestamp && r.timestamp >= cutoff7d);
  const avgRatio7d = rows7d.length > 0
    ? rows7d.reduce((acc, r) => acc + r.ratio, 0) / rows7d.length
    : null;

  return {
    rows,
    rowsCount: rows.length,
    avgRatio,
    avgRatio7d,
    count7d: rows7d.length,
    lastRow: rows[rows.length - 1],
  };
}

// ---------------------------------------------------------------------------
// CLI (optional — for manual inspection)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('Usage: analytics-firing-trend.js <path/to/events.jsonl>\n');
    process.exit(1);
  }
  const result = computeFiringTrend(filePath);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { parseActivationRows, computeFiringTrend };
