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
 * LL6 extension: also reads routing_decision merged events from events.jsonl.
 * routing_decision rows are returned preferentially (merged: true) over the
 * split routing_outcome pair. Historical events.jsonl files only have split
 * routing_outcome rows; the tool synthesises routing_decision rows on-the-fly
 * from matched Variant A + Variant C pairs (merged: false, synthesised: true).
 *
 * Per v2016-release-plan.md §W3.
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { parseFields, projectArray } = require('../lib/field-projection');

// Maximum bytes to read from routing.jsonl to avoid blocking on huge files.
const MAX_ROUTING_READ = 2 * 1024 * 1024; // 2 MB

// Maximum bytes to read from events.jsonl for routing_decision lookup.
// Large enough to cover typical session sizes without blocking.
const MAX_EVENTS_READ = 4 * 1024 * 1024; // 4 MB

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
    // fields: accepts a comma-separated string or string[] — validated by parseFields() at runtime.
    // Schema type intentionally omitted: the validator subset does not support oneOf/anyOf,
    // and parseFields() enforces the allowed shapes with clear error messages.
    fields: { description: 'Optional comma-separated string or array of top-level field names to project. Omit for full response (backward compat).' },
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

/**
 * Read and parse events.jsonl, returning routing_decision rows and raw
 * routing_outcome rows for synthesis. Capped at MAX_EVENTS_READ bytes.
 * Returns newest-first.
 *
 * @param {string} eventsPath - Absolute path to events.jsonl
 * @returns {{ decisions: object[], hookRows: object[], stopRows: object[] }}
 */
function readRoutingEventsFromAudit(eventsPath) {
  const decisions = [];
  const hookRows = [];
  const stopRows = [];
  try {
    const stat = fs.statSync(eventsPath);
    let raw;
    if (stat.size > MAX_EVENTS_READ) {
      // Read the last MAX_EVENTS_READ bytes and skip the (likely truncated) first line.
      const fd = fs.openSync(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_EVENTS_READ);
        const bytesRead = fs.readSync(fd, buf, 0, MAX_EVENTS_READ, stat.size - MAX_EVENTS_READ);
        raw = buf.slice(0, bytesRead).toString('utf8');
        const firstNl = raw.indexOf('\n');
        if (firstNl !== -1) raw = raw.slice(firstNl + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(eventsPath, 'utf8');
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch (_e) { continue; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const type = obj.type;
      if (type === 'routing_decision') {
        decisions.push(obj);
      } else if (type === 'routing_outcome') {
        if (obj.source === 'hook') hookRows.push(obj);
        else if (obj.source === 'subagent_stop') stopRows.push(obj);
      }
    }
  } catch (_e) {
    // File missing or unreadable — return empty collections
  }
  decisions.reverse();
  hookRows.reverse();
  stopRows.reverse();
  return { decisions, hookRows, stopRows };
}

// Per-model output token caps (mirrors emit-routing-outcome.js MODEL_OUTPUT_CAPS).
const MODEL_OUTPUT_CAPS = {
  haiku:  32768,
  sonnet: 32768,
  opus:   32768,
};

/**
 * Synthesise routing_decision rows on-the-fly from matched Variant A (hook) +
 * Variant C (subagent_stop) routing_outcome pairs in historical events.jsonl.
 *
 * Matching key: (orchestration_id, agent_type). For each Variant C row, find
 * the nearest Variant A row in the same (orch, agent_type) bucket. Once
 * matched, neither row is reused (greedy earliest-match).
 *
 * @param {object[]} hookRows  - Variant A routing_outcome rows, newest-first
 * @param {object[]} stopRows  - Variant C routing_outcome rows, newest-first
 * @returns {object[]} Synthesised routing_decision rows (newest-first)
 */
function synthesiseDecisions(hookRows, stopRows) {
  // Build a map: key=(orch_id + '|' + agent_type) -> array of hook rows (indices)
  const hookByKey = new Map();
  for (let i = 0; i < hookRows.length; i++) {
    const row = hookRows[i];
    const key = (row.orchestration_id || '') + '|' + (row.agent_type || '');
    if (!hookByKey.has(key)) hookByKey.set(key, []);
    hookByKey.get(key).push(i);
  }
  const usedHookIdx = new Set();
  const synthesised = [];

  for (const stopRow of stopRows) {
    const key = (stopRow.orchestration_id || '') + '|' + (stopRow.agent_type || '');
    const candidates = hookByKey.get(key);
    if (!candidates) continue;
    // Pick the first unused candidate (greedy earliest-written = least index since
    // hookRows is newest-first; we want oldest match → pick the highest index).
    let chosenIdx = -1;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (!usedHookIdx.has(candidates[i])) { chosenIdx = candidates[i]; break; }
    }
    if (chosenIdx === -1) continue;
    usedHookIdx.add(chosenIdx);
    const hookRow = hookRows[chosenIdx];

    const stopTs = stopRow.timestamp || null;
    const spawnTs = hookRow.timestamp || null;
    let durationMs = null;
    if (stopTs && spawnTs) {
      const d = Date.parse(stopTs) - Date.parse(spawnTs);
      if (!isNaN(d) && d >= 0) durationMs = d;
    }
    const outputTokens = stopRow.output_tokens || 0;
    const model = hookRow.model_assigned || null;
    const cap = model && MODEL_OUTPUT_CAPS[model];
    const ratio = (outputTokens > 0 && cap)
      ? Math.round((outputTokens / cap) * 10000) / 10000
      : null;

    synthesised.push({
      timestamp: stopTs,
      type: 'routing_decision',
      orchestration_id: stopRow.orchestration_id || null,
      agent_id: stopRow.agent_id || null,
      agent_type: stopRow.agent_type || null,
      tool_name: hookRow.tool_name || null,
      description: hookRow.description || null,
      model_assigned: model,
      effort_assigned: hookRow.effort_assigned || null,
      turns_used: stopRow.turns_used || 0,
      input_tokens: stopRow.input_tokens || 0,
      output_tokens: outputTokens,
      result: stopRow.result || null,
      completion_volume_ratio: ratio,
      spawn_timestamp: spawnTs,
      duration_ms: durationMs,
      synthesised: true,  // marks this as synthesised from historical pairs, not emitted
    });
  }
  // Return newest-first (already newest-first since stopRows is newest-first)
  return synthesised;
}

/**
 * Normalise a routing_decision event into the output shape for routing_lookup.
 *
 * @param {object} ev
 * @param {boolean} [merged=true]  true = emitted merged event; false = synthesised
 * @returns {object}
 */
function normalizeDecisionEntry(ev, merged) {
  return {
    ts: ev.timestamp || null,
    orchestration_id: ev.orchestration_id || null,
    agent_id: ev.agent_id || null,
    agent_type: ev.agent_type || null,
    tool_name: ev.tool_name || null,
    description: ev.description || null,
    model_assigned: ev.model_assigned || null,
    effort_assigned: ev.effort_assigned || null,
    turns_used: (typeof ev.turns_used === 'number') ? ev.turns_used : null,
    input_tokens: (typeof ev.input_tokens === 'number') ? ev.input_tokens : null,
    output_tokens: (typeof ev.output_tokens === 'number') ? ev.output_tokens : null,
    result: ev.result || null,
    completion_volume_ratio: (typeof ev.completion_volume_ratio === 'number') ? ev.completion_volume_ratio : null,
    spawn_timestamp: ev.spawn_timestamp || null,
    duration_ms: (typeof ev.duration_ms === 'number') ? ev.duration_ms : null,
    merged: merged !== false,
    synthesised: ev.synthesised === true,
    // Preserve task_id if present (PM-emitted Variant B might set it)
    task_id: ev.task_id || null,
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

  // Apply filters
  const orchId = (input && typeof input.orchestration_id === 'string') ? input.orchestration_id : null;
  const taskId = (input && typeof input.task_id === 'string') ? input.task_id : null;
  const agentType = (input && typeof input.agent_type === 'string') ? input.agent_type : null;

  // -----------------------------------------------------------------------
  // Step 1: collect routing_decision events from events.jsonl (emitted or
  // synthesised from historical Variant A + Variant C pairs).
  // routing_decision rows are preferred over the split routing_outcome pair.
  // -----------------------------------------------------------------------
  const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
  const { decisions: emittedDecisions, hookRows, stopRows } = readRoutingEventsFromAudit(eventsPath);
  const synthesised = synthesiseDecisions(hookRows, stopRows);

  // Build a dedup key set from emitted decisions so synthesised rows for the
  // same agent_id are not double-counted.
  const emittedAgentIds = new Set(
    emittedDecisions.map(d => d.agent_id).filter(Boolean)
  );
  const filteredSynthesised = synthesised.filter(
    d => !d.agent_id || !emittedAgentIds.has(d.agent_id)
  );

  // Merge emitted + filtered synthesised, newest-first
  const allDecisions = [...emittedDecisions, ...filteredSynthesised].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta; // newest first
  });

  // -----------------------------------------------------------------------
  // Step 2: also read routing.jsonl (PM-written decomposition decisions).
  // These are a separate source and are NOT merged with routing_decision rows.
  // -----------------------------------------------------------------------
  const routingPath = path.join(projectRoot, '.orchestray', 'state', 'routing.jsonl');
  const allRoutingEntries = readAllRoutingEntries(routingPath);

  // -----------------------------------------------------------------------
  // Step 3: apply filters and build combined matches list.
  // routing_decision rows appear first (preferred); routing.jsonl rows follow.
  // -----------------------------------------------------------------------
  const matches = [];

  // Filter and normalise routing_decision rows
  for (const ev of allDecisions) {
    if (orchId !== null && ev.orchestration_id !== orchId) continue;
    if (taskId !== null && (ev.task_id || null) !== taskId) continue;
    if (agentType !== null && ev.agent_type !== agentType) continue;
    matches.push(normalizeDecisionEntry(ev, !ev.synthesised));
  }

  // Filter and normalise routing.jsonl entries (legacy PM decomposition log)
  for (const entry of allRoutingEntries) {
    if (orchId !== null && entry.orchestration_id !== orchId) continue;
    if (taskId !== null && entry.task_id !== taskId) continue;
    if (agentType !== null && entry.agent_type !== agentType) continue;
    const normalized = normalizeEntry(entry);
    normalized.merged = false;
    normalized.synthesised = false;
    matches.push(normalized);
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

  // R-FPX (v2.1.12): apply field projection when `fields` is requested.
  // Omitting `fields` returns the full legacy response (backward compat).
  const fieldSpec = parseFields(input && input.fields);
  if (fieldSpec && fieldSpec.error) {
    return toolError('routing_lookup: ' + fieldSpec.error);
  }
  if (fieldSpec !== null) {
    result.matches = projectArray(result.matches, fieldSpec);
  }

  return toolSuccess(result);
}

module.exports = {
  definition,
  handle,
};
