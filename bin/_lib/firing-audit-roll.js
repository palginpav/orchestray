'use strict';

/**
 * firing-audit-roll.js — rolling-window helper for the daily firing-audit cron.
 *
 * Extracted from audit-firing-nightly.js so v2.2.11 can reuse or extend without
 * modifying the entry-point script.
 *
 * Public API
 * ----------
 *   loadShadow(cwd)         → { entries: Map<string, obj>, generated_at: string|null } | null
 *   tally24hFires(eventsPath, eventTypes, windowStartMs) → Map<string, number>
 *   computeRatios(shadow, fireMap) → { numerator, denominator, ratio, darkCount, darkTypes }
 */

const fs   = require('node:fs');
const path = require('node:path');

const MAX_EVENTS_FILE_BYTES = 256 * 1024 * 1024; // 256 MB guard

/**
 * Load the schema shadow JSON and return a Map of event-type → shadow-entry.
 * Skips `_meta` key. Returns null on parse/read failure.
 *
 * @param {string} cwd - Project root directory.
 * @returns {{ entries: Map<string, object>, generated_at: string|null } | null}
 */
function loadShadow(cwd) {
  const shadowPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');
  let raw;
  try {
    raw = fs.readFileSync(shadowPath, 'utf8');
  } catch (e) {
    process.stderr.write(`firing-audit-roll: read shadow failed: ${e.message}\n`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`firing-audit-roll: parse shadow failed: ${e.message}\n`);
    return null;
  }

  const entries = new Map();
  let generated_at = null;
  for (const k of Object.keys(parsed)) {
    if (k === '_meta') {
      if (parsed._meta && typeof parsed._meta.generated_at === 'string') {
        generated_at = parsed._meta.generated_at;
      }
      continue;
    }
    const entry = parsed[k];
    if (entry && typeof entry === 'object') entries.set(k, entry);
  }
  return { entries, generated_at };
}

/**
 * Count fires per event-type from a single events.jsonl file, filtering to rows
 * whose `timestamp` falls within [windowStartMs, +Infinity).
 *
 * Uses a per-line regex scan (no full JSON parse on every line) to stay fast
 * even on large files.
 *
 * @param {string} eventsPath - Absolute path to events.jsonl.
 * @param {string[]} eventTypes - List of event types to count.
 * @param {number} windowStartMs - Epoch ms for the start of the window.
 * @returns {Map<string, number>} event_type → fire count within window.
 */
function tally24hFires(eventsPath, eventTypes, windowStartMs) {
  const counts = new Map();
  for (const t of eventTypes) counts.set(t, 0);

  let stat;
  try {
    stat = fs.statSync(eventsPath);
  } catch (e) {
    // File may not exist on fresh repos — that is fine, return all zeros.
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

    // Extract event type via regex to avoid full parse on every row.
    const typeMatch = line.match(/"(?:event|type)"\s*:\s*"([^"]+)"/);
    if (!typeMatch) continue;
    const eventType = typeMatch[1];
    if (!counts.has(eventType)) continue;

    // Timestamp check — parse only when the type is relevant.
    const tsMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (!tsMatch) continue;
    const ts = Date.parse(tsMatch[1]);
    if (isNaN(ts) || ts < windowStartMs) continue;

    counts.set(eventType, (counts.get(eventType) || 0) + 1);
  }

  return counts;
}

/**
 * Compute activation-ratio metrics from a shadow map and a fire-count map.
 *
 * Skips event types with `feature_optional: true` (shadow flag `f === 1`).
 *
 * @param {{ entries: Map<string, object> }} shadow
 * @param {Map<string, number>} fireMap - event_type → fire count.
 * @returns {{
 *   numerator:  number,  — distinct event types that fired ≥1 time
 *   denominator: number, — declared non-optional event types
 *   ratio:      number,  — numerator / denominator (NaN when denom=0)
 *   darkCount:  number,  — denominator - numerator
 *   darkTypes:  string[] — list of dark event-type names
 * }}
 */
function computeRatios(shadow, fireMap) {
  let numerator   = 0;
  let denominator = 0;
  const darkTypes = [];

  for (const [type, entry] of shadow.entries.entries()) {
    if (entry && entry.f === 1) continue;  // feature_optional opt-out
    denominator++;
    const count = fireMap.get(type) || 0;
    if (count > 0) {
      numerator++;
    } else {
      darkTypes.push(type);
    }
  }

  const darkCount = denominator - numerator;
  const ratio     = denominator === 0 ? 0 : numerator / denominator;

  return { numerator, denominator, ratio, darkCount, darkTypes };
}

module.exports = { loadShadow, tally24hFires, computeRatios };
