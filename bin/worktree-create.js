#!/usr/bin/env node
'use strict';

/**
 * worktree-create.js — WorktreeCreate hook for Claude Code agent isolation.
 *
 * Convention (discovered via stdin inspection):
 *   - Claude Code sends JSON via stdin: { session_id, cwd, agent_type, name, hook_event_name }
 *   - Hook is responsible for choosing the worktree path AND creating it.
 *   - Standard path: <cwd>/.claude/worktrees/<name>
 *   - On success: print { "worktree_path": "<absolute_path>" } to stdout and exit 0.
 *   - On failure: print error to stderr and exit non-zero.
 *
 * Companion: worktree-remove.js for cleanup on agent shutdown.
 */

const fs            = require('node:fs');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

function logStderr(msg) {
  try { process.stderr.write('[orchestray/worktree-create] ' + msg + '\n'); } catch (_e) {}
}

let stdinBuf = '';
try {
  stdinBuf = fs.readFileSync(0, 'utf8');
} catch (_e) {
  // No stdin available — abort
  logStderr('FAIL: could not read stdin');
  process.exit(1);
}

let input = {};
try {
  input = JSON.parse(stdinBuf || '{}');
} catch (e) {
  logStderr(`FAIL: could not parse stdin as JSON: ${e.message}`);
  process.exit(1);
}

const agentName = input.name || input.agent_name;
const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

if (!agentName) {
  logStderr('FAIL: no agent name in stdin (expected "name" field)');
  process.exit(1);
}

if (!projectRoot) {
  logStderr('FAIL: no project root (no cwd field or CLAUDE_PROJECT_DIR env)');
  process.exit(1);
}

// Pre-flight: ensure projectRoot is a git work tree
const checkRepo = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
  encoding: 'utf8',
});
if (checkRepo.status !== 0 || (checkRepo.stdout || '').trim() !== 'true') {
  logStderr(`FAIL: ${projectRoot} is not inside a git work tree`);
  process.exit(1);
}

// Construct worktree path: <projectRoot>/.claude/worktrees/<agentName>
const worktreesParent = path.join(projectRoot, '.claude', 'worktrees');
const worktreePath = path.join(worktreesParent, agentName);

// Ensure parent dir exists
try {
  fs.mkdirSync(worktreesParent, { recursive: true });
} catch (e) {
  logStderr(`FAIL: could not mkdir ${worktreesParent}: ${e.message}`);
  process.exit(1);
}

// If worktree already exists for this agent name — remove it first (idempotency)
if (fs.existsSync(worktreePath)) {
  logStderr(`Worktree already exists at ${worktreePath} — removing first for idempotency`);
  spawnSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktreePath], {
    encoding: 'utf8',
  });
  // Best-effort prune in case worktree dir was deleted but git still tracks it
  spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' });
}

// Create worktree on current HEAD (detached — agent works on detached HEAD)
const result = spawnSync('git', [
  '-C', projectRoot,
  'worktree', 'add',
  '--detach',
  '--quiet',
  worktreePath,
  'HEAD',
], { encoding: 'utf8' });

if (result.status !== 0) {
  logStderr(`FAIL: git worktree add exited ${result.status}: ${result.stderr || result.stdout}`);
  process.exit(1);
}

// Output worktree path on stdout — Claude Code's worktree contract.
// Single line, plain text, no JSON wrapping (avoids downstream Orchestray scripts
// confusing JSON output for a directory prefix in auto-commit-worktree).
process.stdout.write(worktreePath + '\n');
logStderr(`OK created worktree at ${worktreePath} for agent ${agentName}`);
process.exit(0);
