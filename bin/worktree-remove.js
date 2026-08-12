#!/usr/bin/env node
'use strict';

/**
 * worktree-remove.js — WorktreeRemove hook for Claude Code agent isolation.
 *
 * Convention (mirrors worktree-create.js):
 *   - stdin JSON: { session_id, cwd, agent_type, name, hook_event_name, ... }
 *   - Reconstructs worktree path as <cwd>/.claude/worktrees/<name>.
 *   - Removes the worktree (--force to handle detached-HEAD checkout state).
 *   - Fail-open: always exits 0 to never block agent shutdown.
 *
 * P1 (v2.3.26 W15) — data-loss fix. This hook used to run `git worktree
 * remove --force` unconditionally, on the assumption that
 * auto-commit-worktree-on-subagent-stop.js had already committed any work.
 * That assumption is false whenever the auto-commit hook is disabled (env
 * or config kill switch), its own `git commit` fails, or WorktreeRemove
 * simply fires without a completed SubagentStop having run first — there is
 * no ordering guarantee between the two hook invocations. An agent's
 * uncommitted work (11 files, ~11 minutes, three of them untracked — a
 * `git add -A` never ran) was destroyed this way with no check, no event,
 * no warning.
 *
 * Fix: independently re-verify the worktree's own git status immediately
 * before removal — `git status --porcelain` surfaces BOTH tracked
 * modifications and untracked files in one call, so a single check covers
 * both loss modes. A dirty (or unreadable-status) worktree is left on disk
 * — never destroyed — and a `worktree_changes_unmerged` event names the
 * paths so the PM can recover them. "Fail-open" for this hook now means
 * "never block agent shutdown", not "delete unconditionally".
 */

const fs            = require('node:fs');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { writeEvent } = require('./_lib/audit-event-writer');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');

function logStderr(msg) {
  try { process.stderr.write('[orchestray/worktree-remove] ' + msg + '\n'); } catch (_e) {}
}

/**
 * Run a git command with a bounded timeout. Never throws.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 4000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e && e.message ? e.message : e) };
  }
}

/**
 * Parse `git status --porcelain` output into a list of relative paths.
 * Covers both tracked modifications (` M`, `A `, ...) and untracked files
 * (`??`) — the two-char status code is stripped, the path kept.
 * @param {string} porcelainOutput
 * @returns {string[]}
 */
function changedPaths(porcelainOutput) {
  return porcelainOutput
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3).trim())
    .filter((l) => l.length > 0);
}

/**
 * Emit `worktree_changes_unmerged` naming the paths that blocked removal.
 * Fail-open: swallows all errors.
 * @param {string} projectRoot
 * @param {string} worktreePath
 * @param {string|undefined} agentName
 * @param {string|undefined} sessionId
 * @param {string[]} paths
 * @param {string|null} [reason]
 */
function emitUnmergedEvent(projectRoot, worktreePath, agentName, sessionId, paths, reason) {
  try {
    const cwd = resolveSafeCwd(projectRoot);
    const event = {
      type:              'worktree_changes_unmerged',
      schema_version:    1,
      worktree_path:     worktreePath,
      agent_name:        agentName || null,
      session_id:        sessionId || null,
      changed_paths:     paths.slice(0, 50),
      changed_count:     paths.length,
    };
    if (reason) event.reason = reason;
    writeEvent(event, { cwd });
  } catch (_e) { /* fail-open */ }
}

let stdinBuf = '';
try { stdinBuf = readHookInputRaw(); } catch (_e) {}

let input = {};
try { input = JSON.parse(stdinBuf || '{}'); } catch (_e) {}

const agentName   = input.name || input.agent_name;
const sessionId   = input.session_id;
const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const worktreePathFromInput = input.worktree_path || input.path;

if (!agentName && !worktreePathFromInput) {
  logStderr('No agent name or worktree_path — nothing to remove');
  process.exit(0);
}

const worktreePath = worktreePathFromInput
  || path.join(projectRoot, '.claude', 'worktrees', agentName);

if (!fs.existsSync(worktreePath)) {
  logStderr(`Worktree path does not exist (already removed?): ${worktreePath}`);
  // Still run prune to clean stale git refs
  spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' });
  process.exit(0);
}

// P1: re-verify the worktree is actually clean before removing. Never trust
// an upstream hook to have already committed — see header note.
const statusResult = git(worktreePath, ['status', '--porcelain']);

if (statusResult.status !== 0) {
  // Could not determine status — fail toward preservation, not toward
  // guessing the worktree is clean.
  logStderr(
    `Could not read git status for ${worktreePath} (exit ${statusResult.status}) — ` +
    `SKIPPING removal to avoid data loss: ${statusResult.stderr.slice(0, 200)}`
  );
  emitUnmergedEvent(projectRoot, worktreePath, agentName, sessionId, [], 'status_check_failed');
  process.exit(0);
}

const dirty = changedPaths(statusResult.stdout);
if (dirty.length > 0) {
  logStderr(
    `Worktree ${worktreePath} has ${dirty.length} uncommitted path(s) — ` +
    `SKIPPING removal to avoid data loss: ${dirty.slice(0, 10).join(', ')}` +
    (dirty.length > 10 ? ', ...' : '')
  );
  emitUnmergedEvent(projectRoot, worktreePath, agentName, sessionId, dirty, null);
  process.exit(0);
}

// Clean — safe to force-remove (detached-HEAD checkout state, no data at risk).
const result = spawnSync('git', [
  '-C', projectRoot,
  'worktree', 'remove',
  '--force',
  worktreePath,
], { encoding: 'utf8' });

if (result.status === 0) {
  logStderr(`OK removed worktree ${worktreePath}`);
} else {
  logStderr(`Non-zero cleanup (${result.status}): ${result.stderr || result.stdout}`);
  // Try prune as fallback
  spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' });
}

// Always succeed — never block agent shutdown
process.exit(0);
