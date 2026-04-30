'use strict';

/**
 * v2216-fn16-shipped-source-prune-fix.test.js — v2.2.16 hotfix regression test.
 *
 * v2.2.15 FN-16 prune deleted scripts from install target's bin/ whose basename
 * was missing from canonical hooks/hooks.json — even when the source still
 * ships the script for subprocess invocation. The 6 audit scripts retired from
 * canonical hooks by v2.2.10 F1 were getting clobbered on every install.
 *
 * v2.2.16 fix: prune only deletes the install-target file when source ALSO
 * does not ship it. Source-shipped scripts are intentional and must stay.
 *
 * Approach: run the REAL bin/install.js with --local against a synthetic
 * install target whose settings.json wires a script as a stale hook entry.
 * After install, check whether the script file survived in the install target.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');
const NODE       = process.execPath;

function makeTarget(extraScriptName) {
  // Make a synthetic install target with .claude/ pre-populated.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v2216-fn16-tgt-'));
  const claudeDir = path.join(target, '.claude');
  const installBin = path.join(claudeDir, 'orchestray', 'bin');
  fs.mkdirSync(installBin, { recursive: true });

  // Pre-stage the "stale" script in install target's bin/.
  const stalePath = path.join(installBin, extraScriptName + '.js');
  fs.writeFileSync(stalePath, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });

  // Pre-stage settings.json that registers the stale script as a hook.
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [{
            type: 'command',
            command: 'node "' + stalePath + '"',
            timeout: 5,
          }],
        }],
      },
    })
  );

  return { target, stalePath };
}

function runInstall(target) {
  return spawnSync(NODE, [INSTALL_JS, '--local'], {
    cwd: target,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: target },
  });
}

describe('v2.2.16 FN-16 hotfix — shipped-source check before unlink', () => {

  test('1. Source ships script + not in canonical hooks → script SURVIVES install', () => {
    // archive-orch-events is shipped in real source bin/ but not registered
    // in canonical hooks/hooks.json (per v2.2.10 F1 retire). v2.2.15 deleted
    // it on every install; v2.2.16 keeps it.
    const { target, stalePath } = makeTarget('archive-orch-events');

    try {
      const r = runInstall(target);
      assert.equal(r.status, 0, 'install exits 0; stderr: ' + (r.stderr || '').slice(0, 500));
      assert.ok(
        fs.existsSync(stalePath),
        'archive-orch-events.js MUST survive prune because source ships it for subprocess invocation'
      );
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('2. Source does NOT ship + not in canonical hooks → script gets pruned', () => {
    // Truly stale: no orchestray script with this name exists in source bin/.
    const { target, stalePath } = makeTarget('truly-stale-script-xyzzy');

    try {
      const r = runInstall(target);
      assert.equal(r.status, 0, 'install exits 0; stderr: ' + (r.stderr || '').slice(0, 500));
      assert.equal(
        fs.existsSync(stalePath),
        false,
        'truly-stale-script-xyzzy.js MUST get pruned (source does not ship it)'
      );
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('3. Multiple subprocess scripts (v2.2.10 F1 set) all survive install', () => {
    // The full set the v2.2.15 bug clobbered: 6 audit scripts shipped in source
    // for subprocess invocation by audit-on-orch-complete.js.
    const subprocessScripts = [
      'archive-orch-events',
      'audit-housekeeper-orphan',
      'audit-pm-emit-coverage',
      'audit-promised-events',
      'audit-round-archive-hook',
      'scan-cite-labels',
    ];

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v2216-fn16-tgt-'));
    const claudeDir = path.join(target, '.claude');
    const installBin = path.join(claudeDir, 'orchestray', 'bin');
    fs.mkdirSync(installBin, { recursive: true });

    const hookEntries = [];
    for (const s of subprocessScripts) {
      const p = path.join(installBin, s + '.js');
      fs.writeFileSync(p, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
      hookEntries.push({
        type: 'command',
        command: 'node "' + p + '"',
        timeout: 5,
      });
    }

    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: hookEntries }] } })
    );

    try {
      const r = spawnSync(NODE, [INSTALL_JS, '--local'], {
        cwd: target,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, HOME: target },
      });
      assert.equal(r.status, 0, 'install exits 0; stderr: ' + (r.stderr || '').slice(0, 500));

      for (const s of subprocessScripts) {
        const p = path.join(installBin, s + '.js');
        assert.ok(
          fs.existsSync(p),
          s + '.js MUST survive prune (shipped in source for subprocess invocation)'
        );
      }
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

});
