#!/usr/bin/env node
'use strict';

/**
 * validate-context-size-hint.js — PreToolUse:Agent hook (v2.2.15 FN-44).
 *
 * Mechanical exit-2 promotion of the `context_size_hint_missing` warn telemetry
 * (214 fires in recent traffic). Per `feedback_mechanical_over_prose.md`,
 * unenforced rules drift; per the v2.2.15 risk register the immediate flip
 * would block too many legitimate spawns, so this validator implements a
 * **3-spawn soft-warn ramp per orchestration** before escalating to exit 2.
 *
 * The check is independent of bin/preflight-spawn-budget.js (which gates the
 * NATIVE tool_input.context_size_hint field). This validator focuses on the
 * inline-prompt-body declaration that PMs are expected to emit per
 * delegation-templates.md.
 *
 * Activation: every PreToolUse:Agent spawn (any subagent_type).
 *
 * Accepted forms (per v2.2.14 G-11 — both forms must parse):
 *
 *   Flat form:
 *     context_size_hint: system=8000 tier2=4000 handoff=12000
 *
 *   Object form (also accepted):
 *     context_size_hint: { system: 8000, tier2: 4000, handoff: 12000 }
 *
 * Soft-warn ramp:
 *   - Counter file: .orchestray/state/context-size-hint-warn-count-<orch-id>.txt
 *   - First 3 spawns of an orch missing the hint → warn-event only, exit 0.
 *   - 4th and subsequent spawns → exit 2 + emit gate_blocked event.
 *   - When orchestration_id is unresolvable, the validator falls back to
 *     warn-only (no ramp, no block) to avoid breaking pre-orchestration spawns.
 *
 * Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1 → bypass entirely
 *   (no event, no block). Distinct suffix from the retired v2.2.14 G-04
 *   `_REQUIRED_DISABLED` family.
 *
 * Contract:
 *   - exit 0 within ramp window or when hint is present.
 *   - exit 2 when ramp window is exhausted and hint is still absent.
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// Ramp window: how many missing-hint spawns we tolerate per orchestration
// before exit-2. Tunable via env var for ops experimentation.
const DEFAULT_RAMP_THRESHOLD = 3;

// Mirror the regexes used by preflight-spawn-budget.js so both gates accept
// the same surface forms (G-11 form-parity invariant).
const HINT_RE_FLAT = /^\s*`?context_size_hint:\s*system=(\d+)\s+tier2=(\d+)\s+handoff=(\d+)/m;
const HINT_RE_OBJ  = /^\s*`?context_size_hint:\s*\{\s*system\s*:\s*(\d+)\s*,\s*tier2\s*:\s*(\d+)\s*,\s*handoff\s*:\s*(\d+)\s*\}/m;

// ---------------------------------------------------------------------------
// Hint detection
// ---------------------------------------------------------------------------

/**
 * Return true if the spawn already carries a non-zero context_size_hint —
 * either as the native tool_input.context_size_hint object, or inline in the
 * prompt body in either G-11 form.
 *
 * @param {object} toolInput
 * @returns {{ present: boolean, source: string }}
 */
function evaluateHint(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return { present: false, source: 'no_tool_input' };
  }

  // Native field.
  const native = toolInput.context_size_hint;
  if (native && typeof native === 'object') {
    const sys = Number(native.system) || 0;
    const t2  = Number(native.tier2)  || 0;
    const hf  = Number(native.handoff) || 0;
    if (sys + t2 + hf > 0) {
      return { present: true, source: 'tool_input_native' };
    }
  }

  // Inline prompt body — accept both flat AND object form.
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
  if (prompt.length > 0) {
    if (HINT_RE_FLAT.test(prompt) || HINT_RE_OBJ.test(prompt)) {
      return { present: true, source: 'prompt_body' };
    }
  }

  return { present: false, source: 'absent' };
}

// ---------------------------------------------------------------------------
// Orchestration ID + ramp counter
// ---------------------------------------------------------------------------

/**
 * Resolve the current orchestration_id, if any, by reading the marker file.
 * Returns null when the marker is missing or unparsable.
 */
function resolveOrchestrationId(cwd) {
  try {
    const f = getCurrentOrchestrationFile(cwd);
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.orchestration_id || parsed.id || null;
  } catch (_e) {
    return null;
  }
}

function counterFilePath(cwd, orchId) {
  return path.join(cwd, '.orchestray', 'state', `context-size-hint-warn-count-${orchId}.txt`);
}

/**
 * Read the current warn-count for this orchestration, increment it, persist,
 * and return both the new count and the threshold.
 *
 * @returns {{ count: number, threshold: number }}
 */
function bumpWarnCount(cwd, orchId, threshold) {
  const filePath = counterFilePath(cwd, orchId);
  let count = 0;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n >= 0) count = n;
  } catch (_e) { /* fresh counter */ }

  count += 1;

  // FN-44 + W9 F-7 (v2.2.15): atomic tmp+rename write. Multiple PreToolUse
  // hooks for parallel Agent() spawns can race on the same counter file;
  // a non-atomic writeFileSync risks lost updates / partial reads. The
  // tmp+rename pattern matches `bin/install.js` writeJsonAtomic discipline
  // (FN-18 sibling).
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, String(count) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (_e) { /* best-effort persistence — fail-open */ }

  return { count, threshold };
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
  // Kill switch: full bypass.
  if (process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

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

    // PreToolUse:Agent matcher only.
    const toolName = event.tool_name || event.hook_event_matcher || '';
    if (toolName !== 'Agent') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    const toolInput = event.tool_input || {};
    const role = toolInput.subagent_type || toolInput.agent_type || null;

    const evaluation = evaluateHint(toolInput);
    if (evaluation.present) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Hint missing. Decide warn vs block via ramp.
    const orchId = resolveOrchestrationId(cwd);
    const threshold = (() => {
      const env = process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_RAMP_THRESHOLD;
      const n = parseInt(env, 10);
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RAMP_THRESHOLD;
    })();

    // No orchestration context yet → warn-only (cannot ramp without an orch id).
    if (!orchId) {
      emitGateEvent(cwd, {
        version:        SCHEMA_VERSION,
        schema_version: SCHEMA_VERSION,
        type:           'context_size_hint_gate_warn',
        subagent_type:  role,
        ramp_count:     null,
        ramp_threshold: threshold,
        ramp_state:     'no_orchestration',
      });
      process.stderr.write(
        '[orchestray] validate-context-size-hint: WARN — spawn missing context_size_hint and no ' +
        'orchestration is active (cannot ramp). Add a `context_size_hint:` line to the delegation ' +
        'prompt. Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const { count } = bumpWarnCount(cwd, orchId, threshold);

    if (count <= threshold) {
      // Within ramp window — warn only.
      emitGateEvent(cwd, {
        version:        SCHEMA_VERSION,
        schema_version: SCHEMA_VERSION,
        type:           'context_size_hint_gate_warn',
        subagent_type:  role,
        orchestration_id: orchId,
        ramp_count:     count,
        ramp_threshold: threshold,
        ramp_state:     'warn',
      });
      process.stderr.write(
        '[orchestray] validate-context-size-hint: WARN (' + count + '/' + threshold + ') — spawn ' +
        'missing context_size_hint. Add a `context_size_hint:` line to the delegation prompt ' +
        '(flat: `system=N tier2=N handoff=N`, or object: `{ system: N, tier2: N, handoff: N }`). ' +
        'After ' + threshold + ' warn-only spawns this orchestration will hard-block. ' +
        'Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Ramp window exhausted → exit 2.
    emitGateEvent(cwd, {
      version:        SCHEMA_VERSION,
      schema_version: SCHEMA_VERSION,
      type:           'context_size_hint_gate_blocked',
      subagent_type:  role,
      orchestration_id: orchId,
      ramp_count:     count,
      ramp_threshold: threshold,
      ramp_state:     'blocked',
    });
    process.stderr.write(
      '[orchestray] validate-context-size-hint: BLOCKED (' + count + ' missing-hint spawns this ' +
      'orchestration; threshold=' + threshold + ') — spawn missing context_size_hint. ' +
      'Add a `context_size_hint:` line to the delegation prompt ' +
      '(flat: `system=N tier2=N handoff=N`, or object: `{ system: N, tier2: N, handoff: N }`). ' +
      'Kill switch: ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'context_size_hint_missing_after_ramp',
    }));
    process.exit(2);
  });
}

module.exports = {
  evaluateHint,
  resolveOrchestrationId,
  bumpWarnCount,
  counterFilePath,
  HINT_RE_FLAT,
  HINT_RE_OBJ,
  DEFAULT_RAMP_THRESHOLD,
};

if (require.main === module) {
  main();
}
