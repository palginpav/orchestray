#!/usr/bin/env node
'use strict';

/**
 * validate-reviewer-dimensions.js — PreToolUse:Agent hook (v2.2.15 FN-43).
 *
 * Mechanical exit-2 promotion of the `reviewer_dimensions_block_missing`
 * warn telemetry that has fired ~45 times in recent traffic without being
 * enforced. Per `feedback_mechanical_over_prose.md`, prose-only rules drift;
 * this gate makes the rule observable and self-correcting.
 *
 * W8B (v2.3.31): folded dimension AUTOFILL into this validator instead of
 * blocking. bin/inject-review-dimensions.js emitted `updatedInput` to append
 * the `## Dimensions to Apply` block, but it runs as a SIBLING PreToolUse:Agent
 * hook — `updatedInput` from one hook does NOT propagate to another (same
 * platform constraint documented at validate-context-size-hint.js:18-34 and
 * preflight-spawn-budget.js:315). This validator ran independently and never
 * observed the injected block, so it blocked every reviewer spawn that lacked
 * a hand-written block — the injector was dead code for its stated purpose.
 * Fixed by computing the dimensions HERE, via the same
 * classifyReviewDimensions() classifier the injector used, and emitting
 * `updatedInput` from the validator that actually gates the spawn.
 * inject-review-dimensions.js is now retired (no-op, unwired from hooks.json).
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. The reviewer
 * delegation prompt should contain BOTH:
 *   1. A `## Dimensions to Apply` heading (case-insensitive on whitespace).
 *   2. A bulleted list of at least one dimension under that heading
 *      (e.g. `- correctness`).
 *
 * If either is missing, the validator computes the dimensions via the
 * classifier and appends the block itself (idempotent — a prompt that
 * already has a well-formed block is passed through untouched).
 *
 * Kill switch: ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1 → reverts to
 * warn-only (no exit 2 on the genuinely-unrecoverable path; autofill still
 * runs since it can never make things worse).
 *
 * Contract:
 *   - exit 0 when the prompt is well-formed (unchanged) OR autofill succeeds
 *     (updatedInput emitted).
 *   - exit 2 only if autofill itself throws / cannot run AND the kill switch
 *     is not active (should be rare — classifier fails open to "all").
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { classifyReviewDimensions } = require('./_lib/classify-review-dimensions');
const { resolveFilesChanged } = require('./_lib/resolve-files-changed');
const { buildDimensionsBlock } = require('./_lib/build-dimensions-block');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// `## Dimensions to Apply` — case-insensitive, allow flexible whitespace.
const DIMENSIONS_HEADING_RE = /^##\s+Dimensions\s+to\s+Apply\b/im;

// A bulleted list item under the heading: `- foo` or `* foo` or `+ foo`.
const BULLET_RE = /^[\t ]*[-*+][\t ]+\S/m;

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the reviewer prompt declares dimensions correctly.
 *
 * @param {string} promptBody
 * @returns {{ ok: boolean, reason?: string }}
 */
function evaluateDimensions(promptBody) {
  if (typeof promptBody !== 'string' || promptBody.length === 0) {
    return { ok: false, reason: 'empty_prompt' };
  }

  const headingMatch = DIMENSIONS_HEADING_RE.exec(promptBody);
  if (!headingMatch) {
    return { ok: false, reason: 'missing_heading' };
  }

  const afterHeading = promptBody.slice(headingMatch.index + headingMatch[0].length);
  const nextSectionIdx = afterHeading.search(/^##\s+\S/m);
  const sectionBody = nextSectionIdx === -1
    ? afterHeading
    : afterHeading.slice(0, nextSectionIdx);

  if (!BULLET_RE.test(sectionBody)) {
    return { ok: false, reason: 'missing_bulleted_list' };
  }

  return { ok: true };
}

/**
 * Return true if this event should trigger the check.
 */
function shouldValidate(event) {
  if (!event) return false;
  const toolName = event.tool_name || event.hook_event_matcher || '';
  if (toolName !== 'Agent') return false;
  const toolInput = event.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return false;
  return toolInput.subagent_type === 'reviewer';
}

// ---------------------------------------------------------------------------
// Orchestration id + config (mirrors the retired injector's helpers)
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

function loadScopingConfig(cwd) {
  try {
    const cfgPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const scoping = cfg && cfg.review_dimension_scoping;
    if (scoping && typeof scoping === 'object') {
      return { enabled: scoping.enabled !== false };
    }
    return { enabled: true };
  } catch (_e) {
    return { enabled: true };
  }
}

/**
 * @param {string} cwd
 * @returns {{ active: boolean, source: string|null }}
 */
function killSwitchStatus(cwd) {
  if (process.env.ORCHESTRAY_DISABLE_REVIEWER_SCOPING === '1') {
    return { active: true, source: 'env' };
  }
  const cfg = loadScopingConfig(cwd);
  if (cfg.enabled === false) {
    return { active: true, source: 'config' };
  }
  return { active: false, source: null };
}

// ---------------------------------------------------------------------------
// Audit emit
// ---------------------------------------------------------------------------

function emitGateEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

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

/**
 * Compute and append the `## Dimensions to Apply` block for a spawn whose
 * prompt lacks one. Never throws — returns null on any internal failure so
 * the caller can decide what to do (fail-open).
 *
 * @param {object} event
 * @param {string} cwd
 * @param {string} promptBody
 * @returns {{ newPrompt: string, dimensions: ("all"|string[]), rationale: string, killSwitch: {active:boolean, source:string|null} } | null}
 */
function computeAutofill(event, cwd, promptBody) {
  try {
    const ks = killSwitchStatus(cwd);
    if (ks.active) {
      return {
        newPrompt: promptBody + buildDimensionsBlock('all'),
        dimensions: 'all',
        rationale: 'review_dimension_scoping disabled (' + ks.source + ')',
        killSwitch: ks,
      };
    }

    const orchestrationId = resolveOrchestrationId(cwd);
    let filesResult;
    try {
      filesResult = resolveFilesChanged(cwd, orchestrationId);
    } catch (_e) {
      filesResult = { files_changed: [], source: 'empty_no_developer' };
    }
    const { files_changed, source: files_changed_source } = filesResult;

    let diff_text = null;
    try {
      const diffMatch = promptBody.match(/(?:^|\n)##\s+Git\s+Diff\s*\n([\s\S]*?)(?=\n##\s|$)/i);
      if (diffMatch && diffMatch[1]) diff_text = diffMatch[1].trim() || null;
    } catch (_de) { /* fail-open */ }

    let classification;
    try {
      classification = classifyReviewDimensions({
        files_changed,
        diff_text,
        config: loadScopingConfig(cwd),
      });
    } catch (_e) {
      classification = { review_dimensions: 'all', rationale: 'classifier error — fallback to all' };
    }

    const { review_dimensions, rationale } = classification;
    const block = buildDimensionsBlock(review_dimensions);

    return {
      newPrompt: promptBody + block,
      dimensions: review_dimensions,
      rationale,
      killSwitch: ks,
      files_changed_count: files_changed.length,
      files_changed_source,
    };
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    emitContinue();
    process.exit(0);
  }
  setImmediate(() => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      emitContinue();
      process.exit(0);
    }

    if (!shouldValidate(event)) {
      emitContinue();
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    const promptBody = (event.tool_input && typeof event.tool_input.prompt === 'string')
      ? event.tool_input.prompt
      : '';

    const spawnId =
      event.agent_id ||
      event.task_id ||
      (typeof event.tool_use_id === 'string' && event.tool_use_id) ||
      (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) ||
      null;

    const result = evaluateDimensions(promptBody);
    if (result.ok) {
      // Already well-formed — pass through byte-identical, no double-inject.
      emitContinue();
      process.exit(0);
    }

    const autofill = computeAutofill(event, cwd, promptBody);
    if (autofill) {
      emitGateEvent(cwd, {
        version:        SCHEMA_VERSION,
        schema_version: SCHEMA_VERSION,
        type:           'reviewer_dimensions_autofilled',
        spawn_id:       spawnId,
        reason:         result.reason,
        dimensions:     autofill.dimensions,
        rationale:      autofill.rationale,
        source:         'validator_autofill',
      });
      const newToolInput = Object.assign({}, event.tool_input, { prompt: autofill.newPrompt });
      emitAllowWithUpdatedInput(newToolInput);
      process.exit(0);
    }

    // Autofill itself failed (should be rare — classifyReviewDimensions fails
    // open to "all" internally). Fall back to the original hard-gate behaviour.
    const gateDisabled = process.env.ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED === '1';

    emitGateEvent(cwd, {
      version:        SCHEMA_VERSION,
      schema_version: SCHEMA_VERSION,
      type:           gateDisabled ? 'reviewer_dimensions_gate_warn' : 'reviewer_dimensions_gate_blocked',
      spawn_id:       spawnId,
      reason:         result.reason,
      gate_disabled:  gateDisabled,
    });

    if (gateDisabled) {
      process.stderr.write(
        '[orchestray] validate-reviewer-dimensions: WARN (kill switch active) — reviewer prompt ' +
        'is missing the `## Dimensions to Apply` block (' + result.reason + ') and autofill failed. ' +
        'Not blocking (ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1).\n'
      );
      emitContinue();
      process.exit(0);
    }

    process.stderr.write(
      '[orchestray] validate-reviewer-dimensions: BLOCKED — reviewer delegation prompt is ' +
      'missing the `## Dimensions to Apply` block (reason: ' + result.reason + ') and autofill ' +
      'failed internally. Add a `## Dimensions to Apply` heading followed by a bulleted list of ' +
      'dimensions (e.g. `- correctness`, `- security`). See agents/pm-reference/delegation-templates.md. ' +
      'Kill switch: ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'reviewer_dimensions_block_missing:' + result.reason,
    }));
    process.exit(2);
  });
}

module.exports = {
  evaluateDimensions,
  shouldValidate,
  computeAutofill,
  killSwitchStatus,
  DIMENSIONS_HEADING_RE,
  BULLET_RE,
};

if (require.main === module) {
  main();
}
