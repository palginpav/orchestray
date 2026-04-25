#!/usr/bin/env node
'use strict';

/**
 * gate-telemetry.js — UserPromptSubmit hook (R-TGATE, v2.1.14).
 *
 * Reads .orchestray/config.json and emits a `feature_gate_eval` audit event
 * recording which feature gates are currently enabled (truthy/falsy) for the
 * upcoming PM turn. Provides the observability signal needed to correlate
 * feature-gate state with orchestration outcomes.
 *
 * Kill switches (any one present → no-op, exit 0):
 *   - process.env.ORCHESTRAY_METRICS_DISABLED === '1'
 *   - process.env.ORCHESTRAY_DISABLE_TIER2_TELEMETRY === '1'
 *   - config.telemetry.tier2_tracking.enabled === false
 *
 * Fail-open contract: any error → exit 0, never blocks the PM turn.
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs   = require('fs');
const path = require('path');

const { atomicAppendJsonl }           = require('./_lib/atomic-append');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Known gate keys to evaluate (all top-level boolean/truthy config keys whose
// name starts with 'enable_' or are in the explicit list below).
// ---------------------------------------------------------------------------

const EXPLICIT_GATE_KEYS = [
  'enable_drift_sentinel',
  'enable_consequence_forecast',
  'enable_replay_analysis',
  'enable_disagreement_protocol',
  'enable_personas',
  'enable_introspection',
  'enable_backpressure',
  'enable_outcome_tracking',
  'enable_repo_map',
  'enable_visual_review',
  'enable_threads',
  'enable_agent_teams',
  'auto_review',
  'auto_document',
];

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE);
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] gate-telemetry: stdin exceeded limit; skipping\n');
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    handle(JSON.parse(input || '{}'));
  } catch (_e) {
    // Fail-open: malformed stdin
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    // Kill-switch: skip emission when metrics are disabled.
    if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }
    // Kill-switch: tier2 telemetry specifically disabled.
    if (process.env.ORCHESTRAY_DISABLE_TIER2_TELEMETRY === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const cwd = resolveSafeCwd(event && event.cwd);

    // Load config — required to evaluate gates. Fail gracefully if absent.
    let config = {};
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    } catch (_e) {
      // Config absent or unreadable — evaluate against empty config (all gates false)
    }

    if (typeof config !== 'object' || Array.isArray(config)) config = {};

    // Kill-switch: check config.telemetry.tier2_tracking.enabled
    if (
      config.telemetry &&
      typeof config.telemetry === 'object' &&
      config.telemetry.tier2_tracking &&
      typeof config.telemetry.tier2_tracking === 'object' &&
      config.telemetry.tier2_tracking.enabled === false
    ) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Collect all gate keys: explicit list + any top-level key starting with 'enable_'
    const allGateKeys = new Set(EXPLICIT_GATE_KEYS);
    for (const key of Object.keys(config)) {
      if (key.startsWith('enable_')) {
        allGateKeys.add(key);
      }
    }

    // Evaluate each gate: truthy value → gates_true, falsy → gates_false.
    const gates_true  = [];
    const gates_false = [];
    for (const key of allGateKeys) {
      const val = config[key];
      // A gate is "true" if the value is exactly boolean true, or a truthy non-boolean.
      // Gates explicitly set to false, 0, null, undefined, "" are considered false.
      if (val === true || (val !== false && val !== null && val !== undefined && val !== 0 && val !== '' && val !== 'false')) {
        // For boolean config keys, only trust boolean true to be "enabled"
        // (non-boolean values like 'on'/'off' strings should be truthy/falsy per JS)
        if (val === true || (typeof val !== 'boolean' && Boolean(val))) {
          gates_true.push(key);
        } else {
          gates_false.push(key);
        }
      } else {
        gates_false.push(key);
      }
    }

    // Resolve orchestration_id
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) {
        orchestrationId = orchData.orchestration_id;
      }
    } catch (_e) {
      // File missing or unreadable — keep 'unknown'
    }

    const auditEvent = {
      version:          1,
      type:             'feature_gate_eval',
      timestamp:        new Date().toISOString(),
      orchestration_id: orchestrationId,
      gates_true:       gates_true.sort(),
      gates_false:      gates_false.sort(),
      eval_source:      'config_snapshot',
    };

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    try {
      fs.mkdirSync(auditDir, { recursive: true });
    } catch (_e) {
      // Directory creation failure is non-fatal.
    }

    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), auditEvent);
  } catch (_e) {
    // Fail-open: any unexpected error — exit 0 with no stderr spam.
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// Export for testing.
module.exports = { EXPLICIT_GATE_KEYS, handle };
