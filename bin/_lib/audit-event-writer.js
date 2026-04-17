'use strict';

/**
 * Shared audit event writer used by bin/audit-event.js and bin/audit-team-event.js.
 *
 * Reads a JSON payload from stdin, resolves the active orchestration_id from
 * `.orchestray/audit/current-orchestration.json`, constructs an event object,
 * and appends a line to `.orchestray/audit/events.jsonl`.
 *
 * Never throws: any error is swallowed and the script exits 0 with
 * `{ continue: true }`. Hook scripts MUST NOT block Claude Code on audit
 * failures.
 *
 * @param {Object} options
 * @param {string} options.type - The event `type` field (e.g. 'agent_start').
 * @param {string} [options.mode] - Optional `mode` field to set on the event
 *   (e.g. 'teams'). Omitted if not provided.
 * @param {(payload: Object) => Object} options.extraFieldsPicker - Function
 *   that returns script-specific fields to merge into the event. Receives the
 *   parsed stdin payload.
 * @param {(payload: Object, ctx: { orchestrationId: string, baseTimestamp: string }) => Array<Object>} [options.additionalEventsPicker]
 *   v2.0.21 — Optional function returning an array of *additional* fully-formed
 *   events to append after the primary event. Used to emit `dynamic_agent_spawn`
 *   alongside `agent_start` when the spawned agent is non-canonical. Each event
 *   should include its own `type`; `timestamp` and `orchestration_id` fields are
 *   provided in `ctx` for convenience but the picker may override them.
 */
const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./atomic-append');
const { resolveSafeCwd } = require('./resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./orchestration-state');
const { MAX_INPUT_BYTES } = require('./constants');

function writeAuditEvent({ type, mode, extraFieldsPicker, additionalEventsPicker }) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input);
      const cwd = resolveSafeCwd(event.cwd);
      const auditDir = path.join(cwd, '.orchestray', 'audit');

      // Read orchestration_id from current-orchestration.json if available
      let orchestrationId = 'unknown';
      try {
        const orchFile = getCurrentOrchestrationFile(cwd);
        const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
        if (orchData.orchestration_id) {
          orchestrationId = orchData.orchestration_id;
        }
      } catch (_e) {
        // File missing or unreadable -- use default
      }

      // Ensure audit directory exists
      fs.mkdirSync(auditDir, { recursive: true });
      try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening; chmod may fail on exotic filesystems */ }

      // Construct audit event — base fields first, then script-specific extras.
      const auditEvent = {
        timestamp: new Date().toISOString(),
        type,
        orchestration_id: orchestrationId,
      };
      if (mode !== undefined) {
        auditEvent.mode = mode;
      }
      const extras = (typeof extraFieldsPicker === 'function')
        ? extraFieldsPicker(event) || {}
        : {};
      Object.assign(auditEvent, extras);

      // Append the primary event to events.jsonl
      const eventsPath = path.join(auditDir, 'events.jsonl');
      atomicAppendJsonl(eventsPath, auditEvent);

      // v2.0.21: optionally append additional events (e.g. dynamic_agent_spawn).
      if (typeof additionalEventsPicker === 'function') {
        try {
          const extra = additionalEventsPicker(event, {
            orchestrationId,
            baseTimestamp: auditEvent.timestamp,
          });
          if (Array.isArray(extra)) {
            for (const ev of extra) {
              if (ev && typeof ev === 'object') {
                atomicAppendJsonl(eventsPath, ev);
              }
            }
          }
        } catch (_e) {
          process.stderr.write('[orchestray] audit-event-writer: additionalEventsPicker threw — skipping additional events: ' + String(_e) + '\n');
        }
      }
    } catch (_e) {
      // Never block the hook due to audit failure
    }

    // Always allow the hook to continue
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = writeAuditEvent;
