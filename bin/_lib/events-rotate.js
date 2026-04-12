'use strict';

// CALLER: invoked by PM via Bash from agents/pm-reference/tier1-orchestration.md
// Section 15 (cleanup). Not imported by any bin/ file directly — the only
// production caller is a prompt-directed shell-out. See orch-1775930000-2014-audit
// artifact 2014-audit-a4-wiring.md § "events-rotate.js verdict" for context.

// 2013-W6-rotate — durable events.jsonl rotation with sentinel-based idempotence.
//
// Exports:
//   rotateEventsForOrchestration(cwd, orchestrationId)
//     Top-level entry point. Implements the three-state sentinel state machine
//     for crash-safe, idempotent rotation of the live events.jsonl into the
//     per-orchestration history archive. Returns a result object.
//
//   getSentinelFilePath(cwd, orchestrationId)
//     Path helper — returns the absolute sentinel file path for the given orch-id.
//
// Three-state sentinel contract (resolved OQ-T2-2):
//
//   State "started"   — written before archive-write begins. Recovery: delete
//                       partial archive + sentinel, restart from filter step.
//   State "archived"  — written after archive fsync completes. Recovery: skip
//                       archive-write, proceed directly to truncate.
//   State "truncated" — written after atomic-rename truncate. Then sentinel is
//                       deleted as the final step. Recovery: just delete sentinel.
//
// Belt-and-braces (minimum floor per resolved OQ-T2-2):
//   Even outside a sentinel-archived recovery, if the archive file already exists
//   and the live file is non-empty, skip the archive-write before proceeding to
//   truncate. This guards against partial-sentinel scenarios not covered by the
//   three explicit states.
//
// Atomicity requirement:
//   The "truncate" step uses a rename-dance, NOT fs.truncateSync (explicitly
//   forbidden). We write the post-rotation content (rows for OTHER orchestrations)
//   to events.jsonl.partial, then fs.renameSync it over events.jsonl. This is
//   atomic on POSIX and preserves file-handle semantics for concurrent writers.

const fs   = require('fs');
const path = require('path');

/**
 * Sentinel file lives in .orchestray/state/ alongside other operational files.
 *
 * @param {string} cwd             - Project root
 * @param {string} orchestrationId - e.g. "orch-1775921459"
 * @returns {string} Absolute path to the sentinel file
 */
function getSentinelFilePath(cwd, orchestrationId) {
  return path.join(cwd, '.orchestray', 'state', `.events-rotation-${orchestrationId}.sentinel`);
}

/**
 * Path to the live events.jsonl (audit log).
 *
 * @param {string} cwd - Project root
 * @returns {string}
 */
function getLiveEventsPath(cwd) {
  return path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
}

/**
 * Path to the archive destination for a completed orchestration.
 *
 * @param {string} cwd             - Project root
 * @param {string} orchestrationId - Orchestration ID
 * @returns {string}
 */
function getArchivePath(cwd, orchestrationId) {
  return path.join(cwd, '.orchestray', 'history', orchestrationId, 'events.jsonl');
}

/**
 * Read and return all non-empty JSONL raw lines from a file.
 * Returns empty arrays if the file is missing.
 *
 * @param {string} filePath
 * @returns {{ raw_lines: string[] }}
 */
function readRawLines(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { raw_lines: [] };
    throw err; // Unexpected read error — propagate.
  }

  const raw_lines = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) raw_lines.push(trimmed);
  }
  return { raw_lines };
}

/**
 * Write (or overwrite) a sentinel file with the given state object.
 * Creates parent directories as needed.
 *
 * @param {string} sentinelPath
 * @param {Object} state
 */
function writeSentinel(sentinelPath, state) {
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify(state) + '\n', { encoding: 'utf8' });
}

/**
 * Read and parse the sentinel file. Returns null if the file is missing or
 * malformed (fail-open — treat as no sentinel on any read error).
 *
 * @param {string} sentinelPath
 * @returns {{ state: string, [key: string]: any }|null}
 */
function readSentinel(sentinelPath) {
  try {
    const raw = fs.readFileSync(sentinelPath, 'utf8').trim();
    return JSON.parse(raw);
  } catch (_e) {
    return null; // Missing or malformed — treat as no sentinel.
  }
}

/**
 * Partition raw JSONL lines into those belonging to `orchestrationId` (archive)
 * and those that do not (keep in live file).
 *
 * Malformed lines (that cannot be parsed) are preserved in the "other" bucket
 * so they survive the rename-dance and are not silently discarded.
 *
 * @param {string[]} raw_lines
 * @param {string}   orchestrationId
 * @returns {{ archiveLines: string[], otherLines: string[] }}
 */
function partitionLines(raw_lines, orchestrationId) {
  const archiveLines = [];
  const otherLines   = [];

  for (const line of raw_lines) {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch (_e) {}

    if (parsed && parsed.orchestration_id === orchestrationId) {
      archiveLines.push(line);
    } else {
      otherLines.push(line);
    }
  }
  return { archiveLines, otherLines };
}

/**
 * Phase 1: filter events.jsonl, write archive for `orchestrationId`,
 * fsync the archive fd for durability, then write the "archived" sentinel.
 *
 * @param {string}   cwd
 * @param {string}   orchestrationId
 * @param {string}   archivePath
 * @param {string}   sentinelPath
 * @param {string}   liveEventsPath
 * @returns {{ rows_archived: number, otherLines: string[] }}
 */
function phaseFilterAndArchive(cwd, orchestrationId, archivePath, sentinelPath, liveEventsPath) {
  const { raw_lines } = readRawLines(liveEventsPath);
  const { archiveLines, otherLines } = partitionLines(raw_lines, orchestrationId);

  // Write archive file with fsync for durability.
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const archiveContent = archiveLines.length > 0
    ? archiveLines.map(l => l + '\n').join('')
    : '';
  const archiveFd = fs.openSync(archivePath, 'w');
  try {
    if (archiveContent) fs.writeSync(archiveFd, archiveContent);
    fs.fsyncSync(archiveFd); // durability guarantee — resolved OQ-T2-2
  } finally {
    fs.closeSync(archiveFd);
  }

  // Advance sentinel to "archived" — now safe to skip archive-write on re-entry.
  writeSentinel(sentinelPath, {
    state: 'archived',
    orchestration_id: orchestrationId,
    timestamp: new Date().toISOString(),
    archive_path: archivePath,
  });

  return { rows_archived: archiveLines.length, otherLines };
}

/**
 * Phase 2: atomically replace live events.jsonl with only the rows that do
 * NOT belong to `orchestrationId`. Uses rename-dance; fs.truncateSync is
 * explicitly forbidden (leaves a partial-state window during the syscall).
 *
 * After the rename, advances sentinel to "truncated". The caller deletes the
 * sentinel as its final step.
 *
 * @param {string}   cwd
 * @param {string}   orchestrationId
 * @param {string[]} otherLines     - Lines to keep in the live file
 * @param {string}   sentinelPath
 * @param {string}   liveEventsPath
 */
function phaseAtomicTruncate(cwd, orchestrationId, otherLines, sentinelPath, liveEventsPath) {
  const partialPath = liveEventsPath + '.partial';

  const keepContent = otherLines.length > 0
    ? otherLines.map(l => l + '\n').join('')
    : '';
  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(partialPath, keepContent, { encoding: 'utf8' });

  // Atomic rename — POSIX guarantees atomicity on the same filesystem.
  fs.renameSync(partialPath, liveEventsPath);

  // Advance sentinel to "truncated".
  writeSentinel(sentinelPath, {
    state: 'truncated',
    orchestration_id: orchestrationId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Top-level entry point. Handles the sentinel state machine and all recovery paths.
 *
 * Result object:
 *   {
 *     state: 'fresh' | 'resumed-started' | 'resumed-archived' | 'resumed-truncated' | 'error',
 *     archive_path: string | null,
 *     rows_archived: number | null,
 *     error: Error | null,
 *   }
 *
 * @param {string} cwd             - Project root (result of resolveSafeCwd)
 * @param {string} orchestrationId - Orchestration ID to rotate out
 * @returns {Object}
 */
function rotateEventsForOrchestration(cwd, orchestrationId) {
  const sentinelPath   = getSentinelFilePath(cwd, orchestrationId);
  const archivePath    = getArchivePath(cwd, orchestrationId);
  const liveEventsPath = getLiveEventsPath(cwd);

  // --- Read existing sentinel (if any) ---
  let resumeState = null;
  const sentinel = readSentinel(sentinelPath);
  if (sentinel && sentinel.orchestration_id === orchestrationId) {
    resumeState = sentinel.state;
  }

  // -------------------------------------------------------------------------
  // Recovery: "truncated" — crashed after rename, before sentinel delete.
  // Just delete the sentinel. Nothing else to do.
  // -------------------------------------------------------------------------
  if (resumeState === 'truncated') {
    try { fs.unlinkSync(sentinelPath); } catch (_e) {}
    return {
      state: 'resumed-truncated',
      archive_path: archivePath,
      rows_archived: null,
      error: null,
    };
  }

  // -------------------------------------------------------------------------
  // Recovery: "archived" — crashed after archive, before truncate.
  // Archive is already safe on disk. Skip archive-write, go straight to truncate.
  // -------------------------------------------------------------------------
  if (resumeState === 'archived') {
    const { raw_lines } = readRawLines(liveEventsPath);
    const { otherLines } = partitionLines(raw_lines, orchestrationId);

    try {
      phaseAtomicTruncate(cwd, orchestrationId, otherLines, sentinelPath, liveEventsPath);
    } catch (err) {
      return { state: 'error', archive_path: archivePath, rows_archived: null, error: err };
    }

    try { fs.unlinkSync(sentinelPath); } catch (_e) {}
    return {
      state: 'resumed-archived',
      archive_path: archivePath,
      rows_archived: null,
      error: null,
    };
  }

  // -------------------------------------------------------------------------
  // Recovery: "started" — crashed before archive completed.
  // Delete partial archive + sentinel, restart from scratch.
  // -------------------------------------------------------------------------
  if (resumeState === 'started') {
    try { fs.unlinkSync(archivePath); } catch (_e) {}
    try { fs.unlinkSync(sentinelPath); } catch (_e) {}
    // Fall through to fresh run.
  }

  // -------------------------------------------------------------------------
  // Fresh run (or post-"started" recovery fallthrough).
  // -------------------------------------------------------------------------

  // Belt-and-braces secondary guard (resolved OQ-T2-2 minimum floor):
  // If the archive already exists on disk and the live file is non-empty,
  // skip the archive-write and proceed directly to truncate. This handles
  // scenarios where the sentinel was lost but the archive is already durable.
  const liveNonEmpty = (() => {
    try { return fs.statSync(liveEventsPath).size > 0; } catch (_e) { return false; }
  })();
  const archiveAlreadyExists = fs.existsSync(archivePath);

  let rows_archived = null;
  let otherLines    = [];

  if (archiveAlreadyExists && liveNonEmpty) {
    // Archive is already on disk — skip write, just compute lines for truncate.
    const { raw_lines } = readRawLines(liveEventsPath);
    const result = partitionLines(raw_lines, orchestrationId);
    otherLines = result.otherLines;
    // No sentinel to advance here — we go straight to truncate.
    // Write a "started" sentinel so truncate can advance it to "archived" state
    // only if we haven't already. Actually we skip the archive phase entirely so
    // write a pseudo-archived sentinel directly to enable the truncate path.
    writeSentinel(sentinelPath, {
      state: 'archived',
      orchestration_id: orchestrationId,
      timestamp: new Date().toISOString(),
      archive_path: archivePath,
      note: 'belt-and-braces: archive already existed, skipped re-write',
    });
  } else {
    // Normal fresh path: write "started" sentinel, then filter + archive.
    writeSentinel(sentinelPath, {
      state: 'started',
      orchestration_id: orchestrationId,
      timestamp: new Date().toISOString(),
    });

    try {
      const result = phaseFilterAndArchive(
        cwd, orchestrationId, archivePath, sentinelPath, liveEventsPath
      );
      rows_archived = result.rows_archived;
      otherLines    = result.otherLines;
    } catch (err) {
      // Sentinel remains at "started" — next call will delete partial archive and retry.
      return { state: 'error', archive_path: null, rows_archived: null, error: err };
    }
  }

  // Phase 2: atomic truncate.
  try {
    phaseAtomicTruncate(cwd, orchestrationId, otherLines, sentinelPath, liveEventsPath);
  } catch (err) {
    // Sentinel is at "archived" — next call will skip archive-write and retry truncate.
    return { state: 'error', archive_path: archivePath, rows_archived, error: err };
  }

  // Delete sentinel — rotation is fully complete.
  try { fs.unlinkSync(sentinelPath); } catch (_e) {}

  const returnState = resumeState === 'started' ? 'resumed-started' : 'fresh';
  return {
    state: returnState,
    archive_path: archivePath,
    rows_archived,
    error: null,
  };
}

module.exports = {
  rotateEventsForOrchestration,
  getSentinelFilePath,
  // Exported for testing only:
  _getLiveEventsPath: getLiveEventsPath,
  _getArchivePath: getArchivePath,
};
