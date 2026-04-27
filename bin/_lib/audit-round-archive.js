'use strict';

/**
 * audit-round-archive.js — P3.1 Audit-Round Auto-Archive (v2.2.0).
 *
 * Pure deterministic markdown extractor — distils a verify-fix audit
 * round's verbatim findings (events.jsonl rows) into a compact digest
 * file under `.orchestray/kb/artifacts/<orch>-round-<n>-digest.md`.
 *
 * Single export: `archiveRound(orchestrationId, roundN, opts)`.
 *
 * Design authority: `.orchestray/kb/artifacts/v220-impl-p31-design.md`
 * (Haiku digest mode rejected in §"Digest computation choice" — the
 * audit-chain invariant requires byte-stable output across re-runs).
 *
 * Three-layer kill switch (any → return {skipped:true,reason:'disabled'}):
 *   - env  ORCHESTRAY_DISABLE_AUDIT_ROUND_ARCHIVE=1
 *   - cfg  audit.round_archive.enabled === false
 *   - file .orchestray/state/.audit-round-archive-disabled
 *
 * Failure contract: NEVER throws. Every branch is fail-open — see
 * `bin/_lib/audit-event-writer.js:25-26` for the canonical statement.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }   = require('./resolve-project-cwd');
const { writeEvent }       = require('./audit-event-writer');
const { MAX_INPUT_BYTES }  = require('./constants');

const FINDING_EVENT_TYPES = new Set([
  'verify_fix_pass',
  'verify_fix_fail',
  'verify_fix_oscillation',
  'audit_round_complete',
  'pm_finding',
]);

const DIGEST_DIR_REL  = path.join('.orchestray', 'kb', 'artifacts');
const SIDECAR_REL     = path.join('.orchestray', 'state', 'audit-round-archive.json');
const SENTINEL_REL    = path.join('.orchestray', 'state', '.audit-round-archive-disabled');
const CONFIG_REL      = path.join('.orchestray', 'config.json');
const EVENTS_REL      = path.join('.orchestray', 'audit', 'events.jsonl');

const STRING_TRUNCATE_BYTES = 200;

// ---------------------------------------------------------------------------
// Config / kill-switch helpers
// ---------------------------------------------------------------------------

function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_DISABLE_AUDIT_ROUND_ARCHIVE === '1') return true;
  try {
    if (fs.existsSync(path.join(cwd, SENTINEL_REL))) return true;
  } catch (_e) { /* fail-open */ }
  try {
    const raw = fs.readFileSync(path.join(cwd, CONFIG_REL), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const block = parsed.audit && parsed.audit.round_archive;
      if (block && block.enabled === false) return true;
    }
  } catch (_e) { /* fail-open — config missing → defaults apply */ }
  return false;
}

// ---------------------------------------------------------------------------
// Round-N event loading
// ---------------------------------------------------------------------------

function loadRoundEvents(cwd, orchestrationId, roundN) {
  const eventsPath = path.join(cwd, EVENTS_REL);
  let raw;
  try {
    const stat = fs.statSync(eventsPath);
    if (stat.size > MAX_INPUT_BYTES * 10) return []; // 10 MB cap
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch (_e) {
    return [];
  }
  if (!raw || !raw.trim()) return [];

  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (!ev || typeof ev !== 'object') continue;
      if (ev.orchestration_id !== orchestrationId) continue;
      const evRound =
        (typeof ev.round === 'number' ? ev.round : null) ??
        (ev.extra && typeof ev.extra.round === 'number' ? ev.extra.round : null);
      if (evRound !== roundN) continue;
      const t = ev.type || ev.event_type;
      if (!t || !FINDING_EVENT_TYPES.has(t)) continue;
      events.push(ev);
    } catch (_e) { /* skip malformed */ }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Deterministic digest construction
// ---------------------------------------------------------------------------

function synthesizeFindingId(ev, roundN, ordinalIndex) {
  if (ev.finding_id && typeof ev.finding_id === 'string') return ev.finding_id;
  const taskId = ev.task_id || (ev.extra && ev.extra.task_id) || 'na';
  const evType = ev.type || ev.event_type || 'unknown';
  return roundN + '.' + ordinalIndex + '.' + taskId + '.' + evType;
}

function pickMessage(ev) {
  if (typeof ev.message === 'string' && ev.message) return ev.message;
  if (typeof ev.error === 'string'   && ev.error)   return ev.error;
  if (typeof ev.summary === 'string' && ev.summary) return ev.summary;
  if (ev.extra && typeof ev.extra === 'object') {
    if (typeof ev.extra.message === 'string' && ev.extra.message) return ev.extra.message;
    if (typeof ev.extra.error   === 'string' && ev.extra.error)   return ev.extra.error;
    if (typeof ev.extra.summary === 'string' && ev.extra.summary) return ev.extra.summary;
  }
  return '<no message field>';
}

function pickCounts(ev) {
  const parts = [];
  const src = (ev.extra && typeof ev.extra === 'object') ? ev.extra : ev;
  for (const k of ['error_count', 'errors_current', 'errors_previous',
                   'remaining_errors', 'fixed_count', 'rounds_total']) {
    if (typeof src[k] === 'number') parts.push(k + '=' + src[k]);
  }
  return parts.length ? parts.join(' ') : 'n/a';
}

function truncateValue(v) {
  if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > STRING_TRUNCATE_BYTES) {
    return '<truncated:' + Buffer.byteLength(v, 'utf8') +
           ' bytes — fetch via mcp__orchestray__history_query_events>';
  }
  return v;
}

function stableStringify(obj) {
  // Deterministic JSON: sort keys recursively for byte-stable output.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

function rowDumpFor(ev) {
  // Apply truncation to every string value > 200 B.
  const out = {};
  const keys = Object.keys(ev).sort();
  for (const k of keys) {
    out[k] = truncateValue(ev[k]);
  }
  return stableStringify(out);
}

function buildDigestBody(orchestrationId, roundN, enriched, generatedAt) {
  const sorted = enriched.slice().sort((a, b) => {
    if (a.finding_id < b.finding_id) return -1;
    if (a.finding_id > b.finding_id) return 1;
    return 0;
  });

  const lines = [];
  lines.push('# Audit Round ' + roundN + ' Digest — ' + orchestrationId);
  lines.push('> Generated: ' + generatedAt +
             '  Source rows: ' + sorted.length +
             '  Finding IDs preserved: ' + sorted.length);
  lines.push('');
  lines.push('## Findings');
  for (const item of sorted) {
    const ev = item.event;
    const sev = ev.severity || (ev.extra && ev.extra.severity) || 'n/a';
    const t   = ev.type || ev.event_type || 'unknown';
    const taskId = ev.task_id || (ev.extra && ev.extra.task_id) || 'na';
    lines.push('- **' + item.finding_id + '** [severity=' + sev +
               '] [type=' + t + '] task=' + taskId + ' round=' + roundN);
    lines.push('  - msg: ' + pickMessage(ev));
    lines.push('  - errors/fixed/remaining: ' + pickCounts(ev));
  }
  lines.push('');
  lines.push('## Field-by-field row dump (for replay)');
  for (const item of sorted) {
    lines.push('```json');
    lines.push(rowDumpFor(item.event));
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sidecar upsert
// ---------------------------------------------------------------------------

function upsertSidecar(cwd, orchestrationId, roundN, entry) {
  const sidecarPath = path.join(cwd, SIDECAR_REL);
  const stateDir    = path.dirname(sidecarPath);
  let cur = { archives: [] };
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.archives)) {
      cur = parsed;
    }
  } catch (_e) { /* fresh */ }

  // Replace any existing entry for the same orch+round.
  cur.archives = cur.archives.filter(a =>
    !(a && a.orchestration_id === orchestrationId && a.round_n === roundN)
  );
  cur.archives.push(entry);
  cur.updated_at = new Date().toISOString();

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = sidecarPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sidecarPath);
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: archiveRound
// ---------------------------------------------------------------------------

// S-003 (v2.2.0 fix-pass): orchestration-id must match the same regex
// `bin/ox.js` uses at `state init`. Any value that contains `..`, `/`,
// `\`, or other path-significant characters would let `path.join` resolve
// outside `.orchestray/kb/artifacts/` and overwrite arbitrary `.md` files
// (e.g., `agents/pm.md` — a path-traversal attack).
// CWE-22 path traversal.
const ORCH_ID_RE = /^orch-[a-zA-Z0-9_-]+$/;

function archiveRound(orchestrationId, roundN, opts) {
  opts = opts || {};
  const cwd = resolveSafeCwd(opts.cwd);

  try {
    if (isDisabled(cwd)) {
      return { skipped: true, reason: 'disabled' };
    }

    if (typeof orchestrationId !== 'string' || !orchestrationId ||
        typeof roundN !== 'number' || !Number.isInteger(roundN) || roundN < 1) {
      return { skipped: true, reason: 'no_round_events' };
    }

    // S-003: regex containment + path-prefix verification.
    if (!ORCH_ID_RE.test(orchestrationId)) {
      return { skipped: true, reason: 'invalid_orch_id' };
    }

    const events = loadRoundEvents(cwd, orchestrationId, roundN);
    if (events.length === 0) {
      return { skipped: true, reason: 'no_round_events' };
    }

    const digestDir = path.join(cwd, DIGEST_DIR_REL);
    const digestRel = path.join(DIGEST_DIR_REL,
                                orchestrationId + '-round-' + roundN + '-digest.md');
    const digestAbs = path.join(cwd, digestRel);

    // S-003: belt-and-suspenders — even with the regex, defence in depth
    // verifies the resolved abs path stays inside DIGEST_DIR_REL.
    const digestDirResolved = path.resolve(digestDir);
    const digestAbsResolved = path.resolve(digestAbs);
    if (!digestAbsResolved.startsWith(digestDirResolved + path.sep) &&
        digestAbsResolved !== digestDirResolved) {
      return { skipped: true, reason: 'invalid_orch_id' };
    }

    // Idempotent: if digest already exists, skip with already_archived.
    try {
      if (fs.existsSync(digestAbs)) {
        return { skipped: true, reason: 'already_archived' };
      }
    } catch (_e) { /* proceed */ }

    // Enrich events with deterministic finding_id.
    const enriched = events.map((ev, idx) => ({
      finding_id: synthesizeFindingId(ev, roundN, idx + 1),
      event: ev,
    }));

    // Use a stable timestamp source — derive from latest event timestamp
    // when present, else now(). Determinism test §6a requires byte-stable
    // output across re-runs on byte-identical input; using the max event
    // timestamp (which is itself fixture-stable) preserves that invariant.
    let generatedAt = null;
    for (const ev of events) {
      if (typeof ev.timestamp === 'string' && (!generatedAt || ev.timestamp > generatedAt)) {
        generatedAt = ev.timestamp;
      }
    }
    if (!generatedAt) generatedAt = '1970-01-01T00:00:00.000Z';

    const body = buildDigestBody(orchestrationId, roundN, enriched, generatedAt);
    const digestBytes = Buffer.byteLength(body, 'utf8');

    // Compute full transcript bytes (sum of raw event JSON line lengths).
    let fullTranscriptBytes = 0;
    for (const ev of events) {
      try { fullTranscriptBytes += Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1; }
      catch (_e) { /* ignore */ }
    }
    const ratio = fullTranscriptBytes > 0
      ? Math.round((digestBytes / fullTranscriptBytes) * 10000) / 10000
      : 0;

    // Atomic write digest.
    try {
      fs.mkdirSync(digestDir, { recursive: true });
      const tmp = digestAbs + '.tmp';
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, digestAbs);
    } catch (_e) {
      try {
        writeEvent({
          version: 1,
          type: 'audit_round_archive_skipped',
          orchestration_id: orchestrationId,
          round_n: roundN,
          reason: 'io_error',
        }, { cwd });
      } catch (_e2) { /* fail-open */ }
      return { skipped: true, reason: 'io_error' };
    }

    const findingIds = enriched.map(e => e.finding_id);

    // Sidecar upsert (advisory).
    const sidecarOk = upsertSidecar(cwd, orchestrationId, roundN, {
      orchestration_id:        orchestrationId,
      round_n:                 roundN,
      digest_path:             digestRel,
      full_transcript_bytes:   fullTranscriptBytes,
      digest_bytes:            digestBytes,
      ratio:                   ratio,
      finding_ids:             findingIds,
      mode:                    'deterministic',
      archived_at:             new Date().toISOString(),
    });
    if (!sidecarOk) {
      try {
        writeEvent({
          version: 1,
          type: 'audit_round_archive_sidecar_failed',
          orchestration_id: orchestrationId,
          round_n: roundN,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
    }

    // Emit success telemetry.
    try {
      writeEvent({
        version: 1,
        type: 'audit_round_archived',
        orchestration_id: orchestrationId,
        round_n: roundN,
        full_transcript_bytes: fullTranscriptBytes,
        digest_bytes: digestBytes,
        ratio: ratio,
        digest_path: digestRel,
        finding_ids: findingIds,
        mode: 'deterministic',
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    return {
      digestPath:           digestRel,
      fullTranscriptBytes:  fullTranscriptBytes,
      digestBytes:          digestBytes,
      ratio:                ratio,
      findingIds:           findingIds,
      mode:                 'deterministic',
    };
  } catch (_e) {
    return { skipped: true, reason: 'io_error' };
  }
}

module.exports = { archiveRound };
