#!/usr/bin/env node
'use strict';

// 2013-W7-kill-switch
/**
 * CLI wrapper for the kill-switch event emitter.
 *
 * Invoked by `skills/orchestray:config/SKILL.md` immediately after a
 * successful write of `mcp_enforcement.global_kill_switch` to config.json.
 *
 * Usage:
 *   node bin/emit-kill-switch-event.js <cwd> <previousValue> <newValue> [reason]
 *
 *   cwd           - Absolute path to the project root (passed by the skill).
 *   previousValue - "true" or "false" — the value BEFORE the config write.
 *   newValue      - "true" or "false" — the value AFTER the config write.
 *   reason        - Optional free-text reason (may be absent or empty).
 *
 * Exit codes:
 *   0 — always (fail-open — never block the caller).
 *
 * Design contract: D6 + OQ-T2-4 (2013-W7).
 */

const { emitKillSwitchEvent } = require('./_lib/kill-switch-event');

const [, , cwd, previousRaw, newRaw, ...reasonParts] = process.argv;

function parseBoolean(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

const previousValue = parseBoolean(previousRaw);
const newValue = parseBoolean(newRaw);
const reason = reasonParts.length > 0 ? reasonParts.join(' ') : null;

if (!cwd || previousValue === null || newValue === null) {
  process.stderr.write(
    '[orchestray] emit-kill-switch-event: invalid arguments. ' +
    'Usage: emit-kill-switch-event.js <cwd> <prevValue> <newValue> [reason]\n'
  );
  process.exit(0);
}

emitKillSwitchEvent({ cwd, previousValue, newValue, reason });
process.exit(0);
