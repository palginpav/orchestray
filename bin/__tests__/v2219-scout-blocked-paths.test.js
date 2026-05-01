'use strict';

/**
 * v2219-scout-blocked-paths.test.js — T10/S1 narrowed scout_blocked_paths defaults.
 *
 * Verifies that the new DEFAULTS no longer block agents/** and bin/**,
 * and that the narrowed set (volatile state + build trees + recursion guard)
 * blocks exactly what it should.
 *
 * 6 cases as specified in the T10 brief.
 *
 * Runner: node --test bin/__tests__/v2219-scout-blocked-paths.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { shouldSpawnScout, DEFAULTS } = require('../_lib/_haiku-routing-rule');

// Minimal config that uses the new narrowed defaults (no scout_blocked_paths override)
const configWithDefaults = {
  haiku_routing: {
    enabled: true,
    scout_min_bytes: 12288,
    scout_blocked_ops: ['Edit', 'Write', 'Bash'],
    // scout_blocked_paths omitted → resolves to DEFAULTS
  },
};

const LARGE = 50_000; // well above 12 288 threshold

describe('T10/S1 — narrowed scout_blocked_paths defaults', () => {

  // Case 1: agents/pm.md is large and class B → should be SCOUTABLE (was blocked before)
  test('agents/pm.md large Read is now scout-eligible (was blocked by old agents/**)', () => {
    const decision = shouldSpawnScout({
      config: configWithDefaults,
      env: {},
      args: { op_kind: 'Read', target_path: 'agents/pm.md', target_bytes: LARGE, class_hint: 'B' },
    });
    assert.equal(decision, true, 'agents/pm.md should now route to scout');
  });

  // Case 2: bin/inject-archetype-advisory.js is large class B → should be SCOUTABLE
  test('bin/inject-archetype-advisory.js large Read is now scout-eligible (was blocked by old bin/**)', () => {
    const decision = shouldSpawnScout({
      config: configWithDefaults,
      env: {},
      args: { op_kind: 'Read', target_path: 'bin/inject-archetype-advisory.js', target_bytes: LARGE, class_hint: 'B' },
    });
    assert.equal(decision, true, 'bin/*.js should now route to scout');
  });

  // Case 3: .orchestray/state/orchestration.md → still blocked (volatile state)
  test('.orchestray/state/* is still blocked', () => {
    const decision = shouldSpawnScout({
      config: configWithDefaults,
      env: {},
      args: { op_kind: 'Read', target_path: '.orchestray/state/orchestration.md', target_bytes: LARGE, class_hint: 'B' },
    });
    assert.equal(decision, false, '.orchestray/state/* must remain blocked');
  });

  // Case 4: .orchestray/audit/events.jsonl → blocked by new .orchestray/audit/*
  test('.orchestray/audit/* is blocked (new addition)', () => {
    const decision = shouldSpawnScout({
      config: configWithDefaults,
      env: {},
      args: { op_kind: 'Read', target_path: '.orchestray/audit/events.jsonl', target_bytes: LARGE, class_hint: 'B' },
    });
    assert.equal(decision, false, '.orchestray/audit/* must be blocked');
  });

  // Case 5: bin/_lib/_haiku-routing-rule.js → blocked (recursion guard)
  test('bin/_lib/_haiku-routing-rule.js is blocked (recursion guard)', () => {
    const decision = shouldSpawnScout({
      config: configWithDefaults,
      env: {},
      args: { op_kind: 'Read', target_path: 'bin/_lib/_haiku-routing-rule.js', target_bytes: LARGE, class_hint: 'B' },
    });
    assert.equal(decision, false, '_haiku-routing-rule.js must be blocked to prevent recursion');
  });

  // Case 6: node_modules/lodash/lodash.js → blocked by node_modules/**
  test('node_modules/** is blocked', () => {
    const decision = shouldSpawnScout({
      config: configWithDefaults,
      env: {},
      args: { op_kind: 'Read', target_path: 'node_modules/lodash/lodash.js', target_bytes: LARGE, class_hint: 'B' },
    });
    assert.equal(decision, false, 'node_modules/** must be blocked');
  });

});

// Verify the DEFAULTS export itself has the narrowed list
describe('T10/S1 — DEFAULTS export shape', () => {
  test('DEFAULTS.scout_blocked_paths does not contain agents/** or bin/**', () => {
    assert.ok(!DEFAULTS.scout_blocked_paths.includes('agents/**'), 'agents/** should not be in defaults');
    assert.ok(!DEFAULTS.scout_blocked_paths.includes('bin/**'), 'bin/** should not be in defaults');
  });

  test('DEFAULTS.scout_blocked_paths contains all four narrowed entries', () => {
    assert.ok(DEFAULTS.scout_blocked_paths.includes('.orchestray/state/*'));
    assert.ok(DEFAULTS.scout_blocked_paths.includes('.orchestray/audit/*'));
    assert.ok(DEFAULTS.scout_blocked_paths.includes('bin/_lib/_haiku-routing-rule.js'));
    assert.ok(DEFAULTS.scout_blocked_paths.includes('node_modules/**'));
  });
});
