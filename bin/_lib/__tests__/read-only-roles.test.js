#!/usr/bin/env node
'use strict';

/**
 * Tests for read-only-roles.js (v2.3.32 W4 finding #2 reconciliation;
 * widened v2.3.31 W9 with operator sign-off).
 *
 * Coverage:
 *   - each axis's live membership matches the current gate/validator sets
 *   - axis 2 is re-exported from role-write-allowlists.js (no drift)
 *   - getRoleAxes() returns correct independent booleans per axis
 *   - isReadOnlyOnAnyAxis() is true iff at least one axis is true
 *   - W9: tester/documenter gained axis 1 (git-destructive), gated by
 *     ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED
 *   - W9: researcher/ux-critic/platform-oracle gained axis 2 (write-path),
 *     gated by ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED
 *   - W9: reviewer/debugger gained axis 4 (allowlist-verified), gated by
 *     ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../read-only-roles');
const { RESTRICTED_ROLES } = require('../role-write-allowlists');

const KILL_SWITCH_ENV_KEYS = [
  'ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED',
  'ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED',
  'ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED',
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of KILL_SWITCH_ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of KILL_SWITCH_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('read-only-roles — axis 1 (git-destructive)', () => {
  test('matches gate-developer-git.js READ_ONLY_ROLES, including W9 tester/documenter', () => {
    const expected = [
      'reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent',
      'tester', 'documenter',
    ];
    assert.equal(mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.size, expected.length);
    for (const r of expected) assert.ok(mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.has(r), r);
  });

  test('developer is not git-destructive-blocked', () => {
    assert.ok(!mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.has('developer'));
  });

  test('isGitDestructiveBlocked(): tester/documenter blocked by default', () => {
    assert.equal(mod.isGitDestructiveBlocked('tester'), true);
    assert.equal(mod.isGitDestructiveBlocked('documenter'), true);
  });

  test('isGitDestructiveBlocked(): pre-W9 roles unaffected by the W9 kill switch', () => {
    process.env.ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED = '1';
    assert.equal(mod.isGitDestructiveBlocked('reviewer'), true);
    assert.equal(mod.isGitDestructiveBlocked('debugger'), true);
  });

  test('kill switch ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED=1 restores pre-W9 behaviour', () => {
    process.env.ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED = '1';
    assert.equal(mod.isGitDestructiveBlocked('tester'), false);
    assert.equal(mod.isGitDestructiveBlocked('documenter'), false);
    assert.equal(mod.isTesterDocumenterGitBlockEnabled(), false);
  });

  test('unaffected roles ignore the kill switch entirely', () => {
    process.env.ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED = '1';
    assert.equal(mod.isGitDestructiveBlocked('developer'), false);
    assert.equal(mod.isGitDestructiveBlocked('not-a-real-role'), false);
  });
});

describe('read-only-roles — axis 2 (write-path restriction)', () => {
  test('is the SAME Set object re-exported from role-write-allowlists (no copy, no drift)', () => {
    assert.strictEqual(mod.WRITE_PATH_RESTRICTED_ROLES, RESTRICTED_ROLES);
  });

  test('includes release-manager and W9 researcher/ux-critic/platform-oracle (live set is 8 roles)', () => {
    assert.ok(mod.WRITE_PATH_RESTRICTED_ROLES.has('release-manager'));
    assert.ok(mod.WRITE_PATH_RESTRICTED_ROLES.has('researcher'));
    assert.ok(mod.WRITE_PATH_RESTRICTED_ROLES.has('ux-critic'));
    assert.ok(mod.WRITE_PATH_RESTRICTED_ROLES.has('platform-oracle'));
    assert.equal(mod.WRITE_PATH_RESTRICTED_ROLES.size, 8);
  });

  test('isWriteRestricted(): W9 roles restricted by default, kill switch restores unrestricted', () => {
    assert.equal(mod.isWriteRestricted('researcher'), true);
    process.env.ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED = '1';
    assert.equal(mod.isWriteRestricted('researcher'), false);
    assert.equal(mod.isWriteRestricted('ux-critic'), false);
    assert.equal(mod.isWriteRestricted('platform-oracle'), false);
  });

  test('kill switch does not affect pre-W9 restricted roles', () => {
    process.env.ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED = '1';
    assert.equal(mod.isWriteRestricted('reviewer'), true);
    assert.equal(mod.isWriteRestricted('tester'), true);
  });
});

describe('read-only-roles — axis 3 (runtime tool verification)', () => {
  test('matches validate-task-completion.js READ_ONLY_AGENTS', () => {
    const expected = ['haiku-scout', 'orchestray-housekeeper', 'project-intent'];
    assert.equal(mod.RUNTIME_TOOL_VERIFIED_ROLES.size, expected.length);
    for (const r of expected) assert.ok(mod.RUNTIME_TOOL_VERIFIED_ROLES.has(r), r);
  });

  test('reviewer and debugger are NOT runtime-verified (axis 3 expects zero writes; they write KB artifacts)', () => {
    assert.ok(!mod.RUNTIME_TOOL_VERIFIED_ROLES.has('reviewer'));
    assert.ok(!mod.RUNTIME_TOOL_VERIFIED_ROLES.has('debugger'));
  });
});

describe('read-only-roles — axis 4 (allowlist-scoped write verification, W9)', () => {
  test('reviewer and debugger are allowlist-verified', () => {
    assert.equal(mod.ALLOWLIST_VERIFIED_ROLES.size, 2);
    assert.ok(mod.ALLOWLIST_VERIFIED_ROLES.has('reviewer'));
    assert.ok(mod.ALLOWLIST_VERIFIED_ROLES.has('debugger'));
  });

  test('isAllowlistVerified(): true by default for reviewer/debugger, false for others', () => {
    assert.equal(mod.isAllowlistVerified('reviewer'), true);
    assert.equal(mod.isAllowlistVerified('debugger'), true);
    assert.equal(mod.isAllowlistVerified('tester'), false);
    assert.equal(mod.isAllowlistVerified('developer'), false);
  });

  test('kill switch ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED=1 disables the axis', () => {
    process.env.ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED = '1';
    assert.equal(mod.isAllowlistVerified('reviewer'), false);
    assert.equal(mod.isAllowlistVerified('debugger'), false);
    assert.equal(mod.isAllowlistVerifiedGateEnabled(), false);
  });
});

describe('read-only-roles — getRoleAxes()', () => {
  test('debugger: git-blocked + write-restricted + allowlist-verified, not runtime-verified', () => {
    const axes = mod.getRoleAxes('debugger');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: true,
      runtimeToolVerified: false,
      allowlistVerified: true,
    });
  });

  test('tester: git-blocked (W9) + write-restricted', () => {
    const axes = mod.getRoleAxes('tester');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: true,
      runtimeToolVerified: false,
      allowlistVerified: false,
    });
  });

  test('researcher: git-blocked + write-restricted (W9 closed the gap)', () => {
    const axes = mod.getRoleAxes('researcher');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: true,
      runtimeToolVerified: false,
      allowlistVerified: false,
    });
  });

  test('haiku-scout: runtime-verified only', () => {
    const axes = mod.getRoleAxes('haiku-scout');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: true,
      allowlistVerified: false,
    });
  });

  test('project-intent: git-blocked + runtime-verified, no write-path restriction (Read-only tools)', () => {
    const axes = mod.getRoleAxes('project-intent');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: false,
      runtimeToolVerified: true,
      allowlistVerified: false,
    });
  });

  test('developer: zero axes', () => {
    const axes = mod.getRoleAxes('developer');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: false,
      allowlistVerified: false,
    });
  });

  test('unknown role: zero axes, no throw', () => {
    const axes = mod.getRoleAxes('not-a-real-role');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: false,
      allowlistVerified: false,
    });
  });

  test('handles null/undefined role without throwing, and returns all-false axes', () => {
    const axesUndef = mod.getRoleAxes(undefined);
    assert.deepEqual(axesUndef, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: false,
      allowlistVerified: false,
    });
    const axesNull = mod.getRoleAxes(null);
    assert.deepEqual(axesNull, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: false,
      allowlistVerified: false,
    });
  });
});

describe('read-only-roles — isReadOnlyOnAnyAxis()', () => {
  test('true for a role on any single axis', () => {
    assert.ok(mod.isReadOnlyOnAnyAxis('tester'));
    assert.ok(mod.isReadOnlyOnAnyAxis('researcher'));
    assert.ok(mod.isReadOnlyOnAnyAxis('haiku-scout'));
    assert.ok(mod.isReadOnlyOnAnyAxis('reviewer'));
  });

  test('false for a role on zero axes', () => {
    assert.ok(!mod.isReadOnlyOnAnyAxis('developer'));
    assert.ok(!mod.isReadOnlyOnAnyAxis('architect'));
    assert.ok(!mod.isReadOnlyOnAnyAxis('inventor'));
  });
});
