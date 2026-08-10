'use strict';

/**
 * session-detect.js — Detect when a Claude Code session started.
 *
 * Theme 1 (v2.0.22): The upgrade-detection state machine needs to compare
 * `installed_at_ms` (from the upgrade sentinel) against the session's start
 * time to decide whether this session predates the install. This module
 * derives the session-start time from the transcript JSONL file at
 * `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`.
 *
 * v2.3.24 (fix): this used to return the transcript file's `mtimeMs`. That is
 * wrong — Claude Code appends to the transcript for the entire session, so
 * mtime is the time of the LAST write, not the first. The error grows with
 * session age (measured at 43 minutes on a live ~40-minute session) and made
 * `sessionStartMs >= installedAtMs` spuriously true for almost any install
 * performed while a session was open, silently swallowing the upgrade
 * warning (Case B in post-upgrade-sweep.js) when it should have fired
 * (Case C). `birthtimeMs` is not a substitute either — on a `--resume`d
 * session it reports the time the file was first created, which can be many
 * days before the resumed session's actual start.
 *
 * The fix reads transcript CONTENT: Claude Code's first few lines
 * (`last-prompt`, `agent-setting`, `mode`, `permission-mode`) carry no
 * `timestamp` field, so this scans forward and returns the timestamp of the
 * first line that has one — the earliest true timestamp in the transcript.
 * The scan is bounded to HEAD_SCAN_BYTES since that timestamp is always near
 * the top of the file; this also caps the cost on multi-hundred-MB
 * transcripts from long-running sessions.
 *
 * Exports:
 *   detectSessionStartMs(sessionId, projectDir) → number | null
 *   encodeCwd(cwd) → string
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// First timestamped line is always within the first few hundred bytes
// (observed: line 5 of a real transcript); 64 KB is generous headroom while
// still bounding the read on pathologically large transcript files.
const HEAD_SCAN_BYTES = 64 * 1024;

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
 * Return the time (in milliseconds since Unix epoch) of the EARLIEST
 * timestamped line in a session's transcript JSONL, or null when it cannot
 * be determined.
 *
 * Null policy (deliberate, v2.3.24): callers must treat null as "assume the
 * session predates the install" (fail loud → warn). Before this fix, null
 * was the common case for any long-running session (mtime keeps moving, but
 * a stat() failure was rare) — a graceful fallback. Now that detection reads
 * real transcript content, null is rare: it only happens when the transcript
 * is missing/unreadable, or — pathologically — every line within the scan
 * window lacks a timestamp. In both cases we cannot rule out that the
 * session predates the install, and understating the reminder recreates the
 * exact silent-failure class this fix removes. Overstating it costs the
 * user one redundant, non-blocking stderr line; understating it costs a
 * stale agent registry the user never finds out about. Keep fail-loud.
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
 * @returns {number|null}      ms epoch of the first timestamped transcript
 *                             line, or null.
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

  let content;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;
    if (stat.size <= HEAD_SCAN_BYTES) {
      content = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(HEAD_SCAN_BYTES);
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buf, 0, HEAD_SCAN_BYTES, 0);
      } finally {
        fs.closeSync(fd);
      }
      content = buf.slice(0, bytesRead).toString('utf8');
    }
  } catch (_e) {
    // File absent, unreadable, or Claude Code changed transcript location.
    // Caller falls back to fail-loud null handling — never block on
    // detection failure.
    return null;
  }

  // Session-start preamble lines (last-prompt, agent-setting, mode,
  // permission-mode) carry no timestamp; scan forward for the first line
  // that does. A tail-cut line at the end of a bounded head read is expected
  // and simply fails JSON.parse — skip it.
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_e) {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const ts = entry.timestamp || (entry.message && entry.message.timestamp);
    if (typeof ts !== 'string') continue;
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return ms;
  }

  // No timestamped line within the scan window.
  return null;
}

module.exports = { detectSessionStartMs, encodeCwd };
