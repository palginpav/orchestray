#!/usr/bin/env node
'use strict';

/**
 * v2327-v3-dirty-worktree-sweep.test.js — V3 (v2.3.27) regression suite.
 *
 * Tests for bin/_lib/dirty-worktree-sweep.js (M1: PM-Stop dirty-worktree
 * capture net, independent of SubagentStop) and bin/sweep-dirty-worktrees-on-pm-stop.js
 * (the Stop hook wrapper), plus M2 (worktree-meta staleness diagnostic).
 *
 * Cases:
 *   1. Tracked change, quiescent → captured (commit + dirty_worktree_captured event).
 *   2. Untracked-only file, quiescent → captured (the exact loss mode from D2).
 *   3. Clean worktree → left alone, no commit, no event.
 *   4. Not-quiescent (fresh mtime) → NOT captured this sweep (agent may still be live).
 *   5. Re-sweep after capture → no duplicate commit/event (git's own clean state dedupes).
 *   6. Debounce → second sweep within MIN_SWEEP_INTERVAL_MS is a no-op (ran: false).
 *   7. No-op sweep latency is measured and reported.
 *   8. M2 — worktree-meta HEAD divergence emits worktree_head_stale, and that
 *      event reaches computeRecentDiagnostics (the banner-surface pipeline)
 *      unmodified — proving the `_stale` suffix routing works with zero
 *      changes to recent-diagnostics.js / dark-event-banner.js.
 *   9. Hook wrapper: kill switch env var → exit 0, no git invocation.
 *
 * Runner: node --test bin/__tests__/v2327-v3-dirty-worktree-sweep.test.js
 */

const { test, describe } = require('node:test');
const assert       = require('node:assert/strict');
const fs           = require('node:fs');
const os           = require('node:os');
const path         = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'bin', 'sweep-dirty-worktrees-on-pm-stop.js');
const NODE        = process.execPath;

const {
  sweepDirtyWorktrees,
  QUIESCENCE_MS,
  MIN_SWEEP_INTERVAL_MS,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'dirty-worktree-sweep.js'));
const { computeRecentDiagnostics } = require(path.join(REPO_ROOT, 'bin', '_lib', 'recent-diagnostics.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitOpts(cwd, homeDir) {
  return { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: homeDir } };
}

function scaffoldOrchestray(dir, orchId = 'test-orch-001') {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8',
  );
}

/**
 * Build a master repo + N linked worktrees under <master>/.claude/worktrees/<name>.
 * @returns {{ masterDir: string, homeDir: string, worktreesFor: (name: string) => string, cleanup: () => void }}
 */
function makeSetup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2327-v3-'));
  const masterDir = path.join(base, 'master');
  fs.mkdirSync(masterDir, { recursive: true });

  const opts = gitOpts(masterDir, base);
  execSync('git init -b main', opts);
  execSync('git config user.email test@local', opts);
  execSync('git config user.name test', opts);
  fs.writeFileSync(path.join(masterDir, 'README.md'), 'hello');
  execSync('git add -A', opts);
  execSync('git commit -m "init"', opts);
  scaffoldOrchestray(masterDir, 'orch-master');
  execSync('git add -A', opts);
  execSync('git -c user.email=orchestray@local -c user.name=orchestray-auto-commit commit -m "scaffold"', opts);

  const worktreesParent = path.join(masterDir, '.claude', 'worktrees');
  fs.mkdirSync(worktreesParent, { recursive: true });

  function addWorktree(name) {
    const wtPath = path.join(worktreesParent, name);
    execSync(`git worktree add -b wt-${name} "${wtPath}"`, opts);
    scaffoldOrchestray(wtPath, 'orch-' + name);
    execSync('git add -A', gitOpts(wtPath, base));
    execSync(
      'git -c user.email=orchestray@local -c user.name=orchestray-auto-commit commit -m "scaffold"',
      gitOpts(wtPath, base),
    );
    return wtPath;
  }

  return {
    masterDir,
    homeDir: base,
    addWorktree,
    cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_e) {} },
  };
}

function countCommits(dir, homeDir) {
  try {
    return parseInt(execSync('git rev-list --count HEAD', gitOpts(dir, homeDir)).trim(), 10);
  } catch (_e) { return 0; }
}

function readEvents(projectDir) {
  const eventsPath = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

/** Backdate mtime of a file so it reads as quiescent. */
function backdateFile(filePath, msAgo) {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(filePath, t, t);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2327 V3 — dirty-worktree sweep (M1) + worktree-head-stale (M2)', () => {

  test('1. Tracked change, quiescent → captured', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a1');
      const f = path.join(wt, 'README.md');
      fs.writeFileSync(f, 'modified by agent');
      backdateFile(f, QUIESCENCE_MS + 10000);

      const before = countCommits(wt, s.homeDir);
      const result = sweepDirtyWorktrees(s.masterDir, { force: true });

      assert.equal(result.ran, true);
      assert.equal(result.captured, 1, 'expected exactly one capture');
      assert.equal(countCommits(wt, s.homeDir), before + 1, 'exactly one new commit');

      const events = readEvents(s.masterDir).filter((e) => e.type === 'dirty_worktree_captured');
      assert.equal(events.length, 1);
      assert.equal(events[0].agent_name, 'agent-a1');
      assert.equal(events[0].files_changed_count, 1);
    } finally { s.cleanup(); }
  });

  test('2. Untracked-only file, quiescent → captured (D2 loss mode)', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a2');
      const f = path.join(wt, 'new-module.js');
      fs.writeFileSync(f, 'module.exports = {};');
      backdateFile(f, QUIESCENCE_MS + 10000);

      const before = countCommits(wt, s.homeDir);
      const result = sweepDirtyWorktrees(s.masterDir, { force: true });

      assert.equal(result.captured, 1);
      assert.equal(countCommits(wt, s.homeDir), before + 1);
      const log = execSync('git show --stat -1 --format=', gitOpts(wt, s.homeDir));
      assert.match(log, /new-module\.js/);
    } finally { s.cleanup(); }
  });

  test('3. Clean worktree → left alone', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a3');
      const before = countCommits(wt, s.homeDir);

      const result = sweepDirtyWorktrees(s.masterDir, { force: true });

      assert.equal(result.captured, 0);
      assert.equal(countCommits(wt, s.homeDir), before);
      const events = readEvents(s.masterDir).filter((e) =>
        e.type === 'dirty_worktree_captured' || e.type === 'dirty_worktree_capture_failed');
      assert.equal(events.length, 0);
    } finally { s.cleanup(); }
  });

  test('4. Fresh mtime (not quiescent) → NOT captured this sweep', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a4');
      fs.writeFileSync(path.join(wt, 'README.md'), 'modified just now');
      // No backdate — mtime is "now", well inside QUIESCENCE_MS.

      const before = countCommits(wt, s.homeDir);
      const result = sweepDirtyWorktrees(s.masterDir, { force: true });

      assert.equal(result.captured, 0, 'a freshly-touched worktree must not be captured yet');
      assert.equal(countCommits(wt, s.homeDir), before);
    } finally { s.cleanup(); }
  });

  test('5. Re-sweep after capture → no duplicate commit or event', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a5');
      const f = path.join(wt, 'README.md');
      fs.writeFileSync(f, 'modified');
      backdateFile(f, QUIESCENCE_MS + 10000);

      const r1 = sweepDirtyWorktrees(s.masterDir, { force: true });
      assert.equal(r1.captured, 1);
      const afterFirst = countCommits(wt, s.homeDir);

      const r2 = sweepDirtyWorktrees(s.masterDir, { force: true });
      assert.equal(r2.captured, 0, 'second sweep must find the worktree already clean');
      assert.equal(countCommits(wt, s.homeDir), afterFirst, 'no new commit on re-sweep');

      const events = readEvents(s.masterDir).filter((e) => e.type === 'dirty_worktree_captured');
      assert.equal(events.length, 1, 'exactly one capture event total, not two');
    } finally { s.cleanup(); }
  });

  test('6. Debounce → second sweep within MIN_SWEEP_INTERVAL_MS is a no-op', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a6');
      const f = path.join(wt, 'README.md');
      fs.writeFileSync(f, 'modified');
      backdateFile(f, QUIESCENCE_MS + 10000);

      const nowMs = Date.now();
      const r1 = sweepDirtyWorktrees(s.masterDir, { nowMs, force: true });
      assert.equal(r1.ran, true);

      // Re-dirty without force, well inside the debounce window.
      fs.writeFileSync(path.join(wt, 'other.txt'), 'x');
      const r2 = sweepDirtyWorktrees(s.masterDir, { nowMs: nowMs + 1000 });
      assert.equal(r2.ran, false, 'debounced sweep must not run at all');

      const r3 = sweepDirtyWorktrees(s.masterDir, { nowMs: nowMs + MIN_SWEEP_INTERVAL_MS + 1000 });
      assert.equal(r3.ran, true, 'sweep resumes once the debounce interval elapses');
    } finally { s.cleanup(); }
  });

  test('7. No-op sweep latency is bounded and measured', () => {
    const s = makeSetup();
    try {
      // No worktrees dirty (agent-a3-style clean dir) — measure cost of a
      // sweep over a handful of clean worktrees.
      for (let i = 0; i < 5; i++) s.addWorktree('agent-clean-' + i);

      const t0 = Date.now();
      const result = sweepDirtyWorktrees(s.masterDir, { force: true });
      const elapsed = Date.now() - t0;

      // eslint-disable-next-line no-console
      console.log(`[v2327-v3] no-op sweep over ${result.scanned} worktree(s): ${elapsed}ms (self-reported: ${result.elapsedMs}ms)`);
      assert.ok(elapsed < 5000, `sweep took ${elapsed}ms — expected well under 5000ms for 5 clean worktrees`);
    } finally { s.cleanup(); }
  });

  test('8. M2 — worktree-meta HEAD divergence emits worktree_head_stale, reaches recent-diagnostics', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a8');

      // Simulate worktree-create.js's baseline write, using an intentionally
      // stale (bogus but well-formed) SHA — divergence is all that matters.
      const metaDir = path.join(s.masterDir, '.orchestray', 'state', 'worktree-meta');
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(
        path.join(metaDir, 'agent-a8.json'),
        JSON.stringify({
          agent_name: 'agent-a8',
          worktree_path: wt,
          created_at: new Date().toISOString(),
          main_tree_head_at_creation: '0000000000000000000000000000000000000000',
          main_tree_uncommitted_count_at_creation: 0,
        }),
        'utf8',
      );

      const result = sweepDirtyWorktrees(s.masterDir, { force: true });
      assert.equal(result.staleDetected, 1);

      const events = readEvents(s.masterDir).filter((e) => e.type === 'worktree_head_stale');
      assert.equal(events.length, 1);
      assert.equal(events[0].agent_name, 'agent-a8');
      assert.notEqual(events[0].main_tree_head_current, events[0].main_tree_head_at_creation);
      assert.ok(events[0].timestamp, 'writeEvent must autofill timestamp');

      // Prove it reaches the banner-surface pipeline with ZERO changes to
      // recent-diagnostics.js: the `_stale` suffix is already TIER3-recognized.
      const recent = computeRecentDiagnostics(s.masterDir, Date.now());
      const staleRow = recent.ranked.find((r) => r.event_type === 'worktree_head_stale');
      assert.ok(staleRow, 'worktree_head_stale must appear in computeRecentDiagnostics ranked output');
      assert.equal(staleRow.tier, 3);
    } finally { s.cleanup(); }
  });

  test('9. Hook wrapper kill switch → exit 0, no capture', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a9');
      const f = path.join(wt, 'README.md');
      fs.writeFileSync(f, 'modified');
      backdateFile(f, QUIESCENCE_MS + 10000);

      const before = countCommits(wt, s.homeDir);
      const r = spawnSync(NODE, [HOOK_SCRIPT], {
        input: JSON.stringify({ hook_event_name: 'Stop', cwd: s.masterDir }),
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, ORCHESTRAY_DIRTY_WORKTREE_SWEEP_DISABLED: '1' },
      });

      assert.equal(r.status || 0, 0, 'hook must exit 0');
      assert.equal(countCommits(wt, s.homeDir), before, 'kill switch must prevent any capture');
    } finally { s.cleanup(); }
  });

  test('9b. Hook wrapper (no kill switch) → captures via full subprocess path', () => {
    const s = makeSetup();
    try {
      const wt = s.addWorktree('agent-a9b');
      const f = path.join(wt, 'README.md');
      fs.writeFileSync(f, 'modified');
      backdateFile(f, QUIESCENCE_MS + 10000);

      const before = countCommits(wt, s.homeDir);
      const r = spawnSync(NODE, [HOOK_SCRIPT], {
        input: JSON.stringify({ hook_event_name: 'Stop', cwd: s.masterDir }),
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env },
      });

      assert.equal(r.status || 0, 0, 'hook must exit 0; stderr: ' + r.stderr.slice(0, 400));
      assert.equal(countCommits(wt, s.homeDir), before + 1, 'exactly one capture commit via the real hook entrypoint');
    } finally { s.cleanup(); }
  });

});
