#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/learn-commands/status-render.js (v2.1.6 — W10 observability).
 *
 * Runner: node --test bin/__tests__/status-surface-auto-learning.test.js
 *
 * Coverage:
 *   1. Kill switch ON via config → output says "Kill switch: ON"
 *   2. Kill switch ON via env var → output says "Kill switch: ON" + env tag
 *   3. Kill switch OFF (default) → output says "Kill switch: OFF"
 *   4. 2 proposed-patterns files → output says "Proposals staged: 2"
 *   5. Tripped breaker sentinel (scope=auto_extract) → output says "TRIPPED"
 *   6. Env var not set → output says "not set"
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { renderAutoLearningStatus } = require('../learn-commands/status-render');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-surface-test-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'proposed-patterns'), { recursive: true });
});

afterEach(() => {
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(root, alBlock) {
  const dir = path.join(root, '.orchestray');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ auto_learning: alBlock }, null, 2),
    'utf8'
  );
}

function writeProposal(root, slug) {
  const fm = `---\nname: ${slug}\ncategory: decomposition\nconfidence: 0.7\n---\n\n# Pattern\n`;
  fs.writeFileSync(
    path.join(root, '.orchestray', 'proposed-patterns', `${slug}.md`),
    fm,
    'utf8'
  );
}

function writeTripSentinel(root) {
  // W8-10: scope must match EXTRACTION_BREAKER_SCOPE ('auto_extract') from
  // auto-learning-scopes.js, which is what post-orchestration-extract.js writes.
  // Previously this used 'extraction' — that was the mismatch being fixed.
  const { EXTRACTION_BREAKER_SCOPE } = require('../_lib/auto-learning-scopes');
  const sentPath = path.join(root, '.orchestray', 'state', `learning-breaker-${EXTRACTION_BREAKER_SCOPE}.tripped`);
  fs.writeFileSync(sentPath, JSON.stringify({ trippedAt: new Date().toISOString() }), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('status-render (auto-learning surface)', () => {
  test('global_kill_switch: true → output says "Kill switch: ON"', () => {
    // W8-04: label now describes the kill switch state directly.
    writeConfig(tmpDir, { global_kill_switch: true });
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('Kill switch: ON'), `Expected "Kill switch: ON" in: ${output}`);
    assert.ok(!output.includes('Kill switch: OFF'), `Must not say OFF when kill switch is on: ${output}`);
  });

  test('no config (kill switch off) → output says "Kill switch: OFF"', () => {
    // W8-04: kill switch is not active → "Kill switch: OFF".
    // No config file — loader returns all-off defaults with global_kill_switch: false.
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('Kill switch: OFF'), `Expected "Kill switch: OFF" when kill switch is off: ${output}`);
  });

  test('ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1 → output says "Kill switch: ON" + env tag', () => {
    // W8-04 + W8-10: env var activates the kill switch.
    process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH = '1';
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('Kill switch: ON'), `Expected "Kill switch: ON": ${output}`);
    assert.ok(output.includes('env: ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1'), `Expected env tag: ${output}`);
  });

  test('2 proposed-patterns files → output says Proposals staged: 2', () => {
    writeProposal(tmpDir, 'alpha-pattern');
    writeProposal(tmpDir, 'beta-pattern');
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('Proposals staged: 2'), `Expected 2 proposals in: ${output}`);
    assert.ok(output.includes('/orchestray:learn list --proposed'), `Expected review hint in: ${output}`);
  });

  test('tripped breaker sentinel → output says TRIPPED', () => {
    writeTripSentinel(tmpDir);
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('Circuit breaker: TRIPPED'), `Expected TRIPPED in: ${output}`);
  });

  test('no tripped sentinel → output says Circuit breaker: OK', () => {
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('Circuit breaker: OK'), `Expected OK in: ${output}`);
  });

  test('kill-switch env var not set → output says not set', () => {
    delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
    const output = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.ok(output.includes('not set'), `Expected "not set" in: ${output}`);
  });

  test('output is deterministic (no current-time drift)', () => {
    writeConfig(tmpDir, {
      global_kill_switch: false,
      extract_on_complete: { enabled: false, shadow_mode: false },
    });
    const output1 = renderAutoLearningStatus({ projectRoot: tmpDir });
    const output2 = renderAutoLearningStatus({ projectRoot: tmpDir });
    assert.equal(output1, output2, 'output must be deterministic');
  });
});
