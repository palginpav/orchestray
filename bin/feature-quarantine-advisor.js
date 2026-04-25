#!/usr/bin/env node
'use strict';

/**
 * feature-quarantine-advisor.js — UserPromptSubmit hook (R-GATE, v2.1.14).
 *
 * Shadow-mode demand advisor. Computes quarantine-eligible gates and emits
 * `feature_quarantine_candidate` audit events for any gate that WOULD be
 * quarantined if the 14-day observation window had elapsed (or has elapsed).
 *
 * This hook takes NO gate action — it is purely advisory (shadow mode).
 * Opt-in quarantine is handled by gate-telemetry.js which reads quarantine_candidates.
 *
 * Rate-limit: emits at most ONE `feature_quarantine_candidate` event per gate
 * per 24 hours, tracked via .orchestray/state/feature-quarantine-advisor-cursor.json.
 *
 * Kill switches (any one → no-op, exit 0):
 *   - process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1'
 *   - config.feature_demand_gate.enabled === false
 *
 * Fail-open contract: any error → exit 0, never blocks the PM turn.
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { computeDemandReport } = require('./_lib/feature-demand-tracker');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

const CURSOR_FILE    = path.join('.orchestray', 'state', 'feature-quarantine-advisor-cursor.json');
const RATE_LIMIT_MS  = 24 * 60 * 60 * 1000; // 24 hours

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE);
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] feature-quarantine-advisor: stdin exceeded limit; skipping\n');
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    handle(JSON.parse(input || '{}'));
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  }
});

function handle(event) {
  try {
    // Kill switch: env var
    if (process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const cwd = resolveSafeCwd(event && event.cwd);

    // Load config for kill switch check
    let config = {};
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    } catch (_e) {}
    if (typeof config !== 'object' || Array.isArray(config)) config = {};

    // Kill switch: config.feature_demand_gate.enabled === false
    if (
      config.feature_demand_gate &&
      typeof config.feature_demand_gate === 'object' &&
      config.feature_demand_gate.enabled === false
    ) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Get orchestration_id
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) {}

    // Compute demand report
    const report = computeDemandReport(cwd);
    const eligibleSlugs = Object.keys(report).filter(slug => report[slug].quarantine_eligible);

    if (eligibleSlugs.length === 0) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Load cursor for rate-limiting
    const cursorPath = path.join(cwd, CURSOR_FILE);
    let cursor = {};
    try {
      cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) || {};
    } catch (_e) {}
    if (typeof cursor !== 'object' || Array.isArray(cursor)) cursor = {};

    const now = Date.now();
    let cursorDirty = false;
    const auditDir = path.join(cwd, '.orchestray', 'audit');

    for (const slug of eligibleSlugs) {
      const lastEmitted = cursor[slug] ? Date.parse(cursor[slug]) : 0;
      if (!isNaN(lastEmitted) && (now - lastEmitted) < RATE_LIMIT_MS) {
        continue; // Rate-limited: already emitted within 24h
      }

      const entry = report[slug];
      const auditEvent = {
        version:              1,
        type:                 'feature_quarantine_candidate',
        timestamp:            new Date().toISOString(),
        orchestration_id:     orchestrationId,
        gate_slug:            slug,
        eval_true_count_30d:  entry.gate_eval_true_count,
        invoked_count_30d:    entry.tier2_invoked_count,
        first_eval_at:        entry.first_eval_at,
        eligibility_reason:   'eval_true_count >= 5 AND invoked_count === 0 AND observation_window >= 14d',
      };

      try {
        fs.mkdirSync(auditDir, { recursive: true });
      } catch (_e) {}
      writeEvent(auditEvent, { cwd });

      cursor[slug] = new Date().toISOString();
      cursorDirty = true;
    }

    // Persist cursor if updated
    if (cursorDirty) {
      try {
        fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
        fs.writeFileSync(cursorPath, JSON.stringify(cursor, null, 2) + '\n', 'utf8');
      } catch (_e) {}
    }
  } catch (_e) {
    // Fail-open: any unexpected error
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// Export for testing.
module.exports = { handle, CURSOR_FILE, RATE_LIMIT_MS };
