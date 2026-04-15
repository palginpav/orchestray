'use strict';

/**
 * `routing_lookup` MCP tool.
 *
 * Queries the routing decision log (.orchestray/state/routing.jsonl) for
 * entries matching the supplied filter. Useful for auditing model/effort
 * routing decisions made by the PM during decomposition.
 *
 * Input:  { orchestration_id, task_id?, agent_type? }
 * Output: { matches: RoutingEntry[], total: number }
 *   where each RoutingEntry has:
 *     { ts, orchestration_id, task_id, agent_type, model, effort,
 *       description, rationale, complexity_score, decided_by, decided_at }
 *
 * Per v2016-release-plan.md §W3.
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');

// Maximum bytes to read from routing.jsonl to avoid blocking on huge files.
const MAX_ROUTING_READ = 2 * 1024 * 1024; // 2 MB

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: [],
  properties: {
    orchestration_id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Filter by orchestration ID. Required when task_id is supplied.',
    },
    task_id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Filter by task ID (e.g. "task-1" or "group-1.task-2").',
    },
    agent_type: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Filter by agent role (developer, reviewer, architect, …).',
    },
  },
});

const definition = deepFreeze({
  name: 'routing_lookup',
  description:
    'Query the routing decision log (.orchestray/state/routing.jsonl) for ' +
    'entries matching any combination of orchestration_id, task_id, or agent_type. ' +
    'Returns matches newest-first. At least one filter parameter is recommended; ' +
    'supplying no filters returns all entries (capped at 500 lines). ' +
    'Per v2016-release-plan.md §W3.',
  inputSchema: INPUT_SCHEMA,
});

/**
 * Read and parse routing.jsonl entries. Returns newest-first (reversed).
 * Malformed JSON lines are silently skipped (fail-open).
 * File size is capped at MAX_ROUTING_READ bytes to prevent blocking.
 *
 * @param {string} routingPath - Absolute path to routing.jsonl
 * @returns {object[]}
 */
function readAllRoutingEntries(routingPath) {
  let raw;
  try {
    const stat = fs.statSync(routingPath);
    if (stat.size > MAX_ROUTING_READ) {
      // File too large — read last MAX_ROUTING_READ bytes.
      const fd = fs.openSync(routingPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_ROUTING_READ);
        const bytesRead = fs.readSync(fd, buf, 0, MAX_ROUTING_READ, stat.size - MAX_ROUTING_READ);
        raw = buf.slice(0, bytesRead).toString('utf8');
        // Skip the first (potentially truncated) line.
        const firstNewline = raw.indexOf('\n');
        if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(routingPath, 'utf8');
    }
  } catch (_e) {
    // File missing or unreadable — return empty
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        entries.push(obj);
      }
    } catch (_e) {
      // Malformed line — skip silently
    }
  }

  // Return newest-first
  return entries.reverse();
}

/**
 * Normalize a routing entry to the canonical output shape.
 * Unknown fields are preserved so callers see the full entry.
 *
 * @param {object} entry - Raw parsed routing entry
 * @returns {object}
 */
function normalizeEntry(entry) {
  return {
    ts: entry.timestamp || entry.ts || null,
    orchestration_id: entry.orchestration_id || null,
    task_id: entry.task_id || null,
    agent_type: entry.agent_type || null,
    model: entry.model || null,
    effort: entry.effort || null,
    description: entry.description || null,
    rationale: entry.rationale || null,
    complexity_score: (typeof entry.complexity_score === 'number') ? entry.complexity_score : null,
    score_breakdown: entry.score_breakdown || null,
    decided_by: entry.decided_by || null,
    decided_at: entry.decided_at || null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('routing_lookup: ' + validation.errors.join('; '));
  }

  // Resolve project root
  let projectRoot;
  try {
    if (context && context.projectRoot) {
      projectRoot = context.projectRoot;
    } else {
      const paths = require('../lib/paths');
      projectRoot = paths.getProjectRoot();
    }
  } catch (err) {
    return toolError('routing_lookup: cannot resolve project root');
  }

  const routingPath = path.join(projectRoot, '.orchestray', 'state', 'routing.jsonl');
  const allEntries = readAllRoutingEntries(routingPath);

  // Apply filters
  const orchId = (input && typeof input.orchestration_id === 'string') ? input.orchestration_id : null;
  const taskId = (input && typeof input.task_id === 'string') ? input.task_id : null;
  const agentType = (input && typeof input.agent_type === 'string') ? input.agent_type : null;

  const matches = [];
  for (const entry of allEntries) {
    if (orchId !== null && entry.orchestration_id !== orchId) continue;
    if (taskId !== null && entry.task_id !== taskId) continue;
    if (agentType !== null && entry.agent_type !== agentType) continue;
    matches.push(normalizeEntry(entry));
  }

  // F10: cap result at 500 entries to match the documented limit.
  const capped = matches.slice(0, 500);
  const result = {
    matches: capped,
    total: matches.length,
    truncated: matches.length > 500,
  };

  // F22: warn when no filters were supplied — result spans all orchestrations.
  if (orchId === null && taskId === null && agentType === null) {
    result._note = 'no filter supplied — result is bounded but may span multiple orchestrations';
  }

  return toolSuccess(result);
}

module.exports = {
  definition,
  handle,
};
