'use strict';

/**
 * pattern-seen-set.js — CiteCache per-orchestration pattern seen-set.
 *
 * Tracks which patterns have been cited (with full body) in each orchestration.
 * First delegation that cites a pattern records a row; subsequent delegations
 * can retrieve the first-agent info and hash to emit a cached citation instead
 * of the full body.
 *
 * State file: .orchestray/state/pattern-seen-set.jsonl
 * Row format: { orch_id, slug, first_agent, body_hash, ts }
 *
 * Contract:
 *   - Never throws. All I/O wrapped in try/catch; errors cause fail-open
 *     (caller falls back to emitting full body).
 *   - Clear on orchestration_complete: call clearForOrch(orchId) from the
 *     archive flow (collect-agent-metrics.js on orchestration_complete detection).
 *   - body_hash is sha256(body) hex; hashShort is first 6 hex chars.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicAppendJsonl } = require('./atomic-append');
const { recordDegradation } = require('./degraded-journal');

// v2.1.9 I-06: hard size cap for the seen-set file. When exceeded, the reader
// emits a degraded-journal `pattern_seen_set_oversize` entry and the writer
// atomically truncates to roughly the most recent 5 MB of rows.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const TRUNCATE_TARGET_BYTES = 5 * 1024 * 1024; // 5 MB — post-truncate target

/**
 * Resolve path to the seen-set JSONL file.
 * @param {string} [projectRoot]
 * @returns {string}
 */
function _seenSetPath(projectRoot) {
  return path.join(
    projectRoot || process.cwd(),
    '.orchestray', 'state', 'pattern-seen-set.jsonl'
  );
}

/**
 * Compute sha256 hex of a string.
 * @param {string} body
 * @returns {string}
 */
function computeBodyHash(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Read all rows from the seen-set file. Returns [] on any error (fail-open).
 *
 * v2.1.9 I-06: hardened with try/catch around stat/read/parse. On ENOENT
 * returns silently; on other errors or oversized files records a degraded-
 * journal entry and returns an empty set (caller falls back to emitting full
 * pattern bodies). Oversized files get a separate `pattern_seen_set_oversize`
 * kind so operators can distinguish corruption from growth.
 *
 * @param {string} filePath
 * @returns {Array<{orch_id:string, slug:string, first_agent:string, body_hash:string, ts:string}>}
 */
function _readRows(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    try {
      recordDegradation({
        kind: 'pattern_seen_set_corrupt',
        severity: 'warn',
        detail: { message: String(err.message || err).slice(0, 200), dedup_key: 'stat-' + filePath },
      });
    } catch (_) { /* last resort */ }
    return [];
  }

  if (stat.size > MAX_FILE_BYTES) {
    try {
      recordDegradation({
        kind: 'pattern_seen_set_oversize',
        severity: 'warn',
        detail: {
          size_bytes: stat.size,
          cap_bytes: MAX_FILE_BYTES,
          dedup_key: 'oversize-' + filePath,
        },
      });
    } catch (_) { /* last resort */ }
    // Attempt in-place truncation — best effort; fail-open on write failure.
    try {
      _truncateToTarget(filePath, TRUNCATE_TARGET_BYTES);
    } catch (_) { /* truncation failed; caller still sees empty rows */ }
    return [];
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    try {
      recordDegradation({
        kind: 'pattern_seen_set_recovered',
        severity: 'warn',
        detail: { message: String(err.message || err).slice(0, 200), dedup_key: 'read-' + filePath },
      });
    } catch (_) { /* last resort */ }
    return [];
  }

  const rows = [];
  let parseErrors = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (_) {
      parseErrors++;
    }
  }
  if (parseErrors > 0) {
    try {
      recordDegradation({
        kind: 'pattern_seen_set_recovered',
        severity: 'warn',
        detail: { parse_errors: parseErrors, dedup_key: 'parse-' + filePath },
      });
    } catch (_) { /* last resort */ }
  }
  return rows;
}

/**
 * Atomically rewrite the seen-set file, keeping only the tail rows that fit
 * within `targetBytes`. Writes to a sibling tmp file then renames over the
 * target (same-filesystem rename is atomic). Fail-open on any error.
 *
 * Exported for tests.
 *
 * @param {string} filePath
 * @param {number} targetBytes
 * @returns {{ truncated: boolean, kept?: number, dropped?: number }}
 */
function _truncateToTarget(filePath, targetBytes) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  // Greedily keep tail lines whose cumulative bytes fit target.
  let kept = [];
  let running = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const sz = Buffer.byteLength(line, 'utf8') + 1; // plus newline
    if (running + sz > targetBytes) break;
    running += sz;
    kept.push(line);
  }
  kept.reverse();
  const content = kept.length > 0 ? kept.join('\n') + '\n' : '';
  const tmp = filePath + '.truncate.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
  return { truncated: true, kept: kept.length, dropped: Math.max(0, lines.length - kept.length) };
}

/**
 * Record that a pattern was cited (full body delivered) in an orchestration.
 * Idempotent: if the slug is already recorded for this orchId, does nothing.
 *
 * @param {string} orchId
 * @param {string} slug
 * @param {string} body       Full pattern body text (used to compute hash)
 * @param {string} agentType  The agent type receiving this delegation
 * @param {string} [projectRoot]
 * @returns {{ recorded: boolean }}
 */
function recordSeen(orchId, slug, body, agentType, projectRoot) {
  try {
    const filePath = _seenSetPath(projectRoot);

    // Check if already recorded (idempotent).
    const existing = _readRows(filePath);
    for (const row of existing) {
      if (row.orch_id === orchId && row.slug === slug) {
        return { recorded: false };
      }
    }

    const bodyHash = computeBodyHash(String(body || ''));
    const row = {
      orch_id:     orchId,
      slug:        slug,
      first_agent: agentType,
      body_hash:   bodyHash,
      ts:          new Date().toISOString(),
    };

    // Ensure directory exists.
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_) {}

    // v2.1.9 I-06: pre-write size guard. If the file is already over the cap,
    // truncate to ~5 MB worth of tail rows before appending.
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        try {
          recordDegradation({
            kind: 'pattern_seen_set_oversize',
            severity: 'warn',
            detail: {
              size_bytes: stat.size,
              cap_bytes: MAX_FILE_BYTES,
              phase: 'pre-write',
              dedup_key: 'oversize-pre-write-' + filePath,
            },
          });
        } catch (_) { /* ignore */ }
        try { _truncateToTarget(filePath, TRUNCATE_TARGET_BYTES); } catch (_) { /* fail-open */ }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Non-ENOENT stat failure — log and continue; atomicAppendJsonl will
        // retry or fail-open on its own.
      }
    }

    atomicAppendJsonl(filePath, row);
    return { recorded: true };
  } catch (err) {
    // Fail-open: disk error must not block orchestration.
    recordDegradation({
      kind: 'pattern_seen_set_write_failed',
      severity: 'warn',
      detail: { message: err.message, slug, orchId, dedup_key: 'write-' + orchId + '-' + slug },
    });
    return { recorded: false };
  }
}

/**
 * Check if a pattern has already been cited in this orchestration.
 *
 * @param {string} orchId
 * @param {string} slug
 * @param {string} [projectRoot]
 * @returns {{ seen: boolean, firstAgent: string|null, hashShort: string|null }}
 */
function isSeenInOrch(orchId, slug, projectRoot) {
  try {
    const filePath = _seenSetPath(projectRoot);
    const rows = _readRows(filePath);
    for (const row of rows) {
      if (row.orch_id === orchId && row.slug === slug) {
        return {
          seen:       true,
          firstAgent: row.first_agent || null,
          hashShort:  row.body_hash ? row.body_hash.slice(0, 6) : null,
        };
      }
    }
    return { seen: false, firstAgent: null, hashShort: null };
  } catch (_) {
    // Fail-open: treat as not-seen so full body is delivered.
    return { seen: false, firstAgent: null, hashShort: null };
  }
}

/**
 * Remove all rows for a given orchestration id (called on orchestration_complete).
 * Rewrites the file without matching rows.
 *
 * @param {string} orchId
 * @param {string} [projectRoot]
 * @returns {{ cleared: boolean }}
 */
function clearForOrch(orchId, projectRoot) {
  try {
    const filePath = _seenSetPath(projectRoot);
    const rows = _readRows(filePath);
    const remaining = rows.filter(r => r.orch_id !== orchId);
    if (remaining.length === rows.length) return { cleared: false };

    const content = remaining.map(r => JSON.stringify(r)).join('\n');
    fs.writeFileSync(filePath, content ? content + '\n' : '', 'utf8');
    return { cleared: true };
  } catch (_) {
    // Fail-open: cleanup failure must not block anything.
    return { cleared: false };
  }
}

module.exports = {
  recordSeen,
  isSeenInOrch,
  clearForOrch,
  computeBodyHash,
  // Exported for tests and hardening inspection:
  _readRows,
  _truncateToTarget,
  MAX_FILE_BYTES,
  TRUNCATE_TARGET_BYTES,
};
