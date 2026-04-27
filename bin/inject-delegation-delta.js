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

    // Markers missing → emit skip (caller produced an unstructured prompt;
    // the helper returned type='full' with reason='markers_missing'). Pass
    // through unchanged.
    if (result.type === 'full' && result.reason === 'markers_missing') {
      emitSkip(cwd, orchestration_id, agent_type, 'markers_missing');
      emitContinue();
      process.exit(0);
      return;
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
