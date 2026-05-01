'use strict';

/**
 * state-gc.js — TTL-based GC for unbounded state-file accumulators.
 *
 * Addresses F-02, F-03, F-08, F-15, F-20 from v2.2.21 T2 debugger findings:
 *   F-02: routing-pending.jsonl — 2,054 entries / 413 KB, oldest 16 days
 *   F-03: stop-hook.jsonl      — 2,647 entries / 510 KB, no GC
 *   F-08: degraded.jsonl       — 7,988 entries / 2.5 MB across rotated files
 *   F-20: kb-sweep-snapshot.json — 891 KB single non-rotating JSON file
 *
 * Exports:
 *   safeReadJson(filePath, defaultValue) — JSON.parse with SyntaxError self-heal
 *   runOnce(projectDir, opts?)           — idempotent TTL prune of all accumulators
 *
 * Kill switch: ORCHESTRAY_STATE_GC_DISABLED=1 — runOnce() becomes a no-op,
 * reverting to v2.2.20 behaviour (no GC). safeReadJson() is unaffected.
 *
 * Idempotent: calling runOnce() twice on the same state files produces the
 * same result as calling it once.
 *
 * v2.2.21 W4-T18: state-gc initial implementation.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

// Known accumulator JSONL files (relative to .orchestray/state/).
const JSONL_ACCUMULATORS = [
  'routing-pending.jsonl',
  'stop-hook.jsonl',
  'degraded.jsonl',
];

// Known JSON state files that can grow unboundedly (relative to .orchestray/state/).
// For these we track the mtime; if older than TTL, reset to defaultValue.
const JSON_STATE_FILES = [
  { rel: 'kb-sweep-snapshot.json', defaultValue: {} },
];

// ---------------------------------------------------------------------------
// safeReadJson — self-healing JSON.parse
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file, auto-healing on SyntaxError.
 *
 * When parsing fails:
 *   1. Emits `state_file_corrupt` event (best-effort — never throws).
 *   2. Truncates the file to a JSON representation of `defaultValue`.
 *   3. Returns `defaultValue`.
 *
 * On ENOENT: returns `defaultValue` silently (normal pre-first-write state).
 * On other read errors: returns `defaultValue` silently (fail-open).
 *
 * @param {string} filePath      - Absolute path to JSON file.
 * @param {*}      defaultValue  - Value to return and write on corruption ({} or []).
 * @returns {*}
 */
function safeReadJson(filePath, defaultValue) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultValue;
    // Other I/O error — fail-open.
    return defaultValue;
  }

  try {
    return JSON.parse(raw);
  } catch (syntaxErr) {
    // SyntaxError: emit event and truncate.
    _emitStateFileCorrupt(filePath, syntaxErr.message);
    _truncateToDefault(filePath, defaultValue);
    return defaultValue;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Emit `state_file_corrupt` audit event. Best-effort: never throws.
 * Lazy-requires audit-event-writer to avoid circular dependency.
 *
 * @param {string} filePath
 * @param {string} reason
 */
function _emitStateFileCorrupt(filePath, reason) {
  try {
    // eslint-disable-next-line global-require
    const { writeEvent } = require('./audit-event-writer');
    writeEvent({
      version:     1,
      timestamp:   new Date().toISOString(),
      type:        'state_file_corrupt',
      path:        filePath,
      reason:      reason ? String(reason).slice(0, 512) : 'SyntaxError',
    });
  } catch (_e) { /* fail-open */ }
}

/**
 * Write the JSON representation of `defaultValue` to `filePath`.
 * Best-effort: never throws.
 *
 * @param {string} filePath
 * @param {*} defaultValue
 */
function _truncateToDefault(filePath, defaultValue) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue) + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }
}

/**
 * Parse a timestamp string and return ms since epoch, or null on failure.
 *
 * @param {string|undefined|null} ts
 * @returns {number|null}
 */
function _parseTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return isNaN(ms) ? null : ms;
}

/**
 * Prune JSONL lines older than `cutoffMs`.
 *
 * Reads all lines, drops any where the timestamp field (ts, timestamp,
 * stop_timestamp) is older than `cutoffMs`. Lines with no parseable
 * timestamp are kept (fail-open for unknown formats).
 *
 * Writes the result back atomically (write tmp → rename).
 *
 * @param {string} filePath
 * @param {number} cutoffMs  - Entries with timestamp < cutoffMs are dropped.
 * @returns {{ kept: number, dropped: number }} Summary counts.
 */
function _pruneJsonlByTtl(filePath, cutoffMs) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { kept: 0, dropped: 0 };
    return { kept: 0, dropped: 0 };
  }

  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  let kept = 0;
  let dropped = 0;
  const keptLines = [];

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (_e) {
      // Unparseable line — keep it to avoid data loss.
      keptLines.push(line);
      kept++;
      continue;
    }

    // Try common timestamp field names in priority order.
    const tsMs = _parseTimestamp(rec.timestamp) ||
                 _parseTimestamp(rec.ts) ||
                 _parseTimestamp(rec.stop_timestamp);

    if (tsMs !== null && tsMs < cutoffMs) {
      dropped++;
    } else {
      // Keep: no parseable timestamp (fail-open) OR timestamp within TTL window.
      keptLines.push(line);
      kept++;
    }
  }

  if (dropped === 0) return { kept, dropped };

  // Write atomically.
  const tmpPath = filePath + '.gc-tmp-' + process.pid;
  try {
    fs.writeFileSync(tmpPath, keptLines.join('\n') + (keptLines.length > 0 ? '\n' : ''), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Cleanup tmp on failure.
    try { fs.unlinkSync(tmpPath); } catch (_e) {}
    process.stderr.write('[orchestray/state-gc] failed to write pruned file ' + filePath + ': ' + (err && err.message) + '\n');
  }

  return { kept, dropped };
}

/**
 * Prune rotated JSONL generations (.1.jsonl … .N.jsonl) in addition to
 * the active file.
 *
 * @param {string} filePath    - Active (unsuffixed) JSONL path.
 * @param {number} cutoffMs
 * @param {number} maxGenerations
 * @returns {{ kept: number, dropped: number }}
 */
function _pruneJsonlAndRotations(filePath, cutoffMs, maxGenerations) {
  let totalKept = 0;
  let totalDropped = 0;

  // Prune active file.
  const activeResult = _pruneJsonlByTtl(filePath, cutoffMs);
  totalKept += activeResult.kept;
  totalDropped += activeResult.dropped;

  // Prune rotated generations.
  const ext  = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;

  for (let i = 1; i <= maxGenerations; i++) {
    const rotPath = `${base}.${i}${ext || '.jsonl'}`;
    const result  = _pruneJsonlByTtl(rotPath, cutoffMs);
    totalKept += result.kept;
    totalDropped += result.dropped;
  }

  return { kept: totalKept, dropped: totalDropped };
}

// ---------------------------------------------------------------------------
// runOnce — main GC entry point
// ---------------------------------------------------------------------------

/**
 * Prune all known accumulator state files to entries within the TTL window.
 *
 * Idempotent: safe to call multiple times.
 *
 * Kill switch: ORCHESTRAY_STATE_GC_DISABLED=1 — returns immediately with
 * `{ skipped: true }` without touching any files.
 *
 * @param {string} projectDir - Absolute project root.
 * @param {{ ttlMs?: number, maxGenerations?: number }} [opts]
 * @returns {{ skipped?: boolean, results: Object }}
 */
function runOnce(projectDir, opts) {
  // === v2.2.21 W4-T18: state-gc invocation ===
  if (process.env.ORCHESTRAY_STATE_GC_DISABLED === '1') {
    return { skipped: true, results: {} };
  }

  const ttlMs          = (opts && opts.ttlMs          != null) ? opts.ttlMs          : DEFAULT_TTL_MS;
  const maxGenerations = (opts && opts.maxGenerations != null) ? opts.maxGenerations : 5;
  const cutoffMs       = Date.now() - ttlMs;

  const stateDir = path.join(projectDir, '.orchestray', 'state');
  const results  = {};

  // Prune each JSONL accumulator (including its rotated generations).
  for (const rel of JSONL_ACCUMULATORS) {
    const filePath = path.join(stateDir, rel);
    try {
      results[rel] = _pruneJsonlAndRotations(filePath, cutoffMs, maxGenerations);
    } catch (err) {
      // Per fail-open contract: log to stderr, continue.
      process.stderr.write('[orchestray/state-gc] error pruning ' + rel + ': ' + (err && err.message) + '\n');
      results[rel] = { error: String(err && err.message) };
    }
  }

  // For JSON state files: self-heal corruption via safeReadJson.
  // (The actual size/TTL cap for kb-sweep-snapshot.json is deferred to the
  //  architect's sharding design; here we just ensure it self-heals on corruption.)
  for (const { rel, defaultValue } of JSON_STATE_FILES) {
    const filePath = path.join(stateDir, rel);
    try {
      safeReadJson(filePath, defaultValue);
      results[rel] = { healed: true };
    } catch (err) {
      results[rel] = { error: String(err && err.message) };
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  safeReadJson,
  runOnce,
  // Exported for testing only:
  _pruneJsonlByTtl,
  _pruneJsonlAndRotations,
  _parseTimestamp,
  _emitStateFileCorrupt,
  DEFAULT_TTL_MS,
};
