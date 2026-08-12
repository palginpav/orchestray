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

module.exports = { extractSpawnTaskId };
