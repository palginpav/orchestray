'use strict';

/**
 * Streaming iterator over Orchestray audit + archive events.jsonl files.
 *
 * Per v2011c-stage2-plan.md §7.
 *
 * Exports:
 *   async function* scanEvents(options?) -> AsyncGenerator<NormalizedEvent>
 *   async function queryEvents(filters, options?) -> { events, total_matching, returned }
 *
 * Normalization:
 *   - `type` wins over legacy `event` field; legacy key is dropped.
 *   - Lines with neither type nor event are logged + skipped.
 *   - Live-audit lines without timestamp are skipped (no natural fallback).
 *   - Archive lines without timestamp fall back to the enclosing dir's mtime
 *     (cached per archive).
 *   - Every yielded event carries a `ref` field with its archive URI.
 *
 * The generator is total — file missing, permission denied, malformed JSONL
 * lines all log to stderr and continue. No exception escapes to the caller.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const paths = require('./paths');

// ---------------------------------------------------------------------------
// scanEvents
// ---------------------------------------------------------------------------

function _resolveRoots(options) {
  const override = options && options.roots;
  let liveAudit;
  let historyDir;
  if (override && typeof override === 'object') {
    liveAudit = override.liveAudit;
    historyDir = override.historyDir;
  }
  if (!liveAudit) {
    try { liveAudit = paths.getAuditEventsPath(); } catch (_e) { liveAudit = null; }
  }
  if (!historyDir) {
    try { historyDir = paths.getHistoryDir(); } catch (_e) { historyDir = null; }
  }
  return { liveAudit, historyDir };
}

function _logStderr(msg) {
  try { process.stderr.write('[orchestray-mcp] ' + msg + '\n'); } catch (_e) { /* swallow */ }
}

function _normalizeEvent(raw, sourcePath, lineNumber) {
  const hasType = typeof raw.type === 'string' && raw.type.length > 0;
  const hasEvent = typeof raw.event === 'string' && raw.event.length > 0;

  if (hasType && hasEvent && raw.type !== raw.event) {
    _logStderr(
      'history_scan: schema drift at ' + sourcePath + ':' + lineNumber +
      ' (type=' + raw.type + ', event=' + raw.event + ') — preferring type'
    );
  }

  let eventType;
  if (hasType) eventType = raw.type;
  else if (hasEvent) eventType = raw.event;
  else {
    _logStderr(
      'history_scan: no type/event field at ' + sourcePath + ':' + lineNumber
    );
    return null;
  }

  // Drop legacy `event` field; keep all other properties.
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'event') continue;
    if (k === 'type') continue;
    out[k] = v;
  }
  out.type = eventType;
  return out;
}

async function* _scanFile(filepath, refUri, isLive, archiveMtimeCache) {
  let stream;
  try {
    stream = fs.createReadStream(filepath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  } catch (err) {
    _logStderr('history_scan: cannot open ' + filepath + ': ' + (err && err.message));
    return;
  }

  stream.on('error', (err) => {
    _logStderr('history_scan: stream error on ' + filepath + ': ' + (err && err.message));
  });

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  try {
    for await (const rawLine of rl) {
      lineNumber++;
      if (rawLine.length === 0 || rawLine.trim().length === 0) continue;
      let obj;
      try {
        obj = JSON.parse(rawLine);
      } catch (err) {
        _logStderr(
          'history_scan malformed line: ' + filepath + ':' + lineNumber
        );
        continue;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        _logStderr('history_scan: non-object at ' + filepath + ':' + lineNumber);
        continue;
      }
      const normalized = _normalizeEvent(obj, filepath, lineNumber);
      if (normalized === null) continue;

      // Timestamp fallback
      if (typeof normalized.timestamp !== 'string' || normalized.timestamp.length === 0) {
        if (isLive) {
          _logStderr(
            'history_scan: live event missing timestamp at ' + filepath + ':' + lineNumber + ' — skipping'
          );
          continue;
        }
        // Archive fallback: use enclosing dir mtime (cached per archive).
        const archiveDir = path.dirname(filepath);
        let fallback = archiveMtimeCache.get(archiveDir);
        if (fallback === undefined) {
          try {
            const st = fs.statSync(archiveDir);
            fallback = st.mtime.toISOString();
          } catch (_e) {
            fallback = new Date(0).toISOString();
          }
          archiveMtimeCache.set(archiveDir, fallback);
        }
        normalized.timestamp = fallback;
      }

      normalized.ref = refUri;
      yield normalized;
    }
  } catch (err) {
    _logStderr('history_scan: iterator error on ' + filepath + ': ' + (err && err.message));
  } finally {
    try { rl.close(); } catch (_e) { /* swallow */ }
  }
}

async function* scanEvents(options) {
  const { liveAudit, historyDir } = _resolveRoots(options);
  const archiveMtimeCache = new Map();

  // Live audit first.
  if (liveAudit && fs.existsSync(liveAudit)) {
    yield* _scanFile(liveAudit, 'orchestray:history://audit/live', true, archiveMtimeCache);
  }

  // Archives next. Iterate each immediate subdirectory of historyDir and
  // scan its events.jsonl if present. Sorted lexicographically for
  // deterministic ordering.
  if (historyDir && fs.existsSync(historyDir)) {
    let entries;
    try {
      entries = fs.readdirSync(historyDir, { withFileTypes: true });
    } catch (err) {
      _logStderr('history_scan: readdir failed on ' + historyDir + ': ' + (err && err.message));
      entries = [];
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const dirName of dirs) {
      const jsonl = path.join(historyDir, dirName, 'events.jsonl');
      if (!fs.existsSync(jsonl)) continue;
      const refUri = 'orchestray:history://orch/' + dirName;
      yield* _scanFile(jsonl, refUri, false, archiveMtimeCache);
    }
  }
}

// ---------------------------------------------------------------------------
// queryEvents
// ---------------------------------------------------------------------------

// Strict ISO-8601 UTC shape used by every event timestamp in this codebase.
// Accepts: 2026-04-11T06:55:18Z and 2026-04-11T06:55:18.123Z. Rejects date-
// only, local-time, and offset (+00:00) forms so that a caller passing
// "yesterday" or "2026-04-11" cannot silently receive wrong results from
// the downstream lexical string comparison in _matches. B8 from the
// v2.0.11 solidification pass.
const _ISO8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function _isIsoTimestamp(s) {
  return typeof s === 'string' && _ISO8601_UTC.test(s);
}

/**
 * Validate `filters.since` and `filters.until` as strict ISO-8601 UTC
 * strings before queryEvents begins scanning. Throws a synchronous Error
 * with `code: 'INVALID_FILTER'` on bad input so the tool handler can
 * translate it into a structured tool-result error instead of returning
 * garbage matches.
 */
function _validateFilters(filters) {
  if (!filters) return;
  if (filters.since !== undefined && !_isIsoTimestamp(filters.since)) {
    const e = new Error(
      'history_scan: filters.since must be ISO-8601 UTC ' +
        '(YYYY-MM-DDTHH:MM:SS[.sss]Z); got ' + JSON.stringify(filters.since)
    );
    e.code = 'INVALID_FILTER';
    throw e;
  }
  if (filters.until !== undefined && !_isIsoTimestamp(filters.until)) {
    const e = new Error(
      'history_scan: filters.until must be ISO-8601 UTC ' +
        '(YYYY-MM-DDTHH:MM:SS[.sss]Z); got ' + JSON.stringify(filters.until)
    );
    e.code = 'INVALID_FILTER';
    throw e;
  }
}

function _matches(ev, filters) {
  if (filters.since && typeof ev.timestamp === 'string' && ev.timestamp < filters.since) return false;
  if (filters.until && typeof ev.timestamp === 'string' && ev.timestamp > filters.until) return false;
  if (Array.isArray(filters.orchestration_ids) && filters.orchestration_ids.length > 0) {
    if (!filters.orchestration_ids.includes(ev.orchestration_id)) return false;
  }
  if (Array.isArray(filters.event_types) && filters.event_types.length > 0) {
    if (!filters.event_types.includes(ev.type)) return false;
  }
  if (filters.agent_role && ev.agent_role !== filters.agent_role) return false;
  return true;
}

async function queryEvents(filters, options) {
  const f = filters || {};
  _validateFilters(f);
  const limit = typeof f.limit === 'number' ? f.limit : 100;
  const offset = typeof f.offset === 'number' ? f.offset : 0;

  // One pass over the corpus, applying filters during iteration. We keep
  // a count of total matches and a window of `offset..offset+limit`
  // matching events. Memory-bounded to `limit` events regardless of total.
  let totalMatching = 0;
  const windowEvents = [];

  for await (const ev of scanEvents(options)) {
    if (!_matches(ev, f)) continue;
    if (totalMatching >= offset && windowEvents.length < limit) {
      windowEvents.push(ev);
    }
    totalMatching++;
  }

  return {
    events: windowEvents,
    total_matching: totalMatching,
    returned: windowEvents.length,
  };
}

module.exports = {
  scanEvents,
  queryEvents,
};
