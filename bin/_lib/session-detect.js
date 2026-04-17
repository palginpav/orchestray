'use strict';

/**
 * session-detect.js — Detect when a Claude Code session started.
 *
 * Theme 1 (v2.0.22): The upgrade-detection state machine needs to compare
 * `installed_at_ms` (from the upgrade sentinel) against the session's start
 * time to decide whether this session predates the install. This module
 * derives the session-start time from the transcript JSONL file mtime at
 * `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, which Claude Code
 * creates at the first transcript event (approximately session start).
 *
 * Exports:
 *   detectSessionStartMs(sessionId, projectDir) → number | null
 *   encodeCwd(cwd) → string
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

/**
 * Regex for a valid Claude Code session ID.
 * Session IDs are UUID v4 or UUID-like hex strings. We accept anything that
 * consists only of hex digits and hyphens (36 chars max) and contains no
 * path-traversal characters. This blocks "../" injection before any fs call.
 *
 * @type {RegExp}
 */
const SESSION_ID_RE = /^[0-9a-f-]{1,36}$/i;

/**
 * Encode an absolute directory path into the format Claude Code uses for its
 * per-project transcript directory name:
 *   /home/user/myproject  →  -home-user-myproject
 *
 * Algorithm: strip leading slash, then replace every remaining slash with '-',
 * then prepend '-'.
 *
 * @param {string} cwd  Absolute POSIX path (must start with '/').
 * @returns {string}    Encoded directory name.
 */
function encodeCwd(cwd) {
  return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
}

/**
 * Return the mtime (in milliseconds since Unix epoch) of the transcript JSONL
 * file for a given session, or null if the file cannot be read.
 *
 * The transcript file is created by Claude Code at the first event of the
 * session, so its mtime is a reliable proxy for session-start time (within
 * seconds). When null is returned the caller should fall back to the legacy
 * same-session warning behavior.
 *
 * Input validation rejects:
 *   - non-string or empty sessionId / projectDir
 *   - sessionId not matching SESSION_ID_RE (blocks path traversal)
 *   - relative projectDir (must start with '/')
 *
 * @param {string} sessionId   Claude Code session identifier.
 * @param {string} projectDir  Absolute path to the project directory (cwd of
 *                             the Claude Code process), used to locate the
 *                             correct per-project transcript directory.
 * @returns {number|null}      mtimeMs of the transcript file, or null.
 */
function detectSessionStartMs(sessionId, projectDir) {
  // --- Input validation (must happen before any fs call) ---

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    // Reject malformed IDs including any path-traversal attempts.
    return null;
  }
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    return null;
  }
  if (!path.isAbsolute(projectDir)) {
    // Relative paths are ambiguous; reject to avoid silent wrong-dir reads.
    return null;
  }

  const encoded       = encodeCwd(projectDir);
  const transcriptPath = path.join(
    os.homedir(), '.claude', 'projects', encoded, sessionId + '.jsonl'
  );

  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch (_e) {
    // File absent, unreadable, or Claude Code changed transcript location.
    // Caller falls back to legacy behavior — never block on detection failure.
    return null;
  }
}

module.exports = { detectSessionStartMs, encodeCwd };
