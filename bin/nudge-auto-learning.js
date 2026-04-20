#!/usr/bin/env node
'use strict';

/**
 * nudge-auto-learning.js — SessionStart hook that fires ROI aggregator and
 * KB-refs sweep in the background.
 *
 * Why this exists
 * ---------------
 * `bin/pattern-roi-aggregate.js` and `bin/kb-refs-sweep.js` are fully implemented
 * and config-gated (`auto_learning.roi_aggregator.enabled`,
 * `auto_learning.kb_refs_sweep.enabled`), but NO production caller invokes them.
 * The scripts have internal `min_days_between_runs` throttles, so calling them
 * frequently is safe — they exit fast when the window hasn't elapsed.
 *
 * This hook fires on every SessionStart and detaches both scripts as background
 * processes. The detachment means session startup is never blocked by their
 * work; the throttle ensures they only actually do work once per day (ROI) or
 * once per week (KB sweep) per config defaults.
 *
 * Kill-switch honoring: if `auto_learning.global_kill_switch: true` or env
 * `ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1`, the nudge skips both. Individual
 * feature disable (`roi_aggregator.enabled: false`) is respected inside each
 * script, so we don't pre-check that here — we let each script decide.
 *
 * Fail-open: any spawn error is swallowed. SessionStart must never fail.
 *
 * v2.1.8+ — follow-up to "auto-learning inert" diagnosis.
 */

const fs    = require('node:fs');
const path  = require('node:path');
const { spawn } = require('node:child_process');

const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { recordDegradation } = require('./_lib/degraded-journal');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');

/** Background scripts to nudge, relative to bin/. */
const NUDGE_SCRIPTS = [
  'pattern-roi-aggregate.js',
  'kb-refs-sweep.js',
];

/**
 * Best-effort kill-switch check. We only block on config / env; feature-specific
 * toggles are handled inside each script.
 *
 * @param {string} projectRoot
 * @returns {boolean} true if the global kill switch is active
 */
function isKillSwitchActive(projectRoot) {
  if (process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH === '1') return true;
  try {
    const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    return !!(cfg && cfg.auto_learning && cfg.auto_learning.global_kill_switch === true);
  } catch {
    return false; // fail-open: treat parse errors as "not killed"
  }
}

/**
 * Detached-spawn one of the NUDGE_SCRIPTS. Stdio is discarded; the child
 * is unref'd so this process can exit immediately.
 *
 * @param {string} scriptName
 * @param {string} projectRoot
 */
function spawnDetached(scriptName, projectRoot) {
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) return;
  try {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.on('error', () => { /* fail-open */ });
    child.unref();
  } catch (err) {
    try {
      recordDegradation({
        kind: 'config_load_failed',
        severity: 'warn',
        detail: {
          reason: 'nudge_spawn_failed',
          script: scriptName,
          error: err && err.message ? err.message.slice(0, 80) : 'unknown',
        },
        projectRoot,
      });
    } catch {}
  }
}

/**
 * Run the nudge: fire both background scripts unless the kill switch is active.
 *
 * @param {string} projectRoot
 */
function runNudge(projectRoot) {
  if (isKillSwitchActive(projectRoot)) return;
  for (const script of NUDGE_SCRIPTS) {
    spawnDetached(script, projectRoot);
  }
}

module.exports = { runNudge, isKillSwitchActive, spawnDetached };

if (require.main === module) {
  let input = '';
  const finish = () => {
    try {
      let event = {};
      if (input.trim()) {
        try { event = JSON.parse(input); } catch { event = {}; }
      }
      const projectRoot =
        process.env.ORCHESTRAY_PROJECT_ROOT ||
        resolveSafeCwd(event && event.cwd);
      runNudge(projectRoot);
    } catch (err) {
      try {
        recordDegradation({
          kind: 'config_load_failed',
          severity: 'warn',
          detail: {
            reason: 'nudge_auto_learning_uncaught',
            error: err && err.message ? err.message.slice(0, 80) : 'unknown',
          },
        });
      } catch {}
    }
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('error', finish);
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write(
        '[orchestray] nudge-auto-learning: stdin exceeded ' +
        MAX_INPUT_BYTES + ' bytes; aborting\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', finish);
}
