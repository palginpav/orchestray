'use strict';

/**
 * Shared constant and helper for the current-orchestration marker file.
 *
 * The path `.orchestray/audit/current-orchestration.json` was hardcoded in
 * 7+ hook scripts. Centralising it here means a single change propagates
 * everywhere (W8 fix).
 */

const path = require('path');

/** Relative path from project root to the orchestration marker file. */
const CURRENT_ORCHESTRATION_FILE = path.join('.orchestray', 'audit', 'current-orchestration.json');

/**
 * Resolve the absolute path to the current-orchestration.json marker.
 *
 * @param {string} cwd - Absolute path to the project root (already validated).
 * @returns {string} Absolute path to the marker file.
 */
function getCurrentOrchestrationFile(cwd) {
  return path.join(cwd, CURRENT_ORCHESTRATION_FILE);
}

module.exports = {
  CURRENT_ORCHESTRATION_FILE,
  getCurrentOrchestrationFile,
};
