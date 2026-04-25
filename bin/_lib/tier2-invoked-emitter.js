'use strict';

/**
 * tier2-invoked-emitter.js — shared helper for emitting `tier2_invoked` audit events.
 *
 * Called by protocol entry-point scripts (inject-archetype-advisory.js and others)
 * when a Tier-2 feature protocol fires its primary action. Provides the measurement
 * signal for R-TGATE observability (v2.1.14).
 *
 * Kill switches (both must be absent for emission to proceed):
 *   - process.env.ORCHESTRAY_METRICS_DISABLED === '1'
 *   - process.env.ORCHESTRAY_DISABLE_TIER2_TELEMETRY === '1'
 *   - config.telemetry.tier2_tracking.enabled === false (if config is loadable)
 *
 * Fail-open contract: any error is swallowed. This helper NEVER throws.
 *
 * @param {object} options
 * @param {string} options.cwd           - Project root (absolute path, already resolved)
 * @param {string} options.protocol      - Protocol slug (e.g. 'archetype_cache')
 * @param {string} options.trigger_signal - Free-text reason the protocol fired
 */

const fs   = require('fs');
const path = require('path');

const { atomicAppendJsonl }           = require('./atomic-append');
const { getCurrentOrchestrationFile } = require('./orchestration-state');

/**
 * Valid protocol slugs for the `tier2_invoked` event.
 * Used for documentation only — callers are not blocked for unknown slugs
 * (fail-open, to avoid breaking protocol scripts on future additions).
 */
const KNOWN_PROTOCOLS = [
  'drift_sentinel',
  'consequence_forecast',
  'pattern_extraction',
  'replay_analysis',
  'auto_documenter',
  'disagreement_protocol',
  'cognitive_backpressure',
  'archetype_cache',
];

// Exported for testing / introspection.
module.exports.KNOWN_PROTOCOLS = KNOWN_PROTOCOLS;

/**
 * Emit a `tier2_invoked` event to `.orchestray/audit/events.jsonl`.
 *
 * @param {object} options
 * @param {string} options.cwd            - Project root directory (absolute path).
 * @param {string} options.protocol       - Protocol slug (see KNOWN_PROTOCOLS).
 * @param {string} options.trigger_signal - Human-readable reason the protocol fired.
 * @returns {void}
 */
function emitTier2Invoked({ cwd, protocol, trigger_signal }) {
  try {
    // Kill-switch: metrics globally disabled
    if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') return;
    // Kill-switch: tier2 telemetry specifically disabled
    if (process.env.ORCHESTRAY_DISABLE_TIER2_TELEMETRY === '1') return;

    // Kill-switch: check config file (fail-open on any config error)
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.telemetry &&
        typeof parsed.telemetry === 'object' &&
        parsed.telemetry.tier2_tracking &&
        typeof parsed.telemetry.tier2_tracking === 'object' &&
        parsed.telemetry.tier2_tracking.enabled === false
      ) {
        return;
      }
    } catch (_configErr) {
      // Config absent or unreadable — proceed (fail-open)
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
      // File missing or unreadable — use 'unknown'
    }

    const auditEvent = {
      version:          1,
      type:             'tier2_invoked',
      timestamp:        new Date().toISOString(),
      orchestration_id: orchestrationId,
      protocol:         String(protocol || ''),
      trigger_signal:   String(trigger_signal || ''),
    };

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    try {
      fs.mkdirSync(auditDir, { recursive: true });
    } catch (_e) {
      // Directory creation failure is non-fatal
    }

    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), auditEvent);
  } catch (_e) {
    // Fail-open: any unexpected error is silently swallowed
  }
}

module.exports.emitTier2Invoked = emitTier2Invoked;
