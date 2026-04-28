'use strict';

/**
 * auto-trigger-ttl.js — UserPromptSubmit early-tail TTL sweeper.
 *
 * v2.2.9 B-7.6 (W1 F-PM-25 fold-in via scope-lock #1).
 *
 * Mechanises the prose-only file-lifecycle invariant:
 *
 *   "PM Section 0 reads `.orchestray/auto-trigger.json` and DELETES it
 *    immediately so it does not re-trigger on the next prompt."
 *
 * If the PM forgets to unlink (or the marker survives a session crash), the
 * file becomes a re-trigger landmine. This sweeper deletes any marker whose
 * `timestamp`/`created_at` field is older than `auto_trigger_ttl_seconds`
 * (default 3600, configurable via `.orchestray/config.json`).
 *
 * Wired as a UserPromptSubmit early-tail hook so it runs BEFORE
 * `complexity-precheck.js` writes a fresh marker — preventing a stale marker
 * from masking a fresh detection.
 *
 * Public API:
 *   runSweep(cwd) -> { action: 'no_marker'|'kept'|'expired'|'error', age_seconds, file_path }
 *
 * The standalone hook entry (bin/expire-auto-trigger.js) wraps this helper
 * with a stdin-passthrough JSON envelope for Claude Code compatibility.
 *
 * Fail-open contract: every code path returns a result object; nothing throws.
 */

const fs = require('fs');
const path = require('path');

const { loadAutoTriggerTtlSeconds } = require('./numeric-thresholds');
const { writeEvent } = require('./audit-event-writer');

function _parseTimestamp(maybe) {
  if (!maybe || typeof maybe !== 'string') return null;
  const t = Date.parse(maybe);
  return Number.isFinite(t) ? t : null;
}

/**
 * Run a single TTL sweep over `.orchestray/auto-trigger.json`.
 *
 * @param {string} cwd
 * @returns {{action: string, age_seconds: number|null, file_path: string}}
 */
function runSweep(cwd) {
  const filePath = path.join(cwd, '.orchestray', 'auto-trigger.json');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { action: 'no_marker', age_seconds: null, file_path: filePath };
    }
    return { action: 'error', age_seconds: null, file_path: filePath };
  }

  // Prefer the file's own `timestamp`/`created_at` field; fall back to mtime.
  let createdAtMs = null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      createdAtMs = _parseTimestamp(parsed.created_at) || _parseTimestamp(parsed.timestamp);
    }
  } catch (_e) { /* fall through to mtime */ }
  if (createdAtMs === null) {
    createdAtMs = stat.mtimeMs;
  }

  const ttlSec = loadAutoTriggerTtlSeconds(cwd);
  const ageSec = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));

  if (ageSec <= ttlSec) {
    return { action: 'kept', age_seconds: ageSec, file_path: filePath };
  }

  // Expired — delete and emit.
  try {
    fs.unlinkSync(filePath);
  } catch (_unlinkErr) {
    return { action: 'error', age_seconds: ageSec, file_path: filePath };
  }
  try {
    writeEvent({
      type: 'auto_trigger_expired',
      version: 1,
      timestamp: new Date().toISOString(),
      age_seconds: ageSec,
      file_path: filePath,
    }, { cwd });
  } catch (_emitErr) { /* fail-open */ }
  return { action: 'expired', age_seconds: ageSec, file_path: filePath };
}

module.exports = {
  runSweep,
};
