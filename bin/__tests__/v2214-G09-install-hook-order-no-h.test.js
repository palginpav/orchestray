'use strict';

/**
 * v2214-G09-install-hook-order-no-h.test.js — G-09 regression: no `h` in shadow
 * for install_hook_order_corrected / install_hook_order_skipped_interleaved.
 *
 * These events write to degraded.jsonl via recordDegradation, not events.jsonl.
 * The shadow `h` (enum_dialect_hash) is a correlator for events.jsonl entries —
 * it must NOT appear for degraded-only events (W2 finding A4).
 *
 * 2 cases:
 *   1. Shadow declares: install_hook_order_corrected + install_hook_order_skipped_interleaved
 *      must NOT have an `h` key in their shadow entries.
 *   2. Layout A drive: install emits install_hook_order_corrected into degraded.jsonl
 *      and the entry has no `h` key in its payload.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');
const SHADOW_JSON = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const NODE       = process.execPath;

// ---------------------------------------------------------------------------
// Helpers (shared with v2213-W3-hook-order tests)
// ---------------------------------------------------------------------------

function makeTmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g09-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-g09-test' }),
    'utf8',
  );
  return dir;
}

function runRealInstall(targetDir, envOverrides = {}) {
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED;
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

function readDegraded(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function clearDegraded(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  try { fs.writeFileSync(p, '', 'utf8'); } catch (_) {}
}

function getAgentEntry(settings) {
  const ptu = settings && settings.hooks && settings.hooks['PreToolUse'];
  if (!Array.isArray(ptu)) return null;
  return ptu.find(e => e.matcher === 'Agent|Explore|Task') || null;
}

function saveSettings(tmpDir, settings) {
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.14 G-09 — install_hook_order_corrected + skipped_interleaved: no h in shadow', () => {

  let tmpDir;
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // ── Case 1: Shadow declares must not have h field ────────────────────────
  test('shadow: install_hook_order_corrected must not have h key', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_JSON, 'utf8'));
    const entry = shadow['install_hook_order_corrected'];
    assert.ok(entry, 'install_hook_order_corrected must be declared in shadow');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(entry, 'h'),
      false,
      'install_hook_order_corrected shadow entry must NOT have h (degraded-only event; h is events.jsonl correlator)'
    );
  });

  test('shadow: install_hook_order_skipped_interleaved must not have h key', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_JSON, 'utf8'));
    const entry = shadow['install_hook_order_skipped_interleaved'];
    assert.ok(entry, 'install_hook_order_skipped_interleaved must be declared in shadow');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(entry, 'h'),
      false,
      'install_hook_order_skipped_interleaved shadow entry must NOT have h (degraded-only event; h is events.jsonl correlator)'
    );
  });

  // ── Case 2: Layout A drive — corrected entry in degraded.jsonl has no h ──
  test('Layout A drive: install_hook_order_corrected emitted to degraded.jsonl without h key', () => {
    tmpDir = makeTmpTarget();

    // Fresh install to get canonical settings.json.
    const fresh = runRealInstall(tmpDir);
    assert.strictEqual(fresh.status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) {
      // Not enough hooks to simulate drift — skip gracefully.
      return;
    }

    const ourHooks = ae.hooks.filter(h => (h.command || '').includes('orchestray'));
    if (ourHooks.length < 2) return;

    // Swap first two hooks to introduce drift (Layout A: no peer hooks).
    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    saveSettings(tmpDir, settings);
    clearDegraded(tmpDir);

    // Second install: should auto-reorder and emit install_hook_order_corrected.
    const second = runRealInstall(tmpDir);
    assert.strictEqual(second.status, 0, 'second install must succeed');

    const degraded = readDegraded(tmpDir);
    const corrected = degraded.find(r =>
      r.kind === 'install_hook_order_corrected' &&
      r.detail && r.detail.event === 'PreToolUse' &&
      r.detail.matcher === 'Agent|Explore|Task'
    );

    assert.ok(corrected, 'install_hook_order_corrected must be written to degraded.jsonl');

    // G-09 invariant: no `h` key in the degraded entry's detail or top-level.
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(corrected, 'h'),
      false,
      'degraded entry must NOT have top-level h key'
    );
    assert.strictEqual(
      corrected.detail && Object.prototype.hasOwnProperty.call(corrected.detail, 'h'),
      false,
      'degraded entry detail must NOT have h key'
    );
  });

});
