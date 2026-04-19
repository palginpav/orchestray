'use strict';

/**
 * scorer-telemetry.js — Shared event-reader for shadow scorers.
 *
 * Tail-scans `.orchestray/audit/events.jsonl` and
 * `.orchestray/history/*\/events.jsonl` with the same 10 MB cap + 64 KB
 * tail-fallback used by degraded-journal.js. Per-process TTL cache (60 s)
 * so repeated pattern_find calls within one minute pay the disk-read cost
 * at most once.
 *
 * Bundle RS (v2.1.3): H1 shadow seam infrastructure.
 */

const fs   = require('fs');
const path = require('path');

// Safety caps matching degraded-journal.readJournalTail.
const MAX_JSONL_READ_BYTES = 10 * 1024 * 1024;   // 10 MB
const TAIL_CHUNK_BYTES     = 64 * 1024;           // 64 KB

// Per-process TTL for event caches.
const CACHE_TTL_MS = 60 * 1000;  // 60 seconds

// In-process cache: key → { at: number, events: object[] }
// Key format: `${projectRoot}|${sortedTypeList}|${sinceMs}`
const _cache = new Map();

/**
 * Tail-read a single JSONL file and return parsed lines (all of them, no
 * filtering). Returns [] if the file does not exist or cannot be read.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function _readJsonlFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    return [];
  }

  let raw;
  try {
    if (stat.size > MAX_JSONL_READ_BYTES) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(TAIL_CHUNK_BYTES);
      const offset = Math.max(0, stat.size - TAIL_CHUNK_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, TAIL_CHUNK_BYTES, offset);
      fs.closeSync(fd);
      raw = buf.slice(0, bytesRead).toString('utf8');
    } else {
      raw = fs.readFileSync(filePath, 'utf8');
    }
  } catch (_) {
    return [];
  }

  const results = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch (_) {
      // Malformed line — skip silently.
    }
  }
  return results;
}

/**
 * Build the union of all event files for a project root.
 * Covers the current audit stream and all history archives.
 *
 * @param {string} projectRoot
 * @returns {string[]} Absolute file paths.
 */
function _eventFilePaths(projectRoot) {
  const paths = [];

  // Current audit stream.
  paths.push(path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl'));

  // Archived orchestrations: .orchestray/history/<orch-id>/events.jsonl
  const historyDir = path.join(projectRoot, '.orchestray', 'history');
  let histEntries;
  try {
    histEntries = fs.readdirSync(historyDir);
  } catch (_) {
    histEntries = [];
  }
  for (const entry of histEntries) {
    const candidate = path.join(historyDir, entry, 'events.jsonl');
    paths.push(candidate);
  }

  return paths;
}

/**
 * Return all events of the requested types within the given time window.
 *
 * Results are cached per (projectRoot, types, sinceMs) for CACHE_TTL_MS.
 * Returned array is newest-first (sorted by timestamp descending).
 *
 * @param {string} projectRoot  - Absolute path to the project root.
 * @param {{ types: Set<string>, sinceMs: number }} opts
 * @returns {object[]}
 */
function getEventWindow(projectRoot, opts) {
  const types   = opts && opts.types instanceof Set ? opts.types : new Set();
  const sinceMs = opts && typeof opts.sinceMs === 'number' ? opts.sinceMs : 0;

  // Build cache key.
  const typesKey = Array.from(types).sort().join(',');
  const cacheKey = projectRoot + '|' + typesKey + '|' + sinceMs;

  const now = Date.now();
  const cached = _cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.events;
  }

  const filePaths = _eventFilePaths(projectRoot);
  const all = [];

  for (const fp of filePaths) {
    const lines = _readJsonlFile(fp);
    for (const ev of lines) {
      if (!ev || typeof ev !== 'object') continue;
      // Normalise event type: some events use `event`, others `type`.
      const evType = ev.type || ev.event;
      if (!types.has(evType)) continue;
      // Time window filter.
      if (sinceMs > 0) {
        const ts = ev.timestamp || ev.ts;
        if (!ts) continue;
        const evMs = Date.parse(ts);
        if (isNaN(evMs) || evMs < sinceMs) continue;
      }
      all.push(ev);
    }
  }

  // Sort newest-first.
  all.sort((a, b) => {
    const ta = Date.parse(a.timestamp || a.ts || 0);
    const tb = Date.parse(b.timestamp || b.ts || 0);
    return tb - ta;
  });

  _cache.set(cacheKey, { at: now, events: all });
  return all;
}

/**
 * Clear the in-process cache. Exported for tests only.
 */
function _clearCache() {
  _cache.clear();
}

module.exports = {
  getEventWindow,
  _clearCache,
};
