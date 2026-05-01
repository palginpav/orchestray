#!/usr/bin/env node
'use strict';

/**
 * inject-review-dimensions.js — PreToolUse:Agent hook (v2.2.19 R-RV-DIMS).
 *
 * Wires the `classifyReviewDimensions()` helper into every reviewer Agent()
 * spawn so the `## Dimensions to Apply` block fires mechanically, regardless
 * of whether the PM authored it in the delegation prompt. Replaces the
 * PM-in-prose §3.RV protocol (which v2.1.16 proved unreliable — zero events
 * fired in a 4-reviewer audit window per the `feedback_mechanical_over_prose`
 * anti-pattern record).
 *
 * Design source: `.orchestray/kb/decisions/v2219-rv-dims-wiring.md`
 *
 * Behaviour (§3.4 decision matrix):
 *   - Non-reviewer subagent_type → `{ continue: true }`, no event, no mutation.
 *   - `ORCHESTRAY_DISABLE_REVIEW_DIMS_HOOK=1` → `{ continue: true }`, no event,
 *     zero overhead (master emergency switch).
 *   - Kill switch active (config `review_dimension_scoping.enabled=false` OR
 *     env `ORCHESTRAY_DISABLE_REVIEWER_SCOPING=1`) → no mutation; emit
 *     `review_dimension_scoping_applied` with `kill_switch_active: true`.
 *   - Prompt already contains `## Dimensions to Apply` → no mutation; emit
 *     event with `injected: false, idempotent_skip: true`.
 *   - Normal path → append `## Dimensions to Apply` block; emit event with
 *     `injected: true`.
 *   - ANY exception on any path → fail-open: `{ continue: true }`, no event.
 *
 * Files-changed source: most-recent developer `agent_stop` event in the
 * current orchestration's `events.jsonl`, capped at 200 rows / 1 MiB.
 * Falls back to `[]` (classifier returns `"all"`) on miss or error.
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 *         { tool_name, tool_input: { prompt, subagent_type, ... }, cwd, ... }
 * Output: JSON on stdout:
 *           { hookSpecificOutput: { hookEventName: "PreToolUse",
 *             permissionDecision: "allow",
 *             updatedInput: { ...original tool_input, prompt: <appended> }
 *           }, continue: true }
 *         OR (skip / kill-switch / non-reviewer / unhandled tool):
 *           { continue: true }
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }               = require('./_lib/resolve-project-cwd');
const { writeEvent }                   = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }              = require('./_lib/constants');
const { getCurrentOrchestrationFile }  = require('./_lib/orchestration-state');
const { classifyReviewDimensions }     = require('./_lib/classify-review-dimensions');
const { extractReviewDimensions }      = require('./_lib/extract-review-dimensions');

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
// Orchestration ID lookup
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
// events.jsonl scan — extract files_changed from most-recent developer
// agent_stop row in the current orchestration (§2 option a).
// Capped at 200 rows / 1 MiB.
// ---------------------------------------------------------------------------

const MAX_EVENTS_SCAN_ROWS = 200;

/**
 * @param {string} cwd
 * @param {string|null} orchestration_id
 * @returns {{ files_changed: string[], source: string }}
 */
function resolveFilesChanged(cwd, orchestration_id) {
  if (!orchestration_id) {
    return { files_changed: [], source: 'empty_no_developer' };
  }

  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch (_e) {
    return { files_changed: [], source: 'empty_no_developer' };
  }

  // Cap at 1 MiB (independent of MAX_INPUT_BYTES which governs stdin).
  const EVENTS_CAP = 1024 * 1024;
  if (raw.length > EVENTS_CAP) {
    raw = raw.slice(-EVENTS_CAP);
    // Trim the possibly-split first line.
    const nl = raw.indexOf('\n');
    if (nl >= 0) raw = raw.slice(nl + 1);
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  // Scan backward from the end for most-recent match.
  let scanned = 0;
  for (let i = lines.length - 1; i >= 0 && scanned < MAX_EVENTS_SCAN_ROWS; i--, scanned++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch (_e) { continue; }

    if (
      row.type === 'agent_stop' &&
      row.agent_type === 'developer' &&
      row.orchestration_id === orchestration_id
    ) {
      // E#3 / W#6 (v2.2.19 audit-fix R1): agent_stop rows now carry
      // `files_changed` as a top-level field (parsed from transcript's
      // ## Structured Result block by collect-agent-metrics.js). The prior
      // `row.structured_result` path never fired in production — production
      // SubagentStop payloads do not carry structured_result. Drop the
      // `|| row.structured_result_parsed` fallback (one canonical field name).
      const filesFromStop = Array.isArray(row.files_changed) ? row.files_changed
        : (row.structured_result && Array.isArray(row.structured_result.files_changed)
            ? row.structured_result.files_changed : null);
      if (filesFromStop && filesFromStop.length > 0) {
        const files = filesFromStop
          .filter((f) => typeof f === 'string' && f.trim().length > 0)
          .map((f) => f.trim());
        const deduped = [...new Set(files)];
        if (deduped.length > 0) {
          return { files_changed: deduped, source: 'developer_agent_stop' };
        }
      }
      // Row found but files_changed absent/empty — keep scanning for earlier row.
    }
  }

  return { files_changed: [], source: 'empty_no_developer' };
}

// ---------------------------------------------------------------------------
// Config loader — reads review_dimension_scoping config key
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Block renderer — §4. byte-identical to delegation-templates.md format.
// ---------------------------------------------------------------------------

const FRAGMENT_LEGEND =
  '- code-quality   → agents/reviewer-dimensions/code-quality.md\n' +
  '- performance    → agents/reviewer-dimensions/performance.md\n' +
  '- documentation  → agents/reviewer-dimensions/documentation.md\n' +
  '- operability    → agents/reviewer-dimensions/operability.md\n' +
  '- api-compat     → agents/reviewer-dimensions/api-compat.md';

/**
 * Build the `## Dimensions to Apply` block.
 *
 * @param {"all"|string[]} review_dimensions
 * @returns {string}
 */
function buildDimensionsBlock(review_dimensions) {
  if (review_dimensions === 'all') {
    return (
      '\n\n## Dimensions to Apply\n\n' +
      'all\n\n' +
      'For each item, Read the matching fragment file BEFORE forming findings:\n' +
      FRAGMENT_LEGEND + '\n\n' +
      'Read all five files. Correctness and Security are always reviewed and live in your core prompt — do NOT request fragment files for them.'
    );
  }

  // Subset case.
  const bulletList = review_dimensions.map((d) => '- ' + d).join('\n');
  return (
    '\n\n## Dimensions to Apply\n\n' +
    bulletList + '\n\n' +
    'For each item above, Read the matching fragment file BEFORE forming findings:\n' +
    FRAGMENT_LEGEND + '\n\n' +
    'Correctness and Security are always reviewed and live in your core prompt — do NOT request fragment files for them.'
  );
}

// ---------------------------------------------------------------------------
// Audit-event emission (always fail-soft)
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} fields
 */
function emitScopingEvent(cwd, fields) {
  try {
    const payload = Object.assign(
      {
        // Info #15 (v2.2.19 audit-fix R1): explicit timestamp removes autofill
        // dependency for a required field — audit-event-writer still overwrites
        // with the same value, but the event validates without relying on autofill.
        timestamp: new Date().toISOString(),
        version: 1,
        type: 'review_dimension_scoping_applied',
        orchestration_id: null,
        session_id: null,
        task_id: null,
        spawn_id: null,
        review_dimensions: 'all',
        rationale: null,
        files_changed_count: 0,
        files_changed_source: 'empty_no_developer',
        kill_switch_active: false,
        kill_switch_source: null,
        injected: false,
        idempotent_skip: false,
        reason: null,
      },
      fields
    );
    writeEvent(payload, { cwd });
  } catch (_e) { /* swallow */ }
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
    process.stderr.write('[orchestray] inject-review-dimensions: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n');
    emitContinue();
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  // Top-level try/catch: ANY unexpected exception → fail-open.
  try {
    // Master kill switch: zero overhead, no event.
    if (process.env.ORCHESTRAY_DISABLE_REVIEW_DIMS_HOOK === '1') {
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

    // Reviewer-only activation gate.
    const subagent_type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : '';
    if (subagent_type !== 'reviewer') {
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

    const orchestration_id = resolveOrchestrationId(cwd);
    const session_id = typeof event.session_id === 'string' ? event.session_id : null;
    const spawn_id   = typeof event.tool_use_id === 'string' ? event.tool_use_id : null;

    // Kill switch checks (config + env, env takes precedence).
    let kill_switch_active = false;
    let kill_switch_source = null;

    const envKS = process.env.ORCHESTRAY_DISABLE_REVIEWER_SCOPING === '1';
    const cfg   = loadScopingConfig(cwd);
    const cfgKS = cfg.enabled === false;

    if (envKS) {
      kill_switch_active = true;
      kill_switch_source = 'env';
    } else if (cfgKS) {
      kill_switch_active = true;
      kill_switch_source = 'config';
    }

    // Info #16 (v2.2.19 audit-fix R1): kill-switch precedence note.
    // Classifier owns kill-switch precedence (Rule 1). We replicate it here
    // for early-exit telemetry — both layers must agree. Removing classifier
    // Rule 1 also requires removing this short-circuit.
    if (kill_switch_active) {
      emitScopingEvent(cwd, {
        orchestration_id,
        session_id,
        spawn_id,
        review_dimensions: 'all',
        rationale: 'review_dimension_scoping disabled (config or env)',
        files_changed_count: 0,
        files_changed_source: 'empty_kill_switch',
        kill_switch_active: true,
        kill_switch_source,
        injected: false,
        idempotent_skip: false,
        reason: 'kill_switch=' + kill_switch_source,
      });
      emitContinue();
      process.exit(0);
      return;
    }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';

    // Idempotency check — case-insensitive heading match.
    const idempotentMatch = /^##\s+dimensions to apply\s*$/im.test(prompt);
    if (idempotentMatch) {
      // Parse what's already there via the canonical extractor.
      let existingDims;
      try {
        existingDims = extractReviewDimensions(prompt);
      } catch (_e) {
        existingDims = null;
      }
      // Normalize null → "all" for analytics (block present but unparseable).
      const dims = existingDims !== null ? existingDims : 'all';

      emitScopingEvent(cwd, {
        orchestration_id,
        session_id,
        spawn_id,
        review_dimensions: dims,
        rationale: 'idempotent: prompt already has ## Dimensions to Apply',
        files_changed_count: 0,
        files_changed_source: 'empty_idempotent_skip',
        kill_switch_active: false,
        kill_switch_source: null,
        injected: false,
        idempotent_skip: true,
        reason: 'idempotent',
      });
      emitContinue();
      process.exit(0);
      return;
    }

    // Resolve files_changed from events.jsonl.
    let filesResult;
    try {
      filesResult = resolveFilesChanged(cwd, orchestration_id);
    } catch (_e) {
      filesResult = { files_changed: [], source: 'empty_no_developer' };
    }
    const { files_changed, source: files_changed_source } = filesResult;

    // W#7 (v2.2.19 audit-fix R1): extract diff_text from the prompt's ## Git Diff
    // section and pass it to the classifier. Future-proofs the classifier surface
    // so content-based routing (e.g. diff contains .schema.json) works without
    // requiring files_changed to carry schema file names.
    let diff_text = null;
    try {
      const diffMatch = prompt.match(/^##\s+Git\s+Diff\s*\n([\s\S]*?)(?=\n##\s|\s*$)/im);
      if (diffMatch && diffMatch[1]) diff_text = diffMatch[1].trim() || null;
    } catch (_de) { /* fail-open */ }

    // Classify dimensions.
    let classification;
    try {
      classification = classifyReviewDimensions({
        files_changed,
        diff_text,
        config: cfg,
      });
    } catch (err) {
      // Fail-open: classifier threw — no event, no mutation.
      process.stderr.write('[orchestray] inject-review-dimensions: classifier error: ' + (err && err.message) + '\n');
      emitContinue();
      process.exit(0);
      return;
    }

    const { review_dimensions, rationale } = classification;

    // Build and append the dimensions block.
    const block = buildDimensionsBlock(review_dimensions);
    const newPrompt = prompt + block;
    const newToolInput = Object.assign({}, toolInput, { prompt: newPrompt });

    // Derive a short reason string (≤80 chars).
    const reasonRaw = 'classifier: ' + (rationale || '').slice(0, 60);

    emitScopingEvent(cwd, {
      orchestration_id,
      session_id,
      spawn_id,
      review_dimensions,
      rationale,
      files_changed_count: files_changed.length,
      files_changed_source,
      kill_switch_active: false,
      kill_switch_source: null,
      injected: true,
      idempotent_skip: false,
      reason: reasonRaw.slice(0, 80),
    });

    emitAllowWithUpdatedInput(newToolInput);
    process.exit(0);
  } catch (_e) {
    try { emitContinue(); } catch (_inner) { /* swallow */ }
    process.exit(0);
  }
});

if (require.main === module) {
  // Entry point when run as a hook script — stdin processing started above.
}
