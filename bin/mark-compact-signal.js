#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook — mark the session as post-compact / resumed.
 *
 * Writes `.orchestray/state/compact-signal.lock` when the SessionStart event
 * arrives with `source:"compact"` or `source:"resume"`. The subsequent
 * UserPromptSubmit handler (`inject-resilience-dossier.js`) consumes the
 * lock to decide whether to inject the resilience dossier into the PM's
 * next turn.
 *
 * Per K2 arbitration (v217-arbitration.md), `source:"clear"` is a
 * deliberate user reset and MUST NOT drop a lock. The injector still
 * runs on subsequent UserPromptSubmit events, finds no lock, and remains
 * silent — that is the correct behavior.
 *
 * Contract:
 *   - Never throws. Any error → stderr log → exit 0 with {continue:true}.
 *   - Respects `ORCHESTRAY_RESILIENCE_DISABLED=1` kill switch.
 *   - Respects `resilience.enabled` / `resilience.kill_switch` config keys.
 *   - Emits `compaction_detected` audit event on compact/resume only.
 *
 * Design: v217-compaction-resilience-design.md §A2, §C3.
 */

const fs = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { recordDegradation } = require('./_lib/degraded-journal');
const { loadResilienceConfig } = require('./_lib/config-schema');

const LOCK_BASENAME = 'compact-signal.lock';

/**
 * Core handler — exported for unit tests so the suite does not need to spawn
 * subprocesses.
 *
 * @param {object} event - SessionStart payload.
 * @returns {{ dropped: boolean, source: string|null, reason?: string }}
 */
function handleSessionStart(event) {
  try {
    const source = event && typeof event.source === 'string' ? event.source : null;

    // K2: /clear is NOT a re-hydration trigger.
    if (source !== 'compact' && source !== 'resume') {
      return { dropped: false, source, reason: 'source_not_eligible' };
    }

    if (process.env.ORCHESTRAY_RESILIENCE_DISABLED === '1') {
      return { dropped: false, source, reason: 'env_kill_switch' };
    }

    const cwd = resolveSafeCwd(event && event.cwd);
    const cfg = loadResilienceConfig(cwd);
    if (!cfg.enabled || cfg.kill_switch) {
      return { dropped: false, source, reason: 'config_disabled' };
    }

    const stateDir = path.join(cwd, '.orchestray', 'state');
    // Create state dir best-effort. If no .orchestray/ exists we still write
    // the lock — the orchestration directory will be created on first
    // orchestrated task.
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_e) { /* swallow */ }

    const lockPath = path.join(stateDir, LOCK_BASENAME);
    const payload = {
      source,
      at: new Date().toISOString(),
      ingested_count: 0,
      max_injections: cfg.max_inject_turns,
      session_id: event && typeof event.session_id === 'string' ? event.session_id : null,
    };

    // Atomic write (tmp+rename) — do NOT throw on failure.
    const tmpPath = lockPath + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, lockPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_e) {}
      recordDegradation({
        kind: 'compact_signal_stuck',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          err_code: (err && err.code) || 'unknown',
          source,
          dedup_key: 'compact_signal_stuck|' + source,
        },
      });
      return { dropped: false, source, reason: 'write_failed' };
    }

    // Audit event.
    try {
      writeEvent({
        type: 'compaction_detected',
        source,
        trigger: event && typeof event.trigger === 'string' ? event.trigger : null,
      }, { cwd });
    } catch (_e) { /* swallow */ }

    return { dropped: true, source };
  } catch (err) {
    return { dropped: false, source: null, reason: 'exception' };
  }
}

function _peekOrchestrationId(cwd) {
  try {
    const markerPath = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
    const raw = fs.readFileSync(markerPath, 'utf8');
    const m = JSON.parse(raw);
    if (m && typeof m.orchestration_id === 'string') return m.orchestration_id;
  } catch (_e) { /* swallow */ }
  return null;
}

function _dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e) {}
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      try {
        process.stderr.write('[orchestray] mark-compact-signal: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
        process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      } catch (_e) {}
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try { event = JSON.parse(input || '{}'); } catch (_e) { event = {}; }
    handleSessionStart(event);
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e) {}
    process.exit(0);
  });
}

module.exports = {
  handleSessionStart,
  LOCK_BASENAME,
};
