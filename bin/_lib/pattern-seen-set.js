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

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB safety cap

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
 * Read all rows from the seen-set file. Returns [] on any error.
 * @param {string} filePath
 * @returns {Array<{orch_id:string, slug:string, first_agent:string, body_hash:string, ts:string}>}
 */
function _readRows(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      process.stderr.write('[orchestray] pattern-seen-set: file exceeds size cap; treating as empty\n');
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch (_) {
        // Skip malformed lines; do not abort.
      }
    }
    return rows;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // File exists but could not be read — treat as corrupt.
      recordDegradation({
        kind: 'pattern_seen_set_corrupt',
        severity: 'warn',
        detail: { message: err.message, dedup_key: 'read-' + filePath },
      });
    }
    return [];
  }
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

module.exports = { recordSeen, isSeenInOrch, clearForOrch, computeBodyHash };
