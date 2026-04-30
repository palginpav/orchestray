'use strict';

/**
 * v2214-G03-calibrate-canonical.test.js — G-03 integration tests (v2.2.14).
 *
 * Verifies that calibrate-role-budgets.js is canonicalised in hooks/hooks.json
 * and that install.js propagates it to fresh and existing settings.json installs.
 * Also verifies that validate-hook-order.js emits no hook_chain_drift_detected
 * when the hook is in canonical position.
 *
 * Cases:
 *   1. hooks/hooks.json has a SessionStart entry for calibrate-role-budgets.js.
 *   2. Fresh install: settings.json SessionStart contains calibrate-role-budgets.js.
 *   3. Existing install missing the hook: upgrade install adds it.
 *   4. validate-hook-order.js: no hook_chain_drift_detected when hook is present
 *      in canonical order (uses installed settings.json).
 *
 * Runner: node --test bin/__tests__/v2214-G03-calibrate-canonical.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const INSTALL_JS   = path.join(REPO_ROOT, 'bin', 'install.js');
const VALIDATOR_JS = path.join(REPO_ROOT, 'bin', 'validate-hook-order.js');
const HOOKS_JSON   = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const NODE         = process.execPath;

const CALIBRATE_SCRIPT = 'calibrate-role-budgets.js';
const CALIBRATE_ARGS   = '--emit-cache --if-stale --quiet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g03-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-g03-test' }),
    'utf8',
  );
  return dir;
}

function runRealInstall(targetDir, envOverrides = {}) {
  const baseEnv = Object.assign({}, process.env);
  const r = cp.spawnSync(
    NODE,
    [INSTALL_JS, '--local'],
    {
      cwd:      targetDir,
      env:      Object.assign({}, baseEnv, { HOME: targetDir }, envOverrides),
      encoding: 'utf8',
      timeout:  20000,
    }
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readSettings(tmpDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'));
  } catch (_) { return null; }
}

function saveSettings(tmpDir, settings) {
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Find all hooks in SessionStart entries (across all matcher groups) whose
 * command references calibrate-role-budgets.js.
 */
function findCalibrateHooks(settings) {
  const entries = (settings && settings.hooks && settings.hooks.SessionStart) || [];
  const found = [];
  for (const entry of entries) {
    for (const h of (entry.hooks || [])) {
      if ((h.command || '').includes(CALIBRATE_SCRIPT)) {
        found.push(h);
      }
    }
  }
  return found;
}

/**
 * Run validate-hook-order.js against a given settings.json directory.
 * Returns { status, stdout, stderr, events }.
 */
function runValidator(targetDir) {
  // Feed a minimal hook payload on stdin so the validator reads cwd correctly.
  const payload = JSON.stringify({ cwd: targetDir });
  const r = cp.spawnSync(
    NODE,
    [VALIDATOR_JS],
    {
      cwd:      targetDir,
      env:      Object.assign({}, process.env, { HOME: targetDir }),
      input:    payload,
      encoding: 'utf8',
      timeout:  10000,
    }
  );
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.14 G-03 — calibrate-role-budgets canonicalised in hooks/hooks.json + install', () => {

  let tmpDir;
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // ── Case 1: hooks/hooks.json declares calibrate-role-budgets.js ──────────
  test('hooks/hooks.json SessionStart contains calibrate-role-budgets.js entry', () => {
    const canonical = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const sessionStart = (canonical.hooks || canonical).SessionStart || [];

    const calibrateEntries = sessionStart.filter(entry =>
      (entry.hooks || []).some(h => (h.command || '').includes(CALIBRATE_SCRIPT))
    );

    assert.ok(
      calibrateEntries.length > 0,
      `hooks/hooks.json SessionStart must contain an entry for ${CALIBRATE_SCRIPT}`,
    );

    // Verify the full command includes all required flags.
    const hook = calibrateEntries[0].hooks.find(h => (h.command || '').includes(CALIBRATE_SCRIPT));
    assert.ok(
      hook.command.includes('--emit-cache'),
      'calibrate-role-budgets entry must include --emit-cache flag',
    );
    assert.ok(
      hook.command.includes('--if-stale'),
      'calibrate-role-budgets entry must include --if-stale flag',
    );
    assert.ok(
      hook.command.includes('--quiet'),
      'calibrate-role-budgets entry must include --quiet flag',
    );
    assert.ok(
      hook.timeout >= 15,
      'calibrate-role-budgets entry must have timeout >= 15 seconds',
    );
  });

  // ── Case 2: fresh install propagates hook into settings.json ─────────────
  test('fresh install: settings.json SessionStart contains calibrate-role-budgets.js', () => {
    tmpDir = makeTmpTarget();
    const result = runRealInstall(tmpDir);
    assert.strictEqual(result.status, 0, `install must exit 0; stderr: ${result.stderr}`);

    const settings = readSettings(tmpDir);
    assert.ok(settings, 'settings.json must exist after install');

    const calibrateHooks = findCalibrateHooks(settings);
    assert.ok(
      calibrateHooks.length > 0,
      'settings.json SessionStart must contain calibrate-role-budgets.js after fresh install',
    );

    // Verify flags are preserved in the installed command.
    const cmd = calibrateHooks[0].command;
    assert.ok(cmd.includes('--emit-cache'), 'installed command must include --emit-cache');
    assert.ok(cmd.includes('--if-stale'),   'installed command must include --if-stale');
    assert.ok(cmd.includes('--quiet'),       'installed command must include --quiet');
  });

  // ── Case 3: upgrade install adds hook to existing settings missing it ─────
  test('upgrade install: adds calibrate-role-budgets.js to existing settings that lack it', () => {
    tmpDir = makeTmpTarget();

    // First install to get a valid settings.json structure.
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'first install must succeed');

    // Strip calibrate-role-budgets.js from SessionStart to simulate a pre-G03 install.
    const settings = readSettings(tmpDir);
    assert.ok(settings, 'settings.json must exist');
    const ss = settings.hooks && settings.hooks.SessionStart;
    assert.ok(Array.isArray(ss), 'SessionStart must be an array');

    // Remove entries containing calibrate-role-budgets.js.
    for (let i = ss.length - 1; i >= 0; i--) {
      ss[i].hooks = (ss[i].hooks || []).filter(
        h => !(h.command || '').includes(CALIBRATE_SCRIPT)
      );
      if (ss[i].hooks.length === 0) ss.splice(i, 1);
    }
    saveSettings(tmpDir, settings);

    // Verify it's gone.
    const settingsBefore = readSettings(tmpDir);
    assert.strictEqual(
      findCalibrateHooks(settingsBefore).length,
      0,
      'calibrate hook must be absent before upgrade install',
    );

    // Run upgrade install.
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'upgrade install must succeed');

    // Verify it's back.
    const settingsAfter = readSettings(tmpDir);
    const calibrateHooks = findCalibrateHooks(settingsAfter);
    assert.ok(
      calibrateHooks.length > 0,
      'upgrade install must re-add calibrate-role-budgets.js to SessionStart',
    );
  });

  // ── Case 4: validate-hook-order.js: no drift after canonical install ──────
  test('validate-hook-order: no hook_chain_drift_detected after canonical install', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'install must succeed');

    // Run the validator.
    const v = runValidator(tmpDir);
    assert.strictEqual(v.status, 0, `validator must exit 0; stderr: ${v.stderr}`);

    // No drift warning in stderr.
    assert.ok(
      !v.stderr.includes('Hook chain order drift detected'),
      `validator must not emit drift warning after canonical install; got: ${v.stderr}`,
    );

    // No hook_chain_drift_detected events emitted.
    const events = readEvents(tmpDir);
    const driftEvents = events.filter(e => e.event_type === 'hook_chain_drift_detected');
    assert.strictEqual(
      driftEvents.length,
      0,
      `no hook_chain_drift_detected events expected; found: ${JSON.stringify(driftEvents)}`,
    );
  });

});
