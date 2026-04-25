#!/usr/bin/env node
'use strict';

/**
 * r-budget.test.js — R-BUDGET TDD tests (v2.1.15, W6).
 *
 * Verifies per-role pre-spawn context-size budgets with soft enforcement:
 *   1. Pre-spawn check warns (does NOT block) when context exceeds role budget.
 *   2. All 13+ agent types have explicit budget entries in config.json.
 *   3. Each entry records source: "fallback_model_tier_thin_telemetry".
 *   4. `bin/preflight-spawn-budget.js --self-test` exits 0.
 *   5. Hard-block opt-in blocks (exit 2) only when explicitly enabled.
 *   6. Kill switch (budget_enforcement.enabled: false) disables all checks.
 *   7. Fail-open when config is missing or malformed.
 *   8. budget_warn event section present in event-schemas.md.
 *
 * Runner: node --test tests/r-budget.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, '.orchestray', 'config.json');
const EVENT_SCHEMAS = path.join(ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const PREFLIGHT_SCRIPT = path.join(ROOT, 'bin', 'preflight-spawn-budget.js');
const CALIBRATE_SCRIPT = path.join(ROOT, 'bin', 'calibrate-role-budgets.js');

// ---------------------------------------------------------------------------
// Required roles — 15 entries per R-BUDGET canonical list
// ---------------------------------------------------------------------------
const REQUIRED_ROLES = [
  'pm', 'architect', 'developer', 'refactorer', 'reviewer',
  'debugger', 'tester', 'documenter', 'inventor', 'researcher',
  'security-engineer', 'release-manager', 'ux-critic',
  'project-intent', 'platform-oracle',
];

// ---------------------------------------------------------------------------
// Module under test — checkBudget
// ---------------------------------------------------------------------------
const { checkBudget } = require('../bin/preflight-spawn-budget');

// ---------------------------------------------------------------------------
// Helper: load config
// ---------------------------------------------------------------------------
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Test 1: All required roles have explicit budget entries in config.json
// ---------------------------------------------------------------------------
describe('config.json role_budgets', () => {
  test('all required roles present with explicit entries', () => {
    const config = loadConfig();
    assert.ok(config.role_budgets, 'role_budgets block must exist in config.json');

    const missingRoles = REQUIRED_ROLES.filter(role => !config.role_budgets[role]);
    assert.deepEqual(
      missingRoles,
      [],
      `Missing role_budgets entries: ${missingRoles.join(', ')}`
    );
  });

  test('every budget entry has source: "fallback_model_tier_thin_telemetry"', () => {
    const config = loadConfig();
    const badEntries = REQUIRED_ROLES.filter(role => {
      const entry = config.role_budgets[role];
      return !entry || entry.source !== 'fallback_model_tier_thin_telemetry';
    });
    assert.deepEqual(
      badEntries,
      [],
      `Entries missing correct source field: ${badEntries.join(', ')}`
    );
  });

  test('every budget entry has a positive budget_tokens value', () => {
    const config = loadConfig();
    const badEntries = REQUIRED_ROLES.filter(role => {
      const entry = config.role_budgets[role];
      return !entry || typeof entry.budget_tokens !== 'number' || entry.budget_tokens <= 0;
    });
    assert.deepEqual(
      badEntries,
      [],
      `Entries missing/invalid budget_tokens: ${badEntries.join(', ')}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: checkBudget warns (does NOT block) by default when over budget
// ---------------------------------------------------------------------------
describe('checkBudget — soft-enforce (warn-only default)', () => {
  test('returns warn action when computed size exceeds budget (hard_block not set)', () => {
    const config = loadConfig();
    // developer budget is 60K; pass 70K to trigger the warn
    const result = checkBudget('developer', 70000, config);
    assert.equal(result.action, 'warn', 'Expected warn action, not block');
    assert.ok(result.budget > 0, 'Expected positive budget in result');
    assert.equal(result.role, 'developer');
    assert.equal(result.computed_size, 70000);
  });

  test('returns ok action when computed size is within budget', () => {
    const config = loadConfig();
    const result = checkBudget('developer', 10000, config);
    assert.equal(result.action, 'ok', 'Expected ok action when under budget');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Hard-block opt-in — blocks only when hard_block enabled
// ---------------------------------------------------------------------------
describe('checkBudget — hard-block opt-in', () => {
  test('blocks (exit-2 signal) when hard_block is true and over budget', () => {
    const config = loadConfig();
    // Clone config and set hard_block to true for this test
    const hardConfig = JSON.parse(JSON.stringify(config));
    hardConfig.budget_enforcement = { enabled: true, hard_block: true };
    const result = checkBudget('developer', 70000, hardConfig);
    assert.equal(result.action, 'block', 'Expected block action when hard_block enabled and over budget');
  });

  test('does NOT block when hard_block is true but under budget', () => {
    const config = loadConfig();
    const hardConfig = JSON.parse(JSON.stringify(config));
    hardConfig.budget_enforcement = { enabled: true, hard_block: true };
    const result = checkBudget('developer', 5000, hardConfig);
    assert.equal(result.action, 'ok', 'Expected ok action when under budget even with hard_block enabled');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Kill switch — budget_enforcement.enabled: false disables all checks
// ---------------------------------------------------------------------------
describe('checkBudget — kill switch', () => {
  test('returns ok (disabled) when budget_enforcement.enabled is false', () => {
    const config = loadConfig();
    const disabledConfig = JSON.parse(JSON.stringify(config));
    disabledConfig.budget_enforcement = { enabled: false, hard_block: true };
    // Even 99999999 tokens should pass when disabled
    const result = checkBudget('developer', 99999999, disabledConfig);
    assert.equal(result.action, 'ok', 'Expected ok when enforcement disabled');
    assert.equal(result.reason, 'disabled', 'Expected reason=disabled');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Fail-open on missing/malformed config
// ---------------------------------------------------------------------------
describe('checkBudget — fail-open', () => {
  test('returns ok when role_budgets block is missing from config', () => {
    const minimalConfig = {};
    // Should not throw; should fail-open
    let result;
    assert.doesNotThrow(() => {
      result = checkBudget('developer', 99999999, minimalConfig);
    });
    assert.equal(result.action, 'ok', 'Expected fail-open (ok) when role_budgets missing');
    assert.equal(result.reason, 'fail_open');
  });

  test('returns ok when role is unknown (not in role_budgets)', () => {
    const config = loadConfig();
    const result = checkBudget('unknown-role-xyz', 99999999, config);
    assert.equal(result.action, 'ok', 'Expected fail-open when role not found');
    assert.equal(result.reason, 'fail_open');
  });
});

// ---------------------------------------------------------------------------
// Test 6: --self-test flag exits 0
// ---------------------------------------------------------------------------
describe('preflight-spawn-budget.js --self-test', () => {
  test('exits 0 on --self-test', () => {
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [PREFLIGHT_SCRIPT, '--self-test'], {
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch (err) {
      exitCode = err.status || 1;
    }
    assert.equal(exitCode, 0, '--self-test must exit 0');
  });
});

// ---------------------------------------------------------------------------
// Test 7: event-schemas.md contains budget_warn section
// ---------------------------------------------------------------------------
describe('event-schemas.md — budget_warn', () => {
  test('event-schemas.md contains budget_warn event schema section', () => {
    const schemasContent = fs.readFileSync(EVENT_SCHEMAS, 'utf8');
    assert.ok(
      schemasContent.includes('budget_warn'),
      'event-schemas.md must contain a budget_warn event schema section'
    );
  });

  test('budget_warn schema includes required fields', () => {
    const schemasContent = fs.readFileSync(EVENT_SCHEMAS, 'utf8');
    // Check for the required fields per W6 brief: agent_role, computed_size, budget, source
    const requiredFields = ['agent_role', 'computed_size', 'budget', 'source'];
    for (const field of requiredFields) {
      assert.ok(
        schemasContent.includes(`"${field}"`),
        `event-schemas.md must include field "${field}" in budget_warn schema`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: calibrate-role-budgets.js ships but is flagged as v2.1.16 actor
// ---------------------------------------------------------------------------
describe('calibrate-role-budgets.js — v2.1.16 actor', () => {
  test('calibrate-role-budgets.js exists', () => {
    assert.ok(
      fs.existsSync(CALIBRATE_SCRIPT),
      'bin/calibrate-role-budgets.js must exist'
    );
  });

  test('calibrate-role-budgets.js is documented as v2.1.16 actor (not auto-run in v2.1.15)', () => {
    const content = fs.readFileSync(CALIBRATE_SCRIPT, 'utf8');
    assert.ok(
      content.includes('v2.1.16') || content.includes('2.1.16'),
      'calibrate-role-budgets.js must document that it is a v2.1.16 actor'
    );
  });
});
