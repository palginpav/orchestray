#!/usr/bin/env node
'use strict';

/**
 * v2318-w6b-dedup-blackout.test.js — the dedup blackout class (v2.3.18 W6b→W9).
 *
 * The file keeps its W6b name because it still guards what W6b was about: a
 * hook that silently never runs. What changed is the mechanism it guards.
 *
 * W6b through W8 tuned an install-topology PREDICTION — is the local tree
 * there? registered? carrying this script? — so the global install could yield
 * to a sibling that was about to fire. Every version of that prediction had the
 * same failure mode: both installs decided the other one would handle the
 * event, so neither did, silently. Six paths, five fixes.
 *
 * W9 deleted the prediction. Dedup is now one atomic claim on
 * `(script, session, payload)` in `hook-stdin.js#dedupDecision`. These tests
 * pin the two properties that buys us:
 *
 *   1. Install topology cannot suppress anything. No arrangement of local
 *      dirs, settings files or missing scripts produces zero fires.
 *   2. Two racers on one payload still yield exactly one fire.
 *
 * Runner: node --require ./tests/helpers/setup.js --test \
 *           bin/_lib/__tests__/v2318-w6b-dedup-blackout.test.js
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const LIB_DIR    = path.resolve(__dirname, '..');
const HOOK_STDIN = path.join(LIB_DIR, 'hook-stdin.js');

const RAW = '{"session_id":"w9","tool_name":"Bash"}';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w9-blackout-'));
}

function writeSettings(root, name, obj) {
  const dir = path.join(root, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2), 'utf8');
}

/** A settings shape matching what the local installer actually writes. */
function hookSettings(command) {
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } };
}

/** Materialize a hook script inside an install tree and return its path. */
function installScript(installRoot, name) {
  const bin = path.join(installRoot, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  fs.writeFileSync(file, '// hook', 'utf8');
  return file;
}

/** The child program: ask for one dedup decision and print it. */
function decisionProgram(callerPath, cwd, raw) {
  return `
    const hs = require(${JSON.stringify(HOOK_STDIN)});
    const raw = ${JSON.stringify(raw)};
    process.stdout.write(JSON.stringify(hs._internal.dedupDecision({
      callerPath: ${JSON.stringify(callerPath)},
      cwd: ${JSON.stringify(cwd)},
      raw,
      payload: JSON.parse(raw),
    })));
  `;
}

function childEnv(home) {
  const env = Object.assign({}, process.env, { HOME: home });
  delete env.ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP;
  delete env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED;
  return env;
}

/**
 * Ask a child process for the dedup decision, with HOME pointed at a fake
 * global install so `os.homedir()` resolves there. A separate process is the
 * point: the claim is cross-process state, and every blackout in this
 * subsystem looked correct under in-process inspection.
 */
function decideInChild({ home, cwd, callerPath, raw }) {
  const stdout = execFileSync(process.execPath, ['-e', decisionProgram(callerPath, cwd, raw || RAW)], {
    cwd, env: childEnv(home), encoding: 'utf8', timeout: 15000,
  });
  return JSON.parse(stdout);
}

/** Two decisions from two genuinely concurrent processes. */
function decideConcurrently(home, cwd, callers, raws) {
  return Promise.all(callers.map((callerPath, i) => new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', decisionProgram(callerPath, cwd, (raws && raws[i]) || RAW)],
      { cwd, env: childEnv(home), encoding: 'utf8', timeout: 15000 },
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout)))
    );
  })));
}

// ---------------------------------------------------------------------------

describe('W9: install topology can no longer black out a hook', () => {
  let project;
  let home;
  let globalCaller;

  beforeEach(() => {
    project = mkProject();
    home    = path.join(project, 'fakehome');
    globalCaller = installScript(path.join(home, '.claude', 'orchestray'), 'some-hook.js');
  });
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  test('a stale local install dir does not silence the global caller', () => {
    fs.mkdirSync(path.join(project, '.claude', 'orchestray', 'bin'), { recursive: true });

    const decision = decideInChild({ home, cwd: project, callerPath: globalCaller });
    assert.equal(decision.fire, true);
  });

  test('a REGISTERED local install does not silence it either', () => {
    // This is the one arrangement the deleted layer suppressed. It was a
    // prediction that the local copy would fire; when it did not — because
    // Claude Code never spawned it, or spawned it from a path the probe read
    // differently — the event was simply lost. Only an actual competing claim
    // suppresses now.
    const localBin = path.join(project, '.claude', 'orchestray', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, 'some-hook.js'), '// hook', 'utf8');
    writeSettings(project, 'settings.json',
      hookSettings('node "' + path.join(localBin, 'some-hook.js') + '"'));

    const decision = decideInChild({ home, cwd: project, callerPath: globalCaller });
    assert.equal(decision.fire, true, 'an uncontested caller must always win its claim');
  });

  test('settings naming only the GLOBAL install are irrelevant', () => {
    // The W7b E-A shape: `~`, `$HOME` and `${HOME}` read as project-relative,
    // so settings pointing exclusively at the global install marked the LOCAL
    // one live and the global install yielded to nothing. The text of a
    // settings file no longer participates in the decision at all.
    fs.mkdirSync(path.join(project, '.claude', 'orchestray', 'bin'), { recursive: true });
    for (const form of ['~', '$HOME', '${HOME}']) {
      writeSettings(project, 'settings.json',
        hookSettings('node "' + form + '/.claude/orchestray/bin/some-hook.js"'));
      const decision = decideInChild({ home, cwd: project, callerPath: globalCaller });
      assert.equal(decision.fire, true, 'BLACKOUT with settings form ' + form);
    }
  });

  test('a script that exists in only ONE install still fires (partial upgrade)', () => {
    // W8 C-1: global on the new release, local a version behind, so the script
    // the release added exists only in the global copy.
    const localBin = path.join(project, '.claude', 'orchestray', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, 'older-hook.js'), '// hook', 'utf8');
    writeSettings(project, 'settings.json',
      hookSettings('node "' + path.join(localBin, 'older-hook.js') + '"'));

    const decision = decideInChild({ home, cwd: project, callerPath: globalCaller });
    assert.equal(decision.fire, true, 'nothing else can run this script');
  });

  test('the dedup path exposes no predicate about the other install', () => {
    // Structural, because the five previous fixes each replaced one topology
    // predicate with a slightly better one. There is no better one.
    const priority = require('../install-path-priority.js');
    for (const gone of ['shouldFireFromThisInstall', 'localInstallRegistered', 'localInstallHasScript']) {
      assert.equal(priority[gone], undefined, gone + ' must stay deleted');
    }
    const stdinSrc = fs.readFileSync(HOOK_STDIN, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/install-path-priority/.test(stdinSrc),
      'the hook entry must not consult install topology'
    );
  });
});

describe('W9: exactly one of two racing installs fires', () => {
  let project;
  let home;
  let globalCaller;
  let localCaller;

  beforeEach(() => {
    project = mkProject();
    home    = path.join(project, 'fakehome');
    globalCaller = installScript(path.join(home, '.claude', 'orchestray'), 'some-hook.js');
    localCaller  = installScript(path.join(project, '.claude', 'orchestray'), 'some-hook.js');
  });
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  test('concurrent processes, same payload → exactly one fires', async () => {
    const decisions = await decideConcurrently(home, project, [globalCaller, localCaller]);
    const fired = decisions.filter((d) => d.fire);
    assert.equal(fired.length, 1,
      'O_EXCL admits one claimant; observed ' + JSON.stringify(decisions));
    assert.equal(decisions.find((d) => !d.fire).reason, 'duplicate_install');
  });

  test('sequential processes, same payload → exactly one fires', () => {
    const first  = decideInChild({ home, cwd: project, callerPath: localCaller });
    const second = decideInChild({ home, cwd: project, callerPath: globalCaller });
    assert.equal(first.fire, true);
    assert.equal(second.fire, false);
    assert.equal(second.firstCaller, localCaller);
  });

  test('distinct payloads within the window → both fire', async () => {
    // Over-suppression is the mirror-image failure: two real events collapsing
    // into one is as invisible as a blackout.
    const decisions = await decideConcurrently(home, project, [globalCaller, localCaller], [
      '{"session_id":"w9","tool_name":"Bash"}',
      '{"session_id":"w9","tool_name":"Read"}',
    ]);
    assert.deepEqual(decisions.map((d) => d.fire), [true, true]);
  });

  test('the same caller repeating a payload → both fire', () => {
    const first  = decideInChild({ home, cwd: project, callerPath: localCaller });
    const second = decideInChild({ home, cwd: project, callerPath: localCaller });
    assert.equal(first.fire, true);
    assert.equal(second.fire, true);
    assert.equal(second.reason, 'same_caller_repeat');
  });
});
