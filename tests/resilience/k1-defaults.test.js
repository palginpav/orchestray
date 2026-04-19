#!/usr/bin/env node
'use strict';

/**
 * K1 arbitration test — resilience ships LIVE by default (v2.1.7 Bundle D).
 *
 * This is the most important assertion in the suite. K1 (see
 * .orchestray/kb/decisions/v217-arbitration.md) is a binding commitment that
 * v2.1.7 installs receive `resilience.enabled: true` and
 * `resilience.shadow_mode: false` with no config intervention.
 *
 * If this test ever fails, the release-manager's README sweep is wrong.
 * Read the arbitration doc before "fixing" this test.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_RESILIENCE,
  loadResilienceConfig,
  validateResilienceConfig,
} = require('../../bin/_lib/config-schema');

describe('K1 (BINDING): resilience ships LIVE by default', () => {
  test('DEFAULT_RESILIENCE.enabled === true', () => {
    assert.equal(DEFAULT_RESILIENCE.enabled, true,
      'K1 violation: resilience MUST be enabled by default on v2.1.7+');
  });

  test('DEFAULT_RESILIENCE.shadow_mode === false', () => {
    assert.equal(DEFAULT_RESILIENCE.shadow_mode, false,
      'K1 violation: resilience MUST NOT ship in shadow mode on v2.1.7+');
  });

  test('DEFAULT_RESILIENCE.kill_switch === false', () => {
    assert.equal(DEFAULT_RESILIENCE.kill_switch, false);
  });

  test('loadResilienceConfig returns live defaults when no config file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-'));
    const cfg = loadResilienceConfig(dir);
    assert.equal(cfg.enabled, true,
      'fresh-install default MUST be enabled:true');
    assert.equal(cfg.shadow_mode, false,
      'fresh-install default MUST be shadow_mode:false');
  });

  test('loadResilienceConfig returns live defaults when config file is malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-'));
    fs.mkdirSync(path.join(dir, '.orchestray'));
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), '{not-json');
    const cfg = loadResilienceConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.shadow_mode, false);
  });

  test('loadResilienceConfig returns live defaults when resilience block absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-'));
    fs.mkdirSync(path.join(dir, '.orchestray'));
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({
      complexity_threshold: 5,
    }));
    const cfg = loadResilienceConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.shadow_mode, false);
  });

  test('operator can OPT INTO shadow mode via config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-'));
    fs.mkdirSync(path.join(dir, '.orchestray'));
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({
      resilience: { shadow_mode: true },
    }));
    const cfg = loadResilienceConfig(dir);
    assert.equal(cfg.shadow_mode, true, 'shadow_mode opt-in should be honored');
    assert.equal(cfg.enabled, true, 'opt-in shadow does not disable');
  });

  test('env var ORCHESTRAY_RESILIENCE_DISABLED=1 disables regardless of config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-'));
    fs.mkdirSync(path.join(dir, '.orchestray'));
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({
      resilience: { enabled: true, shadow_mode: false },
    }));
    const prior = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
    try {
      const cfg = loadResilienceConfig(dir);
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.kill_switch, true);
    } finally {
      if (prior === undefined) delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      else process.env.ORCHESTRAY_RESILIENCE_DISABLED = prior;
    }
  });
});

describe('validateResilienceConfig — range checks', () => {
  test('accepts defaults', () => {
    const r = validateResilienceConfig(DEFAULT_RESILIENCE);
    assert.ok(r.valid);
  });
  test('rejects non-object', () => {
    const r = validateResilienceConfig('nope');
    assert.equal(r.valid, false);
  });
  test('rejects inject_max_bytes below 512', () => {
    const r = validateResilienceConfig({ inject_max_bytes: 10 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('inject_max_bytes')));
  });
  test('rejects max_inject_turns out of range', () => {
    const r = validateResilienceConfig({ max_inject_turns: 99 });
    assert.equal(r.valid, false);
  });
  test('rejects wrong-type enabled', () => {
    const r = validateResilienceConfig({ enabled: 'yes' });
    assert.equal(r.valid, false);
  });
});
