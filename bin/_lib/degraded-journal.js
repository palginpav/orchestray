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
 *   - v2.3.12 W9 (B1): selected high-frequency `info` kinds
 *     (PERSISTENT_DEDUP_KINDS) are ALSO deduped CROSS-process for DEDUP_TTL_MS
 *     via an on-disk index (degraded-dedup.json). `error`/`warn` are never
 *     suppressed. Kill switch: ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED=1.
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

// ---------------------------------------------------------------------------
// v2.3.12 W9 (B1): cross-process persistent dedup.
//
// The in-process `_seen` Set above is wiped on every process exit, so recurring
// low-value `info` degradations (e.g. the same malformed legacy KB file scanned
// every sweep run) re-append on each fresh process — the source of the 2170-line
// degraded.jsonl flood. For a curated set of high-frequency `info` kinds we keep
// an on-disk index of (kind, fingerprint) → last-seen timestamp and suppress
// re-appends within DEDUP_TTL_MS. `error`/`warn` records are NEVER suppressed.
//
// Kill switch: ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED=1 reverts to v2.3.11
// (in-process dedup only).
// ---------------------------------------------------------------------------
// v2.3.24: 'agent_registry_stale' was listed here but is emitted at
// severity 'warn' (post-upgrade-sweep.js), while the gate below only
// persist-dedups severity === 'info' — so the membership could never fire.
// Resolved as: dropped, not lowered to 'info'. Unlike the other kinds here
// (high-frequency, benign fallback signals where 24h cross-process
// suppression is the point), agent_registry_stale is a real, actionable
// warning about a stale agent registry. The per-session marker file in
// post-upgrade-sweep.js already prevents re-emission within one session;
// adding 24h cross-process suppression on top would hide the same genuine
// warning from other sessions open around the same install.
const PERSISTENT_DEDUP_KINDS = new Set([
  'kb_refs_sweep_malformed_frontmatter',
  'kb_refs_sweep_malformed_summary',
  'kb_refs_sweep_file_oversize',
  'pattern_roi_events_file_oversize',
]);
const DEDUP_TTL_MS      = 24 * 60 * 60 * 1000; // 24 h
const DEDUP_MAX_ENTRIES = 2000;
const DEDUP_REL_PATH    = ['.orchestray', 'state', 'degraded-dedup.json'];

/**
 * Persistent dedup check. Returns true when this (kind, fp) was recorded within
 * DEDUP_TTL_MS (and the new record should be suppressed). Otherwise records the
 * current timestamp and returns false. Fail-open: any error returns false so the
 * record is appended (never suppress on uncertainty).
 *
 * @param {string} projectRoot
 * @param {string} kind
 * @param {string} fp
 * @returns {boolean}
 */
function _persistDedupSkip(projectRoot, kind, fp) {
  if (process.env.ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED === '1') return false;
  try {
    const file = path.join(projectRoot, ...DEDUP_REL_PATH);
    const key = kind + '|' + fp;
    const now = Date.now();
    let index = {};
    try {
      index = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      if (typeof index !== 'object' || Array.isArray(index)) index = {};
    } catch (_) { index = {}; }

    const last = index[key];
    if (typeof last === 'number' && (now - last) < DEDUP_TTL_MS) {
      return true; // recently seen → suppress
    }

    // Record + prune expired + cap size (drop oldest).
    index[key] = now;
    for (const k of Object.keys(index)) {
      if ((now - index[k]) >= DEDUP_TTL_MS) delete index[k];
    }
    const keys = Object.keys(index);
    if (keys.length > DEDUP_MAX_ENTRIES) {
      keys.sort((a, b) => index[a] - index[b]); // oldest first
      for (const k of keys.slice(0, keys.length - DEDUP_MAX_ENTRIES)) delete index[k];
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(index));
    } catch (_) { /* swallow — best effort */ }
    return false;
  } catch (_) {
    return false; // fail-open: append
  }
}

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
  'kb_refs_sweep_file_read_error',       // v2.1.6 W6: could not read a file during kb-refs-sweep
  'kb_refs_sweep_malformed_frontmatter', // v2.1.6 W6: KB/pattern file missing frontmatter delimiters
  'kb_refs_sweep_write_error',           // v2.1.6 W6: failed to write sweep artefact
  'kb_refs_sweep_snapshot_error',        // v2.1.6 W6: failed to write sweep snapshot JSON
  'kb_refs_sweep_init_error',            // v2.1.6 W6: init error (cwd resolution failed)
  'kb_refs_sweep_uncaught',              // v2.1.6 W6: unexpected top-level error in sweep
  'kb_refs_sweep_file_oversize',         // v2.1.6 C5: .md file exceeded per-file read cap; scan skipped
  'kb_refs_sweep_malformed_summary',     // v2.3.12 W11 (B3): one per-run summary of malformed-frontmatter files (replaces per-file flood)
  'shared_promote_local_collision',      // v2.1.6 C5: shared-promote local collision (same slug, different body)
  'pattern_roi_events_file_oversize',    // v2.1.6 C5: events.jsonl file exceeded per-file read cap; skipped
  'pattern_roi_events_file_read_error',  // v2.1.6 C5: failed to read an events.jsonl file
  'pattern_roi_malformed_jsonl_line',    // v2.1.6 C5: malformed JSONL line in events.jsonl; skipped
  'pattern_roi_corrupt_pattern_frontmatter', // v2.1.6 C5: pattern .md missing or unparseable frontmatter
  'pattern_roi_snapshot_write_error',    // v2.1.6 C5: failed to write roi-snapshot.json
  'pattern_roi_suggestion_write_error',  // v2.1.6 C5: failed to write calibration-suggestion .md
  'pattern_roi_uncaught_error',          // v2.1.6 C5: unexpected top-level error in roi aggregator
  'auto_learning_config_malformed',      // v2.1.6 W7: auto_learning config block malformed; all-off defaults used
  'mcp_server_max_per_task_out_of_range', // v2.1.7 C: max_per_task tool value out of range (1..1000); fell back to default
  'mcp_server_max_per_task_unknown_tool', // v2.1.7 C: max_per_task config key names an unrecognized MCP tool; passed through
  // v2.1.7 Bundle A: Haiku extraction backend degradation kinds
  'auto_extract_parse_failed',           // v2.1.7 A: extractor output was not valid ExtractorOutput JSON
  'auto_extract_backend_timeout',        // v2.1.7 A: extractor subprocess exceeded timeout_ms; SIGTERM sent
  'auto_extract_backend_exit_nonzero',   // v2.1.7 A: extractor subprocess exited with non-zero code
  'auto_extract_backend_oversize',       // v2.1.7 A: extractor stdout exceeded max_output_bytes
  // v2.1.7 Bundle D: resilience dossier + re-hydration (compaction survival)
  'dossier_write_failed',        // v2.1.7 D: write-resilience-dossier.js could not atomically write the dossier
  'dossier_inject_failed',       // v2.1.7 D: inject-resilience-dossier.js could not read/inject the dossier
  'dossier_corrupt',             // v2.1.7 D: parseDossier rejected the file (schema mismatch / JSON error / missing critical)
  'dossier_stale',               // v2.1.7 D: inject skipped because status=completed or dossier too old
  'compact_signal_stuck',        // v2.1.7 D: compact-signal.lock write / parse / cleanup failure
  'dossier_oversize_truncated',  // v2.1.7 D: serializer dropped deferred/expanded tiers to stay ≤ 12 KB
  'dossier_fence_collision',     // v2.1.7 SEC-01: dossier field contains fence substring; injection skipped to prevent prompt-injection
  // v2.1.7 zero-deferral patch — SEC-04/SEC-05
  'file_too_large',              // SEC-04: file exceeded per-reader size cap; read skipped, fail-open
  'file_read_failed',            // SEC-04: fd-based read failed with an unexpected errno; caller fails open
  'dossier_field_sanitised',     // SEC-05: dossier path-shaped field contained invalid content; field nulled
  // v2.1.7 zero-deferral patch — F4 / SEC-07
  'auto_extract_backend_unsupported_value', // F4: backend='haiku-sdk' is reserved/not implemented; fell back to haiku-cli
  // v2.1.8 Bundle CTX: CiteCache degraded kinds
  'pattern_seen_set_write_failed',  // CiteCache: disk write error; PM falls back to emitting full bodies
  'pattern_seen_set_corrupt',       // CiteCache: JSONL parse error on read; PM emits full bodies for remainder of orch
  // v2.1.9 Bundle B1 I-06: pattern-seen-set hardening
  'pattern_seen_set_recovered',     // CiteCache: fail-open recovery — bad read or parse error salvaged
  'pattern_seen_set_oversize',      // CiteCache: file exceeded 10 MB cap; truncated to ~5 MB tail
  // v2.1.9 Bundle B1 I-04: curator cursor-corruption clean recovery
  'curator_cursor_reset',           // Curator: corrupt cursor detected; full-diff mode restored (one event per session)
  // v2.1.8 Bundle CTX: SpecSketch degraded kinds
  'spec_sketch_parse_failed',       // SpecSketch: symbol parser errored on unfamiliar language; PM renders prose fallback
  'spec_sketch_budget_exceeded',    // SpecSketch: skeleton exceeded 400 tokens; truncated to top files + trailer
  // v2.1.8 Bundle CTX: RepoMapDelta degraded kinds
  'repo_map_delta_first_emit_failed',    // RepoMapDelta: first-emission write failed; PM falls back to full injection
  'repo_map_delta_first_agent_unknown',  // RepoMapDelta: PM state corrupt/racey; first-agent unknown; falls back to full injection
  // v2.1.8 Bundle CTX: ArchetypeCache degraded kinds
  'archetype_cache_blacklisted',         // ArchetypeCache: match found but archetype_id in blacklist; advisory suppressed
  'archetype_cache_signature_failed',    // ArchetypeCache: computeSignature() returned empty string; advisory skipped
  'archetype_cache_hint_write_failed',   // ArchetypeCache: recordAdvisoryServed() disk write failed; advisory event not persisted
  // v2.3.31 W3: event-schema shadow validation degraded (schema file unreadable — e.g. foreign, non-Orchestray project)
  'event_schema_unreadable',
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
 *   severity?: 'error'|'warn'|'info',
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
    // v2.1.7: accept 'error' severity for backend-failure kinds (e.g. non-zero exit code)
    const severity    = event.severity === 'info' ? 'info'
      : event.severity === 'error' ? 'error'
      : 'warn';
    const detail      = event.detail && typeof event.detail === 'object'
      ? Object.assign({}, event.detail)
      : {};

    // In-process dedup.
    const fp = _fingerprint(kind, detail);
    if (_seen.has(fp)) return { appended: false };
    _seen.add(fp);

    // v2.3.12 W9 (B1): cross-process persistent dedup for high-frequency info
    // kinds. error/warn are never suppressed.
    if (severity === 'info' && PERSISTENT_DEDUP_KINDS.has(kind)) {
      if (_persistDedupSkip(projectRoot, kind, fp)) return { appended: false };
    }

    // Resolve orchestration id (best-effort, cached).
    const orchId = _resolveOrchId(projectRoot);

    // Build the record.
    // v2.3.24: stamp the resolved root on every row, regardless of whether the
    // caller supplied one. An unattributed row is otherwise indistinguishable
    // from a production row — a prior purge left ~72 rows nobody could classify
    // because there was nothing on the row itself pointing back to a root.
    const rec = {
      schema:           JOURNAL_SCHEMA_VERSION,
      ts:               new Date().toISOString(),
      kind,
      severity,
      pid:              process.pid,
      orchestration_id: orchId,
      project_root:     projectRoot,
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
  _persistDedupSkip,
  PERSISTENT_DEDUP_KINDS,
  DEDUP_TTL_MS,
};
