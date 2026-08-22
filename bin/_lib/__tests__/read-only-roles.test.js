#!/usr/bin/env node
'use strict';

/**
 * Tests for read-only-roles.js (v2.3.32 W4 finding #2 reconciliation).
 *
 * Coverage:
 *   - each axis's live membership matches the current gate/validator sets
 *   - axis 2 is re-exported from role-write-allowlists.js (no drift)
 *   - getRoleAxes() returns correct independent booleans per axis
 *   - isReadOnlyOnAnyAxis() is true iff at least one axis is true
 *   - the write-unrestricted gap set excludes project-intent (Read-only tools)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../read-only-roles');
const { RESTRICTED_ROLES } = require('../role-write-allowlists');

describe('read-only-roles — axis 1 (git-destructive)', () => {
  test('matches gate-developer-git.js READ_ONLY_ROLES', () => {
    const expected = ['reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent'];
    assert.equal(mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.size, expected.length);
    for (const r of expected) assert.ok(mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.has(r), r);
  });

  test('developer and tester are not git-destructive-blocked', () => {
    assert.ok(!mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.has('developer'));
    assert.ok(!mod.GIT_DESTRUCTIVE_BLOCKED_ROLES.has('tester'));
  });
});

describe('read-only-roles — axis 2 (write-path restriction)', () => {
  test('is the SAME Set object re-exported from role-write-allowlists (no copy, no drift)', () => {
    assert.strictEqual(mod.WRITE_PATH_RESTRICTED_ROLES, RESTRICTED_ROLES);
  });

  test('includes release-manager (live set is 5 roles, not the 4 the v2.3.31 audit read)', () => {
    assert.ok(mod.WRITE_PATH_RESTRICTED_ROLES.has('release-manager'));
    assert.equal(mod.WRITE_PATH_RESTRICTED_ROLES.size, 5);
  });
});

describe('read-only-roles — axis 3 (runtime tool verification)', () => {
  test('matches validate-task-completion.js READ_ONLY_AGENTS', () => {
    const expected = ['haiku-scout', 'orchestray-housekeeper', 'project-intent'];
    assert.equal(mod.RUNTIME_TOOL_VERIFIED_ROLES.size, expected.length);
    for (const r of expected) assert.ok(mod.RUNTIME_TOOL_VERIFIED_ROLES.has(r), r);
  });

  test('reviewer and debugger are NOT runtime-verified despite prose read-only claims', () => {
    assert.ok(!mod.RUNTIME_TOOL_VERIFIED_ROLES.has('reviewer'));
    assert.ok(!mod.RUNTIME_TOOL_VERIFIED_ROLES.has('debugger'));
  });
});

describe('read-only-roles — write-unrestricted gap set', () => {
  test('flags researcher, ux-critic, platform-oracle', () => {
    assert.ok(mod.GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES.has('researcher'));
    assert.ok(mod.GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES.has('ux-critic'));
    assert.ok(mod.GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES.has('platform-oracle'));
  });

  test('excludes project-intent (frontmatter grants Read only, no Write tool)', () => {
    assert.ok(!mod.GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES.has('project-intent'));
  });
});

describe('read-only-roles — getRoleAxes()', () => {
  test('debugger: git-blocked + write-restricted, not runtime-verified', () => {
    const axes = mod.getRoleAxes('debugger');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: true,
      runtimeToolVerified: false,
      writeUnrestrictedGap: false,
    });
  });

  test('tester: write-restricted only', () => {
    const axes = mod.getRoleAxes('tester');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: true,
      runtimeToolVerified: false,
      writeUnrestrictedGap: false,
    });
  });

  test('researcher: git-blocked + write-unrestricted gap, no allowlist', () => {
    const axes = mod.getRoleAxes('researcher');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: false,
      runtimeToolVerified: false,
      writeUnrestrictedGap: true,
    });
  });

  test('haiku-scout: runtime-verified only', () => {
    const axes = mod.getRoleAxes('haiku-scout');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: true,
      writeUnrestrictedGap: false,
    });
  });

  test('project-intent: git-blocked + runtime-verified, no write gap', () => {
    const axes = mod.getRoleAxes('project-intent');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: true,
      writePathRestricted: false,
      runtimeToolVerified: true,
      writeUnrestrictedGap: false,
    });
  });

  test('developer: zero axes', () => {
    const axes = mod.getRoleAxes('developer');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: false,
      writeUnrestrictedGap: false,
    });
  });

  test('unknown role: zero axes, no throw', () => {
    const axes = mod.getRoleAxes('not-a-real-role');
    assert.deepEqual(axes, {
      gitDestructiveBlocked: false,
      writePathRestricted: false,
      runtimeToolVerified: false,
      writeUnrestrictedGap: false,
    });
  });

  test('handles null/undefined role without throwing', () => {
    assert.doesNotThrow(() => mod.getRoleAxes(undefined));
    assert.doesNotThrow(() => mod.getRoleAxes(null));
  });
});

describe('read-only-roles — isReadOnlyOnAnyAxis()', () => {
  test('true for a role on any single axis', () => {
    assert.ok(mod.isReadOnlyOnAnyAxis('tester'));
    assert.ok(mod.isReadOnlyOnAnyAxis('researcher'));
    assert.ok(mod.isReadOnlyOnAnyAxis('haiku-scout'));
  });

  test('false for a role on zero axes', () => {
    assert.ok(!mod.isReadOnlyOnAnyAxis('developer'));
    assert.ok(!mod.isReadOnlyOnAnyAxis('architect'));
    assert.ok(!mod.isReadOnlyOnAnyAxis('inventor'));
  });
});
