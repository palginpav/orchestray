'use strict';

/**
 * resolve-files-changed.js — shared helper (v2.3.31 W8B).
 *
 * Extracted from the now-retired bin/inject-review-dimensions.js so that
 * validate-reviewer-dimensions.js can compute the same `files_changed` set
 * for dimension classification, without depending on a sibling
 * PreToolUse:Agent hook's `updatedInput` (which does not propagate — see
 * validate-context-size-hint.js header comment for the established root
 * cause in this codebase).
 *
 * Reads the most-recent developer `agent_stop` event for the current
 * orchestration from `.orchestray/audit/events.jsonl`, capped at 200 rows /
 * 1 MiB, with a per-orchestration cache (W-PE-2, originally added to
 * inject-review-dimensions.js in v2.2.21) to avoid repeat scans across
 * multiple reviewer spawns in the same orchestration. Cache file:
 * `.orchestray/state/files-changed-cache.json`.
 */

const fs   = require('fs');
const path = require('path');

const MAX_EVENTS_SCAN_ROWS = 200;
const FILES_CHANGED_CACHE_REL = path.join('.orchestray', 'state', 'files-changed-cache.json');
const FILES_CHANGED_CACHE_MAX_BYTES = 64 * 1024; // 64K cap; clip on read
const EVENTS_CAP = 1024 * 1024;

function _readFilesChangedCache(cwd) {
  try {
    const p = path.join(cwd, FILES_CHANGED_CACHE_REL);
    const stat = fs.statSync(p);
    if (stat.size > FILES_CHANGED_CACHE_MAX_BYTES) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return {};
  }
}

function _writeFilesChangedCache(cwd, cache) {
  try {
    const p = path.join(cwd, FILES_CHANGED_CACHE_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache), 'utf8');
  } catch (_e) {
    // fail-open — cache is an optimization, never required for correctness
  }
}

/**
 * @param {string} cwd
 * @param {string|null} orchestration_id
 * @returns {{ files_changed: string[], source: string }}
 */
function resolveFilesChanged(cwd, orchestration_id) {
  if (!orchestration_id) {
    return { files_changed: [], source: 'empty_no_developer' };
  }

  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  let eventsSize = 0;
  try { eventsSize = fs.statSync(eventsPath).size; } catch (_e) { /* fall through */ }

  const cache = _readFilesChangedCache(cwd);
  const orchEntry = cache[orchestration_id];
  if (orchEntry && orchEntry._latest && typeof orchEntry._latest.events_size_at_write === 'number') {
    if (orchEntry._latest.events_size_at_write === eventsSize &&
        Array.isArray(orchEntry._latest.files_changed)) {
      return {
        files_changed: orchEntry._latest.files_changed.slice(),
        source: orchEntry._latest.source || 'developer_agent_stop',
      };
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch (_e) {
    return { files_changed: [], source: 'empty_no_developer' };
  }

  if (raw.length > EVENTS_CAP) {
    raw = raw.slice(-EVENTS_CAP);
    const nl = raw.indexOf('\n');
    if (nl >= 0) raw = raw.slice(nl + 1);
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let scanned = 0;
  for (let i = lines.length - 1; i >= 0 && scanned < MAX_EVENTS_SCAN_ROWS; i--, scanned++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch (_e) { continue; }

    if (
      row.type === 'agent_stop' &&
      row.agent_type === 'developer' &&
      row.orchestration_id === orchestration_id
    ) {
      const filesFromStop = Array.isArray(row.files_changed) ? row.files_changed
        : (row.structured_result && Array.isArray(row.structured_result.files_changed)
            ? row.structured_result.files_changed : null);
      if (filesFromStop && filesFromStop.length > 0) {
        const files = filesFromStop
          .filter((f) => typeof f === 'string' && f.trim().length > 0)
          .map((f) => f.trim());
        const deduped = [...new Set(files)];
        if (deduped.length > 0) {
          try {
            const cacheNext = cache && typeof cache === 'object' ? Object.assign({}, cache) : {};
            cacheNext[orchestration_id] = Object.assign({}, cacheNext[orchestration_id] || {}, {
              _latest: {
                files_changed: deduped,
                source: 'developer_agent_stop',
                events_size_at_write: eventsSize,
                ts: new Date().toISOString(),
              },
            });
            _writeFilesChangedCache(cwd, cacheNext);
          } catch (_e) { /* fail-open */ }
          return { files_changed: deduped, source: 'developer_agent_stop' };
        }
      }
    }
  }

  return { files_changed: [], source: 'empty_no_developer' };
}

module.exports = { resolveFilesChanged };
