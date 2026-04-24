#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit / SessionStart hook — inject the resilience dossier after compaction.
 *
 * Fires on every user prompt (UserPromptSubmit) and on session start after
 * compaction or resume (SessionStart with source=compact|resume).
 *
 * On UserPromptSubmit: gated internally — only emits an `additionalContext`
 * block when `.orchestray/state/compact-signal.lock` exists AND the injection
 * counter has not exceeded `resilience.max_inject_turns`.
 *
 * On SessionStart (source=compact|resume): always injects the dossier (no
 * lock/counter logic — the SessionStart event fires exactly once per
 * compaction, so no repeat injection management is needed).
 *
 * Native envelope mode (default): emits the hookSpecificOutput.additionalContext
 * shape with the raw dossier JSON as the `additionalContext` string value.
 * The dossier is Claude-facing context — the user never sees it in the terminal.
 *
 * Legacy fence mode (ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1): reverts
 * to wrapping the dossier in `<orchestray-resilience-dossier>` XML fences
 * (the pre-2.1.10 behaviour).
 *
 * Context cap: the `additionalContext` value is capped at NATIVE_ENVELOPE_MAX_CHARS
 * characters (10,000). If truncated, a marker is appended and a `dossier_truncated`
 * audit event is emitted.
 *
 * Contract:
 *   - Never throws (fail-open). Any error → {continue:true} with no injection.
 *   - Respects `ORCHESTRAY_RESILIENCE_DISABLED=1` kill switch.
 *   - Respects `ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1` kill switch
 *     (reverts to legacy fenced-markdown path without restart).
 *   - Respects `resilience.enabled`, `resilience.kill_switch`, `resilience.shadow_mode`.
 *   - shadow_mode=true → dossier is still READ (so telemetry/doctor work)
 *     but NOT injected; emits `rehydration_skipped_clean` with reason='shadow_mode'.
 *
 * Design: v217-compaction-resilience-design.md §A2, §C1, §D; v2.1.10 R2.
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
 * Hard cap on additionalContext string length (characters, not bytes).
 * Per W1 gotcha 5: Claude Code rejects additionalContext payloads > 10 KB.
 * We use character count as a safe proxy (characters ≤ bytes for UTF-8).
 */
const NATIVE_ENVELOPE_MAX_CHARS = 10000;
const TRUNCATION_MARKER = '\n\n[TRUNCATED — dossier exceeded 10KB envelope cap; see .orchestray/state/resilience-dossier.json]';

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

    // Build the additionalContext payload.
    const { finalContext, truncated } = _buildAdditionalContext(raw, dossier, cwd);

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
          bytes_full: Buffer.byteLength(raw, 'utf8'),
          cap: NATIVE_ENVELOPE_MAX_CHARS,
          dedup_key: 'dossier_inject_failed|oversize',
        },
      });
    }

    return {
      output: _makeEnvelopeOutput('UserPromptSubmit', finalContext),
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

// ---------------------------------------------------------------------------
// Shared helpers for native-envelope vs legacy-fence paths
// ---------------------------------------------------------------------------

/**
 * Build the additionalContext payload string, choosing between native envelope
 * (plain JSON) and legacy fence (XML-wrapped) modes. Also enforces the 10,000-
 * character cap and emits a `dossier_truncated` audit event if truncation occurs.
 *
 * @param {string} raw - Raw dossier JSON string.
 * @param {object} dossier - Parsed dossier object.
 * @param {string} cwd - Project root (for audit event writing).
 * @returns {{ finalContext: string, truncated: boolean }}
 */
function _buildAdditionalContext(raw, dossier, cwd) {
  const useLegacyFence = process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED === '1';

  let content;
  if (useLegacyFence) {
    // Legacy path: wrap in XML fence with standing instruction.
    content = FENCE_OPEN + '\n' + raw.trim() + '\n' + FENCE_CLOSE +
      '\n\n' + DOSSIER_STANDING_INSTRUCTION;
  } else {
    // Native envelope path: plain dossier JSON (no fence).
    content = raw.trim();
  }

  if (content.length <= NATIVE_ENVELOPE_MAX_CHARS) {
    return { finalContext: content, truncated: false };
  }

  // Truncation required.
  let truncated;
  if (useLegacyFence) {
    truncated = FENCE_OPEN + '\n' +
      JSON.stringify({
        schema_version: dossier.schema_version,
        orchestration_id: dossier.orchestration_id,
        phase: dossier.phase,
        status: dossier.status,
        note: 'deferred_fields_available_at: orchestray:orchestration://current',
      }) + '\n' +
      FENCE_CLOSE + '\n\n' + DOSSIER_STANDING_INSTRUCTION;
  } else {
    // Native path: truncate the raw JSON and append the truncation marker.
    const cap = NATIVE_ENVELOPE_MAX_CHARS - TRUNCATION_MARKER.length;
    truncated = content.slice(0, Math.max(0, cap)) + TRUNCATION_MARKER;
  }

  // Emit dossier_truncated audit event.
  _audit(cwd, {
    type: 'dossier_truncated',
    orchestration_id: dossier.orchestration_id || null,
    original_length: content.length,
    cap: NATIVE_ENVELOPE_MAX_CHARS,
    mode: useLegacyFence ? 'legacy_fence' : 'native_envelope',
  });

  return { finalContext: truncated, truncated: true };
}

/**
 * Build the hook stdout output object.
 * Native envelope mode emits `hookSpecificOutput.additionalContext`.
 * Legacy fence mode also uses the same envelope shape (the fence IS the content).
 *
 * @param {string} hookEventName - 'UserPromptSubmit' or 'SessionStart'.
 * @param {string} additionalContext - The context string to inject.
 * @returns {object}
 */
function _makeEnvelopeOutput(hookEventName, additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

/**
 * SessionStart handler — injects the dossier exactly once per compaction/resume.
 * Unlike UserPromptSubmit, there is no lock/counter: SessionStart fires exactly
 * once per compaction. The function still respects all kill-switches and config flags.
 *
 * @param {object} event - SessionStart payload (may include `session_source`).
 * @returns {{ output: object, action: string, reason?: string }}
 */
function handleSessionStart(event) {
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
    const dossierPath = path.join(stateDir, 'resilience-dossier.json');

    if (!_exists(dossierPath)) {
      return { output: nop, action: 'skipped_no_dossier' };
    }

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
          trigger: 'SessionStart',
          dedup_key: 'dossier_inject_failed|session_start_read',
        },
      });
      return { output: nop, action: 'skipped_corrupt', reason: 'read_failed' };
    }

    const parsed = parseDossier(raw);
    if (!parsed.ok) {
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
          sha256_prefix: sha256Prefix,
          trigger: 'SessionStart',
          dedup_key: 'dossier_corrupt|session_start|' + parsed.reason,
        },
      });
      return { output: nop, action: 'skipped_corrupt', reason: parsed.reason };
    }

    const dossier = parsed.dossier;

    // Stale-skip: orchestration completed.
    if (dossier.status === 'completed') {
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'completed',
        trigger: 'SessionStart',
        orchestration_id: dossier.orchestration_id || null,
      });
      return { output: nop, action: 'skipped_stale', orchestration_id: dossier.orchestration_id || null };
    }

    const { finalContext, truncated } = _buildAdditionalContext(raw, dossier, cwd);
    const bytesInjected = Buffer.byteLength(finalContext, 'utf8');

    // Shadow-mode short-circuit.
    if (cfg.shadow_mode) {
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'shadow_mode',
        trigger: 'SessionStart',
        orchestration_id: dossier.orchestration_id || null,
        bytes_would_inject: bytesInjected,
      });
      return { output: nop, action: 'shadow_dry_run', orchestration_id: dossier.orchestration_id || null };
    }

    _audit(cwd, {
      type: 'dossier_injected',
      trigger: 'SessionStart',
      orchestration_id: dossier.orchestration_id || null,
      written_at: dossier.written_at || null,
      bytes_injected: bytesInjected,
      truncated,
    });

    if (truncated) {
      recordDegradation({
        kind: 'dossier_inject_failed',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          reason: 'oversize_truncated',
          bytes_full: Buffer.byteLength(raw, 'utf8'),
          cap: NATIVE_ENVELOPE_MAX_CHARS,
          trigger: 'SessionStart',
          dedup_key: 'dossier_inject_failed|session_start_oversize',
        },
      });
    }

    return {
      output: _makeEnvelopeOutput('SessionStart', finalContext),
      action: 'injected',
      orchestration_id: dossier.orchestration_id || null,
      bytes_injected: bytesInjected,
    };
  } catch (err) {
    try {
      recordDegradation({
        kind: 'dossier_inject_failed',
        severity: 'warn',
        projectRoot: resolveSafeCwd(event && event.cwd),
        detail: {
          err_code: (err && err.code) || 'throw',
          err_msg: String(err && err.message || err).slice(0, 80),
          trigger: 'SessionStart',
          dedup_key: 'dossier_inject_failed|session_start_exception',
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

    // Route to the appropriate handler based on hook event type.
    // SESSION_SOURCE env var allows test simulation of SessionStart(source=compact|resume).
    const hookEvent = event.hook_event_name || event.hookEventName || '';
    const sessionSource = event.session_source || process.env.SESSION_SOURCE || '';
    const isSessionStart = hookEvent === 'SessionStart' ||
      (sessionSource === 'compact' || sessionSource === 'resume');

    let result;
    if (isSessionStart) {
      result = handleSessionStart(event);
    } else {
      result = handleUserPromptSubmit(event);
    }

    try { process.stdout.write(JSON.stringify(result.output)); } catch (_e) {}
    process.exit(0);
  });
}

module.exports = {
  handleUserPromptSubmit,
  handleSessionStart,
  FENCE_OPEN,
  FENCE_CLOSE,
  NATIVE_ENVELOPE_MAX_CHARS,
  TRUNCATION_MARKER,
  _buildAdditionalContext,
};
