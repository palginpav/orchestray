#!/usr/bin/env node
'use strict';

/**
 * p22-scout-min-bytes.test.js — P2.2 scout_min_bytes boundary.
 *
 * Verifies the inclusive lower-bound semantics of `scout_min_bytes`:
 *   - target_bytes = 12287 → inline (one byte below)
 *   - target_bytes = 12288 → spawn (boundary; >=, not >)
 *   - target_bytes = 12289 → spawn (one byte above)
 *
 * Rule pseudocode in pm.md §23 uses `target_bytes < scout_min_bytes` →
 * False, hence at exactly the threshold the rule continues and returns
 * True. These tests pin that semantics so a future "exclusive" misread
 * trips CI.
 *
 * Runner: node --test bin/__tests__/p22-scout-min-bytes.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { shouldSpawnScout } = require('../_lib/_haiku-routing-rule');

const config = {
  haiku_routing: {
    enabled: true,
    scout_min_bytes: 12288,
    scout_blocked_ops: ['Edit', 'Write', 'Bash'],
    scout_blocked_paths: ['.orchestray/state/*', 'agents/**', 'bin/**'],
  },
};

describe('P2.2 — scout_min_bytes boundary', () => {

  test('target_bytes 12287 (one byte below threshold) → inline', () => {
    const decision = shouldSpawnScout({
      config,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 12287, class_hint: 'B' },
    });
    assert.equal(decision, false, 'Below threshold must short-circuit inline');
  });

  test('target_bytes 12288 (exact threshold) → spawn (inclusive lower bound)', () => {
    const decision = shouldSpawnScout({
      config,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 12288, class_hint: 'B' },
    });
    assert.equal(decision, true, 'Exact threshold must spawn (>=, not >)');
  });

  test('target_bytes 12289 (one byte above threshold) → spawn', () => {
    const decision = shouldSpawnScout({
      config,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 12289, class_hint: 'B' },
    });
    assert.equal(decision, true);
  });

});
