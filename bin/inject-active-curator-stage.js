#!/usr/bin/env node
'use strict';

/**
 * inject-active-curator-stage.js — UserPromptSubmit / SessionStart hook
 * (W9, v2.1.15, R-CURATOR-SPLIT).
 *
 * Mirrors inject-active-phase-slice.js (W8) for the curator agent.
 * At curator-turn boundaries, reads the current curator stage from
 * `.orchestray/state/curator-run.md` (or falls back to `discover` if absent)
 * and stages the matching curator stage file at
 * `.orchestray/state/active-curator-stage.md`.
 *
 * Kill switches (any one → no-op, output `{continue: true}`):
 *   - process.env.ORCHESTRAY_DISABLE_CURATOR_STAGES === '1'
 *   - config.curator_slice_loading.enabled === false
 *
 * On the kill-switch path, the curator's Section Loading dispatch table loads
 * `agents/curator.md.legacy` directly via branch (b) — see
 * agents/pm.md Curator Section Loading Protocol.
 *
 * Exit code: always 0 (advisory; never blocks).
 *
 * Module exports: resolveStageForPhase, STAGE_TO_FILE (for tests, W6 pattern).
 */

const fs = require('fs');
const path = require('path');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

const STATE_DIR = path.join('.orchestray', 'state');
const CURATOR_RUN_FILE = 'curator-run.md';
const ACTIVE_STAGE = 'active-curator-stage.md';

// Map curator stage names to their file names in agents/curator-stages/.
const STAGE_TO_FILE = {
  discover:  'phase-decomp.md',
  input:     'phase-decomp.md',
  read:      'phase-decomp.md',
  score:     'phase-execute.md',
  decide:    'phase-execute.md',
  decision:  'phase-execute.md',
  evaluate:  'phase-execute.md',
  commit:    'phase-close.md',
  apply:     'phase-close.md',
  output:    'phase-close.md',
  complete:  'phase-close.md',
};

const STAGES_DIR_RELATIVE = path.join('agents', 'curator-stages');

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

function readStageFromCuratorRun(cwd) {
  const runPath = path.join(cwd, STATE_DIR, CURATOR_RUN_FILE);
  if (!fs.existsSync(runPath)) return null;
  let text;
  try {
    text = fs.readFileSync(runPath, 'utf8');
  } catch (_e) {
    return null;
  }
  // Pull current_stage from YAML frontmatter
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const stageMatch = fm.match(/^current_stage:\s*([^\n#]+)/m);
  if (!stageMatch) return null;
  return stageMatch[1].trim().toLowerCase().replace(/^["']|["']$/g, '');
}

function resolveStageForPhase(stage) {
  if (!stage) return null;
  return STAGE_TO_FILE[stage] || null;
}

function stageFile(cwd, stageFileName) {
  const src = path.join(cwd, STAGES_DIR_RELATIVE, stageFileName);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(cwd, STATE_DIR, ACTIVE_STAGE);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(_input) {
  const cwd = process.cwd();

  // Kill switch: env var
  if (process.env.ORCHESTRAY_DISABLE_CURATOR_STAGES === '1') {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  // Kill switch: config
  const config = loadConfig(cwd);
  if (
    config.curator_slice_loading &&
    config.curator_slice_loading.enabled === false
  ) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  // Read active curator stage (default: discover)
  const rawStage = readStageFromCuratorRun(cwd) || 'discover';
  const stageFileName = resolveStageForPhase(rawStage) || 'phase-decomp.md';

  // Stage the curator file
  const staged = stageFile(cwd, stageFileName);

  // Always also load the contract
  const contractSrc = path.join(cwd, STAGES_DIR_RELATIVE, 'phase-contract.md');
  const contractOk = fs.existsSync(contractSrc);

  if (!staged || !contractOk) {
    // Stage files missing — fall back silently
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    return;
  }

  const stagedPath = path.join(cwd, STATE_DIR, ACTIVE_STAGE);
  const contractPath = contractSrc;

  // Intentionally omits additionalContext — curator is manually-invoked, not a
  // session-level user prompt. The PM loads stages via the Curator Section
  // Loading Protocol (agents/pm.md §"Curator Section Loading Protocol") at
  // curator spawn time. This output records the stage selection in the audit
  // trail without injecting context into Claude's prompt (per W12 R-ORACLE-3).
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      type: 'curator_stage_injected',
      stage: rawStage,
      stage_file: stageFileName,
      staged_path: stagedPath,
      contract_path: contractPath,
    },
  }) + '\n');
}

module.exports = {
  resolveStageForPhase,
  STAGE_TO_FILE,
};
