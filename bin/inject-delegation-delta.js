#!/usr/bin/env node
'use strict';

/**
 * inject-delegation-delta.js — PreToolUse:Agent hook (v2.2.2 Bucket C1).
 *
 * Moves the R-DELEG-DELTA pre-render protocol (formerly PM Section
 * "Delegation Delta Pre-Render", agents/pm.md ~line 619-636) out of
 * PM in-prompt prose and into deterministic hook execution. This means
 * the delegation-delta substitution fires on every Agent() spawn,
 * regardless of whether the operator hand-crafted the delegation
 * prompt or the orchestrator forgot the step.
 *
 * Behaviour (v222-design.md §Bucket C → C1):
 *   - On `tool_name === 'Agent'`, parse stdin, resolve cwd, look up the
 *     active orchestration_id from `.orchestray/audit/current-orchestration.json`.
 *   - Call `bin/_lib/spawn-context-delta.js#computeDelta(prompt, opts)`.
 *     - `result.type === 'full'` → emit `delegation_delta_emit` with
 *       `type_emitted: 'full'`, register Slot-4 cache breakpoint, pass
 *       the original prompt through unchanged.
 *     - `result.type === 'delta'` → emit `delegation_delta_emit` with
 *       `type_emitted: 'delta'` and `full_bytes_avoided`, substitute
 *       `result.delta_text` for the prompt via `updatedInput.prompt`.
 *   - Kill switches (any one short-circuits to `delegation_delta_skip`):
 *       - `process.env.ORCHESTRAY_DISABLE_DELEGATION_DELTA === '1'`
 *       - `config.pm_protocol.delegation_delta.enabled === false`
 *   - Post-compact resume detection: read
 *     `.orchestray/state/resilience-dossier.json`. If
 *     `last_compact_detected_at` is set AND no spawn-prefix-cache file
 *     exists for `(orch, agent_type)`, pass `postCompactResume: true`
 *     to computeDelta.
 *   - Fail-open contract: ANY thrown exception → emit
 *     `delegation_delta_skip` with `reason: 'compute_delta_threw'` and
 *     pass the original prompt through unchanged. Never block the
 *     spawn, never exit non-zero.
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 *         { tool_name, tool_input: { prompt, subagent_type, ... }, cwd, ... }
 * Output: JSON on stdout:
 *           { hookSpecificOutput: { hookEventName: "PreToolUse",
 *             permissionDecision: "allow",
 *             updatedInput: { ...original tool_input, prompt: <maybe-mutated> }
 *           }, continue: true }
 *         OR (skip / kill-switch / unhandled tool):
 *           { continue: true }
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

const PREFIX_CACHE_DIR_REL = path.join('.orchestray', 'state', 'spawn-prefix-cache');
const DOSSIER_REL          = path.join('.orchestray', 'state', 'resilience-dossier.json');
const CONFIG_REL           = path.join('.orchestray', 'config.json');

// ---------------------------------------------------------------------------
// W3 fix: mechanical marker injection (orch-20260428T123030Z-w226-mechanical-redo)
//
// When the PM produces a delegation prompt without delta markers, inject them
// mechanically using heading-based heuristics so `computeDelta` can proceed.
//
// The split boundary is the FIRST heading that is definitionally per-spawn
// (task-specific). Everything before it is treated as static (cache-stable);
// everything from that heading onward is the per-spawn portion.
//
// Per-spawn boundary headings (ordered by priority — first match wins):
//   ## Task            — the subtask description
//   ## Files to        — file ownership list (varies per task)
//   ## Context from    — prior-agent handoff (varies per spawn)
//   ## Acceptance Rubric — arch-synthesised per task
//   ## Correction Patterns — match-set varies
//   ## User Correction   — user-specific, varies
//
// If no boundary heading is found (the prompt contains no per-spawn sections)
// the entire prompt is wrapped as static with an empty per-spawn section.
// This is a valid degenerate case: first spawn treats the whole prompt as
// static, caches it, and subsequent spawns (which must also lack markers)
// get a full-prompt pass-through — no regression from the pre-fix behaviour.
//
// Returns { markedPrompt: string } on success, null on failure.
// ---------------------------------------------------------------------------

const PER_SPAWN_BOUNDARY_HEADINGS = [
  /^## Task(\b|:|\s)/im,
  /^## Files to/im,
  /^## Context from/im,
  /^## Acceptance Rubric/im,
  /^## Correction Pattern/im,
  /^## User Correction/im,
];

const MARK_STATIC_BEGIN    = '<!-- delta:static-begin -->';
const MARK_STATIC_END      = '<!-- delta:static-end -->';
const MARK_PER_SPAWN_BEGIN = '<!-- delta:per-spawn-begin -->';
const MARK_PER_SPAWN_END   = '<!-- delta:per-spawn-end -->';

/**
 * Attempt to inject delta markers into a prompt that lacks them.
 *
 * @param {string} prompt — raw delegation prompt without markers
 * @returns {string|null} marked prompt, or null if injection is not applicable
 */
function injectMarkersHeuristically(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;

  // Bail immediately if markers are already present (no-op guard).
  if (prompt.includes(MARK_STATIC_BEGIN)) return null;

  const lines = prompt.split('\n');

  // Find the first per-spawn boundary heading.
  let splitLineIndex = -1;
  outer:
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of PER_SPAWN_BOUNDARY_HEADINGS) {
      if (re.test(line)) {
        splitLineIndex = i;
        break outer;
      }
    }
  }

  let staticPortion;
  let perSpawnPortion;

  if (splitLineIndex <= 0) {
    // No per-spawn boundary found (or it's the very first line).
    // Treat entire prompt as static; per-spawn is empty.
    staticPortion  = prompt;
    perSpawnPortion = '';
  } else {
    // Split at the boundary line; boundary line starts the per-spawn section.
    staticPortion   = lines.slice(0, splitLineIndex).join('\n');
    perSpawnPortion = lines.slice(splitLineIndex).join('\n');
    // Trim trailing newline from static to avoid double-newline in the
    // assembled prompt (the marker template adds its own newlines).
    staticPortion = staticPortion.replace(/\n+$/, '');
  }

  return (
    MARK_STATIC_BEGIN + '\n' +
    staticPortion + '\n' +
    MARK_STATIC_END + '\n' +
    MARK_PER_SPAWN_BEGIN + '\n' +
    perSpawnPortion + '\n' +
    MARK_PER_SPAWN_END
  );
}

// ---------------------------------------------------------------------------
// stdout helpers
// ---------------------------------------------------------------------------

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function emitAllowWithUpdatedInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }));
}

// ---------------------------------------------------------------------------
// Kill-switch helpers (mirrors spawn-context-delta.js#isDisabled)
// ---------------------------------------------------------------------------

function isKillSwitchEnv() {
  return process.env.ORCHESTRAY_DISABLE_DELEGATION_DELTA === '1';
}

function isKillSwitchConfig(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, CONFIG_REL), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg === 'object') {
      const block = cfg.pm_protocol && cfg.pm_protocol.delegation_delta;
      if (block && block.enabled === false) return true;
    }
  } catch (_e) { /* fail-open: defaults apply */ }
  return false;
}

// ---------------------------------------------------------------------------
// Orchestration_id lookup
// ---------------------------------------------------------------------------

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return orchData && typeof orchData.orchestration_id === 'string'
      ? orchData.orchestration_id
      : null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Post-compact resume detection
// ---------------------------------------------------------------------------

function detectPostCompactResume(cwd, orchestration_id, agent_type) {
  try {
    const dp = path.join(cwd, DOSSIER_REL);
    if (!fs.existsSync(dp)) return false;
    const j = JSON.parse(fs.readFileSync(dp, 'utf8'));
    if (!j || typeof j !== 'object') return false;
    if (!j.last_compact_detected_at) return false;

    // Compact detected — check whether a spawn-prefix-cache file exists for
    // the (orch, agent_type) pair. If it does NOT exist, this is a fresh
    // post-compact spawn and we must force type='full'.
    const cacheFile = path.join(
      cwd,
      PREFIX_CACHE_DIR_REL,
      `${orchestration_id}-${agent_type}.txt`
    );
    return !fs.existsSync(cacheFile);
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spawn-counter sidecar (v2.2.2 Fix #2 — `spawn_n` for delegation_delta_emit
// and delegation_delta_skip). The schema marks spawn_n as required for emit;
// for skip we pass it through if available so the skip's position in the
// sequence is recoverable. The counter lives at
// `.orchestray/state/spawn-prefix-cache/<orch>-<agent>.count` next to the
// prefix-cache file so a single fs.unlink + dir-sweep clears both. Counter
// is read+incremented per call; pre-existing emits without a counter file
// resolve to 1 (matches `first_spawn` semantics).
// ---------------------------------------------------------------------------

function nextSpawnN(cwd, orchestration_id, agent_type) {
  try {
    const dir = path.join(cwd, PREFIX_CACHE_DIR_REL);
    fs.mkdirSync(dir, { recursive: true });
    const counterPath = path.join(dir, `${orchestration_id}-${agent_type}.count`);
    let n = 0;
    try {
      const raw = fs.readFileSync(counterPath, 'utf8').trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) n = parsed;
    } catch (_e) { /* missing file = 0 */ }
    n += 1;
    try { fs.writeFileSync(counterPath, String(n), 'utf8'); } catch (_e) { /* swallow */ }
    return n;
  } catch (_e) {
    return 1;
  }
}

function peekSpawnN(cwd, orchestration_id, agent_type) {
  try {
    if (!orchestration_id || !agent_type) return null;
    const counterPath = path.join(cwd, PREFIX_CACHE_DIR_REL, `${orchestration_id}-${agent_type}.count`);
    const raw = fs.readFileSync(counterPath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed + 1;
    return 1;
  } catch (_e) {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Audit-event emission helpers (always fail-soft)
// ---------------------------------------------------------------------------

function emitSkip(cwd, orchestration_id, agent_type, reason, extra) {
  try {
    const payload = {
      version: 1,
      type: 'delegation_delta_skip',
      orchestration_id: orchestration_id || null,
      agent_type: agent_type || null,
      reason,
    };
    if (extra && typeof extra === 'object') {
      Object.assign(payload, extra);
    }
    writeEvent(payload, { cwd });
  } catch (_e) { /* swallow — advisory hook never crashes */ }
}

function emitFromResult(cwd, orchestration_id, agent_type, result) {
  try {
    const type_emitted = result.type === 'delta' ? 'delta' : 'full';
    const spawn_n = nextSpawnN(cwd, orchestration_id, agent_type);
    const payload = {
      version: 1,
      type: 'delegation_delta_emit',
      orchestration_id: orchestration_id || null,
      agent_type: agent_type || null,
      spawn_n,
      type_emitted,
      prefix_hash: result.prefix_hash || null,
      prefix_bytes: typeof result.prefix_bytes === 'number' ? result.prefix_bytes : 0,
      delta_bytes: typeof result.delta_bytes === 'number' ? result.delta_bytes : null,
      full_bytes_avoided: typeof result.full_bytes_avoided === 'number' ? result.full_bytes_avoided : 0,
      reason: result.reason || null,
      post_compact_resume: result.reason === 'post_compact_resume',
    };
    writeEvent(payload, { cwd });
  } catch (_e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Cache-breakpoint registration on first spawn (Slot 4 priming)
// ---------------------------------------------------------------------------

function registerSlot4(orchestration_id, result) {
  try {
    const { registerOpportunisticArtifact } = require('./_lib/cache-breakpoint-manifest');
    if (!result || !result.prefix_path || !result.prefix_bytes) return;
    registerOpportunisticArtifact({
      slot: 4,
      path: result.prefix_path,
      bytes: result.prefix_bytes,
      prefix_hash: result.prefix_hash || null,
      orchestration_id,
    });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Main stdin processor
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  emitContinue();
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] inject-delegation-delta: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n');
    emitContinue();
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  // Top-level try/catch: ANY unexpected exception → fail-open silent allow.
  let cwd = '';
  let orchestration_id = null;
  let agent_type = null;

  try {
    let event;
    try {
      event = JSON.parse(input || '{}');
    } catch (_e) {
      emitContinue();
      process.exit(0);
      return;
    }

    // Defensive: only act on Agent dispatches.
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') {
      emitContinue();
      process.exit(0);
      return;
    }

    const toolInput = event.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
      emitContinue();
      process.exit(0);
      return;
    }

    agent_type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : '';
    if (!agent_type) {
      // Defensive — no agent_type means the dispatch is malformed; let the
      // downstream gate handle it.
      emitContinue();
      process.exit(0);
      return;
    }

    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_e) {
      cwd = process.cwd();
    }

    // Kill switches.
    if (isKillSwitchEnv()) {
      emitSkip(cwd, null, agent_type, 'kill_switch_env');
      emitContinue();
      process.exit(0);
      return;
    }
    if (isKillSwitchConfig(cwd)) {
      emitSkip(cwd, null, agent_type, 'kill_switch_config');
      emitContinue();
      process.exit(0);
      return;
    }

    // Resolve orchestration_id — required to scope the prefix cache.
    orchestration_id = resolveOrchestrationId(cwd);
    if (!orchestration_id) {
      emitSkip(cwd, null, agent_type, 'no_orchestration_active');
      emitContinue();
      process.exit(0);
      return;
    }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    if (prompt.length === 0) {
      emitSkip(cwd, orchestration_id, agent_type, 'empty_prompt');
      emitContinue();
      process.exit(0);
      return;
    }

    // Detect post-compact resume scenario (defence-in-depth on top of the
    // helper's own dossier auto-detect).
    const postCompactResume = detectPostCompactResume(cwd, orchestration_id, agent_type);

    // Call the helper.
    let result;
    try {
      const { computeDelta } = require('./_lib/spawn-context-delta');
      result = computeDelta(prompt, {
        cwd,
        orchestration_id,
        agent_type,
        postCompactResume,
      });
    } catch (e) {
      emitSkip(cwd, orchestration_id, agent_type, 'compute_delta_threw', {
        error_class: (e && e.constructor && e.constructor.name) || 'Error',
      });
      emitContinue();
      process.exit(0);
      return;
    }

    if (!result || typeof result !== 'object') {
      emitSkip(cwd, orchestration_id, agent_type, 'compute_delta_threw', {
        error_class: 'NullResult',
      });
      emitContinue();
      process.exit(0);
      return;
    }

    // Markers missing → attempt mechanical injection (W3 fix).
    //
    // The PM did not wrap the delegation with delta markers. Rather than
    // silently skipping, inject them heuristically so computeDelta can build
    // the prefix cache — even though we always pass the ORIGINAL (unmarked)
    // prompt to the model. This preserves cache-pinning benefits without
    // exposing marker syntax to the spawned agent.
    //
    // Contract for injected spawns:
    //   - The marked prompt is used ONLY for prefix-cache computation.
    //   - The model always receives the original prompt unchanged (type='full').
    //   - Emits delegation_delta_emit with type_emitted='full' and
    //     reason='markers_injected' so telemetry distinguishes this path
    //     from a genuine PM-authored first_spawn.
    //   - On injection failure, falls back to delegation_delta_skip(markers_missing).
    if (result.type === 'full' && result.reason === 'markers_missing') {
      const markedPrompt = injectMarkersHeuristically(prompt);
      if (markedPrompt) {
        let retryResult;
        try {
          const { computeDelta } = require('./_lib/spawn-context-delta');
          retryResult = computeDelta(markedPrompt, {
            cwd,
            orchestration_id,
            agent_type,
            postCompactResume,
          });
        } catch (_e) {
          retryResult = null;
        }
        if (retryResult && retryResult.reason !== 'markers_missing' && retryResult.reason !== 'disabled') {
          // computeDelta processed the marked prompt successfully.
          // Override reason to signal the injection path for telemetry.
          result = Object.assign({}, retryResult, {
            type: 'full',  // Always pass original prompt to the model (not delta_text).
            reason: 'markers_injected',
          });
          // Fall through to the standard type='full' dispatch below.
        } else {
          // Retry still failed (should be rare — e.g., injection produced
          // malformed markers). Fall back to skip.
          emitSkip(cwd, orchestration_id, agent_type, 'markers_missing');
          emitContinue();
          process.exit(0);
          return;
        }
      } else {
        // Injection returned null (guard tripped or prompt already has markers).
        // Fall back to original skip behavior.
        emitSkip(cwd, orchestration_id, agent_type, 'markers_missing');
        emitContinue();
        process.exit(0);
        return;
      }
    }

    // Helper kill-switch tripped (defence-in-depth: helper short-circuited
    // even though our checks above did not). Emit skip and pass through.
    if (result.type === 'full' && result.reason === 'disabled') {
      emitSkip(cwd, orchestration_id, agent_type, 'kill_switch_helper');
      emitContinue();
      process.exit(0);
      return;
    }

    // Disk write failed — emit the emit event with reason for diagnostic
    // visibility, but still pass the original prompt through (helper
    // already returned `text === prompt`).
    if (result.type === 'full' && result.reason === 'disk_write_failed') {
      emitFromResult(cwd, orchestration_id, agent_type, result);
      emitContinue();
      process.exit(0);
      return;
    }

    if (result.type === 'full') {
      // First spawn / hash mismatch / post-compact resume — register Slot-4
      // breakpoint and let the original prompt pass through.
      registerSlot4(orchestration_id, result);
      emitFromResult(cwd, orchestration_id, agent_type, result);
      emitContinue();
      process.exit(0);
      return;
    }

    if (result.type === 'delta') {
      // Substitute the small delta block for the full prompt.
      emitFromResult(cwd, orchestration_id, agent_type, result);

      const newToolInput = Object.assign({}, toolInput, {
        prompt: result.delta_text,
      });
      emitAllowWithUpdatedInput(newToolInput);
      process.exit(0);
      return;
    }

    // Unknown result.type — be defensive.
    emitSkip(cwd, orchestration_id, agent_type, 'compute_delta_threw', {
      error_class: 'UnknownResultType',
    });
    emitContinue();
    process.exit(0);
  } catch (e) {
    // Top-level catch — never let this hook block a spawn.
    try {
      emitSkip(cwd || process.cwd(), orchestration_id, agent_type,
        'compute_delta_threw',
        { error_class: (e && e.constructor && e.constructor.name) || 'Error' });
    } catch (_inner) { /* swallow */ }
    try { emitContinue(); } catch (_e) { /* swallow */ }
    process.exit(0);
  }
});
