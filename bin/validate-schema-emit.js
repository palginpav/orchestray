#!/usr/bin/env node
'use strict';

/**
 * validate-schema-emit.js — PreToolUse emit-event validator (R-SHDW, v2.1.14).
 *
 * The AUTHORITY for event correctness. Validates event payloads against the
 * full agents/pm-reference/event-schemas.md before they hit events.jsonl.
 *
 * Design: "fails closed" — invalid events are blocked (exit 2). The shadow
 * (inject-schema-shadow.js) is a hint; this validator is the gate.
 *
 * Wired as a PreToolUse hook on any tool whose input contains an audit event
 * payload (currently: checked at audit-event-writer.js pre-write for all
 * hook-initiated writes, since emit_event is not an MCP tool in this codebase).
 *
 * When called as a PreToolUse hook:
 *   - Reads JSON payload from stdin (PreToolUse hook format).
 *   - Extracts tool_input from the payload.
 *   - Validates event type + required fields.
 *   - Exit 2 + stderr on invalid (blocks the tool call).
 *   - Exit 0 + allow on valid.
 *
 * When called as a library (validateAuditEvent):
 *   - Validates and either returns errors or throws on block-level violations.
 *
 * Schema cache: the full event-schemas.md is parsed once per process and cached.
 * Subsequent calls in the same process are zero-IO.
 *
 * Input (PreToolUse mode): JSON on stdin
 * Output: hookSpecificOutput with permissionDecision allow/block
 */

const path = require('path');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { validateEvent }     = require('./_lib/schema-emit-validator');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { isSentinelActive } = require('./_lib/load-schema-shadow');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function allowResponse() {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });
}

function blockResponse(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'block',
      permissionDecisionReason: reason,
    },
  });
}

// ---------------------------------------------------------------------------
// Audit event for validation blocks
// ---------------------------------------------------------------------------

function emitValidationBlockEvent(cwd, eventType, errors) {
  try {
    const auditDir   = path.join(cwd, '.orchestray', 'audit');
    const eventsFile = path.join(auditDir, 'events.jsonl');
    fs.mkdirSync(auditDir, { recursive: true });

    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) {}

    atomicAppendJsonl(eventsFile, {
      timestamp: new Date().toISOString(),
      type: 'schema_shadow_validation_block',
      orchestration_id: orchestrationId,
      version: 1,
      blocked_event_type: eventType || 'unknown',
      errors,
      schema_ref: 'agents/pm-reference/event-schemas.md',
    });
  } catch (_e) {
    // Fail-open: audit failure doesn't un-block the validated event
  }
}

// ---------------------------------------------------------------------------
// Stdin reader (hook mode)
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(allowResponse() + '\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[validate-schema-emit] stdin exceeded limit; allowing\n');
    process.stdout.write(allowResponse() + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    handle(JSON.parse(input || '{}'));
  } catch (_e) {
    // Fail-open on malformed stdin
    process.stdout.write(allowResponse() + '\n');
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Main hook handler
// ---------------------------------------------------------------------------

function handle(hookPayload) {
  try {
    const cwd = resolveSafeCwd(hookPayload && hookPayload.cwd);

    // Extract the audit event payload from tool_input
    const toolInput = (hookPayload && hookPayload.tool_input) || {};

    // -----------------------------------------------------------------------
    // R-SHDW-EMIT path-based defence (v2.1.15)
    //
    // Edit/MultiEdit on `.orchestray/audit/events.jsonl` is *always* blocked.
    // Direct edits bypass the writeEvent gateway and break audit invariants.
    // -----------------------------------------------------------------------
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
    if (filePath && /\.orchestray[\\/]+audit[\\/]+events\.jsonl$/.test(filePath)) {
      // Honour the same circuit / kill-switch semantics as the gateway: if
      // shadow validation is disabled, allow the edit (fail-open).
      const envDisabled = process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW === '1';
      if (envDisabled || isSentinelActive(cwd)) {
        process.stderr.write(
          '[validate-schema-emit] events.jsonl edit allowed — schema shadow disabled\n'
        );
        process.stdout.write(allowResponse() + '\n');
        process.exit(0);
        return;
      }
      const reason =
        'Direct edits to events.jsonl are forbidden — emit via writeEvent gateway ' +
        '(bin/_lib/audit-event-writer.js). Path-based defence; see ' +
        'agents/pm-reference/event-schemas.md.';
      process.stderr.write('[validate-schema-emit] BLOCKED Edit on ' + filePath + '\n');
      process.stdout.write(blockResponse(reason) + '\n');
      process.exit(2);
      return;
    }

    // The tool_input should have the event payload directly, or nested under 'event'
    const eventPayload = toolInput.event || toolInput;

    // If there's no 'type' field this is not an audit event call — allow
    if (!eventPayload || (!eventPayload.type && !eventPayload.event)) {
      process.stdout.write(allowResponse() + '\n');
      process.exit(0);
      return;
    }

    const result = validateEvent(cwd, eventPayload);
    const eventType = result.event_type;

    if (!result.valid) {
      const errMsg = [
        '[validate-schema-emit] BLOCKED event type "' + (eventType || 'unknown') + '"',
        'Errors:',
        ...result.errors.map(e => '  - ' + e),
        'Schema ref: agents/pm-reference/event-schemas.md',
      ].join('\n');

      process.stderr.write(errMsg + '\n');

      // Emit validation block audit event
      emitValidationBlockEvent(cwd, eventType, result.errors);

      process.stdout.write(blockResponse(
        'Invalid audit event "' + (eventType || 'unknown') + '": ' + result.errors.join('; ')
      ) + '\n');
      process.exit(2);
      return;
    }

    process.stdout.write(allowResponse() + '\n');
    process.exit(0);
  } catch (_e) {
    // Fail-open: any unexpected error allows the event
    process.stderr.write('[validate-schema-emit] unexpected error: ' + _e.message + '\n');
    process.stdout.write(allowResponse() + '\n');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Library API: pre-write check for audit-event-writer.js
// ---------------------------------------------------------------------------

/**
 * Validate an event payload before writing to events.jsonl.
 * Called from bin/_lib/audit-event-writer.js as a pre-write gate.
 *
 * @param {string} cwd - Project root.
 * @param {object} eventPayload - The event being written.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAuditEvent(cwd, eventPayload) {
  return validateEvent(cwd, eventPayload);
}

module.exports = { validateAuditEvent };
