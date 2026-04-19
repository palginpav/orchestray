#!/usr/bin/env node
'use strict';

/**
 * status-render.js — Auto-learning status block for /orchestray:status.
 *
 * Emits a structured, deterministic block describing:
 *   - Global kill-switch state + source (env | config | off)
 *   - Circuit-breaker state (OK | TRIPPED) + optional reset hint
 *   - Number of staged proposals in .orchestray/proposed-patterns/
 *   - Kill-switch env var value
 *
 * CLI: node bin/learn-commands/status-render.js [--project-root=PATH]
 *
 * Output is intentionally machine-readable (plain text lines) so tests can
 * assert specific substrings without parsing structured JSON.
 *
 * Design §7 W10 / §2.B/C observability contract.
 * v2.1.6 — W10 observability surfaces.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { loadAutoLearningConfig }     = require('../_lib/config-schema');
const { isTripped }                  = require('../_lib/learning-circuit-breaker');
const { listProposed }               = require('../_lib/proposed-patterns');
const { EXTRACTION_BREAKER_SCOPE }   = require('../_lib/auto-learning-scopes');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the project root from CLI args or process.cwd().
 * @param {string[]} argv
 * @returns {string}
 */
function _resolveProjectRoot(argv) {
  for (const arg of argv.slice(2)) {
    const m = /^--project-root=(.+)$/.exec(arg);
    if (m) return path.resolve(m[1]);
  }
  return process.cwd();
}

/**
 * Determine kill-switch source tag.
 *
 * Priority:
 *   1. Env var ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1 → "(env: ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1)"
 *   2. Config global_kill_switch: true → "(config)"
 *   3. Otherwise → "(off)"
 *
 * @param {boolean} killSwitch - from loadAutoLearningConfig
 * @returns {string}
 */
function _killSwitchSource(killSwitch) {
  const envVal = process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
  if (envVal === '1') {
    return '(env: ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1)';
  }
  if (killSwitch) {
    return '(config)';
  }
  return '(off)';
}

/**
 * Render the auto-learning status block.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] - Project root (default: process.cwd())
 * @returns {string} Multi-line status block.
 */
function renderAutoLearningStatus(options) {
  const projectRoot = (options && options.projectRoot) || process.cwd();

  // Load config — fail-closed on error (all-off defaults).
  let alConfig;
  try {
    alConfig = loadAutoLearningConfig(projectRoot);
  } catch (_e) {
    alConfig = {
      global_kill_switch: false,
      roi_aggregator: { enabled: false },
      kb_refs_sweep: { enabled: false },
    };
  }

  const killSwitch = Boolean(alConfig.global_kill_switch);
  // W8-04: describe the kill switch state directly, not a composite "is anything active?".
  // "Kill switch: OFF" means extraction CAN run if sub-features are enabled.
  // "Kill switch: ON"  means all auto-learning is disabled regardless of sub-features.
  const killState  = killSwitch ? 'Kill switch: ON —  all auto-learning disabled' : 'Kill switch: OFF';
  const killSrc    = _killSwitchSource(killSwitch);

  // Circuit breaker — W8-10: use shared scope constant so this matches what
  // post-orchestration-extract.js writes (was 'extraction', now 'auto_extract').
  let breakerState = 'OK';
  let breakerNote  = '';
  try {
    if (isTripped({ scope: EXTRACTION_BREAKER_SCOPE, cwd: projectRoot })) {
      breakerState = 'TRIPPED';
      breakerNote  = ' — run /orchestray:config repair to reset';
    }
  } catch (_e) {
    // Fail-open: breaker unreadable → report OK.
  }

  // Proposed-patterns count.
  let proposedCount = 0;
  try {
    const proposals = listProposed(projectRoot);
    proposedCount = Array.isArray(proposals) ? proposals.length : 0;
  } catch (_e) {
    // Fail-open.
  }

  // Env var display.
  const envVal = process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
  let envDisplay;
  if (envVal === undefined || envVal === null || envVal === '') {
    envDisplay = 'not set';
  } else if (envVal === '1') {
    envDisplay = "set to '1' (kill switch ACTIVE)";
  } else {
    envDisplay = `set to '${envVal}'`;
  }

  // W8-04: killState now describes the kill switch directly (e.g. "Kill switch: OFF").
  // killSrc is "(off)" when not active, "(config)" or "(env: ...)" when active.
  // For the OFF case we omit the redundant "(off)" suffix — it reads "Kill switch: OFF"
  // rather than "Kill switch: OFF (off)".
  const killSwitchLine = killSwitch
    ? `${killState} ${killSrc}`
    : `${killState} ${killSrc}`.replace(' (off)', '');

  const lines = [
    '### Auto-Learning Status',
    '',
    killSwitchLine,
    `Circuit breaker: ${breakerState}${breakerNote}`,
    `Proposals staged: ${proposedCount}`,
    `Kill-switch env var: ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH — ${envDisplay}`,
  ];

  if (proposedCount > 0) {
    lines.push('');
    lines.push(`Review ${proposedCount} staged proposal(s): /orchestray:learn list --proposed`);
  }

  return lines.join('\n');
}

module.exports = { renderAutoLearningStatus };

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const projectRoot = _resolveProjectRoot(process.argv);
  try {
    process.stdout.write(renderAutoLearningStatus({ projectRoot }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write('[status-render] error: ' + String(err.message || err) + '\n');
    process.exit(1);
  }
}
