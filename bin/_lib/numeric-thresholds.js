'use strict';

/**
 * numeric-thresholds.js — single config schema for v2.2.9 B-7 numeric gates.
 *
 * Bundle B-7 ("Less prose, more mechanisation") moves six numeric thresholds
 * out of pm.md prose and into `.orchestray/config.json`, validated here.
 *
 * Knobs surfaced:
 *   spawn.max_turns_hard_cap        (default 200)        B-7.1 maxTurns gate
 *   repo_map.max_size_kb            (default 96)         B-7.2 repo-map drift
 *   repo_map.shadow_mode            (default true)       B-7.2 v2.2.9 → v2.2.10 flip
 *   auto_trigger_ttl_seconds        (default 3600)       B-7.6 marker TTL
 *
 * Loaders are fail-open: any read/parse error returns documented defaults so
 * the consuming hook (gate-agent-spawn, auto-trigger-ttl) never blocks
 * Claude Code on a config glitch.
 *
 * The B-7.4 (`ORCHESTRAY_STRICT_MODEL_REQUIRED`) and B-7.3 (kb-index validator)
 * gates do NOT live in config — they are env-toggle and structural-validation
 * respectively. They are emitted from this file's documentation only for
 * cross-reference; their code lives in `bin/gate-agent-spawn.js` and
 * `bin/_lib/kb-index-validator.js`.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  spawn: Object.freeze({
    max_turns_hard_cap: 200,
  }),
  repo_map_thresholds: Object.freeze({
    max_size_kb: 96,
    shadow_mode: true,
  }),
  auto_trigger_ttl_seconds: 3600,
});

function _readConfig(cwd) {
  const cfgPath = path.join(cwd, '.orchestray', 'config.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

function _coerceNonNegInt(v, fallback) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}

/**
 * Load `spawn.max_turns_hard_cap` (B-7.1).
 * @param {string} cwd
 * @returns {number} positive integer, default 200.
 */
function loadMaxTurnsHardCap(cwd) {
  const cfg = _readConfig(cwd);
  if (!cfg || !cfg.spawn || typeof cfg.spawn !== 'object') {
    return DEFAULTS.spawn.max_turns_hard_cap;
  }
  return _coerceNonNegInt(cfg.spawn.max_turns_hard_cap, DEFAULTS.spawn.max_turns_hard_cap);
}

/**
 * Load `repo_map_thresholds` block (B-7.2).
 *
 * Note: the existing `repo_map` config block is owned by `bin/_lib/repo-map.js`
 * (languages/cache_dir/cold_init_async). To avoid colliding with that block, the
 * new B-7.2 thresholds live under `repo_map_thresholds` (separate object).
 *
 * @param {string} cwd
 * @returns {{max_size_kb: number, shadow_mode: boolean}}
 */
function loadRepoMapThresholds(cwd) {
  const cfg = _readConfig(cwd);
  const block = (cfg && cfg.repo_map_thresholds && typeof cfg.repo_map_thresholds === 'object')
    ? cfg.repo_map_thresholds : {};
  return {
    max_size_kb: _coerceNonNegInt(block.max_size_kb, DEFAULTS.repo_map_thresholds.max_size_kb),
    shadow_mode: typeof block.shadow_mode === 'boolean' ? block.shadow_mode
      : DEFAULTS.repo_map_thresholds.shadow_mode,
  };
}

/**
 * Load `auto_trigger_ttl_seconds` (B-7.6).
 * @param {string} cwd
 * @returns {number} positive integer seconds, default 3600.
 */
function loadAutoTriggerTtlSeconds(cwd) {
  const cfg = _readConfig(cwd);
  if (!cfg) return DEFAULTS.auto_trigger_ttl_seconds;
  return _coerceNonNegInt(cfg.auto_trigger_ttl_seconds, DEFAULTS.auto_trigger_ttl_seconds);
}

module.exports = {
  DEFAULTS,
  loadMaxTurnsHardCap,
  loadRepoMapThresholds,
  loadAutoTriggerTtlSeconds,
};
