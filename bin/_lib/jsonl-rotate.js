'use strict';

/**
 * Generic JSONL file rotation helper.
 *
 * Appends a single JSON-serializable object as a line to a JSONL file,
 * rotating when the file exceeds a size cap. Rotation renames the current
 * file to `<file>.1.jsonl`, shifting previous generations up (`.1` → `.2`,
 * etc.) and deleting the oldest once `maxGenerations` is reached.
 *
 * Exports:
 *   appendJsonlWithRotation(filePath, record, opts?)
 *     Append `record` to `filePath`, rotating if needed.
 *     opts.maxSizeBytes  — cap in bytes before rotation (default: 50 MB)
 *     opts.maxGenerations — max rotated files to keep (default: 5)
 *
 * Fail-open contract: any I/O error in the rotation housekeeping step is
 * swallowed (logged to stderr); the append of the new record still proceeds.
 * Errors in the final append itself propagate to the caller so the caller
 * can decide to fail-open.
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_MAX_SIZE_BYTES  = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_GENERATIONS = 5;

/**
 * Return the rotation-suffix path for generation `n` (1-indexed).
 * Generation 1 is the most-recent rotated file.
 *
 * @param {string} filePath  - Base JSONL path (e.g. `/x/agent_metrics.jsonl`)
 * @param {number} n         - Generation number (≥ 1)
 * @returns {string}
 */
function rotatedPath(filePath, n) {
  // Strip any existing `.jsonl` extension so we get `base.N.jsonl`.
  const ext  = path.extname(filePath); // e.g. ".jsonl"
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}.${n}${ext || '.jsonl'}`;
}

/**
 * Rotate existing generations upward by one slot, dropping the oldest if it
 * would exceed `maxGenerations`. Operates synchronously; errors are swallowed
 * per the fail-open contract.
 *
 * @param {string} filePath
 * @param {number} maxGenerations
 */
function shiftGenerations(filePath, maxGenerations) {
  try {
    // Delete the oldest generation if it exists.
    const oldest = rotatedPath(filePath, maxGenerations);
    try { fs.unlinkSync(oldest); } catch (_e) {}

    // Shift each generation up one slot, from oldest-1 down to 1.
    for (let i = maxGenerations - 1; i >= 1; i--) {
      const from = rotatedPath(filePath, i);
      const to   = rotatedPath(filePath, i + 1);
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch (_e) {}
    }

    // Rename current live file to generation 1.
    fs.renameSync(filePath, rotatedPath(filePath, 1));
  } catch (err) {
    process.stderr.write(
      '[orchestray] jsonl-rotate: rotation housekeeping failed for ' +
      filePath + ': ' + (err && err.message) + '\n'
    );
  }
}

/**
 * Append `record` (JSON-serializable) to `filePath`, rotating first if the
 * file has grown past `opts.maxSizeBytes`.
 *
 * Creates the parent directory if it does not exist.
 *
 * @param {string} filePath
 * @param {Object} record
 * @param {{ maxSizeBytes?: number, maxGenerations?: number }} [opts]
 */
function appendJsonlWithRotation(filePath, record, opts) {
  const maxSizeBytes  = (opts && opts.maxSizeBytes  != null) ? opts.maxSizeBytes  : DEFAULT_MAX_SIZE_BYTES;
  const maxGenerations = (opts && opts.maxGenerations != null) ? opts.maxGenerations : DEFAULT_MAX_GENERATIONS;

  // Ensure parent directory exists.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_e) {}

  // Check current size and rotate if needed.
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= maxSizeBytes) {
      shiftGenerations(filePath, maxGenerations);
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      // Unexpected stat error — log and proceed (fail-open).
      process.stderr.write(
        '[orchestray] jsonl-rotate: stat failed for ' + filePath +
        ': ' + (err && err.message) + '\n'
      );
    }
    // ENOENT is normal for a new file — no rotation needed.
  }

  // Append the record.
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

module.exports = {
  appendJsonlWithRotation,
  // Exported for testing only:
  _rotatedPath: rotatedPath,
  _shiftGenerations: shiftGenerations,
};
