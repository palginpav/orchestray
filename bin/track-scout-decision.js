#!/usr/bin/env node
'use strict';

/**
 * track-scout-decision.js — PreToolUse:Read hook (v2.2.3 P2 W1 + P3 W4).
 *
 * Phase 2 (W1) shipped this hook as observe-only: emit `scout_decision`
 * with `decision='inline_read_observed'` whenever the PM (or a named
 * subagent) was about to inline-Read a file >= scout_min_bytes. No
 * blocking, no enforcement — pure telemetry.
 *
 * Phase 3 (W4) upgrades the hook with three enforcement modes
 * (`haiku_routing.scout_enforcement`):
 *
 *   - "off"   — observe-only (P2 W1 behavior). Emits `inline_read_observed`.
 *   - "warn"  — emits `scout_spawn_required` but DOES NOT block. Default
 *               for v2.2.3; surfaces the missed-scout signal without
 *               breaking workflows. Promotes to "block" in v2.2.4 after
 *               the 14-day measurement window.
 *   - "block" — emits `inline_read_forced` AND blocks the Read by writing
 *               `{continue:false, reason:"..."}` and exiting 2. The
 *               stderr message tells the PM to spawn `haiku-scout` and
 *               cites the per-session bypass env var.
 *
 * Exempt paths (the EXEMPT_PATHS allowlist) are LEGITIMATE inline reads
 * — orchestration state files, config, tier-2 PM reference, the current
 * orchestration's KB artifacts. Reads matching an exempt entry skip
 * enforcement in all modes and emit `decision='exempt_path_observed'`
 * for visibility.
 *
 * Kill switches (any one → no enforcement, observe-only fallback):
 *   - process.env.ORCHESTRAY_SCOUT_BYPASS === '1' (per-session override)
 *   - config.haiku_routing.scout_enforcement === 'off'
 *
 * Telemetry kill switches (any one → no event, hook still proceeds):
 *   - process.env.ORCHESTRAY_DISABLE_SCOUT_TELEMETRY === '1'
 *   - process.env.ORCHESTRAY_METRICS_DISABLED === '1'
 *   - config.haiku_routing.enabled === false (whole feature off)
 *   - config.haiku_routing.scout_telemetry_enabled === false (event only)
 *
 * Input:  JSON on stdin (Claude Code PreToolUse:Read hook payload).
 *         Shape: { tool_name: 'Read', tool_input: { file_path }, cwd, ... }
 * Output: JSON on stdout — `{continue:true}` (allow) or
 *         `{continue:false, reason:"..."}` (block).
 * Exit:   0 on allow, 2 on block.
 */

const fs   = require('fs');
const path = require('path');

const { writeEvent }                  = require('./_lib/audit-event-writer');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });
const DEFAULT_SCOUT_MIN_BYTES = 12288;

// Default enforcement mode for v2.2.3. Surfaces the signal without
// breaking workflows. v2.2.4 promotes to 'block' after measurement.
const DEFAULT_ENFORCEMENT_MODE = 'warn';
const VALID_MODES = new Set(['off', 'warn', 'block']);

/**
 * Static exempt-path patterns (regex). Matched against the cwd-relative
 * file path. These are LEGITIMATE inline reads:
 *
 *   - Orchestration state (`.orchestray/state/*`)
 *   - Config file
 *   - Tier-2 PM reference (loaded lazily by Section Loading Protocol)
 *
 * The current-orchestration KB artifact pattern
 * (`.orchestray/kb/artifacts/<orch-id>-*`) is dynamic and resolved per
 * call — see `isExemptPath()`.
 */
const STATIC_EXEMPT_PATTERNS = [
  /^\.orchestray\/state\//,
  /^\.orchestray\/config\.json$/,
  /^agents\/pm-reference\//,
];

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
      runMain(JSON.parse(input || '{}'));
    } catch (_e) {
      // Malformed stdin — fail-open.
      process.stdout.write(CONTINUE_RESPONSE);
      process.exit(0);
    }
  });
}

/**
 * Top-level dispatch in the require.main path. Calls handle() for the
 * decision and emits the right stdout/exit pair.
 *
 * @param {object} event
 */
function runMain(event) {
  let outcome;
  try {
    outcome = handle(event);
  } catch (_e) {
    // Defence in depth — fail-open on any unexpected throw.
    outcome = { action: 'allow' };
  }
  if (outcome && outcome.action === 'block') {
    if (outcome.stderrMsg) process.stderr.write(outcome.stderrMsg);
    process.stdout.write(JSON.stringify({
      continue: false,
      reason:   outcome.reason || 'scout_spawn_required',
    }));
    process.exit(2);
  }
  process.stdout.write(CONTINUE_RESPONSE);
  process.exit(0);
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
 * Resolve enforcement mode from config + env.
 *
 * Priority:
 *   1. ORCHESTRAY_SCOUT_BYPASS=1 → 'off' (per-session override)
 *   2. config.haiku_routing.scout_enforcement (off|warn|block)
 *   3. DEFAULT_ENFORCEMENT_MODE ('warn')
 *
 * Invalid config values fall back to the default.
 *
 * @param {object} config
 * @returns {'off'|'warn'|'block'}
 */
function resolveEnforcementMode(config) {
  if (process.env.ORCHESTRAY_SCOUT_BYPASS === '1') return 'off';
  const block = config && config.haiku_routing;
  if (block && typeof block === 'object') {
    const v = block.scout_enforcement;
    if (typeof v === 'string' && VALID_MODES.has(v)) return v;
  }
  return DEFAULT_ENFORCEMENT_MODE;
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

/**
 * Decide whether a relative path is exempt from scout enforcement. Static
 * patterns cover state files, config, tier-2 reference. The dynamic
 * pattern allows the current orchestration's KB artifacts
 * (`.orchestray/kb/artifacts/<orch-id>-*`) to be read inline since those
 * are typically the same orchestration's own outputs.
 *
 * @param {string} relPath        cwd-relative path (forward slashes)
 * @param {string} orchestrationId resolved active orchestration id
 * @returns {boolean}
 */
function isExemptPath(relPath, orchestrationId) {
  if (!relPath || typeof relPath !== 'string') return false;
  for (const re of STATIC_EXEMPT_PATTERNS) {
    if (re.test(relPath)) return true;
  }
  // Dynamic: current orchestration's KB artifacts.
  if (orchestrationId && orchestrationId !== 'unknown') {
    const orchKbPrefix =
      '.orchestray/kb/artifacts/' + orchestrationId + '-';
    if (relPath.startsWith(orchKbPrefix)) return true;
  }
  return false;
}

/**
 * Build the stderr message presented to the PM when a Read is blocked.
 *
 * @param {string} relPath
 * @param {number} fileBytes
 * @param {number} scoutMinBytes
 * @returns {string}
 */
function buildBlockMessage(relPath, fileBytes, scoutMinBytes) {
  return (
    '[orchestray] track-scout-decision: PM is reading ' + relPath +
    ' (' + fileBytes + ' bytes) >= scout_min_bytes (' + scoutMinBytes +
    '). Per Section 23, spawn haiku-scout instead. ' +
    'To override for this session, set ORCHESTRAY_SCOUT_BYPASS=1.\n'
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Decide what action to take for the given hook payload.
 *
 * Returns:
 *   - { action: 'allow' }                              — proceed with Read
 *   - { action: 'block', reason, stderrMsg }           — block Read, exit 2
 *
 * Always logs telemetry when applicable (subject to kill switches). Never
 * throws.
 *
 * @param {object} event
 * @returns {{action: 'allow'|'block', reason?: string, stderrMsg?: string}}
 */
function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);
    const config = loadConfig(cwd);

    // Telemetry kill switches still apply, but we keep going so we can
    // honor enforcement (block mode must work even if telemetry is muted —
    // bypass is a separate env var).
    const telemetryDisabled = isTelemetryDisabled(config);

    const toolInput = (event && event.tool_input) || {};
    const filePath = toolInput.file_path || toolInput.path || '';
    if (!filePath) return { action: 'allow' };

    const fileBytes = statBytes(cwd, filePath);
    // Missing file or stat error — let Read produce its own error.
    if (fileBytes === null) return { action: 'allow' };

    const scoutMinBytes = resolveScoutMinBytes(config);
    const relPath = relativizeFilePath(cwd, filePath);
    const orchestrationId = resolveOrchestrationId(cwd);
    const exempt = isExemptPath(relPath, orchestrationId);

    // Below threshold AND not exempt: silent. (We don't emit
    // exempt_path_observed for sub-threshold reads either — keeps the
    // stream sized like P2 baseline.)
    if (fileBytes < scoutMinBytes) return { action: 'allow' };

    const callerRole = resolveCallerRole(event);

    // Exempt paths bypass enforcement in all modes; emit a dedicated
    // decision value so analytics can distinguish "didn't enforce because
    // exempt" from "enforced and allowed".
    if (exempt) {
      if (!telemetryDisabled) {
        emitDecision({
          cwd, orchestrationId, relPath, fileBytes,
          scoutMinBytes, callerRole,
          decision: 'exempt_path_observed',
        });
      }
      return { action: 'allow' };
    }

    const mode = resolveEnforcementMode(config);

    if (mode === 'off') {
      // Legacy P2 W1 observe-only behavior.
      if (!telemetryDisabled) {
        emitDecision({
          cwd, orchestrationId, relPath, fileBytes,
          scoutMinBytes, callerRole,
          decision: 'inline_read_observed',
        });
      }
      return { action: 'allow' };
    }

    if (mode === 'warn') {
      // Surface the missed-scout signal but don't block.
      if (!telemetryDisabled) {
        emitDecision({
          cwd, orchestrationId, relPath, fileBytes,
          scoutMinBytes, callerRole,
          decision: 'scout_spawn_required',
        });
      }
      return { action: 'allow' };
    }

    // mode === 'block'
    if (!telemetryDisabled) {
      emitDecision({
        cwd, orchestrationId, relPath, fileBytes,
        scoutMinBytes, callerRole,
        decision: 'inline_read_forced',
      });
    }
    return {
      action:    'block',
      reason:    'scout_spawn_required:' + relPath,
      stderrMsg: buildBlockMessage(relPath, fileBytes, scoutMinBytes),
    };
  } catch (_e) {
    // Defence in depth — outer fail-open.
    return { action: 'allow' };
  }
}

/**
 * Write a `scout_decision` event via the central audit gateway. Never
 * throws — telemetry must not break the hook.
 *
 * @param {object} args
 */
function emitDecision(args) {
  try {
    writeEvent({
      version:          1,
      timestamp:        new Date().toISOString(),
      type:             'scout_decision',
      orchestration_id: args.orchestrationId,
      file_path:        args.relPath,
      file_bytes:       args.fileBytes,
      scout_min_bytes:  args.scoutMinBytes,
      decision:         args.decision,
      caller_role:      args.callerRole,
    }, { cwd: args.cwd });
  } catch (_e) {
    // swallow — telemetry must never break the hook.
  }
}

module.exports = {
  handle,
  loadConfig,
  resolveScoutMinBytes,
  resolveEnforcementMode,
  isTelemetryDisabled,
  isExemptPath,
  statBytes,
  resolveCallerRole,
  resolveOrchestrationId,
  relativizeFilePath,
  buildBlockMessage,
  DEFAULT_SCOUT_MIN_BYTES,
  DEFAULT_ENFORCEMENT_MODE,
  STATIC_EXEMPT_PATTERNS,
};
