'use strict';

/**
 * path-containment.js — Shared path-containment guard.
 *
 * Extracted from bin/capture-pm-turn.js and bin/collect-agent-metrics.js (W3 / v2.0.19)
 * to provide a single, tested implementation used by all hook scripts that read
 * user-supplied file paths.
 *
 * Extended in v2.2.21 (G3-W2-T4) with `validateTranscriptPath` — a high-level
 * helper that consolidates all transcript-path containment logic so every
 * hook consuming `event.transcript_path` uses a single, audited gate.
 *
 * Exported API:
 *   isInsideAllowed(resolvedPath, cwdAbs, claudeHomeAbs) → boolean
 *   safeRealpath(p) → string
 *   encodeProjectPath(projectRoot) → string
 *   validateTranscriptPath(transcriptPath, cwd, emitFn?) → string
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Path-traversal regex — verbatim from agents/pm.md:104 / sentinel-probes.js.
const _DOTDOT_RE = /(^|\/)\.\.(\/|$)/;

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

/**
 * Validate a caller-supplied transcript path against the project root and
 * Claude's home directory. Returns the resolved absolute path if safe, or
 * `''` (empty string) on any violation.
 *
 * Security checks (modeled on sentinel-probes.js `_normalizeProjectPath`):
 *   1. Type / emptiness guard
 *   2. Raw `..` component rejection (char-level, before realpath)
 *   3. safeRealpath resolution
 *   4. isInsideAllowed containment check (cwd OR ~/.claude)
 *
 * On rejection, calls `emitFn('transcript_path_containment_failed', reason)`
 * if provided — letting the caller emit an audit event without coupling this
 * library to any specific event emitter.
 *
 * @param {string|null|undefined} transcriptPath  - Caller-supplied path.
 * @param {string}                cwd             - Resolved project root (already-trusted).
 * @param {function=}             emitFn          - Optional (eventType: string, reason: string) => void
 * @returns {string} Resolved absolute path on success; '' on failure.
 */
function validateTranscriptPath(transcriptPath, cwd, emitFn) {
  const emit = typeof emitFn === 'function' ? emitFn : () => {};

  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    // Not a violation — just absent. No audit event.
    return '';
  }

  // Reject raw `..` components in the *input* before any realpath call.
  if (_DOTDOT_RE.test(transcriptPath)) {
    emit('transcript_path_containment_failed', 'dotdot_in_path');
    return '';
  }

  let cwdAbs;
  let claudeHomeAbs;
  let tmpAbs;
  try {
    cwdAbs       = safeRealpath(cwd);
    claudeHomeAbs = safeRealpath(path.join(os.homedir(), '.claude'));
    // Claude Code stores agent transcripts under os.tmpdir() on many platforms.
    tmpAbs       = safeRealpath(os.tmpdir());
  } catch (_e) {
    emit('transcript_path_containment_failed', 'realpath_cwd_failed');
    return '';
  }

  // Resolve the caller-supplied path (may be absolute or relative to cwd).
  const abs = path.isAbsolute(transcriptPath)
    ? transcriptPath
    : path.resolve(cwdAbs, transcriptPath);

  let resolved;
  try {
    resolved = safeRealpath(abs);
  } catch (_e) {
    emit('transcript_path_containment_failed', 'realpath_failed');
    return '';
  }

  const insideTmp = resolved === tmpAbs || resolved.startsWith(tmpAbs + path.sep);
  if (!isInsideAllowed(resolved, cwdAbs, claudeHomeAbs) && !insideTmp) {
    emit('transcript_path_containment_failed', 'outside_allowed_roots');
    return '';
  }

  return resolved;
}

module.exports = { safeRealpath, isInsideAllowed, encodeProjectPath, validateTranscriptPath };
