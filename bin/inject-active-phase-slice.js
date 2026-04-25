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
  // Pull current_phase from YAML frontmatter
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const phaseMatch = fm.match(/^current_phase:\s*([^\n#]+)/m);
  if (!phaseMatch) return null;
  return phaseMatch[1].trim().toLowerCase().replace(/^["']|["']$/g, '');
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
  process.stdout.write(JSON.stringify(response) + '\n');
}

module.exports = {
  resolveSliceForPhase,
  readPhaseFromOrchestration,
  PHASE_TO_FILE,
};
