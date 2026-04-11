'use strict';

// 2013-W7-kill-switch
/**
 * Kill-switch event emitter helper.
 *
 * Emits `kill_switch_activated` or `kill_switch_deactivated` events to
 * `.orchestray/audit/events.jsonl` whenever the config skill flips
 * `mcp_enforcement.global_kill_switch`.
 *
 * Design contract: D6 + OQ-T2-4 (2013-W7).
 *
 * Fail-open: any I/O error is caught and written to stderr. The caller
 * (the config skill write path) must proceed regardless of whether the
 * event write succeeded.
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./atomic-append');
const { getCurrentOrchestrationFile } = require('./orchestration-state');

/**
 * Emit a kill_switch_activated or kill_switch_deactivated event if the value
 * actually changed.
 *
 * @param {object} opts
 * @param {string}  opts.cwd           - Absolute path to the project root.
 * @param {boolean} opts.previousValue - Value BEFORE the config write.
 * @param {boolean} opts.newValue      - Value AFTER the config write.
 * @param {string|null} [opts.reason]  - Optional user-supplied reason string.
 * @returns {boolean} true if an event was emitted, false if skipped (no-op flip or error).
 */
function emitKillSwitchEvent({ cwd, previousValue, newValue, reason = null }) {
  // Only emit on a real value change.
  if (previousValue === newValue) {
    return false;
  }

  try {
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

    const eventType = newValue === true ? 'kill_switch_activated' : 'kill_switch_deactivated';

    const event = {
      timestamp: new Date().toISOString(),
      type: eventType,
      orchestration_id: orchestrationId,
      reason: reason || null,
      source: 'config-skill',
      previous_value: previousValue,
      new_value: newValue,
    };

    atomicAppendJsonl(eventsPath, event);
    return true;
  } catch (err) {
    // Fail-open: warn but never throw — the config write must proceed.
    process.stderr.write(
      '[orchestray] kill-switch event emission failed: ' +
      (err && err.message ? err.message : String(err)) + '\n'
    );
    return false;
  }
}

module.exports = { emitKillSwitchEvent };
