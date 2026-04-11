'use strict';

/**
 * MCP checkpoint ledger reader and path helpers (v2.0.12).
 *
 * The MCP checkpoint ledger records one row per enforced MCP tool call
 * (`pattern_find`, `kb_search`, `history_find_similar_tasks`,
 * `pattern_record_application`) during PM-driven orchestration. The gate
 * in `bin/gate-agent-spawn.js` reads this ledger before allowing the first
 * orchestration spawn. The writer in `bin/record-mcp-checkpoint.js` appends
 * rows via `appendCheckpointEntry`.
 *
 * This module is the structural mirror of `bin/_lib/routing-lookup.js`:
 *   ROUTING_FILE const      → CHECKPOINT_FILE const
 *   getRoutingFilePath(cwd) → getCheckpointFilePath(cwd)
 *   readRoutingEntries(cwd) → readCheckpointEntries(cwd)
 *   findRoutingEntry(...)   → findCheckpointsForOrchestration(cwd, id)
 *
 * Fail-open on every read path: missing file returns [], malformed JSON
 * lines are skipped silently. This matches the routing-lookup.js precedent
 * and the D6 upgrade story — a gate consumer distinguishes "file absent"
 * from "zero rows for this orchestration_id" via its own pre-check; this
 * helper returns [] for both cases and does NOT distinguish them.
 *
 * Checkpoint entry schema:
 * @typedef {Object} CheckpointEntry
 * @property {string}       timestamp        - ISO 8601
 * @property {string}       orchestration_id - from .orchestray/audit/current-orchestration.json
 * @property {string}       tool             - pattern_find | kb_search | history_find_similar_tasks | pattern_record_application
 * @property {string}       outcome          - answered | error | skipped
 * @property {string}       phase            - pre-decomposition | post-decomposition
 * @property {number|null}  result_count     - number of items returned for pattern_find; null otherwise
 *
 * Example row:
 * {
 *   "timestamp": "2026-04-11T12:00:00.000Z",
 *   "orchestration_id": "orch-1775900941",
 *   "tool": "pattern_find",
 *   "outcome": "answered",
 *   "phase": "pre-decomposition",
 *   "result_count": 3
 * }
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl, MAX_JSONL_READ_BYTES } = require('./atomic-append');

/**
 * Path to the MCP checkpoint ledger file, relative to cwd.
 * Operational file — deletable on rollback without touching audit/events.jsonl.
 */
const CHECKPOINT_FILE = '.orchestray/state/mcp-checkpoint.jsonl';

/**
 * Tools required to have a `pre-decomposition` checkpoint row before the
 * first orchestration Agent() spawn is allowed. Consumed by T3's gate check.
 */
const REQUIRED_PRE_DECOMPOSITION_TOOLS = [
  'pattern_find',
  'kb_search',
  'history_find_similar_tasks',
];

/**
 * Tools required after decomposition. Advisory only — missing rows produce a
 * `pattern_record_skipped` event but do NOT block spawns.
 */
const REQUIRED_POST_DECOMPOSITION_TOOLS = ['pattern_record_application'];

/**
 * Return the absolute path to the checkpoint ledger under cwd.
 *
 * @param {string} cwd - Project root (result of resolveSafeCwd)
 * @returns {string}
 */
function getCheckpointFilePath(cwd) {
  return path.join(cwd, CHECKPOINT_FILE);
}

/**
 * Append a single checkpoint entry to the ledger. Creates parent directories
 * as needed. Uses atomic append to avoid concurrent write corruption during
 * parallel MCP hook invocations.
 *
 * @param {string}          cwd   - Project root (result of resolveSafeCwd)
 * @param {CheckpointEntry} entry - Checkpoint entry object
 */
function appendCheckpointEntry(cwd, entry) {
  const filePath = getCheckpointFilePath(cwd);
  atomicAppendJsonl(filePath, entry);
}

/**
 * Read all checkpoint entries from the ledger, parsing each line as JSON.
 * Returns an empty array if the file is missing or unreadable.
 * Malformed JSON lines are skipped silently (fail-open).
 *
 * @param {string} cwd - Project root (result of resolveSafeCwd)
 * @returns {CheckpointEntry[]}
 */
function readCheckpointEntries(cwd) {
  const filePath = getCheckpointFilePath(cwd);
  // Size guard (A2 LOW-1): refuse to load oversized files into memory.
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_JSONL_READ_BYTES) {
      process.stderr.write(
        '[orchestray] readCheckpointEntries: checkpoint file too large (' +
        stat.size + ' bytes > ' + MAX_JSONL_READ_BYTES + '); skipping read\n'
      );
      return [];
    }
  } catch (statErr) {
    if (statErr && statErr.code !== 'ENOENT') {
      // Unexpected stat error — fall through to the readFileSync attempt.
    } else {
      return []; // File missing — no entries.
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_e) {
      // Malformed line — skip silently (fail-open)
    }
  }
  return entries;
}

/**
 * Return all checkpoint entries whose `orchestration_id` matches the given
 * value. Returns an empty array when the file is missing OR when no rows
 * match — the caller is responsible for distinguishing these two cases via a
 * separate file-existence check (e.g. `fs.existsSync(getCheckpointFilePath(cwd))`)
 * if that distinction matters (see DESIGN §D6 step 3).
 *
 * @param {string} cwd             - Project root (result of resolveSafeCwd)
 * @param {string} orchestrationId - Orchestration ID to filter on
 * @returns {CheckpointEntry[]}
 */
function findCheckpointsForOrchestration(cwd, orchestrationId) {
  const entries = readCheckpointEntries(cwd);
  return entries.filter(
    entry =>
      entry &&
      typeof entry === 'object' &&
      entry.orchestration_id === orchestrationId
  );
}

/**
 * Given an already-fetched array of checkpoint rows and a required tool set,
 * return the subset of tools NOT covered by rows matching phaseFilter.
 *
 * This is the single-read variant: the caller fetches rows once (via
 * findCheckpointsForOrchestration) and passes them here, eliminating the
 * double-read TOCTOU window in gate-agent-spawn.js (A1 W2).
 *
 * Phase filtering (A1 I2): only rows whose `phase` field equals phaseFilter
 * are considered. Pass null/undefined to disable phase filtering.
 *
 * @param {CheckpointEntry[]} rows        - Already-fetched rows for one orchestration
 * @param {string[]}          requiredSet - Tool names that must each have ≥1 row
 * @param {string|null}       [phaseFilter='pre-decomposition'] - Phase to filter on
 * @returns {string[]} Tool names from requiredSet that have no matching row
 */
function missingRequiredToolsFromRows(rows, requiredSet, phaseFilter = 'pre-decomposition') {
  if (!rows.length) return [];

  const filtered = phaseFilter != null
    ? rows.filter(e => e && e.phase === phaseFilter)
    : rows;

  const seen = new Set(filtered.map(e => e && e.tool));
  return requiredSet.filter(tool => !seen.has(tool));
}

/**
 * Given an orchestration ID and a required tool set, return the subset of
 * tools that have NO matching checkpoint row. An empty return array means
 * all required tools are satisfied.
 *
 * Fail-open contract (mirrors DESIGN §D6 step 3):
 * - File missing → returns [] (upgrade-window fail-open; the gate must check
 *   file existence separately to emit the correct advisory event type).
 * - File exists but zero rows for this orchestration_id → returns [] (cross-
 *   orchestration fail-open; the gate's pre-check distinguishes this from the
 *   "file absent" case for event logging, but both produce the same allow result).
 * - Rows exist for this orchestration_id AND a required tool is absent → returns
 *   the missing tool name(s); the gate treats this as fail-closed.
 *
 * This is a thin wrapper around missingRequiredToolsFromRows for backward
 * compatibility. New callers that already hold the rows array should call
 * missingRequiredToolsFromRows directly to avoid the second file read.
 *
 * @param {string}   cwd             - Project root (result of resolveSafeCwd)
 * @param {string}   orchestrationId - Orchestration ID to check
 * @param {string[]} requiredSet     - Tool names that must each have ≥1 row
 * @returns {string[]} Tool names from requiredSet that have no checkpoint row
 */
function missingRequiredTools(cwd, orchestrationId, requiredSet) {
  const entries = findCheckpointsForOrchestration(cwd, orchestrationId);
  return missingRequiredToolsFromRows(entries, requiredSet, 'pre-decomposition');
}

module.exports = {
  CHECKPOINT_FILE,
  REQUIRED_PRE_DECOMPOSITION_TOOLS,
  REQUIRED_POST_DECOMPOSITION_TOOLS,
  getCheckpointFilePath,
  // readCheckpointEntries is intentionally not exported — used only internally
  // by findCheckpointsForOrchestration. No external caller exists (A3 F3.2).
  findCheckpointsForOrchestration,
  missingRequiredToolsFromRows,
  missingRequiredTools,
  appendCheckpointEntry,
};
