'use strict';

/**
 * v2.2.15 FN-15: install-merge-hooks-arg-update regression test.
 *
 * Goal: catch the v2.2.14 G-03 regression where install.js mergeHooks "dedup
 * by basename" silently dropped new args/timeout. The v2.2.14 calibrate-role-
 * budgets `--quiet` flag was added in canonical hooks.json but never reached
 * existing user installs, because the dedup pass keyed on basename only.
 *
 * Cases:
 *   1. fresh_install_matches_canonical
 *      Run install --local on an empty target. Every basename in canonical
 *      hooks/hooks.json must produce an installed command line whose args
 *      EXACTLY match the canonical args.
 *
 *   2. inplace_upgrade_with_arg_drift_now_matches_canonical
 *      Pre-seed the target with a settings.json whose calibrate-role-budgets
 *      command lacks the canonical `--quiet` arg. Run install --local. The
 *      installed command line MUST now include `--quiet` (FN-14 arg-update
 *      pass kicked in).
 *
 *   3. command_managed_true_preserved
 *      Pre-seed with a settings.json entry carrying `command_managed:true`
 *      and a non-canonical arg set. Run install --local. The entry must NOT
 *      be overwritten — `command_managed` is the user's opt-out flag.
 */

const { test, describe, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const NODE       = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run install.js --local against tmp target. Returns {status, stdout, stderr}. */
function runInstall(targetDir, env) {
  const r = cp.spawnSync(NODE, [INSTALL_JS, '--local'], {
    cwd:      targetDir,
    env:      Object.assign({}, process.env, { HOME: targetDir }, env || {}),
    encoding: 'utf8',
    timeout:  30_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function makeTmpTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fn15-'));
}

function readSettings(tmpDir) {
  const p = path.join(tmpDir, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Build a basename → canonical args+timeout map from the source hooks.json.
 * args is the exact whitespace tail after the script name.
 */
function canonicalArgsByBasename() {
  const data = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const out = new Map();
  for (const entries of Object.values(data.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of (entry.hooks || [])) {
        const cmd = h.command || '';
        const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/(\S+)(.*)$/);
        if (!m) continue;
        const base = path.basename(m[1]);
        if (!out.has(base)) {
          out.set(base, { args: m[2].trim(), timeout: h.timeout });
        }
      }
    }
  }
  return out;
}

/**
 * Walk an installed settings.json and yield {basename, args, timeout, entry}.
 * Returns first occurrence per basename (matches canonical's first-wins).
 */
function installedArgsByBasename(settings) {
  const out = new Map();
  for (const entries of Object.values((settings && settings.hooks) || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of (entry.hooks || [])) {
        const cmd = h.command || '';
        // path may include spaces; we only care about the args tail after `.js`
        const m = cmd.match(/\.js"?(\s+.*)?$/);
        if (!m) continue;
        const baseM = cmd.match(/\/bin\/([^\s"']+)/);
        if (!baseM) continue;
        const base = path.basename(baseM[1]);
        if (!out.has(base)) {
          out.set(base, { args: (m[1] || '').trim(), timeout: h.timeout, command_managed: h.command_managed === true });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

describe('FN-15 install-merge-hooks-arg-update', () => {
  test('fresh_install_matches_canonical: every basename has canonical args', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    const r = runInstall(tmp);
    assert.equal(r.status, 0,
      'install failed\nstdout=' + r.stdout + '\nstderr=' + r.stderr);
    const settings  = readSettings(tmp);
    assert.ok(settings && settings.hooks, 'settings.json must have hooks block');
    const canonical = canonicalArgsByBasename();
    const installed = installedArgsByBasename(settings);
    const drift     = [];
    for (const [base, expected] of canonical.entries()) {
      const got = installed.get(base);
      if (!got) { drift.push(base + ' MISSING from installed settings.json'); continue; }
      if (got.args !== expected.args) {
        drift.push(base + ' args drift: canonical=' + JSON.stringify(expected.args) +
                   ' installed=' + JSON.stringify(got.args));
      }
    }
    assert.equal(drift.length, 0,
      'fresh install command-line drift:\n  ' + drift.join('\n  '));
  });

  test('inplace_upgrade_with_arg_drift_now_matches_canonical: --quiet propagates', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    // Step 1: do an initial install
    let r = runInstall(tmp);
    assert.equal(r.status, 0, 'first install failed\nstderr=' + r.stderr);
    // Step 2: hand-corrupt the calibrate-role-budgets command to remove --quiet,
    // simulating a v2.2.14 install that pre-dates the FN-14 arg-update logic.
    const settingsPath = path.join(tmp, '.claude', 'settings.json');
    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    let stripped = false;
    for (const entries of Object.values(settings.hooks || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of (entry.hooks || [])) {
          if ((h.command || '').includes('calibrate-role-budgets.js') && h.command.includes('--quiet')) {
            h.command = h.command.replace(/\s*--quiet\b/g, '');
            stripped = true;
          }
        }
      }
    }
    assert.ok(stripped, 'fixture setup failed: no --quiet found to strip');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

    // Step 3: re-run install. FN-14 arg-update pass should restore --quiet.
    r = runInstall(tmp);
    assert.equal(r.status, 0, 'second install failed\nstderr=' + r.stderr);
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const installed = installedArgsByBasename(settings);
    const got = installed.get('calibrate-role-budgets.js');
    assert.ok(got, 'calibrate-role-budgets.js missing from settings.json');
    assert.match(got.args, /--quiet/,
      'args should now contain --quiet, got=' + JSON.stringify(got.args));
    // FN-14 should also have emitted an advisory line (best-effort assert).
    assert.match(r.stderr, /Updated calibrate-role-budgets\.js/,
      'expected stderr advisory for arg update');
  });

  test('command_managed_true_preserved: user-edited entry untouched', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    let r = runInstall(tmp);
    assert.equal(r.status, 0);
    const settingsPath = path.join(tmp, '.claude', 'settings.json');
    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Pick the calibrate-role-budgets entry and stamp command_managed:true
    // along with a non-canonical args string. After re-install, both must
    // remain unchanged.
    const customCommand = 'node /custom/path/calibrate-role-budgets.js --user-edited';
    let stamped = false;
    for (const entries of Object.values(settings.hooks || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of (entry.hooks || [])) {
          if ((h.command || '').includes('calibrate-role-budgets.js')) {
            h.command         = customCommand;
            h.command_managed = true;
            stamped = true;
            break;
          }
        }
        if (stamped) break;
      }
      if (stamped) break;
    }
    assert.ok(stamped, 'fixture setup failed: no calibrate hook to stamp');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

    r = runInstall(tmp);
    assert.equal(r.status, 0, 'second install failed\nstderr=' + r.stderr);
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    let foundManaged = null;
    for (const entries of Object.values(settings.hooks || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of (entry.hooks || [])) {
          if (h.command_managed === true) { foundManaged = h; break; }
        }
        if (foundManaged) break;
      }
      if (foundManaged) break;
    }
    assert.ok(foundManaged, 'command_managed entry should survive re-install');
    assert.equal(foundManaged.command, customCommand,
      'command_managed entry must NOT be overwritten by canonical args update');
  });
});
