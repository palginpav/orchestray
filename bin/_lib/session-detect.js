'use strict';

/**
 * session-detect.js — Detect when a Claude Code session started.
 *
 * Theme 1 (v2.0.22): The upgrade-detection state machine needs to compare
 * `installed_at_ms` (from the upgrade sentinel) against the session's start
 * time to decide whether this session predates the install.
 *
 * v2.3.24 tried deriving session start from the transcript JSONL's mtime,
 * then from the first timestamped line in the transcript content. Both are
 * wrong on a `--resume`d session: mtime tracks the LAST write (arbitrarily
 * late), and the first timestamped line belongs to the ORIGINAL session the
 * resume grew out of (arbitrarily early — measured 16 days stale on a real
 * resume). Neither the transcript's mtime nor its content can distinguish a
 * resume from the session it resumed, because Claude Code's transcript
 * format carries no session-boundary marker at all (verified against an
 * 88 MB real transcript: none of the line types present — last-prompt,
 * agent-setting, mode, permission-mode, attachment, file-history-snapshot,
 * user, assistant, system, file-history-delta, queue-operation — mark a
 * boundary, and gap-detection is unreliable since idle time and resume time
 * look identical). Inferring session identity from a Claude Code artifact we
 * neither control nor version against is guesswork by construction — v2.3.25
 * abandons transcript inference entirely.
 *
 * v2.3.25 fix: record session start ourselves. `writeSessionStartMarker` is
 * called from the `reset-context-telemetry.js` SessionStart hook (chosen
 * because it already fires on every session, including resumes, and already
 * extracts `cwd` + `session_id` from the hook payload for its own per-session
 * reset — recording our marker there costs one extra fs write and no new
 * hook registration). `detectSessionStartMs` then reads that marker instead
 * of touching the transcript at all.
 *
 * Null policy: `detectSessionStartMs` returns null when no marker is present
 * for the given session_id (unwritten yet, pruned, or corrupt file). Callers
 * must keep treating null as "assume the session predates the install" (fail
 * loud → warn) — see post-upgrade-sweep.js. That policy carries over
 * unchanged from v2.3.24, but its cost profile flips: under transcript
 * inference null was common (any read/parse failure) and mostly benign to
 * over-warn on; under marker-based detection null is rare (first hook run
 * after this very upgrade, or a session whose SessionStart hook crashed
 * before writing) and correlates strongly with genuinely predating the
 * install — the two cases where the marker doesn't exist are exactly the
 * cases where we can't prove the session is fresh. Fail-loud stays correct
 * and gets cheaper to pay for at the same time.
 *
 * Exports:
 *   detectSessionStartMs(sessionId, projectDir) → number | null
 *   writeSessionStartMarker(projectDir, sessionId) → void (fail-open)
 */

const fs   = require('fs');
const path = require('path');

const { _withAdvisoryLock } = require('./atomic-append');

const SCHEMA_VERSION = 1;

// Marker entries older than this are pruned on every write so the file
// never grows unbounded across a project's lifetime. 30 days is generous
// headroom over the 7-day upgrade-sentinel TTL (the only current consumer) —
// any marker that old is already irrelevant to every known caller, but the
// margin leaves room for future consumers without needing a second look.
const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Absolute path to the session-start marker file for a given project.
 * @param {string} projectDir
 * @returns {string}
 */
function _markerPath(projectDir) {
  return path.join(projectDir, '.orchestray', 'state', 'session-start-markers.json');
}

/**
 * Record that a session started now, keyed by session_id. Called once per
 * SessionStart (see reset-context-telemetry.js). Fail-open: any error is
 * swallowed — a missed marker write degrades detection to the null-fallback
 * policy, it must never block session start.
 *
 * Also prunes marker entries older than MARKER_TTL_MS on every write so the
 * file stays small over a project's lifetime.
 *
 * @param {string} projectDir - Absolute project root.
 * @param {string} sessionId  - Claude Code session identifier.
 */
function writeSessionStartMarker(projectDir, sessionId) {
  if (typeof projectDir !== 'string' || projectDir.length === 0 || !path.isAbsolute(projectDir)) return;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return;

  const markerPath = _markerPath(projectDir);
  const lockPath    = markerPath + '.lock';
  const tmpPath      = markerPath + '.tmp.' + process.pid;
  const nowMs        = Date.now();

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });

    _withAdvisoryLock(lockPath, () => {
      let data;
      try {
        const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        data = (parsed && typeof parsed === 'object' && parsed.schema_version === SCHEMA_VERSION
                 && parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions))
          ? parsed
          : { schema_version: SCHEMA_VERSION, sessions: {} };
      } catch (_e) {
        // Missing, unreadable, or corrupt — start fresh rather than block.
        data = { schema_version: SCHEMA_VERSION, sessions: {} };
      }

      // Prune stale entries before adding the new one.
      for (const sid of Object.keys(data.sessions)) {
        const entry = data.sessions[sid];
        if (!entry || typeof entry.started_at_ms !== 'number' || (nowMs - entry.started_at_ms) > MARKER_TTL_MS) {
          delete data.sessions[sid];
        }
      }

      data.sessions[sessionId] = {
        started_at_ms: nowMs,
        started_at:    new Date(nowMs).toISOString(),
      };

      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, markerPath);
    });
  } catch (_e) {
    // Fail-open — marker write must never block SessionStart.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {} // best-effort: drop a half-written tmp file
  }
}

/**
 * Return the time (in milliseconds since Unix epoch) this session actually
 * started, per the marker `writeSessionStartMarker` recorded at SessionStart,
 * or null when no marker is available for this session_id.
 *
 * Input validation rejects:
 *   - non-string or empty sessionId / projectDir
 *   - sessionId not matching SESSION_ID_RE (blocks path traversal)
 *   - relative projectDir (must start with '/')
 *
 * @param {string} sessionId   Claude Code session identifier.
 * @param {string} projectDir  Absolute path to the project directory (cwd of
 *                             the Claude Code process).
 * @returns {number|null}      ms epoch of the recorded session start, or null.
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

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(_markerPath(projectDir), 'utf8'));
  } catch (_e) {
    // Marker file missing, unreadable, or malformed JSON.
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== SCHEMA_VERSION) return null;
  const sessions = parsed.sessions;
  if (!sessions || typeof sessions !== 'object') return null;

  const entry = sessions[sessionId];
  if (!entry || typeof entry.started_at_ms !== 'number' || !Number.isFinite(entry.started_at_ms)) {
    return null;
  }
  return entry.started_at_ms;
}

module.exports = { detectSessionStartMs, writeSessionStartMarker };
