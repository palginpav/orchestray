#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

// 2018-W7-UX4cd
/**
 * Request cancellation of an active orchestration via a sentinel file.
 *
 * Creates `.orchestray/state/cancel.sentinel` with orchestration_id and
 * requested_at. Idempotent — if the sentinel already exists, exits 0.
 *
 * Emits `state_cancel_requested` audit event.
 *
 * The clean-abort sequence fires at the PM's next group-boundary Agent() spawn:
 * the PreToolUse:Agent hook (`bin/check-pause-sentinel.js`) detects the sentinel,
 * blocks the spawn (exit 1), and the PM then moves `.orchestray/state/` to
 * `.orchestray/history/orch-*-cancelled/` and emits `state_cancel_aborted`.
 *
 * `--force`: bypasses idempotency check and overwrites any existing sentinel.
 *
 * Usage:
 *   node bin/state-cancel.js [--force] [--reason=<msg>] [projectDir]
 *
 *   projectDir    - Absolute path to project root (default: process.cwd()).
 *                   Must be the last positional argument or omitted.
 *   --force       - Overwrite existing cancel sentinel (resets requested_at).
 *   --reason=<msg>- Human-readable reason for the cancellation (optional).
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

let force = false;
let reason = null;
let projectDir = null;

for (const arg of args) {
  if (arg === '--force') {
    force = true;
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
const sentinelPath = path.join(stateDir, 'cancel.sentinel');

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
    // Fail-open: audit event loss is acceptable over blocking cancel.
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
    // Not in an active orchestration — still allow cancel for safety.
  }
  return 'unknown';
}

/**
 * Atomically write `data` to `destPath` using a tmp+rename pattern.
 * @param {string} destPath
 * @param {string} data
 */
function atomicWrite(destPath, data) {
  const tmpPath = path.join(os.tmpdir(), 'orchestray-cancel-' + process.pid + '.tmp');
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, destPath);
}

// ---------------------------------------------------------------------------
// Fail-open: missing .orchestray/state/ is not a hard error
// ---------------------------------------------------------------------------

if (!fs.existsSync(stateDir)) {
  process.stderr.write(
    '[orchestray] state-cancel: no .orchestray/state/ found — no active orchestration to cancel\n'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

if (fs.existsSync(sentinelPath) && !force) {
  process.stdout.write('[orchestray] cancel already requested (sentinel exists)\n');
  process.stdout.write('  The PM will abort at the next group boundary. Use --force to reset the timestamp.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Write sentinel
// ---------------------------------------------------------------------------

const orchId = resolveOrchestrationId();
const now = new Date().toISOString();

const sentinelPayload = {
  orchestration_id: orchId,
  reason: reason || null,
  requested_at: now,
};

try {
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWrite(sentinelPath, JSON.stringify(sentinelPayload, null, 2) + '\n');
} catch (err) {
  process.stderr.write('[orchestray] state-cancel: failed to write sentinel: ' + (err && err.message) + '\n');
  process.exit(0);
}

appendAuditEvent({
  timestamp: now,
  type: 'state_cancel_requested',
  orchestration_id: orchId,
  reason: reason || null,
  requested_at: now,
});

process.stdout.write('[orchestray] cancel requested for orchestration ' + orchId + '\n');
if (reason) process.stdout.write('  Reason: ' + reason + '\n');
process.stdout.write('  The PM will abort at the next group boundary and archive state to history/.\n');
process.exit(0);
