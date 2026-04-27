#!/usr/bin/env node
'use strict';

/**
 * gate-telemetry.js — UserPromptSubmit hook (R-TGATE + R-GATE, v2.1.14).
 *
 * Reads .orchestray/config.json and emits a `feature_gate_eval` audit event
 * recording which feature gates are currently enabled (truthy/falsy) for the
 * upcoming PM turn. Provides the observability signal needed to correlate
 * feature-gate state with orchestration outcomes.
 *
 * R-GATE quarantine overlay (v2.1.14):
 *   Gates listed in config.feature_demand_gate.quarantine_candidates are moved
 *   from gates_true to gates_false even if their config value is true (opt-in
 *   immediate quarantine). The eval_source field changes to
 *   'config_with_quarantine_overlay' when any override applies.
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

const { writeEvent }                  = require('./_lib/audit-event-writer');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const {
  getQuarantineCandidates,
  readSessionWakes,
  readPinnedWakes,
  GATE_SLUG_TO_CONFIG_KEY,
} = require('./_lib/effective-gate-state');

// ---------------------------------------------------------------------------
// Known gate keys to evaluate.
//
// Two sources contribute to the gate set surfaced in `feature_gate_eval`:
//   1. Legacy top-level `enable_*` keys (and a small explicit list of other
//      top-level boolean flags such as `auto_review` / `auto_document`). These
//      are preserved verbatim so existing dashboards keep working.
//   2. Namespaced boolean leaves discovered by walking the parsed config tree.
//      A leaf qualifies as a gate when its final path segment matches
//      `enabled`, `*_enabled`, or `*_disabled` (the polarity is carried by the
//      gate name — see `event_schemas.full_load_disabled`). The walker emits
//      the dotted path (e.g., `caching.block_z.enabled`).
//
// The walker is intentionally discovery-based: any future namespaced gate that
// follows the `<namespace>...enabled` / `<namespace>...disabled` convention is
// surfaced automatically without code changes here. (R-NSGATE, v2.2.1.)
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
  // P3-W10 (v2.2.3): added for symmetry with the other top-level enable_* gates
  // flipped default-on. Surfaces enable_checkpoints in feature_gate_eval even
  // when absent from config (matches enable_disagreement_protocol /
  // enable_outcome_tracking semantics).
  'enable_checkpoints',
];

// Top-level keys whose subtrees are NOT walked for namespaced gates.
// Rationale: these branches hold infra/telemetry knobs unrelated to feature
// gating, or are folded into a legacy alias elsewhere.
//   - `telemetry`: tier2 kill-switch lives at telemetry.tier2_tracking.enabled
//     and is read directly above; surfacing it as a gate would be circular.
//   - `agent_teams`: `agent_teams.enabled` is folded into the legacy
//     `enable_agent_teams` key below; the walker must not double-emit it.
const NAMESPACE_WALK_BLOCKLIST = new Set([
  'telemetry',
  'agent_teams',
]);

// Path-segment matcher: which leaf names look like a feature gate?
function isGateLeafName(name) {
  if (typeof name !== 'string') return false;
  if (name === 'enabled') return true;
  if (name.endsWith('_enabled')) return true;
  if (name.endsWith('_disabled')) return true;
  return false;
}

/**
 * Recursively walk a parsed config object and collect dotted paths for every
 * boolean leaf whose final segment looks like a gate (see `isGateLeafName`).
 *
 * Returns an array of `{ path: string, value: boolean }` records.
 * Non-boolean leaves are skipped (gates are strictly boolean).
 *
 * Top-level branches listed in NAMESPACE_WALK_BLOCKLIST are not descended into.
 *
 * @param {object} config
 * @returns {Array<{path: string, value: boolean}>}
 */
function walkNamespacedGates(config) {
  const results = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return results;

  function visit(node, segments) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const key of Object.keys(node)) {
      const val = node[key];
      const nextSegments = segments.concat(key);
      if (typeof val === 'boolean') {
        if (isGateLeafName(key) && nextSegments.length >= 2) {
          results.push({ path: nextSegments.join('.'), value: val });
        }
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        visit(val, nextSegments);
      }
    }
  }

  for (const topKey of Object.keys(config)) {
    if (NAMESPACE_WALK_BLOCKLIST.has(topKey)) continue;
    const branch = config[topKey];
    if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
      visit(branch, [topKey]);
    }
  }
  return results;
}

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

    // R-AT-FLAG (v2.1.16): the legacy `enable_agent_teams` is renamed to
    // `agent_teams.enabled`. For telemetry, fold the new namespaced flag into
    // the legacy key so gate evaluation downstream stays back-compat. The new
    // namespace wins when both are present. (Done before the walker runs so
    // `agent_teams.enabled` is not double-emitted as a namespaced gate; the
    // walker also blocklists `agent_teams` for the same reason.)
    if (
      config.agent_teams &&
      typeof config.agent_teams === 'object' &&
      !Array.isArray(config.agent_teams) &&
      typeof config.agent_teams.enabled === 'boolean'
    ) {
      config = Object.assign({}, config, { enable_agent_teams: config.agent_teams.enabled });
    }

    // Collect all gate keys: explicit list + any top-level key starting with
    // 'enable_' (legacy surface) + namespaced gates discovered via walker.
    // (R-NSGATE, v2.2.1.) The walker output is added as dotted paths.
    const legacyGateKeys = new Set(EXPLICIT_GATE_KEYS);
    for (const key of Object.keys(config)) {
      if (key.startsWith('enable_')) {
        legacyGateKeys.add(key);
      }
    }

    // Map dotted gate path → boolean value (its config-snapshot value).
    const namespacedGates = walkNamespacedGates(config);
    const namespacedGateValues = new Map();
    for (const { path: gatePath, value } of namespacedGates) {
      namespacedGateValues.set(gatePath, value);
    }

    // R-GATE: load quarantine overlay state.
    // quarantineCandidates: slugs from config.feature_demand_gate.quarantine_candidates
    // For legacy gates the slug → config-key mapping comes from
    // GATE_SLUG_TO_CONFIG_KEY. For namespaced gates the candidate string IS the
    // dotted gate path (e.g., "output_shape.enabled"); this lets ops quarantine
    // a namespaced gate the same way they already quarantine a legacy slug.
    const quarantinedLegacyKeys      = new Set();
    const quarantinedNamespacedPaths = new Set();
    let hasQuarantineOverlay = false;
    try {
      const candidates = getQuarantineCandidates(config);
      // Wakes apply to the slug name as-stored. We honour wake → no-quarantine
      // for both legacy slugs and dotted-path entries (a dotted path can also
      // be woken if ops put it into the wake file).
      const sessionWakes = readSessionWakes(cwd);
      const pinnedWakes  = readPinnedWakes(cwd);
      for (const slug of candidates) {
        if (sessionWakes.has(slug) || pinnedWakes.has(slug)) continue;
        // Legacy slug?
        const legacyConfigKey = GATE_SLUG_TO_CONFIG_KEY[slug];
        if (legacyConfigKey) {
          quarantinedLegacyKeys.add(legacyConfigKey);
          hasQuarantineOverlay = true;
          continue;
        }
        // Otherwise interpret as a namespaced dotted path. We don't require
        // the path to currently exist in the config — quarantining a future
        // gate is fine; it just has no effect until the gate appears.
        if (typeof slug === 'string' && slug.includes('.')) {
          quarantinedNamespacedPaths.add(slug);
          if (namespacedGateValues.has(slug)) {
            hasQuarantineOverlay = true;
          }
        }
      }
    } catch (_e) {}

    // Evaluate each gate: truthy value → gates_true, falsy → gates_false.
    const gates_true  = [];
    const gates_false = [];

    // Legacy gates (top-level `enable_*` and the explicit list).
    for (const key of legacyGateKeys) {
      // R-GATE overlay: quarantine candidates are treated as false regardless of config.
      if (quarantinedLegacyKeys.has(key)) {
        gates_false.push(key);
        continue;
      }
      const val = config[key];
      // A gate is "true" if the value is exactly boolean true, or a truthy non-boolean.
      // Gates explicitly set to false, 0, null, undefined, "" are considered false.
      if (val === true || (val !== false && val !== null && val !== undefined && val !== 0 && val !== '' && val !== 'false')) {
        if (val === true || (typeof val !== 'boolean' && Boolean(val))) {
          gates_true.push(key);
        } else {
          gates_false.push(key);
        }
      } else {
        gates_false.push(key);
      }
    }

    // Namespaced gates discovered by the walker. The gate name carries its own
    // polarity (e.g., `event_schemas.full_load_disabled: true` → gates_true);
    // we report the boolean value verbatim, no inversion.
    for (const { path: gatePath, value } of namespacedGates) {
      if (quarantinedNamespacedPaths.has(gatePath)) {
        gates_false.push(gatePath);
        continue;
      }
      if (value === true) {
        gates_true.push(gatePath);
      } else {
        gates_false.push(gatePath);
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
      eval_source:      hasQuarantineOverlay ? 'config_with_quarantine_overlay' : 'config_snapshot',
    };

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    try {
      fs.mkdirSync(auditDir, { recursive: true });
    } catch (_e) {
      // Directory creation failure is non-fatal.
    }

    writeEvent(auditEvent, { cwd });
  } catch (_e) {
    // Fail-open: any unexpected error — exit 0 with no stderr spam.
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// Export for testing.
module.exports = {
  EXPLICIT_GATE_KEYS,
  NAMESPACE_WALK_BLOCKLIST,
  isGateLeafName,
  walkNamespacedGates,
  handle,
};
