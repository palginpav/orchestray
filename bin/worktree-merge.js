#!/usr/bin/env node
// NOT_A_HOOK: CLI-only utility, invoked directly by the PM via Bash.
'use strict';

/**
 * bin/worktree-merge.js — mechanical safe worktree→main merge (v2.3.28 W2).
 *
 * The PM's only tools for this are Bash / Read / Write / Edit — no MCP
 * verb. This is a plain CLI so `Bash` is sufficient.
 *
 * Usage:
 *   node bin/worktree-merge.js status <agent-name-or-path>
 *   node bin/worktree-merge.js merge  <agent-name-or-path>
 *
 * `status` is read-only: reports base-vs-current-main-HEAD drift and any
 * conflicts, never writes. `merge` applies tracked changes as a patch and
 * copies untracked-only files — refuses entirely (no partial apply) if any
 * conflict is present. See bin/_lib/worktree-merge.js for the full
 * rationale and the incident history this replaces (D2, D6, D7, V3I).
 *
 * Exit codes: 0 = ok (including "no changes"), 1 = usage/resolution error,
 * 2 = refused due to conflict.
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { resolveTarget, resolveProjectRoot, computeMergePlan, executeMerge } = require('./_lib/worktree-merge');

function logErr(msg) {
  try { process.stderr.write('[orchestray/worktree-merge] ' + msg + '\n'); } catch (_e) {}
}

const command = process.argv[2];
const arg = process.argv[3];

if (command !== 'status' && command !== 'merge') {
  logErr('usage: worktree-merge.js <status|merge> <agent-name-or-path>');
  process.exit(1);
}
if (!arg) {
  logErr('missing agent name or worktree path');
  process.exit(1);
}

const projectRoot = resolveProjectRoot(resolveSafeCwd(process.cwd()));
const target = resolveTarget(projectRoot, arg);
if (!target) {
  logErr(`could not resolve "${arg}" to a worktree under ${projectRoot}/.claude/worktrees/`);
  process.exit(1);
}

const plan = computeMergePlan(projectRoot, target.worktreePath);
if (!plan.ok) {
  logErr('FAIL: ' + plan.error);
  console.log(JSON.stringify({ ok: false, error: plan.error }, null, 2));
  process.exit(1);
}

if (plan.stale) {
  logErr(`WARNING: worktree base (${plan.baseHead.slice(0, 8)}) is stale — current main HEAD is ${plan.currentMainHead.slice(0, 8)}`);
}
if (plan.conflicts.length > 0) {
  logErr(`CONFLICT: ${plan.conflicts.length} path(s) cannot be safely merged:`);
  for (const c of plan.conflicts) logErr(`  ${c.path} — ${c.reason}`);
}

if (command === 'status') {
  console.log(JSON.stringify({
    ok: true,
    agent_name: target.agentName,
    worktree_path: target.worktreePath,
    base_head: plan.baseHead,
    current_main_head: plan.currentMainHead,
    stale: plan.stale,
    tracked_changed: plan.tracked,
    untracked_changed: plan.untracked,
    total_changed_files: plan.totalChangedFiles,
    main_uncommitted_overlap: plan.mainUncommittedOverlap,
    uncommitted_count: plan.uncommittedCount,
    committed_count: plan.committedCount,
    conflicts: plan.conflicts,
    safe_to_merge: plan.conflicts.length === 0,
  }, null, 2));
  process.exit(0);
}

// command === 'merge'
if (plan.conflicts.length > 0) {
  console.log(JSON.stringify({ ok: false, refused: true, conflicts: plan.conflicts }, null, 2));
  process.exit(2);
}

const result = executeMerge(projectRoot, target.worktreePath, plan);
if (!result.ok) {
  logErr('FAIL: ' + result.error);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.conflicts ? 2 : 1);
}

if (result.noChanges) {
  logErr('no changes to merge — worktree is clean relative to its own history');
} else {
  logErr(`OK merged: ${result.filesApplied} tracked file(s) patched, ${result.filesCopied} untracked file(s) copied` + (plan.stale ? ' (base was stale but no conflicting files — proceeded)' : ''));
}
console.log(JSON.stringify(Object.assign({ ok: true, agent_name: target.agentName, stale: plan.stale }, result), null, 2));
process.exit(0);
