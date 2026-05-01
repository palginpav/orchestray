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
 * Activates only when `tool_input.subagent_type === "reviewer"`. The reviewer
 * delegation prompt MUST contain BOTH:
 *   1. A `## Dimensions to Apply` heading (case-insensitive on whitespace).
 *   2. A bulleted list of at least one dimension under that heading
 *      (e.g. `- correctness`).
 *
 * Either missing → exit 2 + emit `reviewer_dimensions_gate_blocked` event.
 *
 * Sibling: validate-reviewer-scope.js still emits `reviewer_dimensions_block_missing`
 * as the warn-channel telemetry (kept for backward compat — analytics dashboards
 * have learned its shape). This script is the new HARD gate.
 *
 * Kill switch: ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1 → reverts to
 * warn-only (no exit 2, but the audit event still fires for observability).
 *
 * Contract:
 *   - exit 2 when block heading or bulleted list is missing (default-on).
 *   - exit 0 when the prompt is well-formed or the kill switch is active.
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// `## Dimensions to Apply` — case-insensitive, allow flexible whitespace.
const DIMENSIONS_HEADING_RE = /^##\s+Dimensions\s+to\s+Apply\b/im;

// A bulleted list item under the heading: `- foo` or `* foo` or `+ foo`.
// Match any bullet anywhere in the prompt body — heading-adjacency is checked
// separately below by extracting the section after the heading.
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

  // Slice from the heading to the next H2 (`## ...`) or end-of-string.
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!shouldValidate(event)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    const promptBody = (event.tool_input && typeof event.tool_input.prompt === 'string')
      ? event.tool_input.prompt
      : '';

    const result = evaluateDimensions(promptBody);
    if (result.ok) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const gateDisabled = process.env.ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED === '1';
    const spawnId =
      event.agent_id ||
      event.task_id ||
      (event.tool_input && (event.tool_input.agent_id || event.tool_input.task_id)) ||
      null;

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
        'is missing the `## Dimensions to Apply` block (' + result.reason + '). Not blocking ' +
        '(ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1).\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    process.stderr.write(
      '[orchestray] validate-reviewer-dimensions: BLOCKED — reviewer delegation prompt is ' +
      'missing the `## Dimensions to Apply` block (reason: ' + result.reason + '). Add a ' +
      '`## Dimensions to Apply` heading followed by a bulleted list of dimensions ' +
      '(e.g. `- correctness`, `- security`). See agents/pm-reference/delegation-templates.md. ' +
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
  DIMENSIONS_HEADING_RE,
  BULLET_RE,
};

if (require.main === module) {
  main();
}
