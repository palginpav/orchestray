'use strict';

/**
 * Routing decision helper for durable model routing (v2.0.11).
 *
 * Routing entry schema:
 * @typedef {Object} RoutingEntry
 * @property {string}  timestamp        - ISO 8601 timestamp
 * @property {string}  orchestration_id - Current orchestration ID
 * @property {string}  task_id          - PM-assigned task ID (e.g. 'task-1' or 'group-1.task-2')
 * @property {string}  agent_type       - Agent role (developer|reviewer|architect|...)
 * @property {string}  description      - First 80 chars of the Agent() description parameter
 * @property {string}  model            - Routing tier: haiku|sonnet|opus
 * @property {string}  effort           - Effort level: low|medium|high|max
 * @property {number}  complexity_score - Score 0-12
 * @property {Object}  score_breakdown  - Per-factor breakdown
 * @property {number}  score_breakdown.file_count    - 0-3
 * @property {number}  score_breakdown.cross_cutting - 0-3
 * @property {number}  score_breakdown.description   - 0-2
 * @property {number}  score_breakdown.keywords      - 0-2
 * @property {string}  decided_by       - Always "pm"
 * @property {string}  decided_at       - Always "decomposition"
 *
 * Example:
 * {
 *   "timestamp": "2026-04-11T12:00:00.000Z",
 *   "orchestration_id": "orch-2026-04-11-001",
 *   "task_id": "task-1",
 *   "agent_type": "developer",
 *   "description": "Fix authentication module in auth/handler.js",
 *   "model": "sonnet",
 *   "effort": "medium",
 *   "complexity_score": 4,
 *   "score_breakdown": { "file_count": 1, "cross_cutting": 1, "description": 1, "keywords": 1 },
 *   "decided_by": "pm",
 *   "decided_at": "decomposition"
 * }
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./atomic-append');

/**
 * Path to the routing decisions file for the current orchestration.
 * Relative to cwd.
 */
const ROUTING_FILE = '.orchestray/state/routing.jsonl';

/**
 * Return the absolute path to the routing file under cwd.
 *
 * @param {string} cwd - Project root (result of resolveSafeCwd)
 * @returns {string}
 */
function getRoutingFilePath(cwd) {
  return path.join(cwd, ROUTING_FILE);
}

/**
 * Append a single routing entry. Creates parent directories as needed.
 * Uses atomic append via bin/_lib/atomic-append.js to avoid concurrent
 * write corruption during parallel decomposition.
 *
 * @param {string}       cwd   - Project root (result of resolveSafeCwd)
 * @param {RoutingEntry} entry - Routing entry object
 */
function appendRoutingEntry(cwd, entry) {
  const filePath = getRoutingFilePath(cwd);
  atomicAppendJsonl(filePath, entry);
}

/**
 * Read all routing entries for the current orchestration, parse each
 * as JSON. Returns an array (empty if file missing or unreadable).
 * Malformed lines are skipped silently (fail-open).
 *
 * @param {string} cwd - Project root (result of resolveSafeCwd)
 * @returns {RoutingEntry[]}
 */
function readRoutingEntries(cwd) {
  const filePath = getRoutingFilePath(cwd);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    // File missing or unreadable — return empty
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
 * Find the routing entry matching the given (agent_type, description)
 * in the current orchestration's routing.jsonl.
 *
 * Matching rules:
 *   1. agent_type must match exactly (case-sensitive)
 *   2. Both stored description and lookup description must be non-empty
 *      after trim. Empty strings never match — this prevents an
 *      accidentally-blank routing entry from acting as a wildcard
 *      that matches all spawns of the same agent_type.
 *   3. Description match uses the first 80 chars of the description
 *      field, normalized via .trim(). To prevent cross-task
 *      contamination where one description is a string-prefix of
 *      another (e.g. "Fix auth" matching "Fix authority"), matching
 *      requires a WORD BOUNDARY after the shorter string:
 *        - Exact match (entryDesc === lookupDesc), OR
 *        - entryDesc starts with lookupDesc followed by a space, OR
 *        - lookupDesc starts with entryDesc followed by a space
 *      The space-boundary rule means "Fix auth module" matches a stored
 *      "Fix auth" (space after "auth"), but stored "Fix auth" does NOT
 *      match lookup "Fix authority" (no space between "auth" and "ority").
 *   4. If multiple entries match, return the MOST RECENT one (last
 *      timestamp) — handles re-planning and verify-fix re-spawns.
 *
 * @param {string} cwd         - Project root (result of resolveSafeCwd)
 * @param {string} agentType   - Agent role to match (case-sensitive)
 * @param {string} description - Description to match (first 80 chars, trimmed)
 * @returns {RoutingEntry|null} Routing entry object or null if no match
 */
function findRoutingEntry(cwd, agentType, description) {
  const entries = readRoutingEntries(cwd);
  if (!entries.length) return null;

  const lookupDesc = (description || '').substring(0, 80).trim();
  // Empty lookup never matches — prevents wildcard matches when the
  // caller omits description. The PM MUST pass a real description.
  if (!lookupDesc) return null;

  const matches = entries.filter(entry => {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.agent_type !== agentType) return false;

    const entryDesc = (entry.description || '').trim();
    // Empty stored description never matches — prevents an accidentally
    // blank routing entry from acting as a wildcard that matches all
    // spawns of the same agent_type.
    if (!entryDesc) return false;

    // Word-boundary-aware match in either direction. Exact equality
    // always matches; otherwise require a space after the shorter
    // string to prevent "Fix auth" matching "Fix authority" etc.
    if (entryDesc === lookupDesc) return true;
    if (entryDesc.startsWith(lookupDesc + ' ')) return true;
    if (lookupDesc.startsWith(entryDesc + ' ')) return true;
    return false;
  });

  if (!matches.length) return null;

  // Return the most recent entry (latest timestamp)
  // Sort descending by timestamp string — ISO 8601 sorts lexicographically
  matches.sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    if (tb > ta) return 1;
    if (tb < ta) return -1;
    return 0;
  });

  return matches[0];
}

module.exports = {
  ROUTING_FILE,
  getRoutingFilePath,
  appendRoutingEntry,
  readRoutingEntries,
  findRoutingEntry,
};
