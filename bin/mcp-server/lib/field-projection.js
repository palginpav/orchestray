'use strict';

/**
 * Field projection for MCP tool responses (R5, v2.1.11).
 *
 * Implements `fields` parameter support as specified in the v2.1.11 scope
 * proposal (AC-01..AC-06). Accepts a comma-separated string or array of
 * top-level key names and filters each result object to only those keys.
 *
 * Hard constraints (W6 S06 closure):
 *   - Top-level keys ONLY. No dot notation. No wildcards. No JSONPath.
 *   - Uses Object.hasOwn semantics: projection is key-presence only.
 *   - Rejects keys containing '.', '*', '$', or '[' with a clear error.
 *   - No JSONPath library is imported or used anywhere in this file.
 *
 * Backward compatibility (AC-03, AC-05):
 *   - When `fields` is absent or null, `parseFields` returns null,
 *     and callers MUST return the full legacy response unchanged.
 *
 * @module lib/field-projection
 */

// Characters that indicate the caller is attempting dot-notation, wildcards,
// or JSONPath — all of which are prohibited by S06.
const FORBIDDEN_CHARS = ['.', '*', '$', '[', ']'];

/**
 * Parse and validate the `fields` input parameter.
 *
 * Accepts:
 *   - undefined / null → returns null (no projection, full response)
 *   - string  → split on ',' and trim each part
 *   - string[] → use as-is (trimmed)
 *
 * Rejects (returns { error: string }):
 *   - Non-string array elements
 *   - Empty field names (after trimming)
 *   - Field names containing forbidden characters (dot, wildcard, JSONPath)
 *
 * @param {string|string[]|undefined|null} fields
 * @returns {string[]|null|{error: string}}
 *   - null if fields is absent (no projection)
 *   - string[] of validated field names if projection is requested
 *   - { error: string } if input is invalid
 */
function parseFields(fields) {
  if (fields === undefined || fields === null) return null;

  let parts;
  if (typeof fields === 'string') {
    parts = fields.split(',').map((s) => s.trim());
  } else if (Array.isArray(fields)) {
    // Validate every element before processing.
    for (let i = 0; i < fields.length; i++) {
      if (typeof fields[i] !== 'string') {
        return { error: 'fields: every element must be a string (index ' + i + ' is ' + typeof fields[i] + ')' };
      }
    }
    parts = fields.map((s) => s.trim());
  } else {
    return { error: 'fields: must be a comma-separated string or an array of strings, got ' + typeof fields };
  }

  // Validate each field name.
  for (const part of parts) {
    if (part.length === 0) {
      return { error: 'fields: empty field name is not allowed (check for trailing commas or spaces)' };
    }
    for (const ch of FORBIDDEN_CHARS) {
      if (part.includes(ch)) {
        return {
          error:
            'fields: "' + part + '" contains "' + ch + '" which is not allowed. ' +
            'Only top-level key names are accepted — no dot notation, wildcards, or JSONPath.',
        };
      }
    }
  }

  return parts;
}

/**
 * Project a single result object to only the requested top-level keys.
 *
 * Unknown keys (keys not present in the object) are silently skipped —
 * an unknown-field request returns the known-fields intersection (per scope
 * proposal integration-risk note: "tool should silently skip unknown fields").
 *
 * Implementation uses Object.hasOwn — no prototype chain traversal.
 *
 * @param {object} obj - The result object to project.
 * @param {string[]} fieldNames - Top-level key names to keep.
 * @returns {object} A new object with only the requested keys present in obj.
 */
function projectObject(obj, fieldNames) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const key of fieldNames) {
    if (Object.hasOwn(obj, key)) {
      out[key] = obj[key];
    }
  }
  return out;
}

/**
 * Project an array of result objects.
 *
 * Convenience wrapper: maps projectObject over each item.
 *
 * @param {object[]} items
 * @param {string[]} fieldNames
 * @returns {object[]}
 */
function projectArray(items, fieldNames) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => projectObject(item, fieldNames));
}

module.exports = { parseFields, projectObject, projectArray };
