#!/usr/bin/env node
'use strict';

/**
 * worktree-remove.js — WorktreeRemove hook for Claude Code agent isolation.
 *
 * Convention (mirrors worktree-create.js):
 *   - stdin JSON: { session_id, cwd, agent_type, name, hook_event_name, ... }
 *   - Reconstructs worktree path as <cwd>/.claude/worktrees/<name>.
 *   - Removes the worktree (--force to handle uncommitted changes from agent).
 *   - Fail-open: always exits 0 to never block agent shutdown.
 */

const fs            = require('node:fs');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');
const { readHookInputRaw } = require('./_lib/hook-stdin');

function logStderr(msg) {
  try { process.stderr.write('[orchestray/worktree-remove] ' + msg + '\n'); } catch (_e) {}
}

let stdinBuf = '';
try { stdinBuf = readHookInputRaw(); } catch (_e) {}

let input = {};
try { input = JSON.parse(stdinBuf || '{}'); } catch (_e) {}

const agentName   = input.name || input.agent_name;
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

// Force-remove worktree (auto-commit hook already saved any work)
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
