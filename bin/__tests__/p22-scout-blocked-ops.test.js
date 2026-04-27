#!/usr/bin/env node
'use strict';

/**
 * p22-scout-blocked-ops.test.js — P2.2 Edit/Write/Bash always blocked.
 *
 * The "writes never delegate" guard rail: even if target_bytes is enormous,
 * an Edit/Write/Bash op cannot be performed by the read-only scout. These
 * three rows pin the ops are ALWAYS rejected regardless of size or class.
 *
 * Runner: node --test bin/__tests__/p22-scout-blocked-ops.test.js
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

describe('P2.2 — Edit/Write/Bash always blocked regardless of bytes', () => {

  test('Edit on 1 MB target → inline', () => {
    const decision = shouldSpawnScout({
      config,
      env: {},
      args: { op_kind: 'Edit', target_path: '/tmp/huge.md', target_bytes: 1_000_000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('Write on 1 MB target → inline', () => {
    const decision = shouldSpawnScout({
      config,
      env: {},
      args: { op_kind: 'Write', target_path: '/tmp/huge.md', target_bytes: 1_000_000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

  test('Bash on 1 MB target → inline', () => {
    const decision = shouldSpawnScout({
      config,
      env: {},
      args: { op_kind: 'Bash', target_path: '/tmp/huge.md', target_bytes: 1_000_000, class_hint: 'B' },
    });
    assert.equal(decision, false);
  });

});
