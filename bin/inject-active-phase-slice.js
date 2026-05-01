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
  const orchPath = path.join(cwd, STATE_DIR, ORCH_FILE);
  if (!fs.existsSync(orchPath)) return null;
  let text;
  try {
    text = fs.readFileSync(orchPath, 'utf8');
  } catch (_e) {
    return null;
  }

  // v2.2.2 Fix A3 / v2.2.19 T7: parser accepts BOTH formats.
  // The documented YAML frontmatter key is `current_phase:` per
  // phase-contract.md, BUT the PM also writes bare `phase:` (same as
  // auto-commit-master-on-pm-stop.js:134 and write-resilience-dossier.js:226
  // which already accept both). Two-pass: `current_phase:` takes precedence;
  // fall back to `phase:` when only the short key is present.
  // Info #10 (v2.2.19 audit-fix R1): when BOTH keys are present and disagree,
  // `current_phase` wins (canonical per phase-contract.md §82). The regex
  // match ordering below enforces this: current_phase match is tried first.

  // Strategy 1: YAML frontmatter (documented in phase-contract.md)
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const phaseMatch =
      fm.match(/^current_phase:\s*([^\n#]+)/m) ||
      fm.match(/^phase:\s*([^\n#]+)/m);
    if (phaseMatch) {
      return phaseMatch[1].trim().toLowerCase().replace(/^["']|["']$/g, '');
    }
  }

  // Strategy 2: bold-list (what the PM actually writes today)
  //   - **phase**: execute
  //   - **current_phase**: execute
  const boldMatch = text.match(/^- \*\*(?:current_)?phase\*\*:\s*([^\n]+)/m);
  if (boldMatch) {
    return boldMatch[1].trim().toLowerCase().replace(/^["']|["']$/g, '');
  }

  return null;
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

  // Read current phase from orchestration.md
  const phase = readPhaseFromOrchestration(cwd);
  const slice = resolveSliceForPhase(phase);

  if (!slice) {
    // Unparseable / missing phase → contract-only injection (no slice).
    emitFallbackEvent(cwd, phase ? 'unrecognized_phase' : 'no_active_orchestration');
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
  emitInjectedEvent,
  PHASE_TO_FILE,
};
