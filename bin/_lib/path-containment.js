'use strict';

/**
 * path-containment.js — Shared path-containment guard.
 *
 * Extracted from bin/capture-pm-turn.js and bin/collect-agent-metrics.js (W3 / v2.0.19)
 * to provide a single, tested implementation used by all hook scripts that read
 * user-supplied file paths.
 *
 * Exported API:
 *   isInsideAllowed(resolvedPath, cwdAbs, claudeHomeAbs) → boolean
 *   safeRealpath(p) → string
 */

const fs   = require('fs');
const path = require('path');

/**
 * Resolve a path to its real absolute form.
 * Falls back to path.resolve() if the path does not exist (e.g., during install).
 *
 * @param {string} p
 * @returns {string}
 */
function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
}

/**
 * Return true if `resolvedPath` is inside the project cwd or the user's ~/.claude dir.
 *
 * DEF-1 (from collect-agent-metrics.js): resolve symlinks on both sides so a cwd
 * that is a symlink to the real project dir does not trip the containment check.
 *
 * @param {string} resolvedPath  - Already-resolved absolute path to check.
 * @param {string} cwdAbs        - Already-resolved absolute project root.
 * @param {string} claudeHomeAbs - Already-resolved absolute ~/.claude path.
 * @returns {boolean}
 */
function isInsideAllowed(resolvedPath, cwdAbs, claudeHomeAbs) {
  const insideCwd =
    resolvedPath === cwdAbs ||
    resolvedPath.startsWith(cwdAbs + path.sep);
  const insideClaudeHome =
    resolvedPath === claudeHomeAbs ||
    resolvedPath.startsWith(claudeHomeAbs + path.sep);
  return insideCwd || insideClaudeHome;
}

/**
 * Encode a project root path into the form Claude Code uses for its
 * ~/.claude/projects/<encoded>/ cache directory.
 *
 * Algorithm: strip the leading '/', replace all remaining '/' with '-'.
 * Claude Code prepends a '-' when building the full path, so:
 *   "/home/palgin/orchestray" → "home-palgin-orchestray"
 * and the full cache dir becomes "~/.claude/projects/-home-palgin-orchestray".
 *
 * @param {string} projectRoot - Absolute path to the project root (e.g. process.cwd()).
 * @returns {string} Encoded path segment.
 */
function encodeProjectPath(projectRoot) {
  return projectRoot.replace(/^\//, '').replace(/\//g, '-');
}

module.exports = { safeRealpath, isInsideAllowed, encodeProjectPath };
