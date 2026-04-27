#!/usr/bin/env node
'use strict';

/**
 * inject-output-shape.js — PreToolUse:Agent hook (v2.2.2 Bucket C2).
 *
 * Moves the R-OUT-SHAPE composer (formerly PM Section 9.7) and the
 * Section 12.a Handoff Contract suffix out of PM in-prompt prose and
 * into deterministic hook execution. This means the smart-output-
 * shaping addendum and the mandatory `## Structured Result` JSON
 * contract suffix fire on every Agent() spawn, regardless of who
 * composed the delegation prompt.
 *
 * Behaviour (v222-design.md §Bucket C → C2):
 *   - On `tool_name === 'Agent'`, parse stdin, call
 *     `bin/_lib/output-shape.js#decideShape(subagent_type, { cwd })`.
 *   - For `category !== 'none'` roles:
 *       Block 1 — Output Style (caveman) when `decideShape` returns
 *                 non-null `caveman_text`. Hybrid + prose-heavy roles
 *                 (NOT structured-only) — already gated by
 *                 output-shape.js itself.
 *       Block 2 — Output token budget when `decideShape` returns
 *                 non-null `length_cap`.
 *       Block 3 — Handoff Contract suffix (Section 12.a) — ALL
 *                 non-`none` roles, regardless of staged_flip_allowlist.
 *                 This is the load-bearing fix for D3 Finding #5.
 *   - For roles in the `staged_flip_allowlist` whose `decideShape`
 *     returns a non-null `output_config_format` (researcher, tester),
 *     also set `updatedInput.outputConfig.format` to the schema. The
 *     allowlist gates ONLY structured-output schema enforcement; the
 *     addendum + contract suffix are not gated by it.
 *   - Excluded roles (pm, haiku-scout, orchestray-housekeeper,
 *     pattern-extractor) → `decideShape` returns null → no event,
 *     no prompt mutation.
 *   - Kill switches:
 *       - `output_shape.enabled === false` (config) → `decideShape`
 *         returns `category: 'none'` → emit event with `category: 'none'`
 *         (intentional opt-out telemetry preserved), no mutation.
 *       - `process.env.ORCHESTRAY_DISABLE_OUTPUT_SHAPE === '1'` → no
 *         event, no mutation, exit 0.
 *
 *   - Fail-open contract: ANY thrown exception → no `updatedInput`,
 *     pass the original prompt through unchanged. Never block the
 *     spawn, never exit non-zero.
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 *         { tool_name, tool_input: { prompt, subagent_type, ... }, cwd, ... }
 * Output: JSON on stdout:
 *           { hookSpecificOutput: { hookEventName: "PreToolUse",
 *             permissionDecision: "allow",
 *             updatedInput: { ...original tool_input, prompt: <appended>,
 *                             outputConfig?: { format: <schema> } }
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
// v2.2.2 Fix #7: single source of truth for the Section 12.a suffix shared
// with bin/validate-task-completion.js and the C2 unit test.
const { HANDOFF_CONTRACT_SUFFIX } = require('./_lib/handoff-contract-text');

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
// Orchestration_id lookup (for audit-event correlation)
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
// Audit-event emission (always fail-soft)
// ---------------------------------------------------------------------------

function emitApplied(cwd, orchestration_id, session_id, role, shape) {
  try {
    const payload = {
      version: 1,
      type: 'output_shape_applied',
      orchestration_id: orchestration_id || null,
      session_id: typeof session_id === 'string' && session_id.length > 0 ? session_id : null,
      // task_id is not available at the PreToolUse:Agent boundary — the
      // Agent tool signature carries `description` but no task_id. Schema
      // marks task_id nullable for output_shape_applied since v2.2.2.
      task_id: null,
      role: role,
      category: shape.category,
      caveman: shape.caveman_text != null,
      structured: shape.output_config_format != null,
      length_cap: typeof shape.length_cap === 'number' ? shape.length_cap : null,
      baseline_output_tokens: null,
      observed_output_tokens: null,
      accuracy_holds: null,
      reason: shape.reason || null,
    };
    writeEvent(payload, { cwd });
  } catch (_e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Prompt assembly: append the addendum + contract suffix to the END of the
// prompt body. Use \n\n separators to mirror PM prose conventions.
// ---------------------------------------------------------------------------

function buildAppendix(shape) {
  const parts = [];

  // Block 1 — caveman addendum (only when non-null; structured-only roles
  // skip caveman per output-shape.js:378).
  if (shape.caveman_text) {
    parts.push('\n\n## Output Style\n\n' + shape.caveman_text);
  }

  // Block 2 — length cap (only when non-null; structured-only roles skip
  // length cap per output-shape.js:391).
  if (typeof shape.length_cap === 'number' && shape.length_cap > 0) {
    parts.push(
      '\n\n**Output token budget:** ≤ ' + shape.length_cap +
      ' tokens; the structured JSON block is exempt from this cap.'
    );
  }

  // Block 3 — Handoff Contract suffix (load-bearing per D3 Finding #5).
  // Fires for ALL non-`none` roles regardless of staged_flip_allowlist.
  parts.push(HANDOFF_CONTRACT_SUFFIX);

  return parts.join('');
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
    process.stderr.write('[orchestray] inject-output-shape: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n');
    emitContinue();
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  // Top-level try/catch: ANY unexpected exception → fail-open.
  try {
    // Env kill-switch: zero-overhead exit.
    if (process.env.ORCHESTRAY_DISABLE_OUTPUT_SHAPE === '1') {
      emitContinue();
      process.exit(0);
      return;
    }

    let event;
    try {
      event = JSON.parse(input || '{}');
    } catch (_e) {
      emitContinue();
      process.exit(0);
      return;
    }

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

    const subagent_type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : '';
    if (!subagent_type) {
      emitContinue();
      process.exit(0);
      return;
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_e) {
      cwd = process.cwd();
    }

    let shape;
    try {
      const { decideShape } = require('./_lib/output-shape');
      shape = decideShape(subagent_type, { cwd });
    } catch (_e) {
      // Helper threw — fail-open silent.
      emitContinue();
      process.exit(0);
      return;
    }

    // Excluded role OR unknown role → no event, no mutation.
    if (shape == null) {
      emitContinue();
      process.exit(0);
      return;
    }

    const orchestration_id = resolveOrchestrationId(cwd);
    const session_id = typeof event.session_id === 'string' ? event.session_id : null;

    // category === 'none' (kill switch tripped OR project-intent / platform-
    // oracle role): emit telemetry but do not mutate the prompt.
    if (shape.category === 'none') {
      emitApplied(cwd, orchestration_id, session_id, subagent_type, shape);
      emitContinue();
      process.exit(0);
      return;
    }

    // Non-`none` shape — append addendum + contract suffix.
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    const appendix = buildAppendix(shape);
    const newPrompt = prompt + appendix;

    const newToolInput = Object.assign({}, toolInput, { prompt: newPrompt });

    // Structured-output schema enforcement (gated by staged_flip_allowlist
    // inside output-shape.js → returns non-null only for researcher + tester
    // by default).
    if (shape.output_config_format != null) {
      const existing = (toolInput.outputConfig && typeof toolInput.outputConfig === 'object')
        ? toolInput.outputConfig
        : {};
      newToolInput.outputConfig = Object.assign({}, existing, {
        format: shape.output_config_format,
      });
    }

    emitApplied(cwd, orchestration_id, session_id, subagent_type, shape);
    emitAllowWithUpdatedInput(newToolInput);
    process.exit(0);
  } catch (_e) {
    try { emitContinue(); } catch (_inner) { /* swallow */ }
    process.exit(0);
  }
});
