'use strict';

/**
 * Tests for v2.2.21 G3-W1-T1 — dual-install hook double-fire fix.
 *
 * Closes T2 F-01 (CRITICAL): when both `~/.claude/orchestray/` and
 * `<projectRoot>/.claude/orchestray/` installs exist, every Claude Code
 * hook event fires the same script twice (7-30 ms apart) producing 4×
 * audit-volume amplification on `mcp_tool_call`, 2× on every other
 * event type.
 *
 * Coverage:
 *  Unit tests of `bin/_lib/install-path-priority.js#shouldFireFromThisInstall`:
 *    1.  Both installs exist + caller GLOBAL → false (suppress)
 *    2.  Both installs exist + caller LOCAL → true
 *    3.  Only LOCAL exists + caller LOCAL → true
 *    4.  Only GLOBAL exists + caller GLOBAL → true
 *    5.  Caller is under NEITHER install path → true (test fixture, etc.)
 *    6.  Kill switch `ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1` → true
 *    7.  Symlinked installs (GLOBAL → LOCAL) collapse → true
 *    8.  Fail-open on garbage scriptPath → true
 *
 *  Sibling-install classifier (`detectSiblingInstallPair`):
 *    9.  GLOBAL ↔ LOCAL pair returns 'sibling-install-pair'
 *   10.  GLOBAL ↔ GLOBAL returns 'same-install'
 *   11.  Two LOCAL paths return 'same-install'
 *
 *  End-to-end (spawning bin/inject-delegation-delta.js from both paths):
 *   12.  Both installs spawn within 50 ms → exactly ONE delegation_delta_emit
 *   13.  Kill-switch revert: same scenario with ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1
 *        → exactly TWO emits (one is followed by suppression but the post-fire
 *        guard will catch it with hook_double_fire_detected)
 *   14.  Single install (only LOCAL exists) → ONE delegation_delta_emit from LOCAL
 *
 *  Wiring:
 *   15.  bin/inject-delegation-delta.js requires install-path-priority and calls
 *        shouldFireFromThisInstall(__filename) at the top of the stdin-end handler.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(REPO_ROOT, 'bin', '_lib', 'install-path-priority.js');
const GUARD_PATH  = path.join(REPO_ROOT, 'bin', '_lib', 'double-fire-guard.js');
const HOOK_PATH   = path.join(REPO_ROOT, 'bin', 'inject-delegation-delta.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'orch-dual-install-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  });
  return dir;
}

function freshHelper() {
  delete require.cache[require.resolve(HELPER_PATH)];
  return require(HELPER_PATH);
}

function freshGuard() {
  delete require.cache[require.resolve(GUARD_PATH)];
  return require(GUARD_PATH);
}

/**
 * Set up a synthetic dual-install layout under `root`:
 *   root/home/.claude/orchestray/bin/<scriptName>   (GLOBAL)
 *   root/proj/.claude/orchestray/bin/<scriptName>   (LOCAL)
 * Returns { homeDir, projectDir, globalScript, localScript }.
 */
function setupDualInstall(root, scriptName, scriptBody) {
  const homeDir    = path.join(root, 'home');
  const projectDir = path.join(root, 'proj');
  const globalBin  = path.join(homeDir, '.claude', 'orchestray', 'bin');
  const localBin   = path.join(projectDir, '.claude', 'orchestray', 'bin');
  fs.mkdirSync(globalBin, { recursive: true });
  fs.mkdirSync(localBin, { recursive: true });
  const globalScript = path.join(globalBin, scriptName);
  const localScript  = path.join(localBin, scriptName);
  if (typeof scriptBody === 'string') {
    fs.writeFileSync(globalScript, scriptBody, { mode: 0o755 });
    fs.writeFileSync(localScript, scriptBody, { mode: 0o755 });
  } else {
    fs.writeFileSync(globalScript, '');
    fs.writeFileSync(localScript, '');
  }
  return { homeDir, projectDir, globalScript, localScript };
}

// ---------------------------------------------------------------------------
// Unit tests — shouldFireFromThisInstall
// ---------------------------------------------------------------------------

test('1. both installs exist; caller GLOBAL → false (suppress)', (t) => {
  const root = makeTmpDir(t);
  const { homeDir, projectDir, globalScript } = setupDualInstall(root, 'hook.js');
  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => { process.env.HOME = savedHome; });

  const { shouldFireFromThisInstall } = freshHelper();
  const result = shouldFireFromThisInstall(globalScript, { cwd: projectDir });
  assert.equal(result, false, 'GLOBAL caller must be suppressed when LOCAL exists');
});

test('2. both installs exist; caller LOCAL → true', (t) => {
  const root = makeTmpDir(t);
  const { homeDir, projectDir, localScript } = setupDualInstall(root, 'hook.js');
  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => { process.env.HOME = savedHome; });

  const { shouldFireFromThisInstall } = freshHelper();
  const result = shouldFireFromThisInstall(localScript, { cwd: projectDir });
  assert.equal(result, true, 'LOCAL caller must always fire');
});

test('3. only LOCAL exists; caller LOCAL → true', (t) => {
  const root       = makeTmpDir(t);
  const homeDir    = path.join(root, 'home-without-orch');
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(homeDir, { recursive: true });
  // home exists, but ~/.claude/orchestray does NOT.
  const localBin = path.join(projectDir, '.claude', 'orchestray', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const localScript = path.join(localBin, 'hook.js');
  fs.writeFileSync(localScript, '');

  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => { process.env.HOME = savedHome; });

  const { shouldFireFromThisInstall } = freshHelper();
  const result = shouldFireFromThisInstall(localScript, { cwd: projectDir });
  assert.equal(result, true, 'single-install LOCAL must fire');
});

test('4. only GLOBAL exists; caller GLOBAL → true', (t) => {
  const root       = makeTmpDir(t);
  const homeDir    = path.join(root, 'home');
  const projectDir = path.join(root, 'proj-without-orch');
  fs.mkdirSync(projectDir, { recursive: true });
  // project exists, but <project>/.claude/orchestray does NOT.
  const globalBin = path.join(homeDir, '.claude', 'orchestray', 'bin');
  fs.mkdirSync(globalBin, { recursive: true });
  const globalScript = path.join(globalBin, 'hook.js');
  fs.writeFileSync(globalScript, '');

  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => { process.env.HOME = savedHome; });

  const { shouldFireFromThisInstall } = freshHelper();
  const result = shouldFireFromThisInstall(globalScript, { cwd: projectDir });
  assert.equal(result, true, 'single-install GLOBAL must fire');
});

test('5. caller is under NEITHER install path → true (test fixture)', (t) => {
  const root = makeTmpDir(t);
  const { homeDir, projectDir } = setupDualInstall(root, 'hook.js');
  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => { process.env.HOME = savedHome; });

  const orphan = path.join(root, 'random', 'place', 'hook.js');
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, '');

  const { shouldFireFromThisInstall } = freshHelper();
  const result = shouldFireFromThisInstall(orphan, { cwd: projectDir });
  assert.equal(result, true, 'orphan caller must fire — helper is a deduplicator, not a global gate');
});

test('6. kill switch ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1 → always true', (t) => {
  const root = makeTmpDir(t);
  const { homeDir, projectDir, globalScript } = setupDualInstall(root, 'hook.js');
  const savedHome = process.env.HOME;
  const savedKill = process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED;
  process.env.HOME = homeDir;
  process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED = '1';
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedKill === undefined) delete process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED;
    else process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED = savedKill;
  });

  const { shouldFireFromThisInstall } = freshHelper();
  const result = shouldFireFromThisInstall(globalScript, { cwd: projectDir });
  assert.equal(result, true, 'kill switch reverts to v2.2.20 behaviour');
});

test('7. symlinked installs (GLOBAL → LOCAL) collapse → true', (t) => {
  const root       = makeTmpDir(t);
  const homeDir    = path.join(root, 'home');
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  const localOrch = path.join(projectDir, '.claude', 'orchestray');
  fs.mkdirSync(path.join(localOrch, 'bin'), { recursive: true });
  // GLOBAL is a symlink pointing AT LOCAL.
  const globalLink = path.join(homeDir, '.claude', 'orchestray');
  try { fs.symlinkSync(localOrch, globalLink, 'dir'); } catch (e) {
    if (e && e.code === 'EPERM') { t.skip('symlink not permitted on this filesystem'); return; }
    throw e;
  }
  // Either path resolves to the same canonical install — all callers fire.
  const localScript  = path.join(localOrch, 'bin', 'hook.js');
  const globalScript = path.join(globalLink, 'bin', 'hook.js'); // reaches localScript via symlink
  fs.writeFileSync(localScript, '');

  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => { process.env.HOME = savedHome; });

  const { shouldFireFromThisInstall } = freshHelper();
  assert.equal(
    shouldFireFromThisInstall(localScript,  { cwd: projectDir }), true,
    'LOCAL caller fires when GLOBAL symlinks to LOCAL'
  );
  assert.equal(
    shouldFireFromThisInstall(globalScript, { cwd: projectDir }), true,
    'GLOBAL caller (via symlink to LOCAL) also fires — single canonical install'
  );
});

test('8. fail-open on garbage scriptPath → true', (t) => {
  const { shouldFireFromThisInstall } = freshHelper();
  assert.equal(shouldFireFromThisInstall(null), true);
  assert.equal(shouldFireFromThisInstall(undefined), true);
  assert.equal(shouldFireFromThisInstall(''), true);
  assert.equal(shouldFireFromThisInstall(42), true);
});

// ---------------------------------------------------------------------------
// Sibling-install classifier
// ---------------------------------------------------------------------------

test('9. detectSiblingInstallPair: GLOBAL ↔ LOCAL → sibling-install-pair', (t) => {
  const savedHome = process.env.HOME;
  process.env.HOME = '/home/u';
  t.after(() => { process.env.HOME = savedHome; });

  const { detectSiblingInstallPair } = freshGuard();
  const globalCaller = '/home/u/.claude/orchestray/bin/inject-delegation-delta.js';
  const localCaller  = '/home/u/proj/.claude/orchestray/bin/inject-delegation-delta.js';
  assert.equal(detectSiblingInstallPair(globalCaller, localCaller), 'sibling-install-pair');
  assert.equal(detectSiblingInstallPair(localCaller, globalCaller), 'sibling-install-pair');
});

test('10. detectSiblingInstallPair: GLOBAL ↔ GLOBAL → same-install', (t) => {
  const savedHome = process.env.HOME;
  process.env.HOME = '/home/u';
  t.after(() => { process.env.HOME = savedHome; });

  const { detectSiblingInstallPair } = freshGuard();
  const a = '/home/u/.claude/orchestray/bin/hook-a.js';
  const b = '/home/u/.claude/orchestray/bin/hook-b.js';
  assert.equal(detectSiblingInstallPair(a, b), 'same-install');
});

test('11. detectSiblingInstallPair: two LOCAL paths → same-install', (t) => {
  const savedHome = process.env.HOME;
  process.env.HOME = '/home/u';
  t.after(() => { process.env.HOME = savedHome; });

  const { detectSiblingInstallPair } = freshGuard();
  const a = '/home/u/proj-a/.claude/orchestray/bin/hook.js';
  const b = '/home/u/proj-b/.claude/orchestray/bin/hook.js';
  assert.equal(detectSiblingInstallPair(a, b), 'same-install');
});

// ---------------------------------------------------------------------------
// End-to-end — spawn the real hook script from synthetic install layouts.
//
// We copy `bin/inject-delegation-delta.js` AND its `_lib/` dependencies into
// both synthetic install dirs. Each spawn is fed a minimal Agent-tool
// PreToolUse stdin payload that triggers the helper's normal code path. The
// hook writes events to `<projectDir>/.orchestray/audit/events.jsonl`.
// ---------------------------------------------------------------------------

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Materialize a working copy of bin/ at `<installRoot>/bin/`. Includes
 * inject-delegation-delta.js and the entire _lib/ subtree.
 */
function materializeHookInstall(installRoot) {
  const dstBin = path.join(installRoot, 'bin');
  fs.mkdirSync(dstBin, { recursive: true });
  fs.copyFileSync(HOOK_PATH, path.join(dstBin, 'inject-delegation-delta.js'));
  copyDirRecursive(path.join(REPO_ROOT, 'bin', '_lib'), path.join(dstBin, '_lib'));
  return path.join(dstBin, 'inject-delegation-delta.js');
}

/**
 * Set up a complete project layout:
 *   <projectDir>/.claude/orchestray/bin/inject-delegation-delta.js   (LOCAL hook)
 *   <homeDir>/.claude/orchestray/bin/inject-delegation-delta.js      (GLOBAL hook)
 *   <projectDir>/.orchestray/audit/current-orchestration.json
 *   <projectDir>/agents/pm-reference/event-schemas.md (copied so schema
 *      validation works when we trigger emit)
 */
function setupHookFixture(t, opts) {
  const root = makeTmpDir(t, 'orch-dual-install-e2e-');
  const homeDir    = path.join(root, 'home');
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const installLocal  = path.join(projectDir, '.claude', 'orchestray');
  const installGlobal = path.join(homeDir, '.claude', 'orchestray');

  let globalHook = null;
  let localHook  = null;
  if (!opts || opts.global !== false) {
    globalHook = materializeHookInstall(installGlobal);
  }
  if (!opts || opts.local !== false) {
    localHook = materializeHookInstall(installLocal);
  }

  // Bootstrap orchestration state and pm-reference dir.
  const auditDir = path.join(projectDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const orchId = 'orch-dual-install-test-' + Date.now();
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );

  // Copy event-schemas.md so the audit-event-writer's schema validator can
  // load it. Otherwise events get blocked by schema_shadow_validation_block.
  const pmRefSrc = path.join(REPO_ROOT, 'agents', 'pm-reference');
  const pmRefDst = path.join(projectDir, 'agents', 'pm-reference');
  copyDirRecursive(pmRefSrc, pmRefDst);

  return { root, homeDir, projectDir, orchId, globalHook, localHook };
}

function readEmitEvents(projectDir) {
  const p = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(e => e && e.type === 'delegation_delta_emit');
}

function spawnHook(hookPath, projectDir, homeDir, extraEnv) {
  const stdin = JSON.stringify({
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'developer',
      // Use a prompt with delta markers so computeDelta proceeds (no
      // markers_injected fallback path) — keeps the test deterministic.
      prompt: [
        'You are the developer.',
        '<!-- delta:static-begin -->',
        'Static portion of the prompt.',
        '<!-- delta:static-end -->',
        '<!-- delta:per-spawn-begin -->',
        '## Task',
        'Test task.',
        '<!-- delta:per-spawn-end -->',
      ].join('\n'),
    },
    cwd: projectDir,
  });

  const env = Object.assign({}, process.env, {
    HOME: homeDir,
    USERPROFILE: homeDir, // Windows compat (no-op on Linux)
  });
  if (extraEnv) Object.assign(env, extraEnv);

  return cp.spawnSync(process.execPath, [hookPath], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    env,
    cwd: projectDir,
  });
}

test('12. dual install + both spawn within 50 ms → exactly ONE delegation_delta_emit', (t) => {
  const fx = setupHookFixture(t);

  // Spawn GLOBAL first, then LOCAL — both within the dedup window.
  // We use synchronous spawnSync sequentially because spawnSync blocks; in
  // production the two hook fires happen 7-30 ms apart from a single Claude
  // Code event. The order matches the F-01 reproduction signature.
  const tStart = Date.now();
  const r1 = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  const r2 = spawnHook(fx.localHook,  fx.projectDir, fx.homeDir);
  const elapsed = Date.now() - tStart;

  assert.equal(r1.status, 0, 'global spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'local spawn must exit 0; stderr=' + r2.stderr);
  // Sanity: both spawns finished quickly. We don't assert <50 ms because
  // spawnSync overhead can exceed that on CI; the dedup TTL inside
  // requireGuard is 100 ms which is the production-relevant window.
  assert.ok(elapsed < 10000, 'both spawns finished within 10 s (observed ' + elapsed + ' ms)');

  const events = readEmitEvents(fx.projectDir);
  assert.equal(
    events.length, 1,
    'must observe exactly ONE delegation_delta_emit; observed ' + events.length
  );
});

test('13. kill-switch revert: ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1 → BOTH installs enter hook body', (t) => {
  const fx = setupHookFixture(t);

  // Disable BOTH the new pre-fire dedup AND the existing post-fire guard
  // to reproduce the raw v2.2.20 baseline (the F-01 regression). With
  // only the pre-fire kill switch on, the post-fire guard still suppresses
  // the second emit — that suppression is correct and orthogonal. The
  // assertion here is that the new pre-fire bypass IS reverted (both
  // processes enter the hook body and reach requireGuard).
  const r1 = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir, {
    ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED: '1',
    ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD:    '1',
  });
  const r2 = spawnHook(fx.localHook,  fx.projectDir, fx.homeDir, {
    ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED: '1',
    ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD:    '1',
  });
  assert.equal(r1.status, 0, 'global spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'local spawn must exit 0; stderr=' + r2.stderr);

  const events = readEmitEvents(fx.projectDir);
  // Both kill switches → both pre-fire and post-fire dedup are off → exact
  // v2.2.20 baseline: TWO delegation_delta_emit events. This is the F-01
  // CRITICAL regression the new pre-fire dedup prevents.
  assert.equal(
    events.length, 2,
    'both kill switches must restore v2.2.20 baseline (2 emits, F-01 regression); observed ' + events.length
  );
});

test('13b. only pre-fire kill switch ON; post-fire guard still suppresses', (t) => {
  const fx = setupHookFixture(t);

  // Only the new pre-fire dedup is bypassed. The existing post-fire
  // requireGuard still does its job: process A fires, process B sees the
  // journal entry with a different caller_path and emits
  // hook_double_fire_detected instead of a second delegation_delta_emit.
  const r1 = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir, {
    ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED: '1',
  });
  const r2 = spawnHook(fx.localHook,  fx.projectDir, fx.homeDir, {
    ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED: '1',
  });
  assert.equal(r1.status, 0, 'global spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'local spawn must exit 0; stderr=' + r2.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.equal(
    events.length, 1,
    'pre-fire bypass + post-fire guard active → 1 emit (post-fire catches the duplicate)'
  );
});

test('14. single install (only LOCAL exists) → ONE emit from LOCAL', (t) => {
  const fx = setupHookFixture(t, { global: false, local: true });
  assert.equal(fx.globalHook, null);

  const r = spawnHook(fx.localHook, fx.projectDir, fx.homeDir);
  assert.equal(r.status, 0, 'local spawn must exit 0; stderr=' + r.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.equal(events.length, 1, 'single-install LOCAL must produce exactly one emit');
});

// ---------------------------------------------------------------------------
// Wiring check
// ---------------------------------------------------------------------------

test('15. inject-delegation-delta.js wires shouldFireFromThisInstall at top of stdin-end handler', () => {
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.ok(
    src.includes("require('./_lib/install-path-priority')"),
    'inject-delegation-delta.js must require install-path-priority'
  );
  assert.ok(
    src.includes('shouldFireFromThisInstall(__filename)'),
    'must call shouldFireFromThisInstall(__filename)'
  );
  // Verify the call appears INSIDE the stdin-end handler (defensive: an
  // import without a call site would be caught by the runtime tests, but
  // this catches accidental relocation to the top level which would run
  // even on test imports of the module).
  const stdinHandlerIdx = src.indexOf("process.stdin.on('end'");
  const callIdx         = src.indexOf('shouldFireFromThisInstall(__filename)');
  assert.ok(stdinHandlerIdx > 0, 'stdin.on(end) handler must exist');
  assert.ok(callIdx > stdinHandlerIdx, 'shouldFireFromThisInstall must be called INSIDE the stdin-end handler');
});
