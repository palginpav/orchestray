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
 * Twin-idempotency (v2.3.8): every Agent spawn fires this hook TWICE — once from
 * the global install and once from the local install — racing on .git/index.lock.
 *   (a) If the target worktree path already exists and is a valid registered worktree
 *       for this project, exit 0 (twin already did the work).
 *   (b) index.lock contention is retried via B6 jittered backoff (already present).
 *       After retries exhausted on a lock error, re-check (a) before failing — the
 *       twin may have completed successfully during the retry window.
 *
 * Companion: worktree-remove.js for cleanup on agent shutdown.
 */

const fs            = require('node:fs');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');
const { readHookInputRaw } = require('./_lib/hook-stdin');

function logStderr(msg) {
  try { process.stderr.write('[orchestray/worktree-create] ' + msg + '\n'); } catch (_e) {}
}

let stdinBuf = '';
try {
  stdinBuf = readHookInputRaw();
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

// A3 (v2.3.10): agentName flows from stdin straight into path.join — an
// unsanitized value like `../../../tmp/evil` or one with separators escapes
// the worktrees parent. Validate against a strict portable-name allowlist
// (the value is used as a single directory component, so no `/`, no `..`).
if (typeof agentName !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(agentName) || agentName === '.' || agentName === '..') {
  logStderr(`FAIL: invalid agent name ${JSON.stringify(String(agentName).slice(0, 80))} — must match /^[a-zA-Z0-9_.-]+$/ and not be '.'/'..'`);
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

// A3 (v2.3.10): defense-in-depth — assert the resolved worktree path is a
// direct child of the worktrees parent. Even with the name allowlist above,
// a belt-and-suspenders containment check guarantees no path-join surprise
// escapes the sandbox root.
const resolvedParent = path.resolve(worktreesParent);
const resolvedWorktree = path.resolve(worktreePath);
if (resolvedWorktree !== path.join(resolvedParent, agentName) ||
    !resolvedWorktree.startsWith(resolvedParent + path.sep)) {
  logStderr(`FAIL: resolved worktree path ${resolvedWorktree} escapes ${resolvedParent}${path.sep}`);
  process.exit(1);
}

// Ensure parent dir exists
try {
  fs.mkdirSync(worktreesParent, { recursive: true });
} catch (e) {
  logStderr(`FAIL: could not mkdir ${worktreesParent}: ${e.message}`);
  process.exit(1);
}

/**
 * Check if the worktree path already exists and is registered with git as a
 * valid worktree for this project. Used to detect twin-invocation idempotency.
 *
 * @returns {boolean}
 */
function worktreeAlreadyValid() {
  if (!fs.existsSync(worktreePath)) return false;
  // `git worktree list --porcelain` lists all worktrees; look for our path.
  const listResult = spawnSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  if (listResult.status !== 0) return false;
  // Each worktree block starts with `worktree <absolute-path>`
  const lines = (listResult.stdout || '').split('\n');
  const normalized = path.resolve(worktreePath);
  return lines.some(l => l.startsWith('worktree ') && path.resolve(l.slice(9).trim()) === normalized);
}

// Twin-idempotency check (a): if the worktree already exists and is valid, the
// twin already completed — exit 0 immediately without touching git state.
if (worktreeAlreadyValid()) {
  logStderr(`Worktree already registered at ${worktreePath} (twin-idempotent) — reusing`);
  process.stdout.write(worktreePath + '\n');
  process.exit(0);
}

// F1 (v2.3.9): stale-cleanup TOCTOU guard.
// The original code checked existsSync ONCE then immediately called
// `git worktree remove --force`. In a twin-hook race (global + local install
// both fire), twin B could see the dir created by twin A mid-checkout and
// force-remove it — destroying A's in-flight work (root cause of the
// `.claude-plugin: No such file or directory` failures and the live sibling
// clobber incident).
//
// Safe cleanup rule:
//   (1) Re-check worktreeAlreadyValid() inside the exists branch. If the twin
//       completed between our initial check and now, reuse — do NOT remove.
//   (2) Only remove a dir that is BOTH unregistered AND old enough that no
//       concurrent worktree add could have created it (mtime > 2h). A freshly
//       created worktree dir will have mtime < seconds; 2h is a conservative
//       threshold that excludes any in-flight checkout.
//
// Minimum age for a dir to be considered stale: 2 hours.
const STALE_WORKTREE_MIN_AGE_MS = 2 * 60 * 60 * 1000;

if (fs.existsSync(worktreePath)) {
  // Re-validate under the exists branch — the twin may have completed since
  // we ran the first worktreeAlreadyValid() above.
  if (worktreeAlreadyValid()) {
    logStderr(`Worktree registered by twin (post-exists check) at ${worktreePath} — reusing`);
    process.stdout.write(worktreePath + '\n');
    process.exit(0);
  }

  // Only remove if provably stale (unregistered AND old mtime).
  let dirMtimeMs = Infinity;
  try {
    dirMtimeMs = fs.statSync(worktreePath).mtimeMs;
  } catch (_e) { /* stat failed — dir may have just been removed; fall through */ }

  const ageMs = Date.now() - dirMtimeMs;
  if (ageMs < STALE_WORKTREE_MIN_AGE_MS) {
    // Dir is fresh — a concurrent worktree add may be in progress. Skip cleanup;
    // let the worktree add below fail naturally (it will hit index.lock contention
    // or succeed if the twin vacated). The retry loop handles lock contention.
    logStderr(
      `Worktree dir at ${worktreePath} exists but is fresh (${Math.round(ageMs / 1000)}s old) ` +
      `and unregistered — skipping force-remove to avoid TOCTOU clobber; retrying add`
    );
  } else {
    logStderr(`Stale worktree dir at ${worktreePath} (${Math.round(ageMs / 3600000)}h old, unregistered) — removing`);
    spawnSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
    });
    // Best-effort prune in case worktree dir was deleted but git still tracks it
    spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' });
  }
}

// Create worktree on current HEAD (detached — agent works on detached HEAD).
// B6: retry on git index.lock contention. Parallel Agent() spawns all invoke
// `git worktree add` concurrently → two processes compete for .git/index.lock.
// Retry up to 5× with jittered back-off (100–200 ms per attempt); fail with
// the original error on non-lock errors or after retries exhausted.
const INDEX_LOCK_RE = /index\.lock|Unable to create.*\.lock|cannot lock ref/i;
const WORKTREE_ADD_MAX_ATTEMPTS = 5;
const WORKTREE_ADD_BASE_JITTER_MS = 100;

let result;
let lastErrWasLock = false;
for (let attempt = 0; attempt < WORKTREE_ADD_MAX_ATTEMPTS; attempt++) {
  result = spawnSync('git', [
    '-C', projectRoot,
    'worktree', 'add',
    '--detach',
    '--quiet',
    worktreePath,
    'HEAD',
  ], { encoding: 'utf8' });

  if (result.status === 0) break;

  const errText = (result.stderr || '') + (result.stdout || '');
  const isLockContention = INDEX_LOCK_RE.test(errText);
  lastErrWasLock = isLockContention;

  if (!isLockContention || attempt === WORKTREE_ADD_MAX_ATTEMPTS - 1) {
    // Twin-idempotency check (b): after retries exhausted on lock contention,
    // re-check whether the twin completed successfully during the retry window.
    if (isLockContention && worktreeAlreadyValid()) {
      logStderr(`Worktree registered by twin after lock contention at ${worktreePath} — reusing`);
      process.stdout.write(worktreePath + '\n');
      process.exit(0);
    }
    logStderr(`FAIL: git worktree add exited ${result.status} (attempt ${attempt + 1}/${WORKTREE_ADD_MAX_ATTEMPTS}): ${errText}`);
    process.exit(1);
  }

  const sleepMs = WORKTREE_ADD_BASE_JITTER_MS + Math.floor(Math.random() * WORKTREE_ADD_BASE_JITTER_MS);
  logStderr(`git worktree add: index.lock contention (attempt ${attempt + 1}), retrying in ${sleepMs}ms`);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  } catch (_e) {
    const deadline = Date.now() + sleepMs;
    while (Date.now() < deadline) { /* spin */ }
  }
}

if (!result || result.status !== 0) {
  // Final twin-idempotency check before hard fail.
  if (lastErrWasLock && worktreeAlreadyValid()) {
    logStderr(`Worktree registered by twin (final check) at ${worktreePath} — reusing`);
    process.stdout.write(worktreePath + '\n');
    process.exit(0);
  }
  logStderr(`FAIL: git worktree add failed after ${WORKTREE_ADD_MAX_ATTEMPTS} attempts`);
  process.exit(1);
}

// Output worktree path on stdout — Claude Code's worktree contract.
// Single line, plain text, no JSON wrapping (avoids downstream Orchestray scripts
// confusing JSON output for a directory prefix in auto-commit-worktree).
process.stdout.write(worktreePath + '\n');
logStderr(`OK created worktree at ${worktreePath} for agent ${agentName}`);
process.exit(0);
