#!/usr/bin/env node
'use strict';

/**
 * inject-active-phase-slice.js — UserPromptSubmit / SessionStart hook
 * (W8, v2.1.15, I-PHASE-GATE).
 *
 * Pass 5 of P-PHASE-SPLIT-RECONCILE: at PM-turn boundaries, reads the
 * current orchestration's `current_phase` from
 * `.orchestray/state/orchestration.md` and stages the matching phase slice
 * file at `.orchestray/state/active-phase-slice.md`. Emits a small
 * `additionalContext` pointer (slices exceed the 10K char cap so we point
 * via a file reference rather than dumping content).
 *
 * Kill switches (any one → no-op, output `{continue: true}`):
 *   - process.env.ORCHESTRAY_DISABLE_PHASE_SLICES === '1'
 *   - config.phase_slice_loading.enabled === false
 *
 * On the kill-switch path, the PM's Section Loading dispatch table loads
 * `tier1-orchestration.md.legacy` directly via branch (b) — see
 * agents/pm.md Section Loading Protocol.
 *
 * Exit code: always 0 (advisory; never blocks).
 */

const fs = require('fs');
const path = require('path');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

const STATE_DIR = path.join('.orchestray', 'state');
const ORCH_FILE = 'orchestration.md';
const ACTIVE_SLICE = 'active-phase-slice.md';

const PHASE_TO_FILE = {
  decomp:           'phase-decomp.md',
  decomposition:    'phase-decomp.md',
  delegation:       'phase-decomp.md',
  assessment:       'phase-decomp.md',
  execute:          'phase-execute.md',
  execution:        'phase-execute.md',
  implementation:   'phase-execute.md',
  verify:           'phase-verify.md',
  review:           'phase-verify.md',
  close:            'phase-close.md',
  closing:          'phase-close.md',
  complete:         'phase-close.md',
};

const SLICES_DIR_RELATIVE = path.join('agents', 'pm-reference');

// ---------------------------------------------------------------------------
// Stdin reader (W6 require.main guard — avoid hang-on-test-import)
// ---------------------------------------------------------------------------

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    // Hard cap to avoid runaway input
    if (input.length > 1024 * 1024) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      handle(JSON.parse(input || '{}'));
    } catch (_e) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(cwd) {
  try {
    const p = path.join(cwd, '.orchestray', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    return {};
  }
}

function readPhaseFromOrchestration(cwd) {
  const result = inspectOrchestration(cwd);
  return result.phase;
}

/**
 * v2.2.3 P0-4 (I-PHASE-GATE-SILENT): inspect orchestration.md and return
 * a structured triage result the caller uses to decide whether to emit a
 * fallback event or silently no-op.
 *
 * Returns:
 *   { exists: false, phase: null }
 *     -- `.orchestray/state/orchestration.md` does not exist (or is unreadable).
 *     Caller MUST silently no-op; no fallback event.
 *
 *   { exists: true,  phase: null }
 *     -- file exists but has no parseable phase line (neither YAML
 *     `current_phase:` nor the bold-list `- **phase**:` form).
 *     Caller MUST silently no-op; no fallback event.
 *     Rationale: an orchestration.md with no phase is the same situation as
 *     no orchestration at all from the slice hook's perspective — there is
 *     no slice to inject and the operator has nothing to act on.
 *
 *   { exists: true,  phase: '<value>' }
 *     -- active orchestration with a parsed phase value. Caller uses
 *     `resolveSliceForPhase(phase)`; if null (unknown phase value) emits
 *     `phase_slice_fallback{ reason: 'unrecognized_phase' }` (legitimate
 *     fault signal). If slice resolves but staging fails, emits
 *     `slice_file_missing:<filename>` (legitimate fault signal).
 *
 * Pre-v2.2.3 the handler emitted `phase_slice_fallback{ reason:
 * 'no_active_orchestration' }` for both null cases above. Telemetry
 * (W3 §E) showed this dominated the signal at 46/48 fallback events,
 * obscuring real failures. P0-4 splits the parse outcome from the emit
 * decision so we keep the legitimate fault signals and drop the noise.
 */
function inspectOrchestration(cwd) {
  const orchPath = path.join(cwd, STATE_DIR, ORCH_FILE);
  if (!fs.existsSync(orchPath)) {
    return { exists: false, phase: null };
  }
  let text;
  try {
    text = fs.readFileSync(orchPath, 'utf8');
  } catch (_e) {
    // Unreadable file: treat as absent for gating purposes (silent no-op).
    return { exists: false, phase: null };
  }

  // v2.2.2 Fix A3: parser accepts BOTH formats. The documented YAML
  // frontmatter (`current_phase:`) per phase-contract.md, AND the bold-list
  // format the PM actually writes today (`- **phase**: <value>` or
  // `- **current_phase**: <value>`). Old YAML archives still parse via the
  // first strategy; live PM-written files parse via the second.

  // Strategy 1: YAML frontmatter (documented in phase-contract.md)
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const phaseMatch = fm.match(/^current_phase:\s*([^\n#]+)/m);
    if (phaseMatch) {
      return {
        exists: true,
        phase: phaseMatch[1].trim().toLowerCase().replace(/^["']|["']$/g, ''),
      };
    }
  }

  // Strategy 2: bold-list (what the PM actually writes today)
  //   - **phase**: execute
  //   - **current_phase**: execute
  const boldMatch = text.match(/^- \*\*(?:current_)?phase\*\*:\s*([^\n]+)/m);
  if (boldMatch) {
    return {
      exists: true,
      phase: boldMatch[1].trim().toLowerCase().replace(/^["']|["']$/g, ''),
    };
  }

  return { exists: true, phase: null };
}

function resolveSliceForPhase(phase) {
  if (!phase) return null;
  return PHASE_TO_FILE[phase] || null;
}

function stageSlice(cwd, sliceFileName) {
  const src = path.join(cwd, SLICES_DIR_RELATIVE, sliceFileName);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(cwd, STATE_DIR, ACTIVE_SLICE);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (_e) {
    return false;
  }
}

function emitFallbackEvent(cwd, reason) {
  // Best-effort: append to events.jsonl directly via the audit gateway when
  // available; otherwise skip silently. This keeps the hook fail-open.
  // The fallback event ALWAYS emits (it is a fault signal); it is NOT gated
  // by `phase_slice_loading.telemetry_enabled` (that flag gates only the
  // positive-path `phase_slice_injected` event added in v2.1.16 R-PHASE-INJ).
  try {
    const writerPath = path.join(cwd, 'bin', '_lib', 'audit-event-writer.js');
    if (!fs.existsSync(writerPath)) return;
    // eslint-disable-next-line global-require
    const { writeEvent } = require(writerPath);
    writeEvent({
      version: 1,
      type: 'phase_slice_fallback',
      reason,
    }, { cwd });
  } catch (_e) {
    // fail-open
  }
}

/**
 * Emit positive-path `phase_slice_injected` event (v2.1.16 R-PHASE-INJ).
 *
 * Pairs with `phase_slice_fallback` so the
 * `injected / (injected + fallback)` ratio empirically validates the
 * v2.1.15 I-PHASE-GATE ~21K/turn savings claim. Read-only telemetry —
 * additive, non-fatal, never blocks the hook.
 *
 * Kill switches (any one → no emission, hook still proceeds normally):
 *   - process.env.ORCHESTRAY_DISABLE_PHASE_INJECT_TELEMETRY === '1'
 *   - config.phase_slice_loading.telemetry_enabled === false
 *     (default true; the field is absent in v2.1.15 configs and we
 *     treat undefined as enabled per the rollout posture in
 *     v2116-release-plan.md §R-PHASE-INJ kill-switch line 115.)
 */
function emitInjectedEvent(cwd, cfg, phase, sliceFileName, pointer) {
  // Kill switch (env)
  if (process.env.ORCHESTRAY_DISABLE_PHASE_INJECT_TELEMETRY === '1') return;
  // Kill switch (config) — only the explicit `false` disables; default is on.
  const block = cfg && typeof cfg === 'object' ? cfg.phase_slice_loading : null;
  if (block && typeof block === 'object' && block.telemetry_enabled === false) {
    return;
  }
  try {
    const writerPath = path.join(cwd, 'bin', '_lib', 'audit-event-writer.js');
    if (!fs.existsSync(writerPath)) return;
    // eslint-disable-next-line global-require
    const { writeEvent } = require(writerPath);
    const slicePath = path.join(SLICES_DIR_RELATIVE, sliceFileName);
    writeEvent({
      version: 1,
      type: 'phase_slice_injected',
      phase,
      slice_path: slicePath,
      pointer_bytes: Buffer.byteLength(String(pointer || ''), 'utf8'),
    }, { cwd });
  } catch (_e) {
    // fail-open — telemetry must never break the hook
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(_payload) {
  const cwd = process.cwd();

  // Kill switch (env)
  if (process.env.ORCHESTRAY_DISABLE_PHASE_SLICES === '1') {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  // Kill switch (config)
  const cfg = loadConfig(cwd);
  const block = cfg.phase_slice_loading;
  if (block && typeof block === 'object' && block.enabled === false) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  // v2.2.3 P0-4 (I-PHASE-GATE-SILENT): silent no-op when no orchestration
  // is active or when orchestration.md has no phase line. We emit
  // `phase_slice_fallback` ONLY for legitimate fault signals
  // (unrecognized phase value, missing slice file). See inspectOrchestration
  // doc-comment for the gate rationale; W3 §E telemetry justifying the
  // change shows 46/48 fallback events were `no_active_orchestration` noise.
  const orchInfo = inspectOrchestration(cwd);
  if (!orchInfo.exists || !orchInfo.phase) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  const phase = orchInfo.phase;
  const slice = resolveSliceForPhase(phase);

  if (!slice) {
    // Active orchestration but phase value is not in PHASE_TO_FILE.
    // Real fault: somebody wrote an unknown phase string to orchestration.md.
    emitFallbackEvent(cwd, 'unrecognized_phase');
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  const ok = stageSlice(cwd, slice);
  if (!ok) {
    emitFallbackEvent(cwd, 'slice_file_missing:' + slice);
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  // Emit additionalContext pointer (small, well under 10K cap).
  const pointer =
    `Active phase slice (current_phase=${phase}): ` +
    `agents/pm-reference/${slice}. ` +
    `Read it for the full phase protocol; phase-contract.md is always loaded.`;

  const response = {
    hookSpecificOutput: {
      // hookEventName is hardcoded to 'UserPromptSubmit'; on SessionStart firing,
      // additionalContext is still respected by Claude Code. Functional non-issue
      // per W12 platform-oracle audit (R-ORACLE-1, cosmetic).
      hookEventName: 'UserPromptSubmit',
      additionalContext: pointer,
    },
    continue: true,
  };

  // v2.1.16 R-PHASE-INJ: positive-path telemetry. Emit AFTER staging succeeded
  // and BEFORE writing stdout so emission failures (which never throw) cannot
  // bend the hook's response contract.
  emitInjectedEvent(cwd, cfg, phase, slice, pointer);

  process.stdout.write(JSON.stringify(response) + '\n');
}

module.exports = {
  resolveSliceForPhase,
  readPhaseFromOrchestration,
  inspectOrchestration,
  emitInjectedEvent,
  handle,
  PHASE_TO_FILE,
};
