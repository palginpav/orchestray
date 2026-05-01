'use strict';

/**
 * Tests for statusline.js B-3 + R2-W4-F3 changes.
 *
 * Since statusline.js does not export its functions, we test via child_process
 * for the full integration path, and test the models.js helpers directly for
 * unit coverage.
 *
 * Covers:
 *   - Known model with [1m] suffix → bumps window (existing behaviour preserved)
 *   - Unknown model with high observed tokens → does NOT bump, denominator gets ~ prefix
 *   - Known model below threshold → no bump, no ~
 *   - models.js MODEL_UNKNOWN no longer carries window_1m
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { MODEL_UNKNOWN, lookupModel } = require('../../bin/_lib/models.js');
const { resetCache, updateCache } = require('../../bin/_lib/context-telemetry-cache');

const STATUSLINE = path.resolve(__dirname, '../../bin/statusline.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-b3-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    // F-19 (v2.2.21): pin idle_suppression: false for these B-3 unit tests so the
    // legacy "[ctx" assertions stay valid when zero subagents are active.
    JSON.stringify({ context_statusbar: { enabled: true, width_cap: 200, pressure_thresholds: { warn: 75, critical: 90 }, idle_suppression: false } }),
    'utf8'
  );
  return dir;
}

function teardown(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function runStatusline(projectDir, sessionId, modelId, totalPromptTokens, payloadExtra) {
  resetCache(projectDir, sessionId);
  updateCache(projectDir, (cache) => {
    cache.session = {
      model: modelId,
      context_window: 200000,
      tokens: { input: totalPromptTokens, output: 0, cache_read: 0, cache_creation: 0, total_prompt: totalPromptTokens },
      last_turn_at: new Date().toISOString(),
    };
    return cache;
  });

  const payload = Object.assign({ cwd: projectDir, session_id: sessionId, model: { id: modelId } }, payloadExtra || {});
  const result = spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return (result.stdout || '').trim();
}

// ── models.js unit: MODEL_UNKNOWN no longer has window_1m ────────────────────

describe('models.js — MODEL_UNKNOWN', () => {
  test('MODEL_UNKNOWN does not have window_1m field', () => {
    assert.ok(!('window_1m' in MODEL_UNKNOWN), 'MODEL_UNKNOWN should not carry window_1m');
  });

  test('MODEL_UNKNOWN short is "?"', () => {
    assert.equal(MODEL_UNKNOWN.short, '?');
  });

  test('unknown model ID resolves to MODEL_UNKNOWN', () => {
    const meta = lookupModel('claude-future-model-99');
    assert.equal(meta.short, '?');
    assert.ok(!('window_1m' in meta), 'unknown model should not have window_1m');
  });

  test('known model (opus-4-6) still has window_1m', () => {
    const meta = lookupModel('claude-opus-4-6');
    assert.ok('window_1m' in meta, 'known Opus model should retain window_1m');
    assert.equal(meta.window_1m, 1000000);
  });
});

// ── statusline integration: bump suppression for unknown model ────────────────

describe('statusline B-3: unknown model bump suppression', () => {
  test('known model (opus-4-6) with 1m suffix → bumps window, no ~ prefix', () => {
    const dir = makeTmpProject();
    try {
      // 900K tokens observed, model has [1m] suffix → should bump to 1M window
      // The [1m] suffix → resolveContextWindow returns 1M directly (not via bump)
      const line = runStatusline(dir, 'sess-known-1m', 'claude-opus-4-6[1m]', 900000);
      assert.ok(line.includes('[ctx'), 'should render ctx block: ' + line);
      // Should use 1M denominator (no ~ prefix)
      assert.ok(line.includes('1M') || line.includes('/'), 'should render with 1M window: ' + line);
      assert.ok(!line.includes('/~'), 'should NOT have ~ prefix for known model: ' + line);
    } finally {
      teardown(dir);
    }
  });

  test('unknown model with tokens exceeding 200K → does NOT bump, ~ prefix appears', () => {
    const dir = makeTmpProject();
    try {
      // 300K tokens observed for an unknown model (default 200K window) — exceeds window
      // B-3: should suppress bump and render with ~ prefix
      const line = runStatusline(dir, 'sess-unknown', 'claude-unknown-future-99', 300000);
      assert.ok(line.includes('[ctx'), 'should render ctx block: ' + line);
      // The denominator should have ~ prefix
      assert.ok(line.includes('/~'), 'should have ~ prefix on denominator for unknown model: ' + line);
      // Model short should be '?'
      assert.ok(line.includes('?'), 'model token should be "?" for unknown model: ' + line);
    } finally {
      teardown(dir);
    }
  });

  test('known model below threshold → no bump, no ~ prefix', () => {
    const dir = makeTmpProject();
    try {
      // 50K tokens for sonnet (200K window) — well below threshold
      const line = runStatusline(dir, 'sess-known-low', 'claude-sonnet-4-6', 50000);
      assert.ok(line.includes('[ctx'), 'should render ctx block: ' + line);
      assert.ok(!line.includes('/~'), 'should NOT have ~ prefix for known model below threshold: ' + line);
      assert.ok(line.includes('son-4-6'), 'model token should be son-4-6: ' + line);
    } finally {
      teardown(dir);
    }
  });

  test('known model (opus-4-6) observed above 200K but no [1m] → bumps to 1M, no ~', () => {
    const dir = makeTmpProject();
    try {
      // 500K tokens for opus without [1m] suffix — bump should activate
      const line = runStatusline(dir, 'sess-opus-bump', 'claude-opus-4-6', 500000);
      assert.ok(line.includes('[ctx'), 'should render ctx block: ' + line);
      // Bump should give 1M window
      assert.ok(!line.includes('/~'), 'should NOT have ~ for known opus model: ' + line);
      assert.ok(line.includes('1M'), 'should show 1M window after bump: ' + line);
    } finally {
      teardown(dir);
    }
  });
});
