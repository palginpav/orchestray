'use strict';

/**
 * Degraded-mode event journal.
 *
 * Appends structured records to `.orchestray/state/degraded.jsonl` whenever
 * a silent fallback fires (FTS5 unavailable, flat config keys, stale agent
 * registry, etc.). Provides an audit trail for /orchestray:doctor.
 *
 * Contract:
 *   - Never throws. All I/O wrapped in try/catch; errors are swallowed.
 *   - Idempotent per-process per-(kind, dedup_fingerprint).
 *   - Rotation at 1 MB × 3 generations via jsonl-rotate.
 *   - Lines capped at 1024 bytes; detail fields truncated if over cap.
 *   - Orchestration-id resolved best-effort; cached 60 s per process.
 */

const fs   = require('fs');
const path = require('path');
const { appendJsonlWithRotation } = require('./jsonl-rotate');

const JOURNAL_SCHEMA_VERSION = 1;

// Rotate at 1 MB, keep 3 generations.
const MAX_SIZE_BYTES  = 1 * 1024 * 1024;   // 1 MB
const MAX_GENERATIONS = 3;

// Per-line hard cap.
const MAX_LINE_BYTES  = 1024;

// Reader safety cap: if journal exceeds this, read last 64 KB only.
const MAX_JSONL_READ_BYTES = 10 * 1024 * 1024;  // 10 MB
const TAIL_CHUNK_BYTES     = 64 * 1024;          // 64 KB

// In-process dedup: never append the same (kind, fingerprint) twice.
const _seen = new Set();

// Orchestration-id cache: resolve at most once per 60 s per projectRoot.
const _orchIdCacheByRoot = new Map();
const ORCH_ID_TTL_MS = 60 * 1000;

// Allowed kind values (closed set in v1).
const KINDS = [
  'fts5_fallback',
  'fts5_backend_unavailable',
  'flat_federation_keys_accepted',
  'flat_curator_keys_accepted',
  'agent_registry_stale',
  'hook_merge_noop',
  'shared_dir_create_failed',
  'curator_reconcile_flagged',
  'config_load_failed',
  'install_integrity_drift',         // v2.1.3 Bundle II: per-file hash drift detected at MCP boot
  'manifest_v1_legacy',              // v2.1.3 Bundle II: old v1 manifest (no files_hashes)
  'install_integrity_verify_slow',   // v2.1.3 Bundle II: verify took >2s (performance signal)
  'curator_duplicate_detect_failed',  // v2.1.3 Bundle CI: H3 pre-filter threw; curator fell back to all-pairs
  'curator_stamp_apply_failed',       // v2.1.3 Bundle CI: H4 post-run stamp apply failed for one pattern
  'shadow_scorer_failed',             // v2.1.3 Bundle RS: shadow scorer load/run error
  'curator_diff_cursor_corrupt',      // v2.1.4 H6: --diff stamp present but missing/malformed body_sha256 (the "cursor" is the body-hash field inside the stamp; no cursor file exists per design §2); treated as stamp-absent
  'curator_diff_hash_compute_failed', // v2.1.4 H6: could not compute SHA-256 of pattern body; treated as dirty
  'curator_diff_forced_full_triggered', // v2.1.4 H6: self-healing forced full sweep (run_count % 10 === 0)
  'curator_diff_dirty_set_empty',        // v2.1.5 H6: zero-dirty short-circuit; entire corpus is clean, no curator spawn
  'unknown_kind',
];

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests only)
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the journal file.
 * @param {string|undefined} projectRoot
 * @returns {string}
 */
function _journalPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), '.orchestray', 'state', 'degraded.jsonl');
}

/**
 * Compute a stable dedup fingerprint for a (kind, detail) pair.
 * The caller controls detail.dedup_key; if absent we hash the first 200
 * chars of the stringified detail.
 * @param {string} kind
 * @param {object|undefined} detail
 * @returns {string}
 */
function _fingerprint(kind, detail) {
  const explicit =
    detail && typeof detail.dedup_key === 'string' ? detail.dedup_key : null;
  return kind + '|' + (explicit || JSON.stringify(detail || {}).slice(0, 200));
}

/**
 * Resolve the current orchestration id from the state file.
 * Returns null on any failure.  Cached 60 s per process.
 * @param {string|undefined} projectRoot
 * @returns {string|null}
 */
function _resolveOrchId(projectRoot) {
  const cacheKey = projectRoot || process.cwd();
  const now = Date.now();
  const cached = _orchIdCacheByRoot.get(cacheKey);
  if (cached && now - cached.at < ORCH_ID_TTL_MS) {
    return cached.id;
  }
  let id = null;
  try {
    const statePath = path.join(cacheKey, '.orchestray', 'state', 'orchestration.md');
    const content = fs.readFileSync(statePath, 'utf8');
    // Parse YAML frontmatter: lines between first two '---' markers.
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const idLine = match[1].split(/\r?\n/).find(l => l.startsWith('id:'));
      if (idLine) {
        id = idLine.replace(/^id:\s*/, '').trim() || null;
      }
    }
  } catch (_) {
    // Any failure → null.
  }
  _orchIdCacheByRoot.set(cacheKey, { id, at: now });
  return id;
}

/**
 * Truncate the detail object so the serialized line fits within MAX_LINE_BYTES.
 * Truncates string values first; then strips keys one by one from the end.
 * @param {object} rec  The full record (mutated in place).
 * @returns {{ truncated: boolean }}
 */
function _capLine(rec) {
  const byteLen = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

  // Fast path: already under cap (byte-measured, so multibyte detail is safe).
  if (byteLen(rec) <= MAX_LINE_BYTES) return { truncated: false };

  const detail = rec.detail;
  if (!detail || typeof detail !== 'object') return { truncated: true };

  // Step 1: truncate string values. ASCII ellipsis keeps byte and char count aligned.
  for (const key of Object.keys(detail)) {
    if (typeof detail[key] === 'string' && detail[key].length > 50) {
      detail[key] = detail[key].slice(0, 50) + '...';
    }
    if (byteLen(rec) <= MAX_LINE_BYTES) return { truncated: true };
  }

  // Step 2: remove keys from the end until it fits.
  const keys = Object.keys(detail);
  for (let i = keys.length - 1; i >= 0; i--) {
    // Never remove dedup_key — it is the dedup identity.
    if (keys[i] === 'dedup_key') continue;
    delete detail[keys[i]];
    if (byteLen(rec) <= MAX_LINE_BYTES) return { truncated: true };
  }

  return { truncated: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record one degraded-mode event.
 *
 * @param {{
 *   kind: string,
 *   severity?: 'warn'|'info',
 *   detail?: object,
 *   projectRoot?: string,
 * }} event
 * @returns {{ appended: boolean }}
 */
function recordDegradation(event) {
  try {
    if (!event || !event.kind) return { appended: false };

    const projectRoot = event.projectRoot || process.cwd();
    const kind        = String(event.kind);
    const severity    = event.severity === 'info' ? 'info' : 'warn';
    const detail      = event.detail && typeof event.detail === 'object'
      ? Object.assign({}, event.detail)
      : {};

    // In-process dedup.
    const fp = _fingerprint(kind, detail);
    if (_seen.has(fp)) return { appended: false };
    _seen.add(fp);

    // Resolve orchestration id (best-effort, cached).
    const orchId = _resolveOrchId(projectRoot);

    // Build the record.
    const rec = {
      schema:           JOURNAL_SCHEMA_VERSION,
      ts:               new Date().toISOString(),
      kind,
      severity,
      pid:              process.pid,
      orchestration_id: orchId,
      detail,
    };

    // Apply 1024-byte cap.
    const capResult = _capLine(rec);
    if (capResult.truncated) {
      rec._truncated = true;
    }

    // Last safety check: if still over cap, skip.
    if (JSON.stringify(rec).length > MAX_LINE_BYTES) {
      return { appended: false };
    }

    // Ensure parent directory exists.
    const jp = _journalPath(projectRoot);
    try {
      fs.mkdirSync(path.dirname(jp), { recursive: true });
    } catch (_) { /* swallow */ }

    // Append with rotation.
    appendJsonlWithRotation(jp, rec, {
      maxSizeBytes:   MAX_SIZE_BYTES,
      maxGenerations: MAX_GENERATIONS,
    });

    return { appended: true };
  } catch (_) {
    return { appended: false };
  }
}

/**
 * Read the last N journal lines as parsed objects, newest-first.
 * Used by /orchestray:doctor and /orchestray:status.
 *
 * @param {{
 *   projectRoot?: string,
 *   maxLines?: number,
 *   sinceMs?: number,
 * }} [opts]
 * @returns {Array<object>}
 */
function readJournalTail(opts) {
  try {
    const projectRoot = (opts && opts.projectRoot) || process.cwd();
    const maxLines    = (opts && opts.maxLines != null) ? opts.maxLines : 20;
    const sinceMs     = (opts && opts.sinceMs  != null) ? opts.sinceMs  : null;

    const jp = _journalPath(projectRoot);

    let stat;
    try {
      stat = fs.statSync(jp);
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }

    let raw;
    if (stat.size > MAX_JSONL_READ_BYTES) {
      // Read last 64 KB only to avoid hanging on a pathologically large file.
      const fd     = fs.openSync(jp, 'r');
      const buf    = Buffer.alloc(TAIL_CHUNK_BYTES);
      const offset = Math.max(0, stat.size - TAIL_CHUNK_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, TAIL_CHUNK_BYTES, offset);
      fs.closeSync(fd);
      raw = buf.slice(0, bytesRead).toString('utf8');
    } else {
      raw = fs.readFileSync(jp, 'utf8');
    }

    const lines   = raw.split('\n').filter(l => l.trim().length > 0);
    const results = [];

    for (let i = lines.length - 1; i >= 0 && results.length < maxLines; i--) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch (_) {
        continue; // Malformed line — skip silently.
      }
      if (!row || typeof row.schema !== 'number') continue;
      if (row.schema > JOURNAL_SCHEMA_VERSION) continue; // Unknown future schema.
      if (sinceMs != null) {
        try {
          const rowMs = new Date(row.ts).getTime();
          if (isNaN(rowMs) || rowMs < sinceMs) continue;
        } catch (_) {
          continue;
        }
      }
      results.push(row);
    }

    return results;
  } catch (_) {
    return [];
  }
}

module.exports = {
  recordDegradation,
  readJournalTail,
  JOURNAL_SCHEMA_VERSION,
  KINDS,
  // Exported for tests only:
  _journalPath,
  _fingerprint,
  _resolveOrchId,
  _capLine,
};
