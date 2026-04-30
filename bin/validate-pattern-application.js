#!/usr/bin/env node
'use strict';

/**
 * validate-pattern-application.js — SubagentStop hook (v2.2.15 P1-07).
 *
 * After a `pattern_find` MCP tool call in the spawn's audit window, the agent
 * MUST have called either `pattern_record_application` OR
 * `pattern_record_skip_reason`. Warn v2.2.15 (3-spawn ramp); hard exit 2
 * thereafter.
 *
 * Kill switch: ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED=1
 *
 * Events emitted:
 *   pattern_application_gate_warn    — ramp window open, exit 0
 *   pattern_application_gate_blocked — ramp exhausted, exit 2
 *
 * Contract:
 *   - exit 0 when no pattern_find in audit window, or ack found.
 *   - exit 0 within ramp window.
 *   - exit 2 when ramp exhausted and ack missing.
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

const SCHEMA_VERSION = 1;
const DEFAULT_RAMP_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrchId(cwd) {
  try {
    const f = getCurrentOrchestrationFile(cwd);
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return parsed.orchestration_id || parsed.id || null;
  } catch (_e) { return null; }
}

function counterFilePath(cwd, orchId) {
  return path.join(cwd, '.orchestray', 'state', `pattern-application-warn-count-${orchId}.txt`);
}

function bumpWarnCount(cwd, orchId, threshold) {
  const filePath = counterFilePath(cwd, orchId);
  let count = 0;
  try {
    const n = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    if (Number.isFinite(n) && n >= 0) count = n;
  } catch (_e) { /* fresh counter */ }
  count += 1;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, String(count) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (_e) { /* best-effort */ }
  return { count, threshold };
}

function emitGateEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

/**
 * Scan audit events.jsonl for pattern_find and ack calls.
 * Returns { hasPatternFind, hasAck }.
 * Scans last 500 events (spawn window approximation).
 */
function scanAuditWindow(cwd) {
  try {
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return { hasPatternFind: false, hasAck: false };

    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const window = lines.slice(Math.max(0, lines.length - 500));

    let hasPatternFind = false;
    let hasAck = false;

    for (const line of window) {
      try {
        const evt = JSON.parse(line);
        const toolName = evt.tool_name || evt.mcp_tool || evt.type || '';
        if (typeof toolName === 'string') {
          if (toolName.includes('pattern_find')) hasPatternFind = true;
          if (toolName.includes('pattern_record_application') ||
              toolName.includes('pattern_record_skip_reason')) {
            hasAck = true;
          }
        }
        // Also check for mcp_checkpoint_recorded events
        if (evt.type === 'mcp_checkpoint_recorded') {
          const slug = evt.tool || evt.slug || '';
          if (typeof slug === 'string') {
            if (slug.includes('pattern_find')) hasPatternFind = true;
            if (slug.includes('pattern_record_application') ||
                slug.includes('pattern_record_skip_reason')) {
              hasAck = true;
            }
          }
        }
      } catch (_) { /* skip malformed */ }
    }

    return { hasPatternFind, hasAck };
  } catch (_e) {
    return { hasPatternFind: false, hasAck: false };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    // Kill switch: full bypass (checked after reading stdin to avoid SIGPIPE on spawnSync)
    if (process.env.ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED === '1') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only activate on SubagentStop
    const hookEvent = event.hook_event_name || '';
    if (hookEvent !== 'SubagentStop') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    const role = (
      event.subagent_type || event.agent_type || event.agent_role ||
      (event.tool_input && event.tool_input.subagent_type) || 'unknown'
    ).toLowerCase().trim();

    // Scan audit window for pattern_find and ack
    const { hasPatternFind, hasAck } = scanAuditWindow(cwd);

    // No pattern_find in window — nothing to check
    if (!hasPatternFind) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Ack found — pass
    if (hasAck) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // pattern_find without ack — apply ramp
    const orchId = resolveOrchId(cwd);
    const threshold = (() => {
      const n = parseInt(process.env.ORCHESTRAY_PATTERN_APPLICATION_RAMP_THRESHOLD, 10);
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RAMP_THRESHOLD;
    })();

    if (!orchId) {
      emitGateEvent(cwd, {
        version:          SCHEMA_VERSION,
        schema_version:   SCHEMA_VERSION,
        type:             'pattern_application_gate_warn',
        agent_role:       role,
        ramp_count:       null,
        ramp_threshold:   threshold,
        ramp_state:       'no_orchestration',
        orchestration_id: null,
      });
      process.stderr.write(
        '[orchestray] validate-pattern-application: WARN — pattern_find called but no ' +
        'pattern_record_application or pattern_record_skip_reason found. ' +
        'No orchestration context. Kill switch: ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const { count } = bumpWarnCount(cwd, orchId, threshold);

    if (count <= threshold) {
      emitGateEvent(cwd, {
        version:          SCHEMA_VERSION,
        schema_version:   SCHEMA_VERSION,
        type:             'pattern_application_gate_warn',
        agent_role:       role,
        ramp_count:       count,
        ramp_threshold:   threshold,
        ramp_state:       'warn',
        orchestration_id: orchId,
      });
      process.stderr.write(
        '[orchestray] validate-pattern-application: WARN (' + count + '/' + threshold + ') — ' +
        'pattern_find called but ack missing (pattern_record_application or ' +
        'pattern_record_skip_reason). Will block after ramp exhausted. ' +
        'Kill switch: ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Ramp exhausted — block
    emitGateEvent(cwd, {
      version:          SCHEMA_VERSION,
      schema_version:   SCHEMA_VERSION,
      type:             'pattern_application_gate_blocked',
      agent_role:       role,
      ramp_count:       count,
      ramp_threshold:   threshold,
      ramp_state:       'blocked',
      orchestration_id: orchId,
    });
    process.stderr.write(
      '[orchestray] validate-pattern-application: BLOCKED — pattern_find was called but ' +
      'no pattern_record_application or pattern_record_skip_reason follows. ' +
      'After calling pattern_find, always call pattern_record_application (if applied) ' +
      'or pattern_record_skip_reason (if skipped). ' +
      'Kill switch: ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'pattern_application_gate_blocked:missing_ack',
    }));
    process.exit(2);
  });
}

module.exports = {
  scanAuditWindow,
};

if (require.main === module) {
  main();
}
