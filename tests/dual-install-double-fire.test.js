'use strict';

/**
 * Dual-install hook double-fire — end-to-end (v2.2.21 G3-W1-T1, rewritten v2.3.18 W9).
 *
 * T2 F-01 (CRITICAL): when both `~/.claude/orchestray/` and
 * `<projectRoot>/.claude/orchestray/` installs exist — the standing
 * configuration per `feedback_update_both_installs.md` — every Claude Code hook
 * event fires the same script twice, 7-30 ms apart, producing 4× audit-volume
 * amplification on `mcp_tool_call` and 2× on every other event type.
 *
 * ## What changed in W9
 *
 * Until W8 the fix had two layers: an install-topology gate that PREDICTED
 * which install would handle the event and suppressed the other one, plus an
 * atomic payload claim behind it. The prediction was rewritten five times
 * (presence → registration → home-prefix expansion → per-script completeness)
 * and each rewrite traded one blackout for another: both installs concluded the
 * sibling would fire, so neither did, silently. W9 deleted it. The claim alone
 * decides, and it observes rather than predicts — a lone caller wins an
 * uncontested claim, two racers produce exactly one winner.
 *
 * The unit tests of `shouldFireFromThisInstall` that used to open this file are
 * gone with the function. What replaces them is coverage of the property that
 * actually mattered, exercised through real spawned processes:
 *
 *   Sibling-install classifier (`detectSiblingInstallPair`):
 *    9.  GLOBAL ↔ LOCAL pair returns 'sibling-install-pair'
 *   10.  GLOBAL ↔ GLOBAL returns 'same-install'
 *   11.  Two LOCAL paths return 'same-install'
 *
 *   End-to-end (spawning bin/inject-delegation-delta.js from both paths):
 *   12.  Both installs fire the same payload → exactly ONE delegation_delta_emit
 *   12b. Four-state matrix (registered/not × which install races first) →
 *        exactly ONE emit each, and never zero. Registration is no longer read;
 *        the four states must be indistinguishable.
 *   12c. Stale local dir + GLOBAL only → GLOBAL still emits
 *   12e. Settings naming ONLY the global install → GLOBAL still emits
 *   12f. Payload cwd ≠ process cwd, either install racing first → exactly ONE
 *   13.  Both kill switches → exactly TWO emits (the v2.2.20 baseline)
 *   13b. Legacy kill switch alone → ONE emit (post-fire guard catches it)
 *   14.  Single install (only LOCAL exists) → ONE emit from LOCAL
 *   17.  Genuinely concurrent spawns, post-fire guard DISABLED → exactly ONE
 *        emit. Isolates the claim: nothing else is left to suppress a duplicate.
 *   18.  A script present in only ONE install still fires (partial upgrade)
 *   19.  Two genuinely distinct events → TWO emits (no over-suppression)
 *
 *   Wiring:
 *   15.  bin/inject-delegation-delta.js reads stdin through the shared entry and
 *        does NOT re-decide the dual-install question itself.
 *   15b. No install-inference predicate survives anywhere in bin/.
 *
 *   Adversarial (v2.3.18 W10) — the claim file is the only thing left that can
 *   suppress a hook, and it lives at a derivable path under a world-writable
 *   directory, so a planted claim was a blackout primitive:
 *   20.  Planted symlink claim + real spawned hook → the hook still emits
 *   21.  Planted attacker-writable claim + real spawned hook → still emits
 *   22.  Planted claim + BOTH installs racing → still exactly one emit
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

// Used only to DERIVE the claim path the way an attacker would — the tests
// below exercise the claim through real spawned hooks, never through this
// module's own functions.
const { claimDir, dedupKey } = require(
  path.join(REPO_ROOT, 'bin', '_lib', 'hook-stdin.js'))._internal;

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

/** Drop block and line comments so source scans do not match prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function freshGuard() {
  delete require.cache[require.resolve(GUARD_PATH)];
  return require(GUARD_PATH);
}

/**
 * Register the local install in `<projectDir>/.claude/settings.json`, the way a
 * real local install does. Since W9 nothing reads this — the fixtures keep
 * writing it so the tests below can assert that it makes no difference.
 */
function registerLocalInstall(projectDir, scriptName) {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const command = 'node "' +
    path.join(projectDir, '.claude', 'orchestray', 'bin', scriptName || 'hook.js') + '"';
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
    }, null, 2)
  );
}

/**
 * Register ONLY the GLOBAL install, written home-relative (`~`). This is the
 * W7b E-A shape: `~` read as non-absolute, non-absolute read as
 * project-relative, so a settings file pointing exclusively at the global
 * install marked the LOCAL one registered and the global install suppressed
 * itself against a directory nothing would spawn.
 */
function registerGlobalInstallHomeRelative(projectDir, scriptName) {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{
        type: 'command',
        command: 'node "~/.claude/orchestray/bin/' + (scriptName || 'hook.js') + '"',
      }] }] },
    }, null, 2)
  );
}

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
//
// Every assertion below runs against real processes on purpose: the claim is
// cross-process state, and six inspection passes over this subsystem missed
// blackouts that a spawn would have surfaced immediately.
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
  } else if (opts && opts.staleLocal) {
    // A local tree with no working hook — either abandoned, or a release behind
    // and missing the script the newer install added.
    fs.mkdirSync(path.join(installLocal, 'bin'), { recursive: true });
  }

  if (opts && opts.registerHomeRelative) {
    registerGlobalInstallHomeRelative(projectDir, 'inject-delegation-delta.js');
  } else {
    const wantRegister = (opts && opts.register !== undefined)
      ? opts.register
      : Boolean(localHook);
    if (wantRegister) registerLocalInstall(projectDir, 'inject-delegation-delta.js');
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

/**
 * @param {string} [payloadCwd] — the `cwd` field Claude Code puts in the hook
 *   payload. Defaults to the project dir; pass a different value to exercise
 *   the divergence that caused the W7b E-B blackout.
 * @param {string} [subagentType] — changes the payload, and with it both the
 *   claim key and the post-fire guard key. Use to model two genuinely distinct
 *   events rather than one event racing itself.
 */
function hookStdinPayload(projectDir, payloadCwd, subagentType) {
  return JSON.stringify({
    tool_name: 'Agent',
    tool_input: {
      subagent_type: subagentType || 'developer',
      // Use a prompt with delta markers so computeDelta proceeds (no
      // markers_injected fallback path) — keeps the test deterministic.
      prompt: [
        'You are the ' + (subagentType || 'developer') + '.',
        '<!-- delta:static-begin -->',
        'Static portion of the prompt.',
        '<!-- delta:static-end -->',
        '<!-- delta:per-spawn-begin -->',
        '## Task',
        'Test task.',
        '<!-- delta:per-spawn-end -->',
      ].join('\n'),
    },
    cwd: payloadCwd || projectDir,
  });
}

function hookEnv(homeDir, extraEnv) {
  const env = Object.assign({}, process.env, {
    HOME: homeDir,
    USERPROFILE: homeDir, // Windows compat (no-op on Linux)
  });
  if (extraEnv) Object.assign(env, extraEnv);
  return env;
}

function spawnHook(hookPath, projectDir, homeDir, extraEnv, payloadCwd, subagentType) {
  return cp.spawnSync(process.execPath, [hookPath], {
    input: hookStdinPayload(projectDir, payloadCwd, subagentType),
    encoding: 'utf8',
    timeout: 10000,
    env: hookEnv(homeDir, extraEnv),
    cwd: projectDir,
  });
}

/**
 * Spawn a hook without blocking, so two installs can genuinely overlap. The
 * sequential `spawnSync` shape below cannot exercise the O_EXCL race at all —
 * the first process has always exited before the second starts.
 */
function spawnHookAsync(hookPath, projectDir, homeDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [hookPath], {
      env: hookEnv(homeDir, extraEnv),
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end(hookStdinPayload(projectDir));
  });
}

test('12. dual install + both fire the same payload → exactly ONE delegation_delta_emit', (t) => {
  const fx = setupHookFixture(t);

  // Spawn GLOBAL first, then LOCAL — both within the dedup window. In
  // production the two fires happen 7-30 ms apart from a single Claude Code
  // event; the order matches the F-01 reproduction signature. Test 17 covers
  // the overlapping case.
  const tStart = Date.now();
  const r1 = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  const r2 = spawnHook(fx.localHook,  fx.projectDir, fx.homeDir);
  const elapsed = Date.now() - tStart;

  assert.equal(r1.status, 0, 'global spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'local spawn must exit 0; stderr=' + r2.stderr);
  assert.ok(elapsed < 10000, 'both spawns finished within 10 s (observed ' + elapsed + ' ms)');

  const events = readEmitEvents(fx.projectDir);
  assert.ok(events.length >= 1, 'BLACKOUT: neither install fired');
  assert.equal(
    events.length, 1,
    'must observe exactly ONE delegation_delta_emit; observed ' + events.length
  );
});

// ---------------------------------------------------------------------------
// The blackout matrix.
//
// Registration used to decide which install yielded, and getting that decision
// wrong took the hook off the air. It is no longer consulted, so all four
// states must produce the same answer: AT MOST ONE emit, and NEVER ZERO.
// ---------------------------------------------------------------------------

const MATRIX_STATES = [
  { name: 'local registered   + GLOBAL races first', register: true,  globalFirst: true  },
  { name: 'local registered   + LOCAL races first',  register: true,  globalFirst: false },
  { name: 'local unregistered + GLOBAL races first', register: false, globalFirst: true  },
  { name: 'local unregistered + LOCAL races first',  register: false, globalFirst: false },
];

for (const state of MATRIX_STATES) {
  test('12b. four-state matrix — ' + state.name + ' → exactly ONE emit, never zero', (t) => {
    const fx = setupHookFixture(t, { register: state.register });

    const first  = state.globalFirst ? fx.globalHook : fx.localHook;
    const second = state.globalFirst ? fx.localHook  : fx.globalHook;
    const r1 = spawnHook(first,  fx.projectDir, fx.homeDir);
    const r2 = spawnHook(second, fx.projectDir, fx.homeDir);
    assert.equal(r1.status, 0, 'first spawn must exit 0; stderr=' + r1.stderr);
    assert.equal(r2.status, 0, 'second spawn must exit 0; stderr=' + r2.stderr);

    const events = readEmitEvents(fx.projectDir);
    // Stated separately from the equality below so a blackout regression names
    // itself instead of hiding behind a generic count mismatch.
    assert.ok(
      events.length >= 1,
      'BLACKOUT: no install fired at all (' + state.name + ') — zero emits must be impossible'
    );
    assert.equal(
      events.length, 1,
      'exactly one install must fire (' + state.name + '); observed ' + events.length
    );
  });
}

test('12c. stale local dir + GLOBAL install alone → GLOBAL still emits', (t) => {
  // An abandoned `<project>/.claude/orchestray/` must not silence the only
  // working install. Before W6c a presence check here was a total blackout.
  const fx = setupHookFixture(t, { local: false, staleLocal: true, register: false });
  assert.equal(fx.localHook, null);
  assert.ok(
    fs.existsSync(path.join(fx.projectDir, '.claude', 'orchestray', 'bin')),
    'fixture must leave a stale local install dir behind'
  );

  const r = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  assert.equal(r.status, 0, 'global spawn must exit 0; stderr=' + r.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.equal(
    events.length, 1,
    'a stale local dir must not black out the global install; observed ' + events.length
  );
});

test('12e. stale local dir + settings naming ONLY the global install → GLOBAL still emits', (t) => {
  // v2.3.18 W7b E-A, end-to-end: the registration probe read `~` as
  // project-relative, so settings pointing exclusively at the GLOBAL install
  // marked the LOCAL one registered and the global install yielded to a stale
  // directory nothing spawns. Settings text no longer participates at all.
  const fx = setupHookFixture(t, {
    local: false, staleLocal: true, registerHomeRelative: true,
  });
  assert.equal(fx.localHook, null);

  const r = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  assert.equal(r.status, 0, 'global spawn must exit 0; stderr=' + r.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.ok(events.length >= 1, 'BLACKOUT: the global install must fire; observed 0 emits');
  assert.equal(events.length, 1, 'exactly one emit; observed ' + events.length);
});

for (const globalFirst of [true, false]) {
  test('12f. payload cwd differs from process cwd (' +
       (globalFirst ? 'GLOBAL' : 'LOCAL') + ' races first) → exactly ONE emit', (t) => {
    // v2.3.18 W7b E-B. Two gates sharing one implementation but not one input
    // (payload cwd vs `process.cwd()`) disagreed, and both installs ended up
    // suppressed. The claim is keyed on the resolved cwd, so a divergence would
    // now show up as a DOUBLE fire — still a failure, but a visible one.
    const fx = setupHookFixture(t);

    const payloadCwd = path.join(fx.projectDir, 'sub');
    fs.mkdirSync(path.join(payloadCwd, '.orchestray', 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(payloadCwd, '.orchestray', 'audit', 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: fx.orchId })
    );
    copyDirRecursive(
      path.join(REPO_ROOT, 'agents', 'pm-reference'),
      path.join(payloadCwd, 'agents', 'pm-reference')
    );

    const first  = globalFirst ? fx.globalHook : fx.localHook;
    const second = globalFirst ? fx.localHook  : fx.globalHook;
    const r1 = spawnHook(first,  fx.projectDir, fx.homeDir, null, payloadCwd);
    const r2 = spawnHook(second, fx.projectDir, fx.homeDir, null, payloadCwd);
    assert.equal(r1.status, 0, 'first spawn must exit 0; stderr=' + r1.stderr);
    assert.equal(r2.status, 0, 'second spawn must exit 0; stderr=' + r2.stderr);

    // The hook writes under the payload cwd; count both roots so a misplaced
    // write is a double-fire failure rather than an invisible pass.
    const events = readEmitEvents(payloadCwd).concat(readEmitEvents(fx.projectDir));
    assert.ok(
      events.length >= 1,
      'BLACKOUT: divergent cwds must not leave both installs suppressed'
    );
    assert.equal(events.length, 1, 'exactly one install must fire; observed ' + events.length);
  });
}

test('13. kill-switch revert: ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1 → BOTH installs enter hook body', (t) => {
  const fx = setupHookFixture(t);

  // Disable BOTH the pre-fire claim AND the post-fire guard to reproduce the
  // raw v2.2.20 baseline (the F-01 regression). With only the pre-fire kill
  // switch on, the post-fire guard still suppresses the second emit — that
  // suppression is correct and orthogonal (13b).
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
  assert.equal(
    events.length, 2,
    'both kill switches must restore v2.2.20 baseline (2 emits, F-01 regression); observed ' + events.length
  );
});

test('13b. only the pre-fire kill switch ON; post-fire guard still suppresses', (t) => {
  const fx = setupHookFixture(t);

  // Only the claim is bypassed. The existing post-fire requireGuard still does
  // its job: process A fires, process B sees the journal entry with a different
  // caller_path and emits hook_double_fire_detected instead of a second
  // delegation_delta_emit.
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

test('17. concurrent spawns with the post-fire guard DISABLED → exactly ONE emit', async (t) => {
  // The load-bearing assertion. Sequential spawns cannot fail the O_EXCL race,
  // and a passing sequential test could always be credited to the post-fire
  // guard instead of the claim. Here the two processes genuinely overlap and
  // the post-fire guard is off, so the claim is the only thing that can hold
  // the count at one.
  const fx = setupHookFixture(t);
  const env = { ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD: '1' };

  const [r1, r2] = await Promise.all([
    spawnHookAsync(fx.globalHook, fx.projectDir, fx.homeDir, env),
    spawnHookAsync(fx.localHook,  fx.projectDir, fx.homeDir, env),
  ]);
  assert.equal(r1.status, 0, 'global spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'local spawn must exit 0; stderr=' + r2.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.ok(events.length >= 1, 'BLACKOUT: neither concurrent install fired');
  assert.equal(
    events.length, 1,
    'the atomic claim must admit exactly one concurrent racer; observed ' + events.length
  );
});

test('18. a script present in only ONE install still fires (partial upgrade)', (t) => {
  // v2.3.18 W8 C-1: global carries the new release, the registered local tree
  // is a version behind and does not have this script at all. The topology
  // gate answered "yes, something spawns local" and suppressed the only copy
  // that could run. Nothing can suppress an uncontested claim.
  const fx = setupHookFixture(t, { local: false, staleLocal: true, register: true });
  assert.equal(fx.localHook, null);
  assert.ok(
    !fs.existsSync(path.join(
      fx.projectDir, '.claude', 'orchestray', 'bin', 'inject-delegation-delta.js')),
    'fixture must register a local install that lacks this script'
  );

  const r = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  assert.equal(r.status, 0, 'global spawn must exit 0; stderr=' + r.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.equal(
    events.length, 1,
    'the only install carrying the script must fire; observed ' + events.length
  );
});

test('19. two genuinely distinct events → TWO emits (no over-suppression)', (t) => {
  // Over-suppression is the mirror image of the blackout and just as invisible.
  // Different subagent types are different events: different claim key, and
  // different post-fire guard key too.
  const fx = setupHookFixture(t);

  const r1 = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir, null, null, 'developer');
  const r2 = spawnHook(fx.localHook,  fx.projectDir, fx.homeDir, null, null, 'reviewer');
  assert.equal(r1.status, 0, 'first spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'second spawn must exit 0; stderr=' + r2.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.equal(
    events.length, 2,
    'the dedup window must not swallow a distinct event; observed ' + events.length
  );
});

// ---------------------------------------------------------------------------
// Adversarial — a planted claim file (v2.3.18 W10)
//
// W9 left the claim as the SOLE dedup mechanism, which promoted the claim
// file's content to the only input in the system that can return `fire: false`.
// It sits at `os.tmpdir()/orchestray-hook-dedup-<uid>/<sha256(cwd)>/<key>.json`
// — every ingredient of which is public — under a world-writable directory. On
// a shared host that is a blackout primitive: pre-create the claim with a
// fabricated `caller_path`, refresh `ts_ms` on a timer, and every genuine hook
// suppresses itself forever.
//
// These spawn the real hook against a planted claim and assert it EMITS. Both
// are silent against pre-W10 sources.
// ---------------------------------------------------------------------------

/** The claim path an attacker who knows the project root can compute. */
function claimPathFor(projectDir) {
  const raw = hookStdinPayload(projectDir);
  const key = dedupKey('inject-delegation-delta.js', raw, JSON.parse(raw));
  return path.join(claimDir(projectDir), key + '.json');
}

/** Register the derived claim directory for cleanup, then return the file path. */
function stageClaimPath(t, projectDir) {
  const file = claimPathFor(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  t.after(() => {
    try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (_e) { /* */ }
  });
  return file;
}

function fabricatedClaim() {
  return JSON.stringify({
    ts_ms: Date.now(),
    caller_path: '/home/attacker/.claude/orchestray/bin/inject-delegation-delta.js',
    pid: 4242,
  });
}

test('20. a planted SYMLINK claim must not silence a real spawned hook', (t) => {
  const fx = setupHookFixture(t, { local: false });
  const file = stageClaimPath(t, fx.projectDir);

  // The attacker owns the content and can refresh it indefinitely. Pre-W10 the
  // hook read straight through the link (`wx` gives O_EXCL, not O_NOFOLLOW, and
  // the read never checked what it was reading).
  const attackerFile = path.join(fx.root, 'attacker-controlled.json');
  const planted = fabricatedClaim();
  fs.writeFileSync(attackerFile, planted);
  fs.symlinkSync(attackerFile, file);

  const r = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  assert.equal(r.status, 0, 'global spawn must exit 0; stderr=' + r.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.ok(
    events.length >= 1,
    'BLACKOUT: a planted symlink claim took the only install off the air');
  assert.equal(events.length, 1, 'exactly one emit; observed ' + events.length);

  assert.equal(
    fs.readFileSync(attackerFile, 'utf8'), planted,
    'the symlink target must not have been written through');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false,
    'the planted link is replaced by a real claim');
});

test('21. a planted ATTACKER-WRITABLE claim must not silence a real spawned hook', (t) => {
  const fx = setupHookFixture(t, { global: false });
  const file = stageClaimPath(t, fx.projectDir);

  // No symlink needed when the claim itself is writable by others: the
  // attacker rewrites its bytes in place and owns the suppression decision.
  fs.writeFileSync(file, fabricatedClaim());
  fs.chmodSync(file, 0o666);

  const r = spawnHook(fx.localHook, fx.projectDir, fx.homeDir);
  assert.equal(r.status, 0, 'local spawn must exit 0; stderr=' + r.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.ok(
    events.length >= 1,
    'BLACKOUT: an attacker-writable claim took the only install off the air');
  assert.equal(events.length, 1, 'exactly one emit; observed ' + events.length);
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600,
    'the untrusted claim is replaced by one only we can write');
});

test('22. a planted claim + BOTH installs racing → still exactly ONE emit', (t) => {
  // The tamper must not flip the outcome in either direction: not to zero
  // (blackout, the defect) and not to two (over-fire). The first install
  // rejects the plant, fires, and takes the claim over with a record only it
  // can have written; the second then meets a claim it can prove is ours.
  const fx = setupHookFixture(t);
  const file = stageClaimPath(t, fx.projectDir);
  fs.writeFileSync(file, fabricatedClaim());
  fs.chmodSync(file, 0o666);

  const r1 = spawnHook(fx.globalHook, fx.projectDir, fx.homeDir);
  const r2 = spawnHook(fx.localHook,  fx.projectDir, fx.homeDir);
  assert.equal(r1.status, 0, 'global spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'local spawn must exit 0; stderr=' + r2.stderr);

  const events = readEmitEvents(fx.projectDir);
  assert.ok(events.length >= 1, 'BLACKOUT: a planted claim silenced both installs');
  assert.equal(events.length, 1, 'exactly one emit; observed ' + events.length);
});

// ---------------------------------------------------------------------------
// Wiring check
// ---------------------------------------------------------------------------

test('15. inject-delegation-delta.js reaches the dedup decision via the shared entry', () => {
  // The hook must not re-decide the dual-install question. A second call site
  // re-decided it against `process.cwd()` when the entry had already decided it
  // against the payload cwd, and both installs went quiet (W7b E-B).
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.ok(
    src.includes("require('./_lib/hook-stdin')"),
    'inject-delegation-delta.js must read stdin through the shared hook entry'
  );
  assert.ok(src.indexOf('setImmediate(') > 0, 'deferred hook body must exist');
  assert.ok(
    !/\bshouldFireFromThisInstall\s*\(/.test(stripComments(src)),
    'must NOT re-decide the dual-install question — hook-stdin.js already did'
  );
});

test('15b. no install-inference predicate survives anywhere in bin/', () => {
  // v2.3.18 W9. Five fixes each replaced one predicate about the OTHER install
  // with a marginally better one, and each new predicate produced a fresh
  // blackout. The class is closed by deletion, so the guard is deletion-shaped:
  // if any of these names comes back, the class is open again.
  const GONE = [
    'shouldFireFromThisInstall',
    'localInstallRegistered',
    'localInstallHasScript',
    'prefixIsLocalInstall',
    'referencesLocalInstall',
  ];

  const priority = require(HELPER_PATH);
  for (const name of GONE) {
    assert.equal(priority[name], undefined, name + ' must not be exported');
  }

  const binDir = path.join(REPO_ROOT, 'bin');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fp); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const code = stripComments(fs.readFileSync(fp, 'utf8'));
      for (const name of GONE) {
        if (new RegExp('\\b' + name + '\\b').test(code)) {
          offenders.push(path.relative(binDir, fp) + ':' + name);
        }
      }
    }
  })(binDir);

  assert.deepStrictEqual(
    offenders, [],
    'dedup must not infer what the other install will do — it cannot be observed, ' +
    'and every proxy for it fails silently. Claim the payload instead.'
  );
});
