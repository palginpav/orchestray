#!/usr/bin/env node
'use strict';

/**
 * auto-commit-worktree-on-subagent-stop.js — SubagentStop hook.
 *
 * Detects a worktree-isolated agent cwd and auto-commits any uncommitted
 * changes with a Generated-By trailer. Clean worktrees are skipped silently.
 *
 * Kill switches (checked in order):
 *   1. ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED=1  — env var (fastest)
 *   2. worktree_auto_commit.enabled === false in .orchestray/config.json
 *
 * Fail-open contract: every error path logs to stderr and exits 0 so that
 * this hook NEVER blocks Claude Code agent shutdown.
 *
 * W1 — v2.2.18 worktree auto-commit on SubagentStop.
 */

const fs                = require('node:fs');
const path              = require('node:path');
const { spawnSync }     = require('node:child_process');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { loadWorktreeAutoCommitConfig } = require('./_lib/config-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a prefixed diagnostic line to stderr.
 * @param {string} msg
 */
function logStderr(msg) {
  try { process.stderr.write('[orchestray/auto-commit] ' + msg + '\n'); } catch (_e) {}
}

/**
 * Run a git command in the given directory.
 * Returns { status, stdout, stderr } — never throws.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 8000,
    });
    return {
      status: r.status,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
    };
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e && e.message ? e.message : e) };
  }
}

/**
 * Detect whether cwd is inside a linked git worktree (not the main tree).
 *
 * In a linked worktree:
 *   git rev-parse --git-dir   → .git/worktrees/<name>  (worktree-specific)
 *   git rev-parse --git-common-dir → .git              (shared common dir)
 *   These two differ.
 *
 * In the main worktree (or a plain clone):
 *   Both return the same path (.git).
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isLinkedWorktree(cwd) {
  const gitDir    = git(cwd, ['rev-parse', '--git-dir']);
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir']);
  if (gitDir.status !== 0 || commonDir.status !== 0) return false;
  // Resolve to absolute paths for a reliable comparison.
  const absGitDir    = path.resolve(cwd, gitDir.stdout);
  const absCommonDir = path.resolve(cwd, commonDir.stdout);
  return absGitDir !== absCommonDir;
}

/**
 * Count files listed by `git status --porcelain`.
 * @param {string} statusOutput
 * @returns {number}
 */
function countChangedFiles(statusOutput) {
  return statusOutput.split('\n').filter(l => l.trim().length > 0).length;
}

/**
 * Read orchestration_id from .orchestray/audit/current-orchestration.json
 * using the resolved project cwd (best-effort).
 * @param {string} cwd
 * @returns {string}
 */
function readOrchestrationId(cwd) {
  try {
    const file = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.orchestration_id === 'string' && data.orchestration_id.length > 0) {
      return data.orchestration_id;
    }
  } catch (_e) { /* fail-open */ }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main — async stdin reader (matches collect-agent-metrics.js convention)
// ---------------------------------------------------------------------------

// 1. Kill switch — env var (fastest, checked before any I/O).
if (process.env.ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED === '1') {
  process.exit(0);
}

let _stdinBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  _stdinBuffer += chunk;
  if (_stdinBuffer.length > MAX_INPUT_BYTES) {
    logStderr('stdin exceeded MAX_INPUT_BYTES; aborting');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  // 2. Parse the SubagentStop hook payload.
  let event = {};
  try {
    event = JSON.parse(_stdinBuffer);
  } catch (_e) {
    // Malformed stdin — fail-open with empty event.
  }

  // 3. Resolve cwd from event payload. If absent, exit 0 with a notice.
  const rawCwd = event && event.cwd;
  if (!rawCwd) {
    logStderr('event.cwd absent — skipping worktree auto-commit');
    process.exit(0);
  }
  const cwd = resolveSafeCwd(rawCwd);

  // 4. Kill switch — config file (requires cwd).
  try {
    const cfg = loadWorktreeAutoCommitConfig(cwd);
    if (cfg.enabled === false) {
      process.exit(0);
    }
  } catch (_e) {
    // Fail-open: if config read throws, proceed.
  }

  // 5. Verify cwd is a linked worktree (not the master tree).
  if (!isLinkedWorktree(cwd)) {
    process.exit(0);
  }

  // 6. Check for dirty state.
  const statusResult = git(cwd, ['status', '--porcelain']);
  if (statusResult.status !== 0) {
    logStderr('git status failed (exit ' + statusResult.status + '): ' + statusResult.stderr.slice(0, 200));
    process.exit(0);
  }
  if (!statusResult.stdout) {
    // Clean worktree — nothing to do.
    process.exit(0);
  }

  // 7. Dirty worktree — commit it.
  const filesChangedCount = countChangedFiles(statusResult.stdout);
  const subagentType      = (event && event.agent_role) ||
                            process.env.CLAUDE_AGENT_TYPE ||
                            'unknown';
  const sessionId         = (event && event.session_id) || 'unknown';
  const orchestrationId   = readOrchestrationId(cwd);
  const worktreeBasename  = path.basename(cwd);

  // git add -A
  const addResult = git(cwd, ['add', '-A']);
  if (addResult.status !== 0) {
    logStderr('git add -A failed (exit ' + addResult.status + '): ' + addResult.stderr.slice(0, 200));
    // Continue anyway — commit may still succeed for already-staged files.
  }

  // Build commit message (load-bearing format — W2 exemption parses this).
  const commitMsg = [
    'wip(auto): ' + subagentType + ' uncommitted edits captured by orchestray',
    '',
    'Agent: ' + subagentType,
    'Orchestration: ' + orchestrationId,
    'Session: ' + sessionId,
    'Worktree: ' + worktreeBasename,
    'Files: ' + filesChangedCount + ' changed',
    'Generated-By: orchestray-auto-commit-worktree',
  ].join('\n');

  const commitResult = spawnSync(
    'git',
    [
      '-C', cwd,
      '-c', 'user.email=orchestray@local',
      '-c', 'user.name=orchestray-auto-commit',
      'commit',
      '-m', commitMsg,
    ],
    { encoding: 'utf8', timeout: 8000 }
  );

  if (commitResult.status !== 0) {
    // Commit failed — emit failure event and exit 0.
    const stderrExcerpt = (commitResult.stderr || '').slice(0, 200);
    logStderr('git commit failed (exit ' + commitResult.status + '): ' + stderrExcerpt);

    try {
      const ts = new Date().toISOString();
      writeEvent(
        {
          type:             'worktree_auto_commit_failed',
          schema_version:   1,
          ts,
          orchestration_id: orchestrationId,
          error_code:       commitResult.status,
          stderr_excerpt:   stderrExcerpt,
        },
        { cwd }
      );
    } catch (_e) { /* fail-open */ }

    process.exit(0);
  }

  // 8. Commit succeeded — read the new commit SHA.
  const shaResult = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const commitSha = shaResult.status === 0 ? shaResult.stdout : 'unknown';

  logStderr('auto-committed ' + filesChangedCount + ' file(s) as ' + commitSha + ' in worktree ' + worktreeBasename);

  // 9. Emit success event.
  try {
    const ts = new Date().toISOString();
    writeEvent(
      {
        type:                'worktree_auto_commit_emitted',
        schema_version:      1,
        ts,
        orchestration_id:    orchestrationId,
        session_id:          sessionId,
        subagent_type:       subagentType,
        worktree_basename:   worktreeBasename,
        files_changed_count: filesChangedCount,
        commit_sha:          commitSha,
      },
      { cwd }
    );
  } catch (_e) { /* fail-open */ }

  process.exit(0);
});
