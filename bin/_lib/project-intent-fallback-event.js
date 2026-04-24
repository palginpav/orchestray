'use strict';

/**
 * project-intent-fallback-event.js — R-RCPT-V2 (v2.1.13)
 *
 * Emits a `project_intent_fallback_no_agent` audit event to
 * `.orchestray/audit/events.jsonl` whenever the PM tries to spawn the
 * project-intent agent but the agent is unavailable (e.g., pre-restart after
 * upgrade, agent file missing, spawn throws), so the PM falls back to the
 * in-process mechanical generator in `bin/_lib/project-intent.js`.
 *
 * Contract (R-RCPT-V2 AC):
 *   - Canonical `type` + `timestamp` fields (v2.1.13 event-naming spec).
 *   - `orchestration_id` included when available (null otherwise).
 *   - Non-throwing: any I/O error is swallowed and the caller continues.
 *
 * Mirrors the pattern in `bin/_lib/kill-switch-event.js` (single purpose,
 * fail-open, reads current orchestration id if present).
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./atomic-append');
const { getCurrentOrchestrationFile } = require('./orchestration-state');

/**
 * Emit a `project_intent_fallback_no_agent` event.
 *
 * @param {object} opts
 * @param {string}  opts.cwd              Absolute path to the project root.
 * @param {string}  [opts.reason]         Short enum-ish string describing
 *                                        why the agent was unavailable
 *                                        (e.g., `agent_file_missing`,
 *                                        `spawn_error`, `restart_required`).
 * @param {object}  [opts.detail]         Optional structured detail blob.
 *                                        Must be JSON-serializable.
 * @returns {boolean} true if the event was successfully appended, false otherwise.
 */
function emitProjectIntentFallbackEvent({ cwd, reason = null, detail = null } = {}) {
  try {
    if (!cwd || typeof cwd !== 'string') return false;

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    const eventsPath = path.join(auditDir, 'events.jsonl');

    // Read current orchestration_id (fail-open: null if unavailable).
    let orchestrationId = null;
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData.orchestration_id && orchData.orchestration_id !== 'unknown') {
        orchestrationId = orchData.orchestration_id;
      }
    } catch (_e) {
      // Missing or unreadable current-orchestration.json — keep null.
    }

    // Ensure audit dir exists so the atomic append can open the file.
    try {
      fs.mkdirSync(auditDir, { recursive: true });
    } catch (_e) { /* best-effort */ }

    const event = {
      timestamp: new Date().toISOString(),
      type: 'project_intent_fallback_no_agent',
      orchestration_id: orchestrationId,
      reason: reason || null,
      detail: detail && typeof detail === 'object' ? detail : null,
      source: 'pm-step-2.7a',
    };

    atomicAppendJsonl(eventsPath, event);
    return true;
  } catch (err) {
    // Fail-open: warn but never throw — the PM must continue to the fallback path.
    try {
      process.stderr.write(
        '[orchestray] project-intent fallback event emission failed: ' +
        (err && err.message ? err.message : String(err)) + '\n'
      );
    } catch (_e) { /* ignore */ }
    return false;
  }
}

module.exports = { emitProjectIntentFallbackEvent };
