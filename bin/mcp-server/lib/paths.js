'use strict';

/**
 * Cross-platform path helpers for the Orchestray MCP server.
 *
 * Single chokepoint for plugin-root and project-root resolution. No untrusted
 * caller paths are accepted in Stage 1 — all inputs come from the server's
 * own environment (env vars, __dirname, process.cwd()).
 *
 * Per v2011c-stage1-plan.md §3.1.
 */

const fs = require('node:fs');
const path = require('node:path');

const WALK_CAP = 20;

/**
 * Walk upward from `start` looking for a directory that contains `marker`.
 * Returns the first directory that has it, or null if the walk cap is hit.
 *
 * `marker` is a relative path like `.claude-plugin/plugin.json` or `.orchestray`.
 */
function walkUpFor(start, marker) {
  let current = path.resolve(start);
  for (let i = 0; i < WALK_CAP; i++) {
    const candidate = path.join(current, marker);
    try {
      // fs.existsSync is acceptable here — one-time startup check, not hot path.
      if (fs.existsSync(candidate)) {
        return current;
      }
    } catch (_e) {
      // Ignore and keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root.
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Resolve the plugin root — the directory containing `.claude-plugin/plugin.json`.
 *
 * Resolution order:
 *   1. `ORCHESTRAY_PLUGIN_ROOT` env var if set and valid
 *   2. Walk up from this file's directory until `.claude-plugin/plugin.json` is found
 *
 * Throws on miss; server.js catches at startup and exits 1.
 */
function getPluginRoot() {
  const fromEnv = process.env.ORCHESTRAY_PLUGIN_ROOT;
  if (fromEnv && fromEnv.length > 0) {
    const marker = path.join(fromEnv, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(marker)) {
      return path.resolve(fromEnv);
    }
    // Env var was set but invalid — still try to walk up as a fallback.
  }

  const found = walkUpFor(__dirname, path.join('.claude-plugin', 'plugin.json'));
  if (found) return found;
  throw new Error('plugin root not found');
}

/**
 * Resolve the project root — the directory containing `.orchestray/`.
 *
 * Walks up from `process.cwd()` (not __dirname) so callers that chdir into a
 * sandbox/fixture get the expected result. Throws on miss.
 */
function getProjectRoot() {
  const found = walkUpFor(process.cwd(), '.orchestray');
  if (found) return found;
  throw new Error('project root not found (no .orchestray/ in cwd ancestors)');
}

/** Absolute path to `<project>/.orchestray/audit/events.jsonl`. */
function getAuditEventsPath() {
  return path.join(getProjectRoot(), '.orchestray', 'audit', 'events.jsonl');
}

/** Absolute path to `<project>/.orchestray/audit/current-orchestration.json`. */
function getCurrentOrchestrationPath() {
  return path.join(getProjectRoot(), '.orchestray', 'audit', 'current-orchestration.json');
}

/** Absolute path to `<project>/.orchestray/config.json`. */
function getConfigPath() {
  return path.join(getProjectRoot(), '.orchestray', 'config.json');
}

module.exports = {
  getPluginRoot,
  getProjectRoot,
  getAuditEventsPath,
  getCurrentOrchestrationPath,
  getConfigPath,
};
