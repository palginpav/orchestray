#!/usr/bin/env node
'use strict';

/**
 * v2318-w3-q1-compute-hint-unit.test.js — unit tests for computeHintFromPrompt
 * and isComputeFallbackDisabled (v2.3.18 W3 Q1). Complements the integration
 * coverage in v2211-w2-8-context-size-hint-required.test.js.
 *
 * Runner: node --test bin/__tests__/v2318-w3-q1-compute-hint-unit.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { computeHintFromPrompt, isComputeFallbackDisabled } = require('../preflight-spawn-budget');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('computeHintFromPrompt', () => {
  test('no delta markers → whole prompt counted conservatively as handoff', () => {
    const prompt = 'x'.repeat(400);
    const r = computeHintFromPrompt(prompt, 'nonexistent-role-xyz', REPO_ROOT);
    assert.equal(r.systemSize, 0, 'unknown role has no agent-definition file to size');
    assert.equal(r.tier2Size, 0);
    assert.equal(r.handoffSize, 100); // 400 chars / 4
  });

  test('known role → systemSize derived from agents/<role>.md file size', () => {
    const r = computeHintFromPrompt('hello', 'developer', REPO_ROOT);
    assert.ok(r.systemSize > 0, 'developer.md exists in this repo — systemSize must be > 0');
  });

  test('delta markers present → static folds into system, per-spawn is handoff, rest is tier2', () => {
    const prompt =
      '<!-- delta:static-begin -->\n' + 'S'.repeat(400) + '\n<!-- delta:static-end -->\n' +
      'T'.repeat(400) + '\n' +
      '<!-- delta:per-spawn-begin -->\n' + 'P'.repeat(400) + '\n<!-- delta:per-spawn-end -->\n';
    const r = computeHintFromPrompt(prompt, 'nonexistent-role-xyz', REPO_ROOT);
    // Capture group includes the marker's surrounding newlines (402 chars, not 400).
    assert.equal(r.systemSize, Math.ceil(402 / 4));
    assert.equal(r.handoffSize, Math.ceil(402 / 4));
    assert.ok(r.tier2Size > 0, 'the T-filler outside both marker blocks must land in tier2');
  });
});

describe('isComputeFallbackDisabled', () => {
  let tmpRoot;
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; });

  test('env kill switch takes precedence', () => {
    const prev = process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED;
    process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED = '1';
    try {
      assert.equal(isComputeFallbackDisabled('/nonexistent'), true);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED;
      else process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_COMPUTE_DISABLED = prev;
    }
  });

  test('config key context_size_hint_compute.enabled: false disables the fallback', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-q1-cfg-'));
    fs.mkdirSync(path.join(tmpRoot, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.orchestray', 'config.json'),
      JSON.stringify({ context_size_hint_compute: { enabled: false } }),
    );
    assert.equal(isComputeFallbackDisabled(tmpRoot), true);
  });

  test('fail-open: no config.json → enabled (returns false)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-q1-nocfg-'));
    assert.equal(isComputeFallbackDisabled(tmpRoot), false);
  });
});
