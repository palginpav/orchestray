'use strict';

// Contract tests for isExperimentActive — T-F2 (v2.0.17 Phase 4 reviewer warning #2).
//
// Key invariant: cfg must be the ROOT config object (containing v2017_experiments),
// NOT the experiments block itself. Passing the block directly silently returns false
// (documented footgun — the JSDoc warns against it).

const test = require('node:test');
const assert = require('node:assert');

const { isExperimentActive } = require('../bin/_lib/config-schema');

// ---------------------------------------------------------------------------
// Happy path — full root config
// ---------------------------------------------------------------------------

test('full root config with flag "on" → true', () => {
  const cfg = { v2017_experiments: { prompt_caching: 'on' } };
  assert.strictEqual(isExperimentActive(cfg, 'prompt_caching'), true);
});

// ---------------------------------------------------------------------------
// Documented footgun — passing experiments block directly
// ---------------------------------------------------------------------------

test('experiments block passed directly (missing v2017_experiments wrapper) → false (footgun)', () => {
  // This is the exact footgun the JSDoc warns against.
  // { prompt_caching: 'on' } has no .v2017_experiments key, so the function
  // returns false even though the caller "has" the flag set.
  const experimentsBlock = { prompt_caching: 'on' };
  assert.strictEqual(isExperimentActive(experimentsBlock, 'prompt_caching'), false);
});

// ---------------------------------------------------------------------------
// global_kill_switch overrides any 'on' flag
// ---------------------------------------------------------------------------

test('global_kill_switch=true overrides an "on" flag → false', () => {
  const cfg = {
    v2017_experiments: {
      global_kill_switch: true,
      prompt_caching: 'on',
      adaptive_verbosity: 'on',
    },
  };
  assert.strictEqual(isExperimentActive(cfg, 'prompt_caching'), false);
  assert.strictEqual(isExperimentActive(cfg, 'adaptive_verbosity'), false);
});

test('global_kill_switch=false does not suppress "on" flags', () => {
  const cfg = {
    v2017_experiments: {
      global_kill_switch: false,
      prompt_caching: 'on',
    },
  };
  assert.strictEqual(isExperimentActive(cfg, 'prompt_caching'), true);
});

// ---------------------------------------------------------------------------
// 'shadow' state is measurement-only, not behavior-active
// ---------------------------------------------------------------------------

test('"shadow" state returns false (measurement-only, not behavior-active)', () => {
  const cfg = { v2017_experiments: { pm_prose_strip: 'shadow' } };
  assert.strictEqual(isExperimentActive(cfg, 'pm_prose_strip'), false);
});

// ---------------------------------------------------------------------------
// 'off' and unknown flags
// ---------------------------------------------------------------------------

test('"off" state returns false', () => {
  const cfg = { v2017_experiments: { prompt_caching: 'off' } };
  assert.strictEqual(isExperimentActive(cfg, 'prompt_caching'), false);
});

test('unknown flag (key absent from experiments block) → false', () => {
  const cfg = { v2017_experiments: { prompt_caching: 'on' } };
  assert.strictEqual(isExperimentActive(cfg, 'nonexistent_flag'), false);
});

// ---------------------------------------------------------------------------
// Missing / null / undefined cfg — fail-open (no throw)
// ---------------------------------------------------------------------------

test('missing v2017_experiments key in root config → false', () => {
  const cfg = { mcp_enforcement: {} };
  assert.strictEqual(isExperimentActive(cfg, 'prompt_caching'), false);
});

test('cfg === null → false (no throw)', () => {
  assert.strictEqual(isExperimentActive(null, 'prompt_caching'), false);
});

test('cfg === undefined → false (no throw)', () => {
  assert.strictEqual(isExperimentActive(undefined, 'prompt_caching'), false);
});
