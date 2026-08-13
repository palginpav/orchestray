'use strict';

/**
 * spawn-task-id.js — single extractor for the task_id embedded in a spawn.
 *
 * Lifted verbatim from the logic at `gate-agent-spawn.js:922-935` (the W4b
 * "leading description token" heuristic) so there is exactly one
 * implementation instead of two independently-drifting copies (the second
 * copy lived at gate-agent-spawn.js:677-680 as `spawnTaskIdForResolve`).
 *
 * Claude Code's Agent() wire format currently drops unknown toolInput
 * fields, so `toolInput.task_id` is almost always null in practice. The
 * fallback parses the leading token of `description` when it matches the
 * PM's task-id convention (`TASK-ID <rest>`, e.g. "DEV-1 ...", "A1 ...").
 *
 * Pure function, no I/O. Never throws.
 *
 * @param {object} toolInput - The PreToolUse `tool_input` payload.
 * @returns {string|null}
 */
function extractSpawnTaskId(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  let spawnTaskId = toolInput.task_id || null;
  if (!spawnTaskId) {
    const descRaw = toolInput.description ||
      (typeof toolInput.prompt === 'string' ? toolInput.prompt.substring(0, 80) : '') || '';
    if (typeof descRaw === 'string') {
      const m = descRaw.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\s/);
      if (m) spawnTaskId = m[1];
    }
  }
  return spawnTaskId || null;
}

/**
 * resolveTaskIdViaRouting — mechanical (not convention-dependent) task_id
 * resolution. W5 (v2.3.28): extractSpawnTaskId() only finds a task_id when
 * the PM's description happens to lead with a SCREAMING-CASE token — that
 * convention is rarely followed in practice, so the registry's task_id
 * column was empty for the overwhelming majority of spawns even though
 * gate-agent-spawn.js was, at the very same moment, successfully resolving
 * the correct routing.jsonl row (by task_id when available, else by
 * (agent_type, description) match) to run its model-tier check.
 *
 * This reuses that same routing.jsonl match (read-only, no auto-seed side
 * effects — gate-agent-spawn.js runs first in the PreToolUse chain and
 * already auto-seeds on miss) so the *authoritative* task_id from the
 * matched routing row is used instead of depending on description wording.
 * Falls back to extractSpawnTaskId()'s heuristic if no routing entry can
 * be resolved (e.g. pre-decomposition spawn, routing.jsonl absent).
 *
 * Fail-open: any error (missing lib, unreadable file, etc.) falls back to
 * the heuristic. Never throws.
 *
 * @param {string} cwd - Project root (result of resolveSafeCwd)
 * @param {object} toolInput - The PreToolUse `tool_input` payload
 * @param {string|null} [orchestrationId] - Current orchestration_id, if known
 * @returns {string|null}
 */
function resolveTaskIdViaRouting(cwd, toolInput, orchestrationId) {
  const heuristicTaskId = extractSpawnTaskId(toolInput);
  if (!toolInput || typeof toolInput !== 'object' || !cwd) return heuristicTaskId;

  try {
    const { readRoutingEntries, findRoutingEntry } = require('./routing-lookup');
    const agentType = toolInput.subagent_type || toolInput.agent_type || '';
    const descRaw = toolInput.description ||
      (typeof toolInput.prompt === 'string' ? toolInput.prompt.substring(0, 80) : '') || '';

    let entry = null;

    if (heuristicTaskId) {
      let matches = readRoutingEntries(cwd).filter(e =>
        e && e.task_id === heuristicTaskId && e.agent_type === agentType
      );
      if (orchestrationId) matches = matches.filter(e => e.orchestration_id === orchestrationId);
      if (matches.length) {
        matches.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        entry = matches[0];
      }
    }

    if (!entry) {
      const lookupDesc = (descRaw || '').substring(0, 80).trim();
      if (orchestrationId) {
        if (lookupDesc) {
          const orchEntries = readRoutingEntries(cwd).filter(e =>
            e && e.orchestration_id === orchestrationId && e.agent_type === agentType
          );
          const descMatches = orchEntries.filter(e => {
            const entryDesc = (e.description || '').trim();
            if (!entryDesc) return false;
            if (entryDesc === lookupDesc) return true;
            if (entryDesc.startsWith(lookupDesc + ' ')) return true;
            if (lookupDesc.startsWith(entryDesc + ' ')) return true;
            return false;
          });
          if (descMatches.length) {
            descMatches.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
            entry = descMatches[0];
          }
        }
      } else {
        entry = findRoutingEntry(cwd, agentType, descRaw);
      }
    }

    if (entry && entry.task_id) return entry.task_id;
  } catch (_e) {
    // Fail-open — fall back to the heuristic below.
  }

  return heuristicTaskId;
}

/**
 * resolveTaskIdFromRoster — task_id fallback for SubagentStart/SubagentStop,
 * where no `description` is available to drive resolveTaskIdViaRouting().
 *
 * At `running`/`completed` time the only correlation signal to a pending
 * `registered` row is `matchPendingSpawn`'s FIFO-within-5s + agent_type
 * filter (agent-registry.js). That filter silently no-ops whenever
 * `event.agent_type` is a roster/task label rather than the canonical
 * agent_type recorded at pre-spawn — true for every `name:`d spawn, since
 * a roster label never equals "developer"/"reviewer"/etc. — so under
 * concurrent same-role spawns the FIFO pick can miss (or mismatch) the
 * right pending row.
 *
 * `deriveRosterName(agentId)` is a separate, unrelated-to-timing signal
 * (verified 211/211 on named starts, design §3.2) — and this project's own
 * spawns commonly name: their roster entry after the task_id itself (e.g.
 * "W7", "V2"). When that roster label is confirmed to be a live task_id in
 * routing.jsonl for this orchestration, it is returned unchanged; otherwise
 * null. Confirmation-only — never invents an id the PM didn't record.
 *
 * Fail-open: any error (missing lib, unreadable file) -> null. Never throws.
 *
 * @param {string} cwd
 * @param {string|null} rosterName - result of deriveRosterName(agentId)
 * @param {string|null} orchestrationId
 * @returns {string|null}
 */
function resolveTaskIdFromRoster(cwd, rosterName, orchestrationId) {
  if (!rosterName || !cwd || !orchestrationId) return null;
  try {
    const { findRoutingEntryByTaskId } = require('./routing-lookup');
    const entry = findRoutingEntryByTaskId(cwd, orchestrationId, rosterName);
    return entry ? rosterName : null;
  } catch (_e) {
    return null;
  }
}

module.exports = { extractSpawnTaskId, resolveTaskIdViaRouting, resolveTaskIdFromRoster };
