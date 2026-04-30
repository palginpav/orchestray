'use strict';

/**
 * v2213-W1-deprecated-env-warn.test.js — deprecated env-var detection (v2.2.13 W1).
 *
 * As of v2.2.14 G-04, ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED is fully
 * retired. The maybeWarnDeprecatedContextHintEnvVar function has been deleted from
 * boot-validate-config.js. These tests verify that retirement is complete.
 *
 * Tests:
 *   1. maybeWarnDeprecatedContextHintEnvVar is no longer exported from boot-validate-config.
 *   2. boot-validate-config runs without error when env var is set (var is no-op).
 *   3. boot-validate-config does NOT emit deprecated_kill_switch_detected (function removed).
 *
 * Runner: node --test bin/__tests__/v2213-W1-deprecated-env-warn.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const BOOT_PATH   = path.join(REPO_ROOT, 'bin', 'boot-validate-config.js');
const NODE        = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-depwarn-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });

  // Minimal valid config so boot-validate-config doesn't fail on zod.
  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {},
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );

  return dir;
}

function readEvents(root) {
  try {
    return fs.readFileSync(
      path.join(root, '.orchestray', 'audit', 'events.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

/**
 * Run boot-validate-config.js with the given env overrides.
 * We pass CLAUDE_PROJECT_DIR so it uses our tmp dir.
 */
function runBoot(cwd, envOverrides) {
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED;
  const env = Object.assign({}, baseEnv, { CLAUDE_PROJECT_DIR: cwd }, envOverrides || {});
  const r = cp.spawnSync(NODE, [BOOT_PATH], {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.14 G-04 — deprecated env-var fully retired in boot-validate-config', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Test 1: maybeWarnDeprecatedContextHintEnvVar no longer exported ─────
  test('maybeWarnDeprecatedContextHintEnvVar is NOT exported from boot-validate-config', () => {
    // Bypass module cache so we get a fresh load
    const modPath = require.resolve(BOOT_PATH);
    delete require.cache[modPath];
    const mod = require(BOOT_PATH);
    assert.equal(
      typeof mod.maybeWarnDeprecatedContextHintEnvVar,
      'undefined',
      'maybeWarnDeprecatedContextHintEnvVar must be removed from exports (G-04)',
    );
  });

  // ── Test 2: env var set → no DEPRECATED warn in stderr ─────────────────
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 → no DEPRECATED warning emitted', () => {
    const r = runBoot(tmpRoot, { ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED: '1' });

    assert.ok(
      !r.stderr.includes('DEPRECATED: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED'),
      'stderr must NOT contain DEPRECATED warning — function was removed; got: ' + r.stderr,
    );
  });

  // ── Test 3: env var set → no deprecated_kill_switch_detected event ──────
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 → no deprecated_kill_switch_detected event', () => {
    runBoot(tmpRoot, { ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED: '1' });

    const events = readEvents(tmpRoot);
    const deprecated = events.filter(e => e.event_type === 'deprecated_kill_switch_detected');
    assert.equal(deprecated.length, 0, 'no deprecated_kill_switch_detected event — function removed in G-04');
  });

});
