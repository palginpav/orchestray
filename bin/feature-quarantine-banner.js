#!/usr/bin/env node
'use strict';

/**
 * feature-quarantine-banner.js — SessionStart hook (R-GATE, v2.1.14).
 *
 * When any feature is quarantined (via opt-in quarantine_candidates), prints a
 * one-line stderr banner:
 *   [orchestray] Quarantined this session: <slug1>, <slug2>. Re-enable with `/orchestray:feature wake <name>`.
 *
 * Session-scoped: uses a /tmp sentinel file to emit the banner only once per session.
 * Sentinel path: /tmp/orchestray-quarantine-banner-<session_id>.lock
 *
 * If no features are quarantined (empty quarantine_candidates), no banner is emitted.
 *
 * Kill switches:
 *   - process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1'
 *   - config.feature_demand_gate.enabled === false
 *
 * Fail-open contract: any error → exit 0, never blocks.
 *
 * Input:  JSON on stdin (Claude Code SessionStart hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const {
  getQuarantineCandidates,
  readSessionWakes,
  readPinnedWakes,
}                         = require('./_lib/effective-gate-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

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

    // Load config
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

    const candidates = getQuarantineCandidates(config);
    if (candidates.length === 0) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Filter out woken gates — those are not actually quarantined this session.
    const sessionWakes = readSessionWakes(cwd);
    const pinnedWakes  = readPinnedWakes(cwd);
    const quarantined  = candidates.filter(slug => !sessionWakes.has(slug) && !pinnedWakes.has(slug));

    if (quarantined.length === 0) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Session-scoped lock: emit banner only once per session.
    // Use session_id from event if available, else a hash of pid+starttime.
    const sessionId = (event && event.session_id)
      ? String(event.session_id).replace(/[^a-zA-Z0-9_-]/g, '')
      : String(process.pid);
    const lockPath = path.join(os.tmpdir(), `orchestray-quarantine-banner-${sessionId}.lock`);

    if (fs.existsSync(lockPath)) {
      // Already emitted this session.
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Write lock file.
    try {
      fs.writeFileSync(lockPath, new Date().toISOString(), 'utf8');
    } catch (_e) {
      // Lock write failed — still emit the banner (fail-open)
    }

    // Emit banner to stderr.
    const slugList = quarantined.join(', ');
    process.stderr.write(
      `[orchestray] Quarantined this session: ${slugList}. Re-enable with \`/orchestray:feature wake <name>\`.\n`
    );
  } catch (_e) {
    // Fail-open
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// Export for testing.
module.exports = { handle };
