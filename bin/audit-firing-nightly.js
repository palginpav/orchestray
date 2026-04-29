#!/usr/bin/env node
'use strict';

/**
 * audit-firing-nightly.js — self-firing daily firing-audit cron (v2.2.10 F3).
 *
 * Why this exists
 * ---------------
 * F3 ships a once-per-calendar-day audit that automatically computes the
 * 24-hour event-activation ratio for every declared event type and surfaces
 * dark (never-fired) types without manual operator intervention. This kills
 * the manual W1 workflow planned for v2.2.11.
 *
 * Behaviour
 * ---------
 *   1. Once-per-day guard: reads/writes
 *      `.orchestray/state/firing-audit-day-<YYYYMMDD>.lock` (UTC). If the
 *      sentinel exists for today, exit 0 silently.
 *   2. Loads `agents/pm-reference/event-schemas.shadow.json`. Skips event
 *      types with `feature_optional: true` (shadow flag `f === 1`).
 *   3. Reads `.orchestray/audit/events.jsonl`, counts fires in the last 24h.
 *   4. Emits one `event_activation_ratio` summary row:
 *        { numerator, denominator, ratio, dark_count, window_label:"daily" }
 *   5. Emits one `event_promised_but_dark` row per dark event type.
 *   6. Writes the day-sentinel so subsequent same-day SessionStarts skip.
 *
 * Kill switch
 * -----------
 * `ORCHESTRAY_FIRING_AUDIT_DISABLED=1` → exit 0 silently.
 *
 * Fail-open contract
 * ------------------
 * Every error path logs to stderr and exits 0. Hooks must never block Claude Code.
 *
 * Wall-clock budget
 * -----------------
 * 10 seconds. The events.jsonl scan is O(file-size); at 256 MB cap and fast
 * local storage this is comfortably within budget.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd }                        = require('./_lib/resolve-project-cwd');
const { writeEvent }                            = require('./_lib/audit-event-writer');
const { loadShadow, tally24hFires, computeRatios } = require('./_lib/firing-audit-roll');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_MS      = 24 * 60 * 60 * 1000;   // 24 hours
const WINDOW_LABEL   = 'daily';

// ---------------------------------------------------------------------------
// Sentinel helpers
// ---------------------------------------------------------------------------

/**
 * Return the YYYYMMDD string for today in UTC.
 * @param {Date} [now]
 * @returns {string}
 */
function utcDateLabel(now) {
  const d = now || new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

/**
 * Absolute path to today's day sentinel.
 * @param {string} cwd
 * @param {string} dateLabel - YYYYMMDD
 * @returns {string}
 */
function sentinelPath(cwd, dateLabel) {
  return path.join(cwd, '.orchestray', 'state', `firing-audit-day-${dateLabel}.lock`);
}

/**
 * Check whether today's sentinel already exists.
 * @param {string} cwd
 * @param {string} dateLabel
 * @returns {boolean}
 */
function sentinelExists(cwd, dateLabel) {
  try {
    fs.accessSync(sentinelPath(cwd, dateLabel));
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Write today's sentinel file. Best-effort; failures are logged.
 * @param {string} cwd
 * @param {string} dateLabel
 */
function writeSentinel(cwd, dateLabel) {
  const stateDir = path.join(cwd, '.orchestray', 'state');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sentinelPath(cwd, dateLabel), new Date().toISOString(), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`audit-firing-nightly: sentinel write failed: ${e.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.ORCHESTRAY_FIRING_AUDIT_DISABLED === '1') {
    return 0;
  }

  // Read hook payload (cwd field).
  let payload = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = fs.readFileSync(0, 'utf8');
      if (raw && raw.trim().length > 0) {
        payload = JSON.parse(raw);
      }
    }
  } catch (_e) { /* fail-open */ }

  const cwd      = resolveSafeCwd(payload && payload.cwd);
  const nowMs    = Date.now();
  const nowDate  = new Date(nowMs);
  const dateLabel = utcDateLabel(nowDate);

  // Once-per-day guard.
  if (sentinelExists(cwd, dateLabel)) {
    return 0;
  }

  // Load shadow.
  const shadow = loadShadow(cwd);
  if (!shadow) return 0;

  // Tally 24h fires from the live audit log.
  const eventsPath   = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const windowStartMs = nowMs - WINDOW_MS;
  const eventTypes   = Array.from(shadow.entries.keys());
  const fireMap      = tally24hFires(eventsPath, eventTypes, windowStartMs);

  // Compute ratios.
  const { numerator, denominator, ratio, darkCount, darkTypes } = computeRatios(shadow, fireMap);

  // Emit the summary row.
  try {
    writeEvent({
      type:         'event_activation_ratio',
      version:      1,
      numerator,
      denominator,
      ratio:        Math.round(ratio * 1e6) / 1e6,  // 6 decimal places
      dark_count:   darkCount,
      window_label: WINDOW_LABEL,
    }, { cwd });
  } catch (e) {
    process.stderr.write(`audit-firing-nightly: emit event_activation_ratio failed: ${e.message}\n`);
  }

  // Emit one event_promised_but_dark row per dark type.
  const nowIso = nowDate.toISOString();
  for (const darkType of darkTypes) {
    try {
      writeEvent({
        type:       'event_promised_but_dark',
        version:    1,
        event_type: darkType,
        days_dark:  null,   // not tracked by nightly; use full tracker for age data
        first_seen_in_shadow_at: null,
        total_fire_count: 0,
        window_label: WINDOW_LABEL,
      }, { cwd });
    } catch (e) {
      process.stderr.write(`audit-firing-nightly: emit event_promised_but_dark(${darkType}) failed: ${e.message}\n`);
    }
  }

  // Write today's sentinel so same-day re-runs are no-ops.
  writeSentinel(cwd, dateLabel);

  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`audit-firing-nightly: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = { main, utcDateLabel, sentinelPath };
