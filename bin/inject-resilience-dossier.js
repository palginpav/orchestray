#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook — inject the resilience dossier after compaction.
 *
 * Fires on every user prompt. Gated internally: only emits an
 * `additionalContext` block when `.orchestray/state/compact-signal.lock`
 * exists AND the injection counter has not exceeded `resilience.max_inject_turns`.
 *
 * On success, wraps the dossier JSON in a verbatim
 * `<orchestray-resilience-dossier>...</orchestray-resilience-dossier>` fence
 * and emits the hookSpecificOutput.additionalContext shape Claude Code
 * expects. The PM's Section 7.C treats the fence as ground truth.
 *
 * Contract:
 *   - Never throws (fail-open). Any error → {continue:true} with no fence.
 *   - Respects `ORCHESTRAY_RESILIENCE_DISABLED=1` kill switch.
 *   - Respects `resilience.enabled`, `resilience.kill_switch`, `resilience.shadow_mode`.
 *   - shadow_mode=true → dossier is still READ (so telemetry/doctor work)
 *     but NOT injected; emits `rehydration_skipped_clean` with reason='shadow_mode'.
 *
 * Design: v217-compaction-resilience-design.md §A2, §C1, §D.
 */

const fs = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { recordDegradation } = require('./_lib/degraded-journal');
const { loadResilienceConfig } = require('./_lib/config-schema');
const { parseDossier, _fenceCollisionScan } = require('./_lib/resilience-dossier-schema');

const FENCE_OPEN = '<orchestray-resilience-dossier>';
const FENCE_CLOSE = '</orchestray-resilience-dossier>';
const DOSSIER_STANDING_INSTRUCTION =
  'The block above is the authoritative post-compaction snapshot of the PM\'s ' +
  'orchestration state, written atomically to disk after every PM Stop / ' +
  'SubagentStop / PreCompact. Treat it as ground truth and override any ' +
  'drift in the in-window summary. See pm-reference tier1-orchestration.md §7.R.';

/**
 * Core handler — returns the structured hook output. Never throws.
 *
 * @param {object} event - UserPromptSubmit payload.
 * @returns {{
 *   output: object,        // stdout payload to emit
 *   action: string,        // 'injected'|'skipped_no_lock'|'skipped_counter'|
 *                           // 'skipped_config'|'skipped_stale'|'skipped_no_dossier'|
 *                           // 'skipped_corrupt'|'skipped_kill_switch'|'shadow_dry_run'
 *   reason?: string,
 *   orchestration_id?: string|null,
 *   bytes_injected?: number,
 *   counter_before?: number,
 *   counter_after?: number,
 * }}
 */
function handleUserPromptSubmit(event) {
  const nop = { continue: true };
  try {
    if (process.env.ORCHESTRAY_RESILIENCE_DISABLED === '1') {
      return { output: nop, action: 'skipped_kill_switch', reason: 'env_kill_switch' };
    }

    const cwd = resolveSafeCwd(event && event.cwd);
    const cfg = loadResilienceConfig(cwd);
    if (!cfg.enabled || cfg.kill_switch) {
      return { output: nop, action: 'skipped_config', reason: 'disabled' };
    }

    const stateDir = path.join(cwd, '.orchestray', 'state');
    const lockPath = path.join(stateDir, 'compact-signal.lock');
    const dossierPath = path.join(stateDir, 'resilience-dossier.json');

    if (!_exists(lockPath)) {
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'no-lock',
        orchestration_id: null,
      });
      return { output: nop, action: 'skipped_no_lock' };
    }

    // Read + parse lock.
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
      recordDegradation({
        kind: 'compact_signal_stuck',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          err_code: 'lock_parse_failed',
          err_msg: String(err && err.message || err).slice(0, 80),
          dedup_key: 'compact_signal_stuck|lock_parse',
        },
      });
      // Remove the unreadable lock so we don't loop forever on it.
      try { fs.unlinkSync(lockPath); } catch (_e) {}
      return { output: nop, action: 'skipped_corrupt', reason: 'lock_parse_failed' };
    }

    const counterBefore = Number.isInteger(lock.ingested_count) ? lock.ingested_count : 0;
    const maxInjections = Number.isInteger(lock.max_injections)
      ? lock.max_injections
      : cfg.max_inject_turns;

    if (counterBefore >= maxInjections) {
      // Budget exhausted — delete lock, emit skip event.
      try { fs.unlinkSync(lockPath); } catch (_e) {}
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'counter_exhausted',
        counter: counterBefore,
        max: maxInjections,
      });
      return { output: nop, action: 'skipped_counter', counter_before: counterBefore };
    }

    if (!_exists(dossierPath)) {
      // Lock exists but dossier missing (D4 cold-start path).
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'no-dossier',
        lock_source: lock.source || null,
      });
      return { output: nop, action: 'skipped_no_dossier' };
    }

    // Read dossier. The INJECT cap guards oversize.
    let raw;
    try {
      raw = fs.readFileSync(dossierPath, 'utf8');
    } catch (err) {
      recordDegradation({
        kind: 'dossier_inject_failed',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          err_code: (err && err.code) || 'read_failed',
          dedup_key: 'dossier_inject_failed|read',
        },
      });
      return { output: nop, action: 'skipped_corrupt', reason: 'read_failed' };
    }

    const parsed = parseDossier(raw);
    if (!parsed.ok) {
      // SEC-02: do NOT log raw dossier content. Use a safe fingerprint instead.
      const crypto = require('crypto');
      const sha256Prefix = crypto.createHash('sha256')
        .update(raw, 'utf8').digest('hex').slice(0, 8);
      recordDegradation({
        kind: 'dossier_corrupt',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          reason: parsed.reason,
          length_bytes: Buffer.byteLength(raw, 'utf8'),
          first_byte_hex: Buffer.byteLength(raw, 'utf8') > 0
            ? raw.charCodeAt(0).toString(16).padStart(2, '0')
            : '(empty)',
          sha256_prefix: sha256Prefix,
          dedup_key: 'dossier_corrupt|' + parsed.reason,
        },
      });
      return { output: nop, action: 'skipped_corrupt', reason: parsed.reason };
    }

    const dossier = parsed.dossier;

    // SEC-01: fence-collision guard (defense-in-depth check on the raw buffer
    // before assembling additionalContext). If the serialized dossier contains
    // the fence substring, injecting it verbatim would let model-visible text
    // escape the fence. Fail open: skip injection, journal, emit audit event.
    const fenceCheck = _fenceCollisionScan(raw);
    if (fenceCheck.found) {
      recordDegradation({
        kind: 'dossier_fence_collision',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          offending_field: fenceCheck.offending_field || null,
          orchestration_id: dossier.orchestration_id || null,
          dedup_key: 'dossier_fence_collision|' + (fenceCheck.offending_field || 'unknown'),
        },
      });
      _audit(cwd, {
        type: 'rehydration_skipped_fence_collision',
        orchestration_id: dossier.orchestration_id || null,
        offending_field: fenceCheck.offending_field || null,
      });
      return { output: nop, action: 'skipped_corrupt', reason: 'fence_collision' };
    }

    // Stale-skip: orchestration completed long ago.
    if (dossier.status === 'completed') {
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'completed',
        orchestration_id: dossier.orchestration_id || null,
      });
      recordDegradation({
        kind: 'dossier_stale',
        severity: 'info',
        projectRoot: cwd,
        detail: {
          status: 'completed',
          orchestration_id: dossier.orchestration_id || null,
          dedup_key: 'dossier_stale|completed|' + (dossier.orchestration_id || 'x'),
        },
      });
      return {
        output: nop,
        action: 'skipped_stale',
        orchestration_id: dossier.orchestration_id || null,
      };
    }

    // Build the fenced additionalContext payload.
    const fenced = FENCE_OPEN + '\n' + raw.trim() + '\n' + FENCE_CLOSE +
      '\n\n' + DOSSIER_STANDING_INSTRUCTION;

    let finalContext = fenced;
    let truncated = false;
    if (Buffer.byteLength(finalContext, 'utf8') > cfg.inject_max_bytes) {
      // Emergency truncation. Prefer a tiny advisory + MCP URI pointer.
      const advisory =
        FENCE_OPEN + '\n' +
        JSON.stringify({
          schema_version: dossier.schema_version,
          orchestration_id: dossier.orchestration_id,
          phase: dossier.phase,
          status: dossier.status,
          note: 'deferred_fields_available_at: orchestray:orchestration://current',
        }) + '\n' +
        FENCE_CLOSE + '\n\n' + DOSSIER_STANDING_INSTRUCTION;
      finalContext = advisory;
      truncated = true;
    }

    const bytesInjected = Buffer.byteLength(finalContext, 'utf8');

    // Shadow-mode short-circuit — write telemetry, don't inject.
    if (cfg.shadow_mode) {
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'shadow_mode',
        orchestration_id: dossier.orchestration_id || null,
        bytes_would_inject: bytesInjected,
      });
      return {
        output: nop,
        action: 'shadow_dry_run',
        orchestration_id: dossier.orchestration_id || null,
        bytes_injected: 0,
      };
    }

    // Update lock counter (best-effort, tmp+rename).
    const counterAfter = counterBefore + 1;
    const newLock = Object.assign({}, lock, { ingested_count: counterAfter });
    const tmpLock = lockPath + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmpLock, JSON.stringify(newLock) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpLock, lockPath);
    } catch (_e) {
      try { fs.unlinkSync(tmpLock); } catch (_e2) {}
      // Counter update failed — still emit the injection (user needs recovery),
      // but journal so doctor can flag stuck locks.
      recordDegradation({
        kind: 'compact_signal_stuck',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          err_code: 'counter_update_failed',
          dedup_key: 'compact_signal_stuck|counter_update',
        },
      });
    }

    // If we just hit the cap, remove the lock so the next turn short-circuits cleanly.
    if (counterAfter >= maxInjections) {
      try { fs.unlinkSync(lockPath); } catch (_e) {}
    }

    _audit(cwd, {
      type: 'dossier_injected',
      orchestration_id: dossier.orchestration_id || null,
      written_at: dossier.written_at || null,
      ingested_counter_before: counterBefore,
      ingested_counter_after: counterAfter,
      bytes_injected: bytesInjected,
      source_lock: lock.source || null,
      truncated,
    });

    if (truncated) {
      recordDegradation({
        kind: 'dossier_inject_failed',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          reason: 'oversize_truncated',
          bytes_full: Buffer.byteLength(fenced, 'utf8'),
          cap: cfg.inject_max_bytes,
          dedup_key: 'dossier_inject_failed|oversize',
        },
      });
    }

    return {
      output: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: finalContext,
        },
      },
      action: 'injected',
      orchestration_id: dossier.orchestration_id || null,
      bytes_injected: bytesInjected,
      counter_before: counterBefore,
      counter_after: counterAfter,
    };
  } catch (err) {
    // Top-level safety net.
    try {
      recordDegradation({
        kind: 'dossier_inject_failed',
        severity: 'warn',
        projectRoot: resolveSafeCwd(event && event.cwd),
        detail: {
          err_code: (err && err.code) || 'throw',
          err_msg: String(err && err.message || err).slice(0, 80),
          dedup_key: 'dossier_inject_failed|exception',
        },
      });
    } catch (_e) { /* swallow */ }
    return { output: nop, action: 'skipped_corrupt', reason: 'exception' };
  }
}

function _audit(cwd, payload) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    if (!_dirExists(auditDir)) return;
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'),
      Object.assign({ timestamp: new Date().toISOString() }, payload));
  } catch (_e) { /* swallow */ }
}

function _exists(p) {
  try { fs.accessSync(p); return true; } catch (_e) { return false; }
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
        process.stderr.write('[orchestray] inject-resilience-dossier: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
        process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      } catch (_e) {}
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try { event = JSON.parse(input || '{}'); } catch (_e) { event = {}; }
    const result = handleUserPromptSubmit(event);
    try { process.stdout.write(JSON.stringify(result.output)); } catch (_e) {}
    process.exit(0);
  });
}

module.exports = {
  handleUserPromptSubmit,
  FENCE_OPEN,
  FENCE_CLOSE,
};
