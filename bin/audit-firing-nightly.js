#!/usr/bin/env node
'use strict';

/**
 * audit-firing-nightly.js — self-firing daily firing-audit cron (v2.2.21 F3/F-05 fix).
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
 *   3. Scans `.orchestray/audit/events.jsonl` over the last 30 days, aggregates
 *      per-event-type fire counts, and writes them to
 *      `.orchestray/state/promised-event-tracker.last-run.json` BEFORE dark
 *      detection. This populates the tracker that was previously always empty
 *      (F-05 fix).
 *   4. Counts fires in the last 24h for the activation-ratio metric.
 *   5. Emits one `event_activation_ratio` summary row:
 *        { numerator, denominator, ratio, dark_count, window_label:"daily" }
 *   6. Emits one `event_promised_but_dark` row per event type with 0 fires
 *      over the 30-day window.
 *   7. Writes the day-sentinel so subsequent same-day SessionStarts skip.
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

const WINDOW_MS        = 24 * 60 * 60 * 1000;      // 24 hours (activation-ratio window)
const WINDOW_LABEL     = 'daily';
const TRACKER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (tracker population window)
const TRACKER_WINDOW_DAYS = 30;
const MAX_EVENTS_FILE_BYTES = 256 * 1024 * 1024;   // 256 MB guard

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

// ---------------------------------------------------------------------------
// Tracker helpers (F-05 fix)
// ---------------------------------------------------------------------------

/**
 * Scan events.jsonl over a rolling window and return a count map for ALL
 * event types observed (not just those in shadow). This is a broader scan
 * than tally24hFires — we want to populate the tracker even for types not yet
 * in shadow to detect future regressions.
 *
 * @param {string} eventsPath - Absolute path to events.jsonl.
 * @param {number} windowStartMs - Epoch ms for the start of the window.
 * @returns {Object.<string, number>} event_type → fire count within window.
 */
function tallyAllFires30d(eventsPath, windowStartMs) {
  const counts = Object.create(null);

  let stat;
  try {
    stat = fs.statSync(eventsPath);
  } catch (_e) {
    return counts;
  }
  if (stat.size === 0 || stat.size > MAX_EVENTS_FILE_BYTES) return counts;

  let text;
  try {
    text = fs.readFileSync(eventsPath, 'utf8');
  } catch (_e) {
    return counts;
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    // Timestamp check first — skip lines outside the window.
    const tsMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (tsMatch) {
      const ts = Date.parse(tsMatch[1]);
      if (!isNaN(ts) && ts < windowStartMs) continue;
    }

    // Extract event type. Both "type" and "event_type" field names appear in
    // the events.jsonl depending on the emitter.
    const typeMatch = line.match(/"(?:event_type|type)"\s*:\s*"([^"]+)"/);
    if (!typeMatch) continue;
    const eventType = typeMatch[1];
    // Skip internal audit-infrastructure events that are not user-facing types.
    if (eventType === 'audit_event_autofilled') continue;
    counts[eventType] = (counts[eventType] || 0) + 1;
  }

  return counts;
}

/**
 * Write the promised-event tracker file with 30-day fire counts for all
 * registered event types. This is the primary fix for F-05: the tracker was
 * always `{event_types:{}}` because no writer populated it with counts.
 *
 * Format:
 *   {
 *     event_types: { [event_type]: count },
 *     window_days: 30,
 *     generated_at: "<ISO>",
 *   }
 *
 * @param {string} cwd
 * @param {string[]} registeredTypes - All non-optional event types from shadow.
 * @param {Object.<string, number>} fireCounts30d - Result of tallyAllFires30d.
 * @param {string} nowIso - Current time as ISO string.
 */
function writeTracker(cwd, registeredTypes, fireCounts30d, nowIso) {
  const stateDir = path.join(cwd, '.orchestray', 'state');
  const file     = path.join(stateDir, 'promised-event-tracker.last-run.json');

  // Build the event_types map: every registered type gets a count (0 if not seen).
  const eventTypesMap = Object.create(null);
  for (const t of registeredTypes) {
    eventTypesMap[t] = fireCounts30d[t] || 0;
  }

  const payload = {
    event_types:  eventTypesMap,
    window_days:  TRACKER_WINDOW_DAYS,
    generated_at: nowIso,
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`audit-firing-nightly: tracker write failed: ${e.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Sentinel helpers
// ---------------------------------------------------------------------------

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

  const eventsPath   = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const nowIso       = nowDate.toISOString();

  // --- F-05 FIX: Populate the tracker BEFORE dark detection ---
  // Scan the last 30 days to get per-event-type fire counts. This is what
  // fills promised-event-tracker.last-run.json which was always empty before.
  const trackerWindowStartMs = nowMs - TRACKER_WINDOW_MS;
  const fireCounts30d = tallyAllFires30d(eventsPath, trackerWindowStartMs);

  // All non-optional registered event types (used to ensure every registered
  // type appears in the tracker, even if it never fired).
  const allRegisteredTypes = Array.from(shadow.entries.keys());
  writeTracker(cwd, allRegisteredTypes, fireCounts30d, nowIso);
  // --- end F-05 fix ---

  // Tally 24h fires for the activation-ratio metric (separate, narrower window).
  const windowStartMs = nowMs - WINDOW_MS;
  const eventTypes    = allRegisteredTypes;
  const fireMap       = tally24hFires(eventsPath, eventTypes, windowStartMs);

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

  // Emit one event_promised_but_dark row per dark type (dark = zero 24h fires,
  // non-optional). Enrich with the 30d total_fire_count from the tracker so
  // consumers know whether the event is truly never-fired vs. just quiet today.
  for (const darkType of darkTypes) {
    const totalFireCount = fireCounts30d[darkType] || 0;
    try {
      writeEvent({
        type:                    'event_promised_but_dark',
        version:                 1,
        event_type:              darkType,
        days_dark:               null,   // age tracking delegated to audit-promised-events
        first_seen_in_shadow_at: null,
        total_fire_count:        totalFireCount,
        window_label:            WINDOW_LABEL,
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

module.exports = { main, utcDateLabel, sentinelPath, tallyAllFires30d, writeTracker };
