'use strict';

/**
 * Pure analytics helper functions for Orchestray metrics.
 *
 * All functions are pure (no I/O, no side effects). They operate on arrays of
 * plain objects (parsed JSONL rows).
 *
 * Exports:
 *   mean(rows, field)        — arithmetic mean of `field` across rows that have
 *                              a finite numeric value for that field.
 *   p50(rows, field)         — median (50th percentile) of `field` across rows
 *                              that have a finite numeric value for that field.
 *   groupBy(rows, keyField)  — partition rows into a Map keyed by `keyField` value.
 *   countBy(rows, keyField)  — count occurrences of each `keyField` value; returns
 *                              a plain object { [key]: count }.
 *
 * Design note: bootstrap CI was explicitly cut from v2.0.17 scope (review Cut #2;
 * at ~20 orch/wk there is no statistical power for CI). Raw means + p50 only.
 */

/**
 * Extract finite numeric values of `field` from an array of rows.
 * Rows where the field is missing, null, NaN, or Infinity are skipped.
 *
 * @param {Object[]} rows
 * @param {string}   field
 * @returns {number[]}
 */
function extractNumbers(rows, field) {
  const out = [];
  for (const row of rows) {
    const v = row[field];
    if (typeof v === 'number' && isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Arithmetic mean of `field` across rows. Returns null if no valid values.
 *
 * @param {Object[]} rows
 * @param {string}   field
 * @returns {number|null}
 */
function mean(rows, field) {
  const nums = extractNumbers(rows, field);
  if (nums.length === 0) return null;
  let sum = 0;
  for (const n of nums) sum += n;
  return sum / nums.length;
}

/**
 * Median (50th percentile) of `field` across rows. Returns null if no valid
 * values. Uses the lower-median convention for even-length arrays to avoid
 * averaging two values that may have different semantics (e.g., two distinct
 * cost-per-orch figures).
 *
 * @param {Object[]} rows
 * @param {string}   field
 * @returns {number|null}
 */
function p50(rows, field) {
  const nums = extractNumbers(rows, field);
  if (nums.length === 0) return null;
  nums.sort((a, b) => a - b);
  // Lower-median for even-length arrays: index = floor((n-1)/2).
  const mid = Math.floor((nums.length - 1) / 2);
  return nums[mid];
}

/**
 * Partition rows into a Map keyed by the string value of `keyField`.
 * Rows where the field is missing or null are keyed under the string `"null"`.
 *
 * @param {Object[]} rows
 * @param {string}   keyField
 * @returns {Map<string, Object[]>}
 */
function groupBy(rows, keyField) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row[keyField] != null ? row[keyField] : 'null');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/**
 * Count occurrences of each value of `keyField` across rows.
 * Returns a plain object for easy JSON serialization.
 *
 * @param {Object[]} rows
 * @param {string}   keyField
 * @returns {Object.<string, number>}
 */
function countBy(rows, keyField) {
  const counts = {};
  for (const row of rows) {
    const key = String(row[keyField] != null ? row[keyField] : 'null');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

module.exports = { mean, p50, groupBy, countBy };
