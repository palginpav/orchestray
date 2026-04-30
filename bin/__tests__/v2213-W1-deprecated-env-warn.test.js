'use strict';

/**
 * v2213-W1-deprecated-env-warn.test.js — deprecated env-var detection (v2.2.13 W1).
 *
 * Verifies that boot-validate-config.js emits `deprecated_kill_switch_detected`
 * exactly once per session when ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1
 * is set, and that the sentinel mechanism prevents re-emit.
 *
 * Tests:
 *   1. Env var set → deprecated_kill_switch_detected emits, stderr warns.
 *   2. Env var NOT set → no deprecated_kill_switch_detected event.
 *   3. Sentinel file present → event does NOT re-emit (dedup works).
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

describe('v2.2.13 W1 — deprecated env-var detection in boot-validate-config', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Test 1: env var set → event emits, stderr warns ────────────────────
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED=1 → deprecated_kill_switch_detected emits once', () => {
    const r = runBoot(tmpRoot, { ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED: '1' });

    // Boot may fail (exit non-zero) due to config validation, but the
    // deprecation warn should still fire before exit — fail-open principle.
    assert.ok(
      r.stderr.includes('DEPRECATED: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED'),
      'stderr must contain the DEPRECATED warning; got: ' + r.stderr,
    );
    assert.ok(
      r.stderr.includes('ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED'),
      'stderr must include replacement env var name (UX critique F-04); got: ' + r.stderr,
    );

    const events = readEvents(tmpRoot);
    const deprecated = events.filter(e => e.event_type === 'deprecated_kill_switch_detected');
    assert.equal(deprecated.length, 1, 'exactly 1 deprecated_kill_switch_detected event');
    assert.equal(deprecated[0].name, 'ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED');
    assert.equal(deprecated[0].replacement, 'ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED');
    assert.equal(deprecated[0].retires_in, 'v2.2.14');
    assert.equal(deprecated[0].schema_version, 1);
  });

  // ── Test 2: env var NOT set → no event ─────────────────────────────────
  test('ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED not set → no deprecated_kill_switch_detected', () => {
    const r = runBoot(tmpRoot, {});

    assert.ok(
      !r.stderr.includes('DEPRECATED: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED'),
      'stderr must NOT contain the DEPRECATED warning when env var is unset; got: ' + r.stderr,
    );

    const events = readEvents(tmpRoot);
    const deprecated = events.filter(e => e.event_type === 'deprecated_kill_switch_detected');
    assert.equal(deprecated.length, 0, 'no deprecated_kill_switch_detected event when env var is unset');
  });

  // ── Test 3: sentinel present → re-emit suppressed ──────────────────────
  test('sentinel file present → event does NOT re-emit (per-session dedup)', () => {
    // v2.2.13 UX critique F-01: shared sentinel (no pid component) so boot
    // and preflight dedupe across the whole session.
    const stateDir = path.join(tmpRoot, '.orchestray', 'state');
    const sentinelPath = path.join(stateDir, 'deprecated-env-warned-context-hint');
    fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n', 'utf8');

    // Run boot in the SAME process pid so the sentinel matches.
    // We need to invoke via --eval to control the pid used.
    // Instead, test the exported function directly.
    const { maybeWarnDeprecatedContextHintEnvVar } = require(BOOT_PATH);

    // Save original env
    const origVal = process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
    process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED = '1';

    // Patch stderr to capture output
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg) => { stderrLines.push(msg); return true; };

    try {
      maybeWarnDeprecatedContextHintEnvVar(tmpRoot);
    } finally {
      process.stderr.write = origWrite;
      if (origVal === undefined) {
        delete process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
      } else {
        process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED = origVal;
      }
    }

    // Sentinel was already present → no warn should have been written.
    // v2.2.13 final-review F-03: substring updated to match the post-ux-critic
    // message (was 'DEPRECATED env var ...'; now 'DEPRECATED: ...').
    const deprecatedWarnings = stderrLines.filter(l =>
      l.includes('DEPRECATED: ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED'),
    );
    assert.equal(deprecatedWarnings.length, 0, 'sentinel must suppress re-emit');

    // No new event should have been written
    const events = readEvents(tmpRoot);
    const deprecated = events.filter(e => e.event_type === 'deprecated_kill_switch_detected');
    assert.equal(deprecated.length, 0, 'sentinel prevents event re-emit');
  });

});
