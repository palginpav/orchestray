#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/learn-commands/patterns-render.js (v2.1.6 — CHG-F02).
 *
 * Runner: node --test bin/__tests__/patterns-render.test.js
 *
 * Coverage (per CHG-F02 fix requirements):
 *   1. Kill switch OFF (default) → banner shows "Kill switch: OFF"
 *   2. Kill switch ON via env var → banner shows "Kill switch: ON (env var)" text
 *   3. Kill switch ON via config → banner shows "Kill switch: ON (config)" text
 *   4. Kill switch framing consistency — same switch description as status-render.js
 *   5. Banner includes circuit-breaker state field
 *   6. Banner includes proposal count
 *   7. Banner includes calibration suggestion count
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { renderPatternsBanner } = require('../learn-commands/patterns-render');
const { renderAutoLearningStatus } = require('../learn-commands/status-render');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterns-render-test-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'),            { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'proposed-patterns'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'kb', 'artifacts'),  { recursive: true });
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

function writeCalibrationSuggestion(root, suffix) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'artifacts', `calibration-suggestion-${suffix}.md`),
    '---\nslug: calib\n---\n',
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('patterns-render (kill-switch banner — CHG-F02)', () => {
  test('kill switch OFF → banner shows "Kill switch: OFF"', () => {
    writeConfig(tmpDir, { global_kill_switch: false });
    const output = renderPatternsBanner({ projectRoot: tmpDir });
    assert.ok(
      output.includes('Kill switch: OFF'),
      `Expected "Kill switch: OFF" in output, got:\n${output}`
    );
    // Must NOT use old "Auto-learning: ON" framing.
    assert.ok(
      !output.includes('Auto-learning: ON'),
      `Old "Auto-learning: ON" framing must not appear in output:\n${output}`
    );
  });

  test('kill switch ON via env var → banner shows "Kill switch: ON" and env tag', () => {
    process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH = '1';
    writeConfig(tmpDir, { global_kill_switch: false });
    const output = renderPatternsBanner({ projectRoot: tmpDir });
    assert.ok(
      output.includes('Kill switch: ON'),
      `Expected "Kill switch: ON" in output, got:\n${output}`
    );
    assert.ok(
      output.includes('env'),
      `Expected env tag in output, got:\n${output}`
    );
    // Must NOT use old "Auto-learning: OFF" framing.
    assert.ok(
      !output.includes('Auto-learning: OFF'),
      `Old "Auto-learning: OFF" framing must not appear in output:\n${output}`
    );
  });

  test('kill switch ON via config → banner shows "Kill switch: ON" and "(config)"', () => {
    writeConfig(tmpDir, { global_kill_switch: true });
    const output = renderPatternsBanner({ projectRoot: tmpDir });
    assert.ok(
      output.includes('Kill switch: ON'),
      `Expected "Kill switch: ON" in output, got:\n${output}`
    );
    assert.ok(
      output.includes('(config)'),
      `Expected "(config)" tag in output, got:\n${output}`
    );
  });

  test('kill switch label consistency — patterns-render and status-render use same framing', () => {
    // Both surfaces should use "Kill switch: ON" when the switch is on via config.
    writeConfig(tmpDir, { global_kill_switch: true });

    const patternsBanner = renderPatternsBanner({ projectRoot: tmpDir });
    const statusBlock    = renderAutoLearningStatus({ projectRoot: tmpDir });

    // Both should contain "Kill switch: ON"
    assert.ok(
      patternsBanner.includes('Kill switch: ON'),
      `patterns-render must use "Kill switch: ON" framing:\n${patternsBanner}`
    );
    assert.ok(
      statusBlock.includes('Kill switch: ON'),
      `status-render must use "Kill switch: ON" framing:\n${statusBlock}`
    );

    // Kill switch OFF consistency
    writeConfig(tmpDir, { global_kill_switch: false });
    const patternsBannerOff = renderPatternsBanner({ projectRoot: tmpDir });
    const statusBlockOff    = renderAutoLearningStatus({ projectRoot: tmpDir });

    assert.ok(
      patternsBannerOff.includes('Kill switch: OFF'),
      `patterns-render must use "Kill switch: OFF" framing:\n${patternsBannerOff}`
    );
    assert.ok(
      statusBlockOff.includes('Kill switch: OFF'),
      `status-render must use "Kill switch: OFF" framing:\n${statusBlockOff}`
    );
  });
});

describe('patterns-render (banner sub-features)', () => {
  test('circuit-breaker state field present in banner', () => {
    writeConfig(tmpDir, { global_kill_switch: false });
    const output = renderPatternsBanner({ projectRoot: tmpDir });
    assert.ok(
      output.includes('Circuit breaker:'),
      `Expected "Circuit breaker:" label in banner:\n${output}`
    );
    assert.ok(
      output.includes('OK'),
      `Expected "OK" breaker state in banner (no sentinel written):\n${output}`
    );
  });

  test('proposal count reflected in banner', () => {
    writeConfig(tmpDir, { global_kill_switch: false });
    writeProposal(tmpDir, 'test-proposal-a');
    writeProposal(tmpDir, 'test-proposal-b');
    const output = renderPatternsBanner({ projectRoot: tmpDir });
    assert.ok(
      output.includes('Proposals staged: 2'),
      `Expected "Proposals staged: 2" in banner:\n${output}`
    );
  });

  test('calibration suggestion count reflected in banner', () => {
    writeConfig(tmpDir, { global_kill_switch: false });
    writeCalibrationSuggestion(tmpDir, '2026-04-19T00-00-00Z');
    const output = renderPatternsBanner({ projectRoot: tmpDir });
    assert.ok(
      output.includes('Pending calibration suggestions: 1'),
      `Expected "Pending calibration suggestions: 1" in banner:\n${output}`
    );
  });
});
