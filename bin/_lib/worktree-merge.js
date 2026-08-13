'use strict';

/**
 * worktree-merge.js — core logic for the safe worktree→main merge helper
 * (v2.3.28 W2).
 *
 * Why this exists
 * ----------------
 * The PM's only proven-safe way to bring worktree work into the main tree is
 * `git -C <worktree> diff -- <file>` applied as a patch, after checking the
 * worktree's base against current main HEAD. Across two releases that manual
 * discipline prevented data loss four times (D2, D6, D7, V3I — see
 * `.orchestray/kb/decisions/v2328-scope-locked.md` §W2). Nothing enforced it;
 * it lived entirely in PM judgement. This module makes it mechanical.
 *
 * Design
 * ------
 * 1. `computeMergePlan` reads the worktree's creation-time baseline (written
 *    by `worktree-create.js`, P2/W15) and diffs it against current main HEAD.
 *    If main has moved, it checks — file by file — whether the SAME file was
 *    also touched on both sides since that baseline. Any such file is a
 *    genuine 3-way conflict candidate and the whole merge is refused (never a
 *    partial apply — a partial merge is its own silent-loss mode).
 *    Discovery of changed files unions two sources: `git status --porcelain`
 *    (uncommitted changes) and `git diff --name-only <base> HEAD` (committed
 *    since base). Agents may commit inside their worktree; omitting the
 *    committed set causes a worktree full of deliverables to report zero
 *    changes and merge as a silent no-op.
 * 2. `executeMerge` applies the plan: tracked changes go through
 *    `git diff <base> -- <path>` → `git apply` (never a wholesale copy —
 *    that's the D6/D7 failure mode). Untracked-only files (the V3I/D2 case)
 *    are copied directly since they cannot collide with tracked history, but
 *    ARE still refused if a file already exists at that path in main
 *    (a naming collision, not a text conflict — still real data risk).
 *
 * No baseline recorded (`worktree-meta/<agent>.json` missing) is a hard
 * refusal, not a best-effort skip — unlike M2's diagnostic use of the same
 * file (which fails open because it's only a warning), a merge tool cannot
 * safely reason about "did main move" without it.
 *
 * Untested-until-now case: a file changed in the worktree since its base
 * AND in main since that base. See `computeMergePlan`'s MODIFIED_BOTH
 * branch — refused with the conflicting file list, never auto-merged. Proven
 * by `bin/__tests__/v2328-w2-worktree-merge.test.js` (case 3; also case 8+
 * cover committed-in-worktree work discovery and 3-way conflict detection).
 */

const fs   = require('node:fs');
const path = require('node:path');

const { spawnSync } = require('node:child_process');

const { git } = require('./dirty-worktree-sweep');
const { resolveMainProjectRoot } = require('./resolve-project-cwd');

/**
 * Resolve the MAIN project root for a cwd that may be inside a git worktree.
 * Delegates to the shared W1 helper; the name is kept as this module's
 * public export for callers already bound to it.
 * @param {string} cwd
 * @returns {string}
 */
function resolveProjectRoot(cwd) {
  return resolveMainProjectRoot(cwd);
}

/**
 * `git status --porcelain --untracked-files=all` — unlike
 * dirty-worktree-sweep.js's gitStatusPorcelain (which uses the default
 * directory-collapsing mode; fine for "is anything dirty", wrong for "which
 * exact files"), this tool needs individual untracked file paths to copy
 * them one at a time and check each for a main-tree collision. Preserves
 * the leading-space-significant first line (no blanket .trim()), same as
 * dirty-worktree-sweep.js's variant.
 * @param {string} cwd
 */
function gitStatusPorcelainAll(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: (r.stdout || '').replace(/[\r\n]+$/, ''), stderr: (r.stderr || '').trim() };
}

const REASONS = {
  MODIFIED_BOTH: 'modified_in_worktree_and_main_since_base',
  UNTRACKED_COLLISION: 'untracked_collides_with_existing_main_file',
  HISTORY_REWRITTEN: 'base_not_ancestor_of_current_main_head',
};

/** @param {string} projectRoot @param {string} agentName */
function readWorktreeMeta(projectRoot, agentName) {
  const metaPath = path.join(projectRoot, '.orchestray', 'state', 'worktree-meta', agentName + '.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve a CLI argument (agent name, or a literal worktree path) to
 * {agentName, worktreePath}.
 * @param {string} projectRoot
 * @param {string} arg
 */
function resolveTarget(projectRoot, arg) {
  if (!arg) return null;
  const asPath = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  if (fs.existsSync(path.join(asPath, '.git'))) {
    return { agentName: path.basename(asPath), worktreePath: asPath };
  }
  const byName = path.join(projectRoot, '.claude', 'worktrees', arg);
  if (fs.existsSync(path.join(byName, '.git'))) {
    return { agentName: arg, worktreePath: byName };
  }
  return null;
}

/**
 * Parse `git status --porcelain` output into tracked-changed and
 * untracked-only relative paths. Renames (`R  old -> new`) resolve to the
 * new path.
 * @param {string} statusOutput
 * @returns {{tracked: string[], untracked: string[]}}
 */
function classifyChanges(statusOutput) {
  const tracked = [];
  const untracked = [];
  for (const raw of statusOutput.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3).trim();
    if (rest.includes(' -> ')) rest = rest.split(' -> ')[1].trim();
    if (code === '??') {
      untracked.push(rest);
    } else {
      tracked.push(rest);
    }
  }
  return { tracked: [...new Set(tracked)], untracked: [...new Set(untracked)] };
}

/**
 * Raw (untrimmed) `git diff` for patch generation — trimming can corrupt a
 * patch's trailing-newline semantics, so this does NOT reuse `git()` from
 * dirty-worktree-sweep.js, which trims for log-friendliness.
 * @param {string} cwd
 * @param {string[]} args
 */
function gitRaw(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}

/**
 * @param {string} projectRoot main tree root (resolveMainProjectRoot output)
 * @param {string} worktreePath
 * @returns {{ok: boolean, error?: string, baseHead?: string, currentMainHead?: string,
 *   stale?: boolean, tracked?: string[], untracked?: string[], conflicts?: Array<{path: string, reason: string}>}}
 */
function computeMergePlan(projectRoot, worktreePath) {
  const agentName = path.basename(worktreePath);
  const meta = readWorktreeMeta(projectRoot, agentName);
  if (!meta || typeof meta.main_tree_head_at_creation !== 'string' || !meta.main_tree_head_at_creation) {
    return { ok: false, error: 'no baseline recorded for this worktree (worktree-meta missing or incomplete) — refusing merge, cannot verify safety' };
  }
  const baseHead = meta.main_tree_head_at_creation;

  const headResult = git(projectRoot, ['rev-parse', 'HEAD']);
  if (headResult.status !== 0) {
    return { ok: false, error: 'could not resolve current main HEAD: ' + headResult.stderr };
  }
  const currentMainHead = headResult.stdout;
  const stale = baseHead !== currentMainHead;

  const statusResult = gitStatusPorcelainAll(worktreePath);
  if (statusResult.status !== 0) {
    return { ok: false, error: 'could not read worktree status: ' + statusResult.stderr };
  }
  const { tracked, untracked } = classifyChanges(statusResult.stdout);

  // Agents may commit inside their worktree rather than leaving work dirty.
  // `git status --porcelain` shows only UNCOMMITTED changes, so committed work
  // must be discovered separately — otherwise a worktree full of committed
  // deliverables reports zero changed files and merges as a silent no-op.
  const committedResult = git(worktreePath, ['diff', '--name-only', baseHead, 'HEAD']);
  if (committedResult.status !== 0) {
    return { ok: false, error: 'could not list committed-since-base changes: ' + committedResult.stderr };
  }
  const committed = committedResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const trackedAll = [...new Set([...tracked, ...committed])];

  const conflicts = [];

  if (stale) {
    const ancestorCheck = git(projectRoot, ['merge-base', '--is-ancestor', baseHead, currentMainHead]);
    if (ancestorCheck.status !== 0) {
      // Base is not an ancestor of current main HEAD (history rewritten —
      // rebase/force-push). We cannot safely reason about a file-level diff
      // against a base main no longer contains. Refuse the whole merge.
      conflicts.push({ path: '*', reason: REASONS.HISTORY_REWRITTEN });
    } else {
      for (const p of trackedAll) {
        const changedInMain = git(projectRoot, ['diff', '--name-only', baseHead, currentMainHead, '--', p]);
        if (changedInMain.status === 0 && changedInMain.stdout.trim().length > 0) {
          conflicts.push({ path: p, reason: REASONS.MODIFIED_BOTH });
        }
      }
    }
  }

  for (const p of untracked) {
    if (fs.existsSync(path.join(projectRoot, p))) {
      conflicts.push({ path: p, reason: REASONS.UNTRACKED_COLLISION });
    }
  }

  // Staleness above is HEAD-to-HEAD and cannot see work sitting UNCOMMITTED in
  // main — the D6 shape (live edits made minutes earlier, not yet committed).
  // executeMerge's `git apply --check` is the real guard, but a status report
  // claiming "safe" without naming this overlap is the silent half of that bug.
  const mainOverlap = [];
  const mainStatus = gitStatusPorcelainAll(projectRoot);
  if (mainStatus.status === 0) {
    const dirtyInMain = new Set([
      ...classifyChanges(mainStatus.stdout).tracked,
      ...classifyChanges(mainStatus.stdout).untracked,
    ]);
    for (const p of [...trackedAll, ...untracked]) {
      if (dirtyInMain.has(p)) mainOverlap.push(p);
    }
  }

  return {
    ok: true, baseHead, currentMainHead, stale,
    tracked: trackedAll, untracked, conflicts,
    uncommittedCount: tracked.length, committedCount: committed.length,
    mainUncommittedOverlap: mainOverlap,
    totalChangedFiles: trackedAll.length + untracked.length,
  };
}

/**
 * Apply a validated (conflict-free) merge plan: patch tracked changes,
 * copy untracked-only files. Never invoked if `plan.conflicts.length > 0` —
 * callers must check that first.
 * @param {string} projectRoot
 * @param {string} worktreePath
 * @param {ReturnType<typeof computeMergePlan>} plan
 * @returns {{ok: boolean, error?: string, filesApplied?: number, filesCopied?: number}}
 */
function executeMerge(projectRoot, worktreePath, plan) {
  if (!plan.ok) return { ok: false, error: plan.error };
  if (plan.conflicts && plan.conflicts.length > 0) {
    return { ok: false, error: 'refusing to merge: unresolved conflicts present', conflicts: plan.conflicts };
  }
  if (plan.tracked.length === 0 && plan.untracked.length === 0) {
    return { ok: true, filesApplied: 0, filesCopied: 0, noChanges: true };
  }

  let filesApplied = 0;
  if (plan.tracked.length > 0) {
    const diffResult = gitRaw(worktreePath, ['diff', plan.baseHead, '--', ...plan.tracked]);
    if (diffResult.status !== 0) {
      return { ok: false, error: 'git diff failed: ' + diffResult.stderr };
    }
    const patchText = diffResult.stdout;
    if (patchText.trim().length > 0) {
      const check = spawnSync('git', ['-C', projectRoot, 'apply', '--check', '-'], { input: patchText, encoding: 'utf8' });
      if (check.status !== 0) {
        return { ok: false, error: 'patch does not apply cleanly to main tree: ' + (check.stderr || '').slice(0, 500) };
      }
      const apply = spawnSync('git', ['-C', projectRoot, 'apply', '-'], { input: patchText, encoding: 'utf8' });
      if (apply.status !== 0) {
        return { ok: false, error: 'patch apply failed: ' + (apply.stderr || '').slice(0, 500) };
      }
      filesApplied = plan.tracked.length;
    }
  }

  let filesCopied = 0;
  for (const p of plan.untracked) {
    const src = path.join(worktreePath, p);
    const dest = path.join(projectRoot, p);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      filesCopied++;
    } catch (e) {
      return { ok: false, error: 'failed to copy untracked file ' + p + ': ' + (e && e.message ? e.message : e), filesApplied, filesCopied };
    }
  }

  return { ok: true, filesApplied, filesCopied };
}

module.exports = {
  readWorktreeMeta,
  resolveTarget,
  resolveProjectRoot,
  classifyChanges,
  computeMergePlan,
  executeMerge,
  gitRaw,
  REASONS,
};
