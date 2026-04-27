#!/usr/bin/env node
'use strict';

/**
 * track-scout-decision.js — PreToolUse:Read hook (v2.2.3 P2 W1).
 *
 * Phase 2 instrumentation for PM Section 23 inline-vs-scout decision rule.
 * v2.2.0 defined a four-class taxonomy and a `scout_min_bytes` threshold
 * (default 12288): when the PM is about to Read a file >= threshold, the
 * decision rule says spawn `haiku-scout` instead of reading inline. v2.2.0
 * shipped the rule as PROSE only — no enforcement, no telemetry. W3 audit
 * found 0 scout invocations across 8 post-v2.2.0 orchestrations: the rule
 * lives in the prompt and is invisible to validation.
 *
 * This hook is the OBSERVE-ONLY half. On PreToolUse:Read it:
 *   1. Reads tool_input.file_path from the hook payload.
 *   2. fs.statSync the path. If absent or unreadable, exits 0 silently
 *      (let Read return its own error).
 *   3. Loads .orchestray/config.json for haiku_routing.scout_min_bytes
 *      (default 12288).
 *   4. If size >= threshold, emits `scout_decision` with
 *      decision='inline_read_observed'.
 *   5. If size < threshold, exits 0 with no event (avoid noise).
 *   6. NEVER blocks the read. Always exits 0.
 *
 * Enforcement (block large-file Reads, force scout spawn) is deferred to
 * v2.2.4. This hook produces the telemetry needed to verify P0-1 fix and
 * tune the threshold (P3-5 A5 trigger window opens once spawn_count > 0).
 *
 * Kill switches (any one → no-op, exit 0):
 *   - process.env.ORCHESTRAY_DISABLE_SCOUT_TELEMETRY === '1'
 *   - process.env.ORCHESTRAY_METRICS_DISABLED === '1'
 *   - config.haiku_routing.enabled === false (the whole feature disabled)
 *   - config.haiku_routing.scout_telemetry_enabled === false (just this event)
 *
 * Input:  JSON on stdin (Claude Code PreToolUse:Read hook payload).
 *         Shape: { tool_name: 'Read', tool_input: { file_path }, cwd, ... }
 * Output: JSON on stdout ({ continue: true }), always.
 * Exit:   always 0 — observe-only, never blocks.
 */

const fs   = require('fs');
const path = require('path');

const { writeEvent }                  = require('./_lib/audit-event-writer');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });
const DEFAULT_SCOUT_MIN_BYTES = 12288;

// ---------------------------------------------------------------------------
// Stdin reader (require.main guard so unit tests can require() this module)
// ---------------------------------------------------------------------------

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(CONTINUE_RESPONSE);
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      handle(JSON.parse(input || '{}'));
    } catch (_e) {
      // Malformed stdin — fail-open.
      process.stdout.write(CONTINUE_RESPONSE);
      process.exit(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load .orchestray/config.json. Returns plain object on success, {} on any
 * failure (missing, malformed, unreadable). Never throws.
 *
 * @param {string} cwd
 * @returns {object}
 */
function loadConfig(cwd) {
  try {
    const p = path.join(cwd, '.orchestray', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    return {};
  }
}

/**
 * Resolve scout_min_bytes from config with the documented default.
 * @param {object} config
 * @returns {number} positive integer
 */
function resolveScoutMinBytes(config) {
  const block = config && config.haiku_routing;
  if (block && typeof block === 'object') {
    const v = block.scout_min_bytes;
    if (Number.isInteger(v) && v > 0) return v;
  }
  return DEFAULT_SCOUT_MIN_BYTES;
}

/**
 * True when telemetry should be skipped entirely. Honors env kill switches
 * and the two config gates.
 *
 * @param {object} config
 * @returns {boolean}
 */
function isTelemetryDisabled(config) {
  if (process.env.ORCHESTRAY_DISABLE_SCOUT_TELEMETRY === '1') return true;
  if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') return true;
  const block = config && config.haiku_routing;
  if (block && typeof block === 'object') {
    if (block.enabled === false) return true;
    if (block.scout_telemetry_enabled === false) return true;
  }
  return false;
}

/**
 * Read file size at the supplied path. Resolves relative paths against cwd.
 * Returns null when the file does not exist or stat fails.
 *
 * @param {string} cwd
 * @param {string} filePath
 * @returns {number|null}
 */
function statBytes(cwd, filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  let abs = filePath;
  if (!path.isAbsolute(abs)) {
    abs = path.join(cwd, filePath);
  }
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return st.size;
  } catch (_e) {
    return null;
  }
}

/**
 * Extract caller_role from the hook payload. Claude Code may carry an
 * `agent_type` (or `subagent_type`) field on the envelope when the Read
 * comes from a subagent. When absent, we default to 'pm' since the PM is
 * the canonical caller of large in-prose Reads. Use 'unknown' only when an
 * explicit non-string value is supplied.
 *
 * @param {object} event
 * @returns {string}
 */
function resolveCallerRole(event) {
  if (!event || typeof event !== 'object') return 'pm';
  const candidates = [event.agent_type, event.subagent_type, event.agent_role];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return 'pm';
}

/**
 * Read active orchestration_id from .orchestray/audit/current-orchestration.json.
 * Returns 'unknown' on any failure (consistent with audit-event-writer's
 * autofill semantics).
 *
 * @param {string} cwd
 * @returns {string}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData && orchData.orchestration_id) return orchData.orchestration_id;
  } catch (_e) { /* fail-open */ }
  return 'unknown';
}

/**
 * Compute repo-relative path for the event payload, mirroring
 * emit-tier2-load.js. Falls back to the raw input when normalization fails.
 *
 * @param {string} cwd
 * @param {string} filePath
 * @returns {string}
 */
function relativizeFilePath(cwd, filePath) {
  if (typeof filePath !== 'string') return '';
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedCwd = String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedCwd && normalized.startsWith(normalizedCwd + '/')) {
    return normalized.slice(normalizedCwd.length + 1);
  }
  return normalized.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);
    const config = loadConfig(cwd);

    if (isTelemetryDisabled(config)) return;

    const toolInput = (event && event.tool_input) || {};
    const filePath = toolInput.file_path || toolInput.path || '';
    if (!filePath) return;

    const fileBytes = statBytes(cwd, filePath);
    // Missing file or stat error — let Read produce its own error.
    if (fileBytes === null) return;

    const scoutMinBytes = resolveScoutMinBytes(config);
    // Below threshold — no event (avoid noise on every small Read).
    if (fileBytes < scoutMinBytes) return;

    // Threshold crossed and PM (or named subagent) is reading inline.
    const auditEvent = {
      version:          1,
      timestamp:        new Date().toISOString(),
      type:             'scout_decision',
      orchestration_id: resolveOrchestrationId(cwd),
      file_path:        relativizeFilePath(cwd, filePath),
      file_bytes:       fileBytes,
      scout_min_bytes:  scoutMinBytes,
      decision:         'inline_read_observed',
      caller_role:      resolveCallerRole(event),
    };

    try {
      writeEvent(auditEvent, { cwd });
    } catch (_e) {
      // Telemetry must never break the hook.
    }
  } catch (_e) {
    // Defence in depth — outer fail-open.
  } finally {
    // Single write site — exactly one CONTINUE_RESPONSE per hook invocation.
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

module.exports = {
  handle,
  loadConfig,
  resolveScoutMinBytes,
  isTelemetryDisabled,
  statBytes,
  resolveCallerRole,
  resolveOrchestrationId,
  relativizeFilePath,
  DEFAULT_SCOUT_MIN_BYTES,
};
