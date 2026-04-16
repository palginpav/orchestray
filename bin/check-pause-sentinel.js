#!/usr/bin/env node
'use strict';

// 2018-W7-UX4cd
/**
 * PreToolUse:Agent sentinel check — blocks spawns when pause or cancel sentinels
 * are present in `.orchestray/state/`.
 *
 * This hook runs BEFORE gate-agent-spawn.js in the PreToolUse:Agent chain
 * (option A: separate hook entry that appears first in hooks.json).
 *
 * Exit semantics:
 *   0 — no sentinel; allow spawn to proceed.
 *   2 — cancel.sentinel present (after grace window); print block reason.
 *   2 — pause.sentinel present; print block reason with resume instructions.
 *
 * Grace window: a fresh cancel.sentinel (written within `cancel_grace_seconds`
 * of now) is treated as exit 0 so any in-flight Agent() call can finish cleanly.
 *
 * Kill flag: `state_sentinel.pause_check_enabled: false` in config.json makes
 * this hook exit 0 unconditionally (inerts the sentinel check without removing
 * sentinel files).
 *
 * Usage:
 *   node bin/check-pause-sentinel.js [projectDir]
 *
 *   projectDir  - Absolute path to project root (default: process.cwd()).
 *                 Claude Code passes this as $CLAUDE_PLUGIN_ROOT via env when
 *                 wired through hooks.json; when invoked directly for tests,
 *                 pass as first positional argument.
 *
 * Input:  JSON on stdin (Claude Code PreToolUse hook payload) — not consumed,
 *         only stdin is drained to avoid EPIPE.
 * Output: block message to stdout (exit 2) or nothing (exit 0).
 *
 * Fail-open: any internal error → exit 0 (operators must never be hard-blocked
 * by a buggy sentinel script).
 *
 * Design contract: 2018-UX4cd (W7).
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Determine project dir
// ---------------------------------------------------------------------------

// Accept positional arg OR fall back to CLAUDE_PLUGIN_ROOT env OR cwd.
const args = process.argv.slice(2);
const positionalArg = args.find(a => !a.startsWith('--')) || null;
const projectDir = positionalArg || process.env.CLAUDE_PLUGIN_ROOT || process.cwd();

// ---------------------------------------------------------------------------
// Drain stdin (required for Claude Code hook scripts to avoid EPIPE)
// ---------------------------------------------------------------------------

let _stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {});
process.stdin.on('data', (chunk) => { _stdinBuf += chunk; });
process.stdin.on('end', () => { run(); });

// Guard: if stdin never closes (unlikely in test contexts), run after 200ms.
const _guard = setTimeout(() => { run(); }, 200);

let _ran = false;
function run() {
  if (_ran) return;
  _ran = true;
  clearTimeout(_guard);
  main();
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

const DEFAULT_STATE_SENTINEL = Object.freeze({
  pause_check_enabled: true,    // kill flag: false inerts the entire check
  cancel_grace_seconds: 5,      // seconds after cancel.sentinel creation before blocking
});

/**
 * Load state_sentinel config block from .orchestray/config.json.
 * Fail-open: missing/malformed returns DEFAULT_STATE_SENTINEL.
 * @param {string} cwd
 * @returns {{ pause_check_enabled: boolean, cancel_grace_seconds: number }}
 */
function loadStateSentinelConfig(cwd) {
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Object.assign({}, DEFAULT_STATE_SENTINEL);
    }
    const fromFile = parsed.state_sentinel;
    if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
      return Object.assign({}, DEFAULT_STATE_SENTINEL);
    }
    const merged = Object.assign({}, DEFAULT_STATE_SENTINEL, fromFile);
    // Validate and clamp
    if (typeof merged.pause_check_enabled !== 'boolean') {
      merged.pause_check_enabled = DEFAULT_STATE_SENTINEL.pause_check_enabled;
    }
    if (!Number.isFinite(merged.cancel_grace_seconds) || merged.cancel_grace_seconds < 0) {
      merged.cancel_grace_seconds = DEFAULT_STATE_SENTINEL.cancel_grace_seconds;
    }
    return merged;
  } catch (_e) {
    return Object.assign({}, DEFAULT_STATE_SENTINEL);
  }
}

// ---------------------------------------------------------------------------
// Sentinel readers
// ---------------------------------------------------------------------------

/**
 * Read and parse a sentinel JSON file. Returns null on any error.
 * @param {string} sentinelPath
 * @returns {object|null}
 */
function readSentinel(sentinelPath) {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  try {
    const config = loadStateSentinelConfig(projectDir);

    // Kill flag: inert the entire check.
    if (!config.pause_check_enabled) {
      process.exit(0);
    }

    const stateDir = path.join(projectDir, '.orchestray', 'state');
    const cancelSentinelPath = path.join(stateDir, 'cancel.sentinel');
    const pauseSentinelPath = path.join(stateDir, 'pause.sentinel');

    // 1. Check cancel sentinel first (higher priority — operator requested full stop).
    if (fs.existsSync(cancelSentinelPath)) {
      const data = readSentinel(cancelSentinelPath) || {};
      const orchId = data.orchestration_id || 'unknown';
      const requestedAt = data.requested_at ? new Date(data.requested_at) : null;
      const graceMs = config.cancel_grace_seconds * 1000;

      // Grace window: if the sentinel was written very recently, allow in-flight calls.
      if (requestedAt && (Date.now() - requestedAt.getTime()) < graceMs) {
        // Still within grace window — allow this spawn.
        process.exit(0);
      }

      process.stdout.write(
        'cancelled: ' + orchId + '\n' +
        '[orchestray] Cancel sentinel present — further Agent() spawns are blocked.\n' +
        'The PM will archive state to history/orch-' + orchId + '-cancelled/ at the next boundary.\n' +
        'To clear without archiving (not recommended): delete .orchestray/state/cancel.sentinel\n'
      );
      process.exit(2);
    }

    // 2. Check pause sentinel.
    if (fs.existsSync(pauseSentinelPath)) {
      const data = readSentinel(pauseSentinelPath) || {};
      const orchId = data.orchestration_id || 'unknown';
      const reason = data.reason ? ' (' + data.reason + ')' : '';

      process.stdout.write(
        'paused: ' + orchId + ' — use /orchestray:state pause --resume to continue\n' +
        '[orchestray] Pause sentinel present' + reason + ' — Agent() spawn blocked.\n' +
        'Resume with: node bin/state-pause.js --resume\n' +
        'Or:          /orchestray:state pause --resume\n'
      );
      process.exit(2);
    }

    // No sentinel — allow spawn.
    process.exit(0);
  } catch (_e) {
    // Fail-open: any unexpected error must not block operators.
    process.exit(0);
  }
}
