#!/usr/bin/env node
'use strict';

/**
 * auto-commit-master-on-pm-stop.js — Stop hook (PM-level).
 *
 * Fires on PM Stop. If an orchestration is active AND the master tree is
 * dirty, commits all changes with a Generated-By trailer that
 * validate-commit-handoff.js exempts. Clean master trees are skipped silently.
 *
 * Kill switches (checked in order):
 *   1. ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED=1  — env var (fastest)
 *   2. master_auto_commit.enabled === false in .orchestray/config.json
 *
 * Mid-git-operation guards (skip silently, no failure event):
 *   .git/REBASE_HEAD, .git/MERGE_HEAD, .git/CHERRY_PICK_HEAD, .git/BISECT_LOG
 *
 * Fail-open contract: every error path logs to stderr and exits 0 so that
 * this hook NEVER blocks Claude Code PM shutdown.
 *
 * W3 — v2.2.18 master-tree auto-commit on PM Stop.
 *
 * Note on PM vs SubagentStop disambiguation: The `Stop` hook event type in
 * hooks.json fires only for the parent (PM-level) agent stop. The separate
 * `SubagentStop` event type fires for subagent stops. Because we register
 * this script under the `Stop` matcher block — not `SubagentStop` — only PM
 * stops trigger this script. No additional runtime check is needed.
 */

const fs            = require('node:fs');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveSafeCwd }           = require('./_lib/resolve-project-cwd');
const { writeEvent }               = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }          = require('./_lib/constants');
const { loadMasterAutoCommitConfig } = require('./_lib/config-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a prefixed diagnostic line to stderr.
 * @param {string} msg
 */
function logStderr(msg) {
  try { process.stderr.write('[orchestray/master-auto-commit] ' + msg + '\n'); } catch (_e) {}
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
 * Count files listed by `git status --porcelain`.
 * @param {string} statusOutput
 * @returns {number}
 */
function countChangedFiles(statusOutput) {
  return statusOutput.split('\n').filter(l => l.trim().length > 0).length;
}

/**
 * Check whether a mid-git-operation file exists in the .git directory.
 * Returns the name of the blocking file if found, or null if clear.
 * @param {string} projectRoot
 * @returns {string|null}
 */
function detectMidGitOperation(projectRoot) {
  const guards = [
    'REBASE_HEAD',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'BISECT_LOG',
  ];
  for (const guard of guards) {
    const p = path.join(projectRoot, '.git', guard);
    try {
      if (fs.existsSync(p)) return guard;
    } catch (_e) { /* existsSync may throw on EPERM; skip */ }
  }
  return null;
}

// S-2 (v2.2.18): parseFrontmatter consolidated into bin/_lib/frontmatter-parse.js.
// Local hand-rolled parser removed; behavior preserved via the shared module.
const { parseFrontmatter } = require('./_lib/frontmatter-parse');

/**
 * Read orchestration state from .orchestray/state/orchestration.md.
 * Returns { status, orchestration_id, current_phase } or null on failure.
 *
 * @param {string} projectRoot
 * @returns {{ status: string, orchestration_id: string, current_phase: string }|null}
 */
function readOrchestrationState(projectRoot) {
  const orchPath = path.join(projectRoot, '.orchestray', 'state', 'orchestration.md');
  let content;
  try {
    content = fs.readFileSync(orchPath, 'utf8');
  } catch (_e) {
    return null;
  }
  try {
    const parsed = parseFrontmatter(content);
    // Shared module returns null on missing/malformed frontmatter.
    // Treat null the same way the legacy parser treated `{}` — return a
    // best-effort state object with sentinel defaults so the caller's
    // gating logic (status === 'active') remains valid.
    const fm = (parsed && parsed.frontmatter) ? parsed.frontmatter : {};
    return {
      status:           fm.status           || '',
      orchestration_id: fm.orchestration_id || 'unknown',
      current_phase:    fm.current_phase    || fm.phase || 'unknown',
    };
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main — async stdin reader (matches W1/collect-agent-metrics.js convention)
// ---------------------------------------------------------------------------

// 1. Kill switch — env var (fastest, checked before any I/O).
if (process.env.ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED === '1') {
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
  // 2. Parse the Stop hook payload.
  let event = {};
  try {
    event = JSON.parse(_stdinBuffer);
  } catch (_e) {
    // Malformed stdin — fail-open with empty event.
  }

  // 3. Resolve project cwd from event payload.
  const rawCwd = event && event.cwd;
  const cwd = resolveSafeCwd(rawCwd);

  // 4. Kill switch — config file (requires cwd).
  try {
    const cfg = loadMasterAutoCommitConfig(cwd);
    if (cfg.enabled === false) {
      process.exit(0);
    }
  } catch (_e) {
    // Fail-open: if config read throws, proceed.
  }

  // 5. Check if orchestration is active via .orchestray/state/orchestration.md.
  const orchState = readOrchestrationState(cwd);
  if (!orchState || orchState.status !== 'active') {
    // No active orchestration — nothing to do.
    process.exit(0);
  }

  const orchestrationId = orchState.orchestration_id;
  const currentPhase    = orchState.current_phase;

  // 6. Mid-git-operation guard.
  const midOpFile = detectMidGitOperation(cwd);
  if (midOpFile) {
    logStderr('skipping during git operation (' + midOpFile + ' detected)');
    process.exit(0);
  }

  // 7. Check for dirty master tree.
  const statusResult = git(cwd, ['status', '--porcelain']);
  if (statusResult.status !== 0) {
    logStderr('git status failed (exit ' + statusResult.status + '): ' + statusResult.stderr.slice(0, 200));
    process.exit(0);
  }
  if (!statusResult.stdout) {
    // Clean master tree — nothing to do.
    process.exit(0);
  }

  // 8. Dirty master tree — commit it.
  const filesChangedCount = countChangedFiles(statusResult.stdout);
  const ts = new Date().toISOString();

  // git add -A
  const addResult = git(cwd, ['add', '-A']);
  if (addResult.status !== 0) {
    logStderr('git add -A failed (exit ' + addResult.status + '): ' + addResult.stderr.slice(0, 200));
    // Continue anyway — commit may still succeed for already-staged files.
  }

  // Build commit message (load-bearing format — validate-commit-handoff.js exemption parses this).
  const commitMsg = [
    'wip(orch ' + orchestrationId + ' stop ' + ts + '): master-tree edits captured',
    '',
    'Phase: ' + currentPhase,
    'Files: ' + filesChangedCount + ' changed',
    'Generated-By: orchestray-auto-commit-master',
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
      writeEvent(
        {
          type:             'master_auto_commit_failed',
          ts:               new Date().toISOString(),
          orchestration_id: orchestrationId,
          error_code:       commitResult.status,
          stderr_excerpt:   stderrExcerpt,
        },
        { cwd }
      );
    } catch (_e) { /* fail-open */ }

    process.exit(0);
  }

  // Commit succeeded — read the new commit SHA.
  const shaResult = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const commitSha = shaResult.status === 0 ? shaResult.stdout : 'unknown';

  logStderr(
    'auto-committed ' + filesChangedCount + ' file(s) as ' + commitSha +
    ' (orch: ' + orchestrationId + ', phase: ' + currentPhase + ')'
  );

  // Emit success event.
  try {
    writeEvent(
      {
        type:                'master_auto_commit_emitted',
        ts:                  new Date().toISOString(),
        orchestration_id:    orchestrationId,
        current_phase:       currentPhase,
        files_changed_count: filesChangedCount,
        commit_sha:          commitSha,
      },
      { cwd }
    );
  } catch (_e) { /* fail-open */ }

  process.exit(0);
});
