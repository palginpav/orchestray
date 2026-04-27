#!/usr/bin/env node
'use strict';

/**
 * p22-scout-decision-rule.test.js — P2.2 Section 23 inline-vs-scout rule.
 *
 * Verifies the pure helper at `bin/_lib/_haiku-routing-rule.js`:
 *   1. Class-B + over-threshold + non-blocked path/op → spawn.
 *   2. Below-threshold short-circuits inline.
 *   3. Class-A always inline (regardless of bytes).
 *   4. Blocked path short-circuits inline.
 *   5. Edit/Bash/Write blocked-op short-circuits inline.
 *   6. ORCHESTRAY_HAIKU_ROUTING_DISABLED=1 env override short-circuits inline.
 *
 * Runner: node --test bin/__tests__/p22-scout-decision-rule.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { shouldSpawnScout } = require('../_lib/_haiku-routing-rule');

const baseConfig = {
  haiku_routing: {
    enabled: true,
    scout_min_bytes: 12288,
    scout_blocked_ops: ['Edit', 'Write', 'Bash'],
    scout_blocked_paths: ['.orchestray/state/*', 'agents/**', 'bin/**'],
  },
};

describe('P2.2 — Section 23 inline-vs-scout decision rule', () => {

  test('Class B Read of 20000-byte /tmp file → spawn', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'B' },
    });
    assert.equal(decision, true);
  });

  test('Class B Read of 10000 bytes → inline (below scout_min_bytes)', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 10000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('Class A always inline regardless of bytes', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'A' },
    });
    assert.equal(decision, false);
  });

  test('blocked path .orchestray/state/* short-circuits inline', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/repo/.orchestray/state/orchestration.md', target_bytes: 20000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('Edit op blocked even with massive target_bytes', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Edit', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('Bash op blocked', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Bash', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('ORCHESTRAY_HAIKU_ROUTING_DISABLED=1 forces inline', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: { ORCHESTRAY_HAIKU_ROUTING_DISABLED: '1' },
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('haiku_routing.enabled=false forces inline (config-level kill)', () => {
    const offConfig = {
      haiku_routing: Object.assign({}, baseConfig.haiku_routing, { enabled: false }),
    };
    const decision = shouldSpawnScout({
      config: offConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('agents/** glob blocks /home/palgin/orchestray/agents/pm.md', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/home/palgin/orchestray/agents/pm.md', target_bytes: 80000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('bin/** glob blocks /home/palgin/orchestray/bin/foo.js', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/home/palgin/orchestray/bin/foo.js', target_bytes: 80000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('Glob op on non-blocked path → spawn (size gate not applicable)', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Glob', target_path: '/tmp/some-tree', target_bytes: 99999999, class_hint: 'B' },
    });
    assert.equal(decision, true);
  });

  test('null class_hint → fail-safe inline', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: null },
    });
    assert.equal(decision, false);
  });

  test('Class D always inline (existing subagent flow)', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: { op_kind: 'Read', target_path: '/tmp/x.md', target_bytes: 20000, class_hint: 'D' },
    });
    assert.equal(decision, false);
  });

  // S-002 (v2.2.0 fix-pass): the routing rule must normalize paths via
  // path.resolve before glob-matching so symlink alias / relative-segment
  // bypasses cannot reach a path the operator marked PM-only (CWE-22).
  test('S-002: path with `..` segment resolves and still hits agents/** block', () => {
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      // The literal string traverses up and back into agents/. Without
      // path.resolve normalization the suffix-match could miss this.
      args: {
        op_kind: 'Read',
        target_path: '/home/palgin/orchestray/bin/../agents/pm.md',
        target_bytes: 80000,
        class_hint: 'B',
      },
    });
    assert.equal(decision, false,
      'path.resolve should normalize ".." segments before glob-matching ' +
      'so PM-only paths cannot be bypassed via relative traversal');
  });

  test('S-002: relative agents/foo.md path still blocked (rule keeps suffix-match path)', () => {
    // Backward-compat: callers that pass already-relative target_path
    // (test fixtures, some PM-internal probes) should still match.
    const decision = shouldSpawnScout({
      config: baseConfig,
      env: {},
      args: {
        op_kind: 'Read',
        target_path: 'agents/pm.md',
        target_bytes: 80000,
        class_hint: 'B',
      },
    });
    assert.equal(decision, false,
      'relative target_path strings must still match scout_blocked_paths');
  });

});
