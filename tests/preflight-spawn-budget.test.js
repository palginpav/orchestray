#!/usr/bin/env node
'use strict';

/**
 * preflight-spawn-budget.test.js — R-BUDGET-WIRE tests (v2.1.16, W8).
 *
 * Verifies the live-file overlay added by R-BUDGET-WIRE:
 *   1. loadLiveRoleBudgets returns null when role-budgets.json is absent
 *      (fallback to static config.role_budgets).
 *   2. loadLiveRoleBudgets returns the live block when role-budgets.json
 *      exists and contains a valid `role_budgets` object.
 *   3. The live block accepts both shapes: { role_budgets: {...} } and a
 *      bare top-level role map.
 *
 * Runner: node --test tests/preflight-spawn-budget.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadLiveRoleBudgets } = require('../bin/preflight-spawn-budget');

// ---------------------------------------------------------------------------
// Helper — create a throwaway project root with .orchestray/state/
// ---------------------------------------------------------------------------
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-budget-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function writeLiveFile(projectRoot, payload) {
  const filePath = path.join(projectRoot, '.orchestray', 'state', 'role-budgets.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// Test 1: live file absent → returns null (caller falls back to static config)
// ---------------------------------------------------------------------------
describe('loadLiveRoleBudgets — fallback to static defaults', () => {
  test('returns null when role-budgets.json does not exist', () => {
    const proj = makeTempProject();
    const result = loadLiveRoleBudgets(proj, null);
    assert.equal(result, null, 'Expected null when live file absent (caller uses config.role_budgets)');
  });

  test('returns null on malformed JSON (fail-open)', () => {
    const proj = makeTempProject();
    fs.writeFileSync(
      path.join(proj, '.orchestray', 'state', 'role-budgets.json'),
      '{ this is not valid json'
    );
    const result = loadLiveRoleBudgets(proj, null);
    assert.equal(result, null, 'Expected null (fail-open) on parse error');
  });
});

// ---------------------------------------------------------------------------
// Test 2: live file present → returns the calibrated block
// ---------------------------------------------------------------------------
describe('loadLiveRoleBudgets — live file overlay', () => {
  test('returns the role_budgets block from the live file (wrapped shape)', () => {
    const proj = makeTempProject();
    writeLiveFile(proj, {
      calibrated_at: '2026-04-25',
      source: 'test_fixture',
      role_budgets: {
        developer: { budget_tokens: 12345, source: 'test_fixture', calibrated_at: '2026-04-25' },
      },
    });
    const result = loadLiveRoleBudgets(proj, null);
    assert.ok(result, 'Expected non-null live budgets');
    assert.ok(result.developer, 'Expected developer entry from live file');
    assert.equal(result.developer.budget_tokens, 12345, 'Expected live budget value to win');
  });

  test('accepts a bare top-level role map (no role_budgets wrapper)', () => {
    const proj = makeTempProject();
    writeLiveFile(proj, {
      developer: { budget_tokens: 99000, source: 'test_fixture', calibrated_at: '2026-04-25' },
    });
    const result = loadLiveRoleBudgets(proj, null);
    assert.ok(result, 'Expected non-null live budgets for bare-map shape');
    assert.equal(result.developer.budget_tokens, 99000);
  });
});

// ---------------------------------------------------------------------------
// Test 3: shipped fallback file passes the live-load path
// ---------------------------------------------------------------------------
describe('shipped role-budgets.json fallback', () => {
  test('repo-root .orchestray/state/role-budgets.json loads as a live block', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const livePath = path.join(repoRoot, '.orchestray', 'state', 'role-budgets.json');
    assert.ok(
      fs.existsSync(livePath),
      'role-budgets.json must exist after R-BUDGET-WIRE rollout'
    );
    const result = loadLiveRoleBudgets(repoRoot, null);
    assert.ok(result, 'Expected non-null block from shipped fallback');
    // 15 roles per the R-BUDGET canonical list
    const roles = ['pm', 'architect', 'developer', 'reviewer', 'debugger',
                   'tester', 'documenter', 'inventor', 'researcher',
                   'security-engineer', 'release-manager', 'ux-critic',
                   'project-intent', 'platform-oracle', 'refactorer'];
    for (const role of roles) {
      assert.ok(result[role], `Expected role "${role}" in shipped fallback`);
      assert.ok(
        typeof result[role].budget_tokens === 'number' && result[role].budget_tokens > 0,
        `Expected positive budget_tokens for "${role}"`
      );
    }
  });
});
