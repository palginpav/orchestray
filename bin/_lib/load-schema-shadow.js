'use strict';

/**
 * load-schema-shadow.js — R-SHDW helper (v2.1.14).
 *
 * Reads the event-schema shadow JSON from disk and returns the parsed object.
 * Also provides source-hash staleness detection and three-strike miss tracking.
 *
 * All operations are fail-open: read failures return null rather than throwing.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SHADOW_REL_PATH  = path.join('agents', 'pm-reference', 'event-schemas.shadow.json');
const SCHEMA_REL_PATH  = path.join('agents', 'pm-reference', 'event-schemas.md');
const STATE_DIR        = path.join('.orchestray', 'state');
const MISSES_FILE      = 'schema-shadow-misses.jsonl';
const SENTINEL_FILE    = '.schema-shadow-disabled';
const MISS_WINDOW_MS   = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Load the shadow JSON from disk.
 *
 * @param {string} cwd - Project root directory.
 * @returns {object|null} Parsed shadow, or null on any read/parse failure.
 */
function loadShadow(cwd) {
  const shadowPath = path.join(cwd, SHADOW_REL_PATH);
  try {
    const raw = fs.readFileSync(shadowPath, 'utf8');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * Compute SHA-256 hash of the source event-schemas.md.
 *
 * @param {string} cwd - Project root directory.
 * @returns {string|null} Hex hash, or null on read failure.
 */
function computeSourceHash(cwd) {
  const schemaPath = path.join(cwd, SCHEMA_REL_PATH);
  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (_e) {
    return null;
  }
}

/**
 * Check whether the three-strike sentinel file exists.
 *
 * @param {string} cwd - Project root directory.
 * @returns {boolean}
 */
function isSentinelActive(cwd) {
  const sentinelPath = path.join(cwd, STATE_DIR, SENTINEL_FILE);
  return fs.existsSync(sentinelPath);
}

/**
 * Record a shadow miss in the miss log. If 3+ misses occur within 24 hours,
 * write the auto-disable sentinel.
 *
 * @param {string} cwd - Project root directory.
 * @param {string} eventType - The event type that caused the miss.
 * @param {string} sourceHash - Current source hash.
 * @param {number} missThreshold - Number of misses that trigger auto-disable (default 3).
 */
function recordMiss(cwd, eventType, sourceHash, missThreshold) {
  if (!missThreshold) missThreshold = 3;
  try {
    const stateDir   = path.join(cwd, STATE_DIR);
    const missesPath = path.join(stateDir, MISSES_FILE);

    // Ensure state dir exists
    fs.mkdirSync(stateDir, { recursive: true });

    // Append miss entry
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event_type: eventType,
      source_hash: sourceHash || 'unknown',
    });
    fs.appendFileSync(missesPath, entry + '\n', 'utf8');

    // Count recent misses (within 24h)
    let missCount = 0;
    try {
      const cutoff = Date.now() - MISS_WINDOW_MS;
      const lines = fs.readFileSync(missesPath, 'utf8')
        .split('\n')
        .filter(l => l.trim());
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (new Date(row.timestamp).getTime() >= cutoff) {
            missCount++;
          }
        } catch (_e) { /* skip malformed line */ }
      }
    } catch (_e) { /* fail-open */ }

    if (missCount >= missThreshold) {
      const sentinelPath = path.join(stateDir, SENTINEL_FILE);
      if (!fs.existsSync(sentinelPath)) {
        fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n', 'utf8');
        process.stderr.write(
          '[load-schema-shadow] three-strike threshold reached (' + missCount +
          ' misses in 24h) — shadow auto-disabled until regeneration\n'
        );
      }
    }
  } catch (_e) {
    // Fail-open: miss tracking errors are non-fatal
  }
}

/**
 * Load shadow with staleness detection.
 *
 * Returns { shadow, stale, disabled } where:
 *   shadow   — parsed shadow object, or null
 *   stale    — true if source_hash mismatch detected
 *   disabled — true if kill switch or sentinel is active
 *
 * @param {string} cwd - Project root directory.
 * @param {object} [opts] - Options.
 * @param {boolean} [opts.envDisabled] - True if env var kill switch is active.
 * @param {boolean} [opts.configDisabled] - True if config kill switch is active.
 * @returns {{ shadow: object|null, stale: boolean, disabled: boolean }}
 */
function loadShadowWithCheck(cwd, opts) {
  const o = opts || {};

  if (o.envDisabled || o.configDisabled || isSentinelActive(cwd)) {
    return { shadow: null, stale: false, disabled: true };
  }

  const shadow = loadShadow(cwd);
  if (!shadow) {
    return { shadow: null, stale: false, disabled: false };
  }

  // Staleness check: compare _meta.source_hash against current file hash
  const storedHash  = shadow._meta && shadow._meta.source_hash;
  const currentHash = computeSourceHash(cwd);

  if (storedHash && currentHash && storedHash !== currentHash) {
    return { shadow, stale: true, disabled: false };
  }

  return { shadow, stale: false, disabled: false };
}

module.exports = {
  loadShadow,
  loadShadowWithCheck,
  computeSourceHash,
  isSentinelActive,
  recordMiss,
  SHADOW_REL_PATH,
  SCHEMA_REL_PATH,
  SENTINEL_FILE,
  MISSES_FILE,
};
