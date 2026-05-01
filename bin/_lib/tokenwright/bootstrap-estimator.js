'use strict';

/**
 * bootstrap-estimator.js — Rolling-median pre-spawn token estimator (W8, v2.2.18).
 *
 * E#5 / W9 note (v2.2.19 audit-fix R1): This module is inert in production when
 * tokenwright.l1_compression_enabled=false (default since v2.2.19 safe-l1 kill-switch).
 * The S2 wire in inject-tokenwright.js calls bootstrapEstimate() after the L1 kill
 * switch, so this code only executes when L1 is re-enabled. Tested at unit level;
 * integration tests activate in v2.2.20 L1 revival.
 *
 *
 * Problem: static bytes/4 formula drifts 900% on researcher agents and ~5x on
 * developer/tester/reviewer. This module replaces the static fallback with a
 * rolling median of the last 10 `tokenwright_realized_savings.actual_input_tokens`
 * samples for the requested agent_type, read from the audit events log.
 *
 * API:
 *   bootstrapEstimate(agentType, opts) → number
 *
 * Kill switches (both must pass for bootstrap to activate):
 *   - env ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED=1  → silent static fallback
 *   - config tokenwright.bootstrap_enabled === false    → silent static fallback
 *
 * Defense:
 *   - Tail-scan: reads last 1000 lines of events.jsonl only (never full file)
 *   - File missing → STATIC_FALLBACK; emits tokenwright_bootstrap_skipped
 *   - Parse error  → STATIC_FALLBACK; emits tokenwright_bootstrap_skipped
 *   - <3 samples   → STATIC_FALLBACK; emits tokenwright_bootstrap_skipped
 *   - Kill switch  → STATIC_FALLBACK; NO event (kill switches are silent)
 *
 * No module-level cache — each call re-reads tail (estimates update as samples land).
 */

const fs   = require('fs');
const path = require('path');

const { writeEvent } = require('../audit-event-writer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Static fallback when bootstrap cannot apply. */
const STATIC_FALLBACK = 500;

/** Minimum samples required to use rolling median. */
const MIN_SAMPLES = 3;

/** Maximum samples to include in median. */
const MAX_SAMPLES = 10;

/** Maximum tail lines to read from the events file (memory guard). */
const TAIL_LINE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute median of a numeric array.
 * Sorts ascending, returns middle element (odd length) or average of two middle
 * elements (even length).
 *
 * @param {number[]} values — must be non-empty
 * @returns {number}
 */
function computeMedian(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Emit a bootstrap-related audit event. Fail-safe — errors go to stderr only.
 *
 * @param {string} type
 * @param {object} payload
 * @param {string} cwd     — project root, passed to writeEvent so the event
 *                           lands in the correct .orchestray/audit/events.jsonl
 */
function _emit(type, payload, cwd) {
  try {
    const ts = new Date().toISOString();
    const event = Object.assign({}, payload, {
      version:   1,
      type,
      ts,
      timestamp: ts,
    });
    writeEvent(event, { cwd });
  } catch (err) {
    try {
      process.stderr.write(
        '[tokenwright/bootstrap-estimator] failed to emit ' + type + ': ' +
        String(err && err.message ? err.message : err) + '\n'
      );
    } catch (_e) { /* swallow */ }
  }
}

/**
 * Read the last TAIL_LINE_LIMIT lines from a JSONL file and return parsed objects
 * that match `type === 'tokenwright_realized_savings'` and `agent_type === agentType`,
 * most-recent first, capped at MAX_SAMPLES.
 *
 * @param {string} eventsPath   — absolute path to events.jsonl
 * @param {string} agentType    — filter to this agent_type
 * @returns {{ samples: number[], error: string|null }}
 */
function readLastNSamples(eventsPath, agentType) {
  try {
    if (!fs.existsSync(eventsPath)) {
      return { samples: [], error: 'metrics_file_missing' };
    }

    // Read raw bytes, take the tail portion only
    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n');
    const tail  = lines.length > TAIL_LINE_LIMIT
      ? lines.slice(lines.length - TAIL_LINE_LIMIT)
      : lines;

    const samples = [];
    // Iterate tail in reverse (most-recent first) to collect up to MAX_SAMPLES
    for (let i = tail.length - 1; i >= 0 && samples.length < MAX_SAMPLES; i--) {
      const line = tail[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_parseErr) {
        // Skip malformed lines; don't abort the whole scan
        continue;
      }
      const evtType = obj.type || obj.event_type;
      if (evtType !== 'tokenwright_realized_savings') continue;
      if (obj.agent_type !== agentType) continue;
      const tokens = obj.actual_input_tokens;
      if (typeof tokens !== 'number' || tokens <= 0) continue;
      samples.push(tokens);
    }

    return { samples, error: null };
  } catch (err) {
    return { samples: [], error: 'parse_error' };
  }
}

/**
 * Resolve the project root from opts or env.
 *
 * @param {object} opts
 * @returns {string}
 */
function resolveCwd(opts) {
  return (opts && opts.cwd) ||
         process.env.ORCHESTRAY_PROJECT_ROOT ||
         process.cwd();
}

/**
 * Resolve the path to events.jsonl for a given project root.
 *
 * @param {string} cwd
 * @returns {string}
 */
function eventsPathFor(cwd) {
  return path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
}

/**
 * Check env kill switch.
 */
function isKillSwitchActive() {
  return process.env.ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED === '1';
}

/**
 * Check config gate. Defaults to true (enabled) when key absent.
 *
 * @param {object} opts
 * @returns {boolean}
 */
function isConfigEnabled(opts) {
  if (opts && opts.config && typeof opts.config.tokenwright === 'object') {
    const flag = opts.config.tokenwright.bootstrap_enabled;
    if (typeof flag === 'boolean') return flag;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a pre-spawn token estimate for the given agent_type.
 *
 * If >= MIN_SAMPLES historical actual_input_tokens samples exist for the
 * agent_type, returns the rolling median of the last MAX_SAMPLES of them.
 * Otherwise returns a bytes/4 estimate when `opts.inBytes` is supplied, or
 * STATIC_FALLBACK (500) when not — this avoids synthetic regression on cold
 * cache (W#9 / v2.2.19 audit-fix R1: STATIC_FALLBACK=500 understates reality
 * for large prompts; bytes/4 is a better cold-start baseline).
 *
 * Events emitted:
 *   - tokenwright_bootstrap_applied   when median is used
 *   - tokenwright_bootstrap_skipped   when falling back (except kill_switch reason)
 *
 * @param {string} agentType   — e.g. 'developer', 'researcher', 'tester', 'reviewer'
 * @param {object} [opts]
 * @param {string} [opts.cwd]           — project root (default: process.cwd())
 * @param {object} [opts.config]        — loaded config object (for bootstrap_enabled flag)
 * @param {number} [opts.inBytes]       — W#9: byte length of the prompt being spawned;
 *                                        when supplied AND samples < MIN_SAMPLES,
 *                                        returns Math.round(inBytes/4) instead of
 *                                        STATIC_FALLBACK so cold-cache estimates track
 *                                        actual prompt size rather than a fixed 500.
 * @returns {number}  estimated input tokens
 */
function bootstrapEstimate(agentType, opts) {
  // Kill switch — silent, no event
  if (isKillSwitchActive()) {
    return STATIC_FALLBACK;
  }

  // Config gate — silent, no event
  if (!isConfigEnabled(opts)) {
    return STATIC_FALLBACK;
  }

  const cwd        = resolveCwd(opts);
  const eventsPath = eventsPathFor(cwd);
  const { samples, error } = readLastNSamples(eventsPath, agentType);

  if (error) {
    _emit('tokenwright_bootstrap_skipped', {
      agent_type: agentType,
      reason:     error,
    }, cwd);
    // W#9: use bytes/4 when inBytes is available, otherwise STATIC_FALLBACK.
    return (opts && typeof opts.inBytes === 'number' && opts.inBytes > 0)
      ? Math.round(opts.inBytes / 4)
      : STATIC_FALLBACK;
  }

  if (samples.length < MIN_SAMPLES) {
    _emit('tokenwright_bootstrap_skipped', {
      agent_type:  agentType,
      reason:      'insufficient_samples',
      sample_size: samples.length,
    }, cwd);
    // W#9: bytes/4 is a better cold-start estimate than STATIC_FALLBACK=500
    // for prompts larger than ~2000 bytes. Rolling median takes over once
    // MIN_SAMPLES (3) historical actuals are available.
    return (opts && typeof opts.inBytes === 'number' && opts.inBytes > 0)
      ? Math.round(opts.inBytes / 4)
      : STATIC_FALLBACK;
  }

  const median = computeMedian(samples);

  _emit('tokenwright_bootstrap_applied', {
    agent_type:           agentType,
    sample_size:          samples.length,
    median_actual_tokens: median,
    pre_estimate:         STATIC_FALLBACK,
    post_estimate:        median,
  }, cwd);

  return median;
}

module.exports = {
  bootstrapEstimate,
  computeMedian,    // exported for tests
  STATIC_FALLBACK,  // exported for tests
  MIN_SAMPLES,      // exported for tests
};
