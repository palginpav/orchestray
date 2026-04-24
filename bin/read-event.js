'use strict';

/**
 * Back-compat read helper for `.orchestray/audit/events.jsonl` (R-EVENT-NAMING,
 * v2.1.13).
 *
 * Legacy files (v2.1.12 and earlier) mix `event`/`ts` with canonical
 * `type`/`timestamp`. Consumers call `normalizeEvent(obj)` on each parsed
 * line before touching fields so downstream code sees only the canonical
 * shape regardless of when the line was written.
 *
 * Design notes:
 * - Non-mutating: returns a new object; never edits the input in place.
 * - Lossless: unknown fields are preserved verbatim.
 * - Conflict resolution: if both the legacy and canonical key are present on
 *   the same row (e.g. a row with both `ts` and `timestamp`), the canonical
 *   value wins. Matches the pre-existing behaviour in
 *   `bin/mcp-server/lib/history_scan.js :: _normalizeEvent`.
 * - Null-safe: non-object inputs return the input unchanged. Callers that
 *   parse malformed JSONL rows already handle the throw themselves; this
 *   helper only normalises shape, never parses.
 */

const { OLD_TO_NEW } = require('./event-field-migration-map');

/**
 * Apply the OLD_TO_NEW migration map to a parsed event object.
 *
 * @param {unknown} obj - A parsed JSONL row from `events.jsonl`.
 * @returns {unknown} A new event object with legacy keys rewritten to their
 *   canonical names. Returns the input unchanged if not a plain object.
 */
function normalizeEvent(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  const out = {};

  // First pass: carry over every field that isn't a legacy alias, and skip the
  // canonical twin when a legacy key is also present so the canonical value
  // takes precedence.
  for (const [key, value] of Object.entries(obj)) {
    if (Object.prototype.hasOwnProperty.call(OLD_TO_NEW, key)) {
      // Legacy key — handled in the second pass.
      continue;
    }
    out[key] = value;
  }

  // Second pass: write canonical fields from legacy aliases only when the
  // canonical key is not already set on the input. This preserves the
  // "canonical wins on conflict" rule from history_scan.js.
  for (const [oldKey, newKey] of Object.entries(OLD_TO_NEW)) {
    if (!Object.prototype.hasOwnProperty.call(obj, oldKey)) continue;
    if (Object.prototype.hasOwnProperty.call(obj, newKey)) {
      // Canonical twin already carried over by the first pass — drop legacy.
      continue;
    }
    out[newKey] = obj[oldKey];
  }

  return out;
}

module.exports = { normalizeEvent };
