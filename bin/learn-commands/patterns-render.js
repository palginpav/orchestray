#!/usr/bin/env node
'use strict';

/**
 * patterns-render.js — Auto-learning banner for /orchestray:patterns.
 *
 * Emits a one-line summary banner and optional footer hints for the
 * patterns dashboard, covering:
 *   - Auto-learning ON/OFF state + source
 *   - Circuit-breaker state
 *   - Number of staged proposals
 *   - Number of pending calibration suggestions
 *
 * CLI: node bin/learn-commands/patterns-render.js [--project-root=PATH]
 *
 * Design §7 W10 / §2.B observability contract / UX-02.
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
 * @param {boolean} killSwitch - from loadAutoLearningConfig
 * @returns {string} "(config)" | "(env: ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1)" | "(off)"
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
 * Count calibration suggestion files in .orchestray/kb/artifacts/.
 *
 * @param {string} projectRoot
 * @returns {number}
 */
function _countCalibrationSuggestions(projectRoot) {
  const artifactsDir = path.join(projectRoot, '.orchestray', 'kb', 'artifacts');
  try {
    const entries = fs.readdirSync(artifactsDir);
    return entries.filter(e => e.startsWith('calibration-suggestion-') && e.endsWith('.md')).length;
  } catch (_e) {
    return 0;
  }
}

/**
 * Render the auto-learning banner for the patterns dashboard.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] - Project root (default: process.cwd())
 * @returns {string} Multi-line banner block.
 */
function renderPatternsBanner(options) {
  const projectRoot = (options && options.projectRoot) || process.cwd();

  // Load config — fail-closed on error (all-off defaults).
  let alConfig;
  try {
    alConfig = loadAutoLearningConfig(projectRoot);
  } catch (_e) {
    alConfig = { global_kill_switch: false };
  }

  const killSwitch = Boolean(alConfig.global_kill_switch);
  // CHG-F02: align with status-render.js framing — describe the kill switch state
  // ("Kill switch: ON/OFF"), not the auto-learning state ("Auto-learning: ON/OFF").
  // This matches the W8-04 post-UX-review standard in status-render.js:94.
  const killState  = killSwitch ? 'Kill switch: ON —  all auto-learning disabled' : 'Kill switch: OFF';
  const killSrc    = _killSwitchSource(killSwitch);

  // Circuit breaker — W8-10: use shared scope constant so this matches what
  // post-orchestration-extract.js writes (was 'extraction', now 'auto_extract').
  let breakerState = 'OK';
  try {
    if (isTripped({ scope: EXTRACTION_BREAKER_SCOPE, cwd: projectRoot })) {
      breakerState = 'TRIPPED';
    }
  } catch (_e) {
    // Fail-open.
  }

  // Proposal count.
  let proposedCount = 0;
  try {
    const proposals = listProposed(projectRoot);
    proposedCount = Array.isArray(proposals) ? proposals.length : 0;
  } catch (_e) {
    // Fail-open.
  }

  // Calibration suggestion count.
  const calibCount = _countCalibrationSuggestions(projectRoot);

  // Build banner line — same kill-switch framing as status-render.js.
  // When OFF, omit the redundant "(off)" suffix (matches status-render.js:136).
  const killSwitchLine = killSwitch
    ? `${killState} ${killSrc}`
    : `${killState} ${killSrc}`.replace(' (off)', '');

  const bannerLine =
    `${killSwitchLine} · ` +
    `Circuit breaker: ${breakerState} · ` +
    `Proposals staged: ${proposedCount} · ` +
    `Pending calibration suggestions: ${calibCount}`;

  const lines = [
    '---',
    bannerLine,
  ];

  if (proposedCount > 0) {
    lines.push(`Review: /orchestray:learn list --proposed`);
  }

  if (calibCount > 0) {
    // W8-07: replaced raw `ls` shell directive with a KB path description that
    // follows the skill-command hint convention used elsewhere in the dashboard.
    lines.push(`Review: /orchestray:kb list  (filter by calibration-suggestion- prefix)`);
  }

  lines.push('---');

  return lines.join('\n');
}

module.exports = { renderPatternsBanner, _countCalibrationSuggestions };

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const projectRoot = _resolveProjectRoot(process.argv);
  try {
    process.stdout.write(renderPatternsBanner({ projectRoot }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write('[patterns-render] error: ' + String(err.message || err) + '\n');
    process.exit(1);
  }
}
