#!/usr/bin/env node
'use strict';

/**
 * inject-worktree-staleness.js — PreToolUse:Agent hook (v2.3.29 W6).
 *
 * Problem: `bin/worktree-create.js` creates every isolated agent's worktree
 * via `git worktree add --detach HEAD`, and this repo commits only at
 * release time. A worktree-isolated agent's copy is therefore routinely
 * missing in-flight main-tree work it has no way to detect — it cannot tell
 * "this repo is broken" from "my copy is behind", so it confidently reports
 * false baselines (measured: three agents in one session, all wrong).
 *
 * `worktree-create.js` already records the gap at creation time
 * (`main_tree_head_at_creation`, `main_tree_uncommitted_count_at_creation` in
 * `.orchestray/state/worktree-meta/<agent>.json`) — but nothing reads that
 * file back to the agent. This hook closes that gap WITHOUT waiting for the
 * worktree-meta file: at PreToolUse:Agent time we are still running in the
 * main tree (the worktree does not exist yet), so we measure the same two
 * facts worktree-create.js is about to record and inject them directly into
 * the delegation prompt via `updatedInput.prompt` — the one mechanism
 * verified to actually reach a spawned subagent (SubagentStart hook output
 * is documented as decision/context-inert; see
 * .orchestray/kb/artifacts/v2110-research-claude-code-instruments.md:202).
 *
 * Behaviour:
 *   - Only acts on `tool_name === 'Agent'`.
 *   - Only acts when the spawn will actually be worktree-isolated: either
 *     `tool_input.isolation === 'worktree'` or the target agent's frontmatter
 *     carries `isolation: worktree` (same detection `warn-isolation-omitted.js`
 *     uses to decide isolation is already covered).
 *   - Measures the MAIN tree's current HEAD and uncommitted/untracked path
 *     count (the same two git calls worktree-create.js makes moments later
 *     against the same tree).
 *   - When uncommitted count > 0, appends a `## Worktree Staleness Warning`
 *     block to the prompt via `updatedInput.prompt` and emits
 *     `worktree_staleness_injected`.
 *   - When the tree is clean, no mutation — nothing to warn about.
 *   - Kill switches: `ORCHESTRAY_DISABLE_WORKTREE_STALENESS_WARN=1`,
 *     `.orchestray/config.json` → `worktree_isolation.staleness_warn: false`.
 *   - Fail-open contract: ANY thrown exception, git failure, or unreadable
 *     config → pass the original prompt through unchanged, exit 0.
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 *         { tool_name, tool_input: { prompt, subagent_type, isolation }, cwd }
 * Output: JSON on stdout:
 *           { hookSpecificOutput: { hookEventName: "PreToolUse",
 *             permissionDecision: "allow",
 *             updatedInput: { ...tool_input, prompt: <appended> } },
 *             continue: true }
 *         OR (skip / kill-switch / unhandled tool): { continue: true }
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { agentFrontmatterHasIsolation } = require('./warn-isolation-omitted');

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

function isKillSwitchEnv() {
  return process.env.ORCHESTRAY_DISABLE_WORKTREE_STALENESS_WARN === '1';
}

function isKillSwitchConfig(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return !!(cfg && cfg.worktree_isolation && cfg.worktree_isolation.staleness_warn === false);
  } catch (_e) {
    return false;
  }
}

/**
 * Measure the main tree's current HEAD and uncommitted/untracked path count.
 * Mirrors the exact two git calls worktree-create.js makes when it records
 * `main_tree_head_at_creation` / `main_tree_uncommitted_count_at_creation`.
 *
 * @param {string} cwd
 * @returns {{head: string|null, uncommittedCount: number|null}}
 */
function measureMainTree(cwd) {
  const headResult = spawnSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const statusResult = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' });
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  const uncommittedCount = statusResult.status === 0
    ? (statusResult.stdout || '').split('\n').filter((l) => l.trim().length > 0).length
    : null;
  return { head, uncommittedCount };
}

function buildAppendix(head, uncommittedCount) {
  return '\n\n## Worktree Staleness Warning\n\n' +
    'Your isolated worktree will be created via `git worktree add --detach HEAD` ' +
    'from the main tree\'s current HEAD (' + (head || 'unknown') + '), but the main ' +
    'tree currently has ' + uncommittedCount + ' uncommitted/untracked path(s) that ' +
    'will NOT be present in your copy. This repo commits only at release time, so ' +
    'in-flight work is common and your baseline may differ from the PM\'s. Do not ' +
    'label unexplained test failures or diffs "pre-existing" without evidence — ' +
    'report exactly what you measure, and flag any discrepancy from an expected ' +
    'baseline instead of asserting one you cannot verify.';
}

function main() {
  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] inject-worktree-staleness: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n');
    emitContinue();
    process.exit(0);
  }

  try {
    if (isKillSwitchEnv()) {
      emitContinue();
      process.exit(0);
    }

    let event;
    try {
      event = JSON.parse(input || '{}');
    } catch (_e) {
      emitContinue();
      process.exit(0);
    }

    if ((event.tool_name || '') !== 'Agent') {
      emitContinue();
      process.exit(0);
    }

    const toolInput = event.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
      emitContinue();
      process.exit(0);
    }

    const subagentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : '';
    if (!subagentType) {
      emitContinue();
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_e) {
      cwd = process.cwd();
    }

    if (isKillSwitchConfig(cwd)) {
      emitContinue();
      process.exit(0);
    }

    // Only spawns that will actually be worktree-isolated get a warning —
    // an un-isolated agent shares the main tree and has no staleness gap.
    const paramIsolation = toolInput.isolation;
    const willIsolate = paramIsolation === 'worktree' || paramIsolation === '"worktree"' ||
      agentFrontmatterHasIsolation(cwd, subagentType);
    if (!willIsolate) {
      emitContinue();
      process.exit(0);
    }

    const { head, uncommittedCount } = measureMainTree(cwd);
    const orchestration_id = resolveOrchestrationId(cwd);

    if (uncommittedCount === null || uncommittedCount === 0) {
      // Clean tree (or git measurement failed) — nothing to warn about.
      // Still emit for telemetry parity so the skip is observable.
      try {
        writeEvent({
          type: 'worktree_staleness_skipped',
          version: 1,
          orchestration_id: orchestration_id || null,
          agent_type: subagentType,
          reason: uncommittedCount === null ? 'git_measurement_failed' : 'clean_tree',
        }, { cwd });
      } catch (_e) { /* swallow */ }
      emitContinue();
      process.exit(0);
    }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    const newPrompt = prompt + buildAppendix(head, uncommittedCount);
    const newToolInput = Object.assign({}, toolInput, { prompt: newPrompt });

    try {
      writeEvent({
        type: 'worktree_staleness_injected',
        version: 1,
        orchestration_id: orchestration_id || null,
        agent_type: subagentType,
        main_tree_head: head,
        main_tree_uncommitted_count: uncommittedCount,
      }, { cwd });
    } catch (_e) { /* swallow */ }

    emitAllowWithUpdatedInput(newToolInput);
    process.exit(0);
  } catch (_e) {
    try { emitContinue(); } catch (_e2) { /* swallow */ }
    process.exit(0);
  }
}

module.exports = { measureMainTree, buildAppendix, isKillSwitchEnv, isKillSwitchConfig };

if (require.main === module) {
  main();
}
