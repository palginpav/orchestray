'use strict';

/**
 * effective-gate-state.js — R-GATE opt-in quarantine overlay (v2.1.14).
 *
 * Returns the post-quarantine-overlay gate state for a given config.
 * Other Orchestray code that checks gate state should use this helper
 * instead of reading `enable_*` keys directly from config to ensure
 * quarantine_candidates overrides are applied.
 *
 * Overlay precedence (highest wins):
 *   1. Session wake: .orchestray/state/feature-wake-session.json
 *   2. 30-day pinned wake: .orchestray/state/feature-wake-pinned.json
 *   3. quarantine_candidates in config (quarantines = false override)
 *   4. Raw config value
 *
 * Fail-open: any I/O error returns the raw config value for the gate.
 * Never throws.
 */

const fs   = require('fs');
const path = require('path');

const {
  WIRED_EMITTER_PROTOCOLS,
  GATE_SLUG_TO_CONFIG_KEY,
} = require('./feature-demand-tracker');

// File paths (relative to cwd).
const SESSION_WAKE_FILE = path.join('.orchestray', 'state', 'feature-wake-session.json');
const PINNED_WAKE_FILE  = path.join('.orchestray', 'state', 'feature-wake-pinned.json');

/**
 * Read the session-wake set (slugs woken for this session).
 * Returns Set<string> of gate slugs that are woken for the session.
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
function readSessionWakes(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, SESSION_WAKE_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.slugs)) return new Set();
    return new Set(data.slugs.filter(s => typeof s === 'string'));
  } catch (_e) {
    return new Set();
  }
}

/**
 * Read the pinned-wake set (slugs woken for 30 days).
 * Respects the `until` expiry timestamp per entry.
 * Returns Set<string> of currently-active pinned wake slugs.
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
function readPinnedWakes(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, PINNED_WAKE_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries)) return new Set();
    const now = Date.now();
    const active = data.entries
      .filter(e => e && typeof e.slug === 'string' && (!e.until || Date.parse(e.until) > now))
      .map(e => e.slug);
    return new Set(active);
  } catch (_e) {
    return new Set();
  }
}

/**
 * Get the quarantine_candidates list from config.
 *
 * @param {object} config - Raw config object (already parsed).
 * @returns {string[]} Array of gate slugs listed as quarantine candidates.
 */
function getQuarantineCandidates(config) {
  try {
    const fdg = config && config.feature_demand_gate;
    if (!fdg || typeof fdg !== 'object') return [];
    const candidates = fdg.quarantine_candidates;
    if (!Array.isArray(candidates)) return [];
    return candidates.filter(s => typeof s === 'string');
  } catch (_e) {
    return [];
  }
}

/**
 * Determine the effective boolean state of a gate slug, applying quarantine overlay.
 *
 * @param {object} params
 * @param {string} params.cwd - Project root directory (absolute path).
 * @param {object} params.config - Raw parsed config object.
 * @param {string} params.gateSlug - Gate slug to check (e.g. 'pattern_extraction').
 * @param {boolean} params.rawValue - The raw config value for this gate.
 * @returns {{ effective: boolean, source: string }}
 *   source is one of: 'session_wake', 'pinned_wake', 'quarantine_overlay', 'config'
 */
function getEffectiveGateState({ cwd, config, gateSlug, rawValue }) {
  try {
    const sessionWakes = readSessionWakes(cwd);
    if (sessionWakes.has(gateSlug)) {
      return { effective: true, source: 'session_wake' };
    }

    const pinnedWakes = readPinnedWakes(cwd);
    if (pinnedWakes.has(gateSlug)) {
      return { effective: true, source: 'pinned_wake' };
    }

    const candidates = getQuarantineCandidates(config);
    if (candidates.includes(gateSlug)) {
      return { effective: false, source: 'quarantine_overlay' };
    }

    return { effective: Boolean(rawValue), source: 'config' };
  } catch (_e) {
    return { effective: Boolean(rawValue), source: 'config' };
  }
}

/**
 * Get the full effective gate map for all tracked wired-emitter gates.
 * Returns an object: gateSlug → { effective: boolean, source: string }
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @param {object} config - Raw parsed config object.
 * @returns {object}
 */
function getEffectiveGateMap(cwd, config) {
  const result = {};
  try {
    const sessionWakes = readSessionWakes(cwd);
    const pinnedWakes  = readPinnedWakes(cwd);
    const candidates   = getQuarantineCandidates(config);

    for (const slug of WIRED_EMITTER_PROTOCOLS) {
      const configKey = GATE_SLUG_TO_CONFIG_KEY[slug];
      const rawValue  = config && config[configKey];

      if (sessionWakes.has(slug)) {
        result[slug] = { effective: true, source: 'session_wake' };
      } else if (pinnedWakes.has(slug)) {
        result[slug] = { effective: true, source: 'pinned_wake' };
      } else if (candidates.includes(slug)) {
        result[slug] = { effective: false, source: 'quarantine_overlay' };
      } else {
        result[slug] = { effective: Boolean(rawValue), source: 'config' };
      }
    }
  } catch (_e) {
    // Fall back: all gates follow raw config (or default false)
    for (const slug of WIRED_EMITTER_PROTOCOLS) {
      const configKey = GATE_SLUG_TO_CONFIG_KEY[slug];
      const rawValue  = config && config[configKey];
      result[slug] = { effective: Boolean(rawValue), source: 'config' };
    }
  }
  return result;
}

/**
 * Write a session-wake entry for the given slug.
 * Adds to existing set (idempotent).
 *
 * @param {string} cwd
 * @param {string} slug
 */
function addSessionWake(cwd, slug) {
  const filePath = path.join(cwd, SESSION_WAKE_FILE);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let data = { slugs: [] };
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.slugs)) data = parsed;
    } catch (_e) {}
    if (!data.slugs.includes(slug)) {
      data.slugs.push(slug);
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_e) {}
}

/**
 * Write a 30-day pinned-wake entry for the given slug.
 * Replaces existing entry for the slug if present.
 *
 * @param {string} cwd
 * @param {string} slug
 */
function addPinnedWake(cwd, slug) {
  const filePath = path.join(cwd, PINNED_WAKE_FILE);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let data = { entries: [] };
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) data = parsed;
    } catch (_e) {}
    // Remove existing entry for this slug, then add a fresh one.
    data.entries = data.entries.filter(e => e && e.slug !== slug);
    const untilMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    data.entries.push({
      slug,
      until: new Date(untilMs).toISOString(),
      added_at: new Date().toISOString(),
    });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_e) {}
}

module.exports = {
  getEffectiveGateState,
  getEffectiveGateMap,
  readSessionWakes,
  readPinnedWakes,
  getQuarantineCandidates,
  addSessionWake,
  addPinnedWake,
  SESSION_WAKE_FILE,
  PINNED_WAKE_FILE,
  // Re-exported from feature-demand-tracker for consumers that import effective-gate-state
  GATE_SLUG_TO_CONFIG_KEY,
};
