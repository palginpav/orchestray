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
const { writeEvent } = require('./_lib/audit-event-writer');
const { recordDegradation } = require('./_lib/degraded-journal');
const { loadResilienceConfig } = require('./_lib/config-schema');
const { parseDossier, _fenceCollisionScan } = require('./_lib/resilience-dossier-schema');
const { peekOrchestrationId } = require('./_lib/peek-orchestration-id');

const FENCE_OPEN = '<orchestray-resilience-dossier>';
const FENCE_CLOSE = '</orchestray-resilience-dossier>';

// ---------------------------------------------------------------------------
// W6 — Dossier compensation constants
// ---------------------------------------------------------------------------

/**
 * Hard cap for compensation: dossiers older than this are considered stale
 * and will NOT be re-injected. 30 days in milliseconds.
 */
const COMPENSATION_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum tail lines to scan from events.jsonl (memory guard, mirrors W8 pattern). */
const COMPENSATION_TAIL_LINE_LIMIT = 2000;

/**
 * Size cap for compensation: dossiers larger than this (bytes) are skipped
 * to avoid exceeding the additionalContext budget.
 */
const COMPENSATION_SIZE_CAP_BYTES = 25 * 1024; // 25 KB
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
 * v2.2.9 B-3 — fail-closed skip-reason telemetry.
 *
 * Every silent-skip / early-return branch in handleUserPromptSubmit and
 * handleSessionStart now emits exactly one `dossier_injection_skipped` event
 * with a categorised `skip_reason` BEFORE returning. This eliminates the
 * v2.2.8 regression class where `dossier_written: 64` but `dossier_injected: 0`
 * because operators had no way to distinguish "inject ran and succeeded" from
 * "inject ran and silently bailed at branch X".
 *
 * Skip reasons are categorical so the orphan auditor (audit-dossier-orphan.js)
 * can decide which skips count as a "legitimate inject suppression" vs an
 * "operator-relevant write-without-inject" pair.
 *
 * Kill switch: ORCHESTRAY_DOSSIER_INJECT_TELEMETRY_DISABLED=1 suppresses the
 * skip telemetry only. The inject mechanism itself stays working with or
 * without telemetry.
 */
const SKIP_REASON = {
  NOT_SESSION_START: 'not_session_start',
  DOSSIER_FILE_MISSING: 'dossier_file_missing',
  DOSSIER_FILE_CORRUPT: 'dossier_file_corrupt',
  DOSSIER_STALE: 'dossier_stale',
  NO_ORCHESTRATION_ACTIVE: 'no_orchestration_active',
  ADDITIONAL_CONTEXT_ALREADY_PRESENT: 'additional_context_already_present',
  KILL_SWITCH_SET: 'kill_switch_set',
  UNKNOWN_SKIP: 'unknown_skip',
};

/**
 * Emit a `dossier_injection_skipped` event. Honours the
 * ORCHESTRAY_DOSSIER_INJECT_TELEMETRY_DISABLED kill switch.
 *
 * @param {string} cwd - Project root.
 * @param {string} skipReason - One of SKIP_REASON values.
 * @param {object} [extra] - Additional fields (trigger, orchestration_id, sub_reason, etc.).
 */
function _emitInjectionSkipped(cwd, skipReason, extra) {
  if (process.env.ORCHESTRAY_DOSSIER_INJECT_TELEMETRY_DISABLED === '1') return;
  try {
    const payload = Object.assign({
      type: 'dossier_injection_skipped',
      version: 1,
      skip_reason: skipReason,
      dossier_path: '.orchestray/state/resilience-dossier.json',
    }, extra || {});
    _audit(cwd, payload);
  } catch (_e) { /* fail-open */ }
}

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
      // SKIP-1: env kill switch. Pre-cwd-resolve so we use a best-effort cwd.
      const cwd = resolveSafeCwd(event && event.cwd);
      _emitInjectionSkipped(cwd, SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'env_kill_switch',
      });
      return { output: nop, action: 'skipped_kill_switch', reason: 'env_kill_switch' };
    }

    const cwd = resolveSafeCwd(event && event.cwd);
    const cfg = loadResilienceConfig(cwd);
    if (!cfg.enabled || cfg.kill_switch) {
      // SKIP-2: config disabled / config kill_switch.
      _emitInjectionSkipped(cwd, SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'UserPromptSubmit',
        sub_reason: cfg.kill_switch ? 'config_kill_switch' : 'config_disabled',
      });
      return { output: nop, action: 'skipped_config', reason: 'disabled' };
    }

    const stateDir = path.join(cwd, '.orchestray', 'state');
    const lockPath = path.join(stateDir, 'compact-signal.lock');
    const dossierPath = path.join(stateDir, 'resilience-dossier.json');

    if (!_exists(lockPath)) {
      // Schema compliance (v2.2.19 Fix 3): add counter, max, bytes_would_inject
      // as required by event-schemas.md. For no-lock, no injection has occurred:
      // counter=0 (no injections consumed), max from config, bytes_would_inject=0
      // (no dossier read at this point).
      _audit(cwd, {
        type: 'rehydration_skipped_clean',
        reason: 'no-lock',
        orchestration_id: null,
        counter: 0,
        max: cfg.max_inject_turns,
        bytes_would_inject: 0,
      });
      // SKIP-3: no compact-signal.lock — UPS turn is not a post-compact recovery turn.
      _emitInjectionSkipped(cwd, SKIP_REASON.NOT_SESSION_START, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'no_lock',
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
      // SKIP-4: lock file unreadable / unparseable.
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_CORRUPT, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'lock_parse_failed',
      });
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
      // SKIP-5: configured max_inject_turns reached — semantically a kill-switch.
      _emitInjectionSkipped(cwd, SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'counter_exhausted',
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
      // SKIP-6: dossier file does not exist on disk.
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_MISSING, {
        trigger: 'UserPromptSubmit',
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
      // SKIP-7: dossier file present but unreadable (fs error).
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_CORRUPT, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'read_failed',
        err_code: (err && err.code) || 'read_failed',
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
      // SKIP-8: dossier on disk failed schema parse (corrupt JSON / version mismatch).
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_CORRUPT, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'parse_failed',
        parse_reason: parsed.reason,
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
      // SKIP-9: fence-collision in raw dossier — semantically a corrupt/unsafe file.
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_CORRUPT, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'fence_collision',
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
      // SKIP-10: dossier present but orchestration is already completed.
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_STALE, {
        trigger: 'UserPromptSubmit',
        orchestration_id: dossier.orchestration_id || null,
        sub_reason: 'completed',
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
      // SKIP-11: shadow_mode config — semantically a kill-switch (suppresses inject).
      _emitInjectionSkipped(cwd, SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'shadow_mode',
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
      version: 1,
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
      // SKIP-12: unexpected throw inside the handler — un-categorised.
      _emitInjectionSkipped(resolveSafeCwd(event && event.cwd), SKIP_REASON.UNKNOWN_SKIP, {
        trigger: 'UserPromptSubmit',
        sub_reason: 'exception',
        err_code: (err && err.code) || 'throw',
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

// ---------------------------------------------------------------------------
// W6 — Dossier compensation helper
// ---------------------------------------------------------------------------

/**
 * Parse JSONL content into an array of objects. Best-effort (skips malformed lines).
 *
 * @param {string} content
 * @returns {object[]}
 */
function _parseJsonlLines(content) {
  const out = [];
  if (!content) return out;
  // S-5: cap at last COMPENSATION_TAIL_LINE_LIMIT lines (memory guard for large audit logs).
  let lines = content.split('\n');
  if (lines.length > COMPENSATION_TAIL_LINE_LIMIT) {
    lines = lines.slice(lines.length - COMPENSATION_TAIL_LINE_LIMIT);
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (_e) { /* skip malformed */ }
  }
  return out;
}

/**
 * Check whether the dossier was written in a previous session without being
 * injected back. If so, perform compensation injection.
 *
 * W6 compensation logic (v2.2.18):
 *   - Kill switch: ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED=1 OR
 *     config.dossier_compensation.enabled === false → emit
 *     dossier_compensation_skipped(reason: kill_switch_via_env|kill_switch_via_config)
 *     and return null (fall through to normal inject path).
 *   - Read the live events.jsonl; tally write/inject counts.
 *   - If write_count > 0 AND inject_count === 0:
 *       - Age check (30 days): if dossier mtime > 30 days → skipped(all_archives_stale).
 *       - Size check (25 KB): if dossier > 25 KB → skipped(size_cap_exceeded).
 *       - Otherwise: inject and emit dossier_compensation_inject.
 *   - Returns the inject output object on compensation-inject, null otherwise.
 *   - Never throws; all errors emit dossier_compensation_skipped(signal_unavailable).
 *
 * NOTE: kill_switch reason values are explicitly emitted here (unlike the W8
 * pattern) so operators can see WHY compensation did not run. This is a
 * deliberate departure from the W8 silent-kill-switch convention.
 *
 * @param {string} cwd
 * @param {string} dossierPath
 * @param {object} cfg  - Parsed resilience config.
 * @returns {object|null}  Hook output if compensation-injected, null otherwise.
 */
function _tryDossierCompensation(cwd, dossierPath, cfg) {
  // Kill switch: env var.
  if (process.env.ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED === '1') {
    _audit(cwd, {
      type: 'dossier_compensation_skipped',
      version: 1,
      reason: 'kill_switch_via_env',
    });
    return null;
  }

  // Kill switch: config.
  const compCfg = cfg && cfg.dossier_compensation;
  if (compCfg && compCfg.enabled === false) {
    _audit(cwd, {
      type: 'dossier_compensation_skipped',
      version: 1,
      reason: 'kill_switch_via_config',
    });
    return null;
  }

  try {
    // Read the live audit log and tally write/inject events.
    const livePath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    if (!_exists(livePath)) {
      // No audit log — cannot determine orphan status; skip silently.
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'signal_unavailable',
      });
      return null;
    }

    let events;
    try {
      events = _parseJsonlLines(fs.readFileSync(livePath, 'utf8'));
    } catch (_e) {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'signal_unavailable',
      });
      return null;
    }

    let writeCount = 0;
    let injectCount = 0;
    for (const ev of events) {
      if (!ev || typeof ev.type !== 'string') continue;
      if (ev.type === 'dossier_written') writeCount += 1;
      else if (ev.type === 'dossier_injected') injectCount += 1;
    }

    // Only compensate when dossier was written but never injected.
    if (writeCount === 0 || injectCount > 0) return null;

    // Dossier must exist for compensation.
    if (!_exists(dossierPath)) return null;

    // Age check: skip if dossier is older than 30 days.
    let stat;
    try {
      stat = fs.statSync(dossierPath);
    } catch (_e) {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'signal_unavailable',
        dossier_path: dossierPath,
      });
      return null;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    const archiveAgeSeconds = Math.round(ageMs / 1000);

    if (ageMs > COMPENSATION_STALE_MS) {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'all_archives_stale',
        dossier_path: dossierPath,
        archive_age_seconds: archiveAgeSeconds,
      });
      return null;
    }

    // Size check: skip if dossier > 25 KB.
    if (stat.size > COMPENSATION_SIZE_CAP_BYTES) {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'size_cap_exceeded',
        dossier_path: dossierPath,
        archive_age_seconds: archiveAgeSeconds,
      });
      return null;
    }

    // Read and parse the dossier for injection.
    let raw;
    try {
      raw = fs.readFileSync(dossierPath, 'utf8');
    } catch (_e) {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'signal_unavailable',
        dossier_path: dossierPath,
        archive_age_seconds: archiveAgeSeconds,
      });
      return null;
    }

    const parsed = parseDossier(raw);
    if (!parsed.ok) {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'signal_unavailable',
        dossier_path: dossierPath,
        archive_age_seconds: archiveAgeSeconds,
      });
      return null;
    }

    // Build the additionalContext payload (uses same path as normal inject).
    const { finalContext } = _buildAdditionalContext(raw, parsed.dossier, cwd);

    // Emit compensation event.
    _audit(cwd, {
      type: 'dossier_compensation_inject',
      version: 1,
      dossier_path: dossierPath,
      archive_age_seconds: archiveAgeSeconds,
      previous_inject_count: 0,
    });

    return _makeEnvelopeOutput('SessionStart', finalContext);

  } catch (_e) {
    // Top-level safety net — fail-open.
    try {
      _audit(cwd, {
        type: 'dossier_compensation_skipped',
        version: 1,
        reason: 'signal_unavailable',
      });
    } catch (_e2) { /* swallow */ }
    return null;
  }
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
      // SKIP-13: env kill switch (SessionStart path).
      _emitInjectionSkipped(resolveSafeCwd(event && event.cwd), SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'SessionStart',
        sub_reason: 'env_kill_switch',
      });
      return { output: nop, action: 'skipped_kill_switch', reason: 'env_kill_switch' };
    }

    const cwd = resolveSafeCwd(event && event.cwd);
    const cfg = loadResilienceConfig(cwd);
    if (!cfg.enabled || cfg.kill_switch) {
      // SKIP-14: config disabled / config kill_switch (SessionStart path).
      _emitInjectionSkipped(cwd, SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'SessionStart',
        sub_reason: cfg.kill_switch ? 'config_kill_switch' : 'config_disabled',
      });
      return { output: nop, action: 'skipped_config', reason: 'disabled' };
    }

    const stateDir = path.join(cwd, '.orchestray', 'state');
    const dossierPath = path.join(stateDir, 'resilience-dossier.json');

    // W6 — Dossier compensation: if a previous session wrote the dossier
    // but never injected it (orphan pattern), re-inject it now synchronously
    // before the normal inject path. Falls through (returns null) when
    // compensation is not applicable. The normal inject path that follows
    // will then run. When compensation fires successfully, we return early
    // so the normal inject path does NOT double-inject.
    const compensationOutput = _tryDossierCompensation(cwd, dossierPath, cfg);
    if (compensationOutput !== null) {
      return { output: compensationOutput, action: 'compensation_injected' };
    }

    if (!_exists(dossierPath)) {
      // SKIP-15: dossier file missing (SessionStart cold-start).
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_MISSING, {
        trigger: 'SessionStart',
      });
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
      // SKIP-16: dossier file present but unreadable (SessionStart path).
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_CORRUPT, {
        trigger: 'SessionStart',
        sub_reason: 'read_failed',
        err_code: (err && err.code) || 'read_failed',
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
      // SKIP-17: dossier on disk failed schema parse (SessionStart path).
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_FILE_CORRUPT, {
        trigger: 'SessionStart',
        sub_reason: 'parse_failed',
        parse_reason: parsed.reason,
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
      // SKIP-18: dossier present but orchestration is already completed (SessionStart path).
      _emitInjectionSkipped(cwd, SKIP_REASON.DOSSIER_STALE, {
        trigger: 'SessionStart',
        orchestration_id: dossier.orchestration_id || null,
        sub_reason: 'completed',
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
      // SKIP-19: shadow_mode config (SessionStart path).
      _emitInjectionSkipped(cwd, SKIP_REASON.KILL_SWITCH_SET, {
        trigger: 'SessionStart',
        sub_reason: 'shadow_mode',
        orchestration_id: dossier.orchestration_id || null,
        bytes_would_inject: bytesInjected,
      });
      return { output: nop, action: 'shadow_dry_run', orchestration_id: dossier.orchestration_id || null };
    }

    // Attribution fix (W0d): when the dossier's own orchestration_id is null
    // (common for completed orchs whose dossier was written after orch close),
    // fall back to the active orchestration marker on disk so the orphan
    // detector can correlate dossier_written / dossier_injected pairs.
    // Fallback only fires on strict null/undefined — empty string is NOT null.
    const dossierOrchId = (dossier.orchestration_id != null)
      ? dossier.orchestration_id
      : peekOrchestrationId(cwd);
    _audit(cwd, {
      type: 'dossier_injected',
      version: 1,
      trigger: 'SessionStart',
      orchestration_id: dossierOrchId,
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
      // SKIP-20: unexpected throw inside the SessionStart handler.
      _emitInjectionSkipped(resolveSafeCwd(event && event.cwd), SKIP_REASON.UNKNOWN_SKIP, {
        trigger: 'SessionStart',
        sub_reason: 'exception',
        err_code: (err && err.code) || 'throw',
      });
    } catch (_e) { /* swallow */ }
    return { output: nop, action: 'skipped_corrupt', reason: 'exception' };
  }
}

function _audit(cwd, payload) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    if (!_dirExists(auditDir)) return;
    writeEvent(payload, { cwd });
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
    const sessionSource = event.source || process.env.SESSION_SOURCE || '';
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
  SKIP_REASON,
  _emitInjectionSkipped,
  _tryDossierCompensation,
  COMPENSATION_STALE_MS,
  COMPENSATION_SIZE_CAP_BYTES,
  COMPENSATION_TAIL_LINE_LIMIT,
};
