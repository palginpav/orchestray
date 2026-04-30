#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

// 2018-W7-UX4cd
/**
 * Pause or resume an active orchestration via a sentinel file.
 *
 * First call (no flags): creates `.orchestray/state/pause.sentinel` with
 * orchestration_id, reason, and paused_at. Emits `state_pause_set` audit event.
 * Idempotent — calling again without `--resume` has no effect and exits 0.
 *
 * `--resume`: deletes the sentinel if present. Emits `state_pause_resumed`.
 * Idempotent — if no sentinel exists, exits 0 silently.
 *
 * The PreToolUse:Agent sentinel hook (`bin/check-pause-sentinel.js`) blocks further
 * Agent() spawns while the sentinel is present. The sentinel persists across session
 * restarts; `/orchestray:resume` honours it.
 *
 * Usage:
 *   node bin/state-pause.js [--resume] [--reason=<msg>] [projectDir]
 *
 *   projectDir    - Absolute path to project root (default: process.cwd()).
 *                   Must be the last positional argument or omitted.
 *   --resume      - Remove the sentinel (resume paused orchestration).
 *   --reason=<msg>- Human-readable reason for the pause (optional).
 *
 * Exit codes:
 *   0 — always (fail-open). Errors are reported to stderr.
 *
 * Design contract: 2018-UX4cd (W7).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeEvent } = require('./_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

let resume = false;
let reason = null;
let projectDir = null;

for (const arg of args) {
  if (arg === '--resume') {
    resume = true;
  } else if (arg.startsWith('--reason=')) {
    reason = arg.slice('--reason='.length);
  } else if (!arg.startsWith('--')) {
    if (projectDir === null) projectDir = arg;
  }
}

if (projectDir === null) projectDir = process.cwd();

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const stateDir = path.join(projectDir, '.orchestray', 'state');
const sentinelPath = path.join(stateDir, 'pause.sentinel');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Append an audit event via the central gateway. Best-effort; fail-open.
 * @param {object} obj
 */
function appendAuditEvent(obj) {
  try {
    writeEvent(obj, { cwd: projectDir });
  } catch (_e) {
    // Fail-open: audit event loss is acceptable over blocking pause.
  }
}

/**
 * Read the current orchestration_id from the state file, or return 'unknown'.
 * @returns {string}
 */
function resolveOrchestrationId() {
  const stateMd = path.join(stateDir, 'orchestration.md');
  try {
    const raw = fs.readFileSync(stateMd, 'utf8');
    const m = raw.match(/orchestration_id[:\s]+([^\s\n]+)/i);
    if (m && m[1]) return m[1].trim();
  } catch (_e) {
    // Not in an active orchestration — still allow pause for safety.
  }
  return 'unknown';
}

/**
 * Atomically write `data` to `destPath` using a tmp+rename pattern.
 * @param {string} destPath
 * @param {string} data
 */
function atomicWrite(destPath, data) {
  const tmpPath = path.join(os.tmpdir(), 'orchestray-pause-' + process.pid + '.tmp');
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, destPath);
}

// ---------------------------------------------------------------------------
// Fail-open: missing .orchestray/state/ is not a hard error
// ---------------------------------------------------------------------------

if (!fs.existsSync(stateDir)) {
  // State dir absent — no active orchestration. Pause is a no-op.
  process.stderr.write(
    '[orchestray] state-pause: no .orchestray/state/ found — no active orchestration to pause\n'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Resume branch
// ---------------------------------------------------------------------------

if (resume) {
  if (!fs.existsSync(sentinelPath)) {
    // Already clear — idempotent, no-op.
    process.stdout.write('[orchestray] pause sentinel not present — nothing to resume\n');
    process.exit(0);
  }

  let sentinelData = {};
  try {
    sentinelData = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
  } catch (_e) {
    // Corrupt sentinel — still delete it.
  }

  try {
    fs.unlinkSync(sentinelPath);
  } catch (err) {
    process.stderr.write('[orchestray] state-pause: could not remove sentinel: ' + (err && err.message) + '\n');
    process.exit(0);
  }

  const orchId = sentinelData.orchestration_id || 'unknown';
  appendAuditEvent({
    timestamp: new Date().toISOString(),
    type: 'state_pause_resumed',
    orchestration_id: orchId,
    resumed_at: new Date().toISOString(),
  });

  process.stdout.write('[orchestray] orchestration ' + orchId + ' resumed\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Pause branch
// ---------------------------------------------------------------------------

if (fs.existsSync(sentinelPath)) {
  // Idempotent: already paused.
  process.stdout.write('[orchestray] orchestration already paused (sentinel exists)\n');
  process.stdout.write('  Use --resume to unpause, or /orchestray:state pause --resume\n');
  process.exit(0);
}

const orchId = resolveOrchestrationId();
const now = new Date().toISOString();

const sentinelPayload = {
  orchestration_id: orchId,
  reason: reason || null,
  paused_at: now,
};

try {
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWrite(sentinelPath, JSON.stringify(sentinelPayload, null, 2) + '\n');
} catch (err) {
  process.stderr.write('[orchestray] state-pause: failed to write sentinel: ' + (err && err.message) + '\n');
  process.exit(0);
}

appendAuditEvent({
  timestamp: now,
  type: 'state_pause_set',
  orchestration_id: orchId,
  reason: reason || null,
  paused_at: now,
});

process.stdout.write('[orchestray] orchestration ' + orchId + ' paused\n');
if (reason) process.stdout.write('  Reason: ' + reason + '\n');
process.stdout.write('  Use --resume or /orchestray:state pause --resume to continue\n');
process.exit(0);
