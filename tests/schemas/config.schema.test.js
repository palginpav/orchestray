#!/usr/bin/env node
'use strict';

/**
 * Tests for schemas/config.schema.js (v2.1.13 R-ZOD).
 *
 * Covers: happy path, malformed fixture, known-key type errors,
 * passthrough of unknown keys (W9 territory), kill-switch invariant.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { configSchema } = require('../../schemas/config.schema');
const { validate, validateOrDie } = require('../../schemas');

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  const p = path.join(FIXTURES, name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
describe('configSchema — happy path', () => {
  test('empty object is valid (every top-level field is optional)', () => {
    const r = configSchema.safeParse({});
    assert.equal(r.success, true);
  });

  test('a realistic v2.1.12 config validates', () => {
    // Shape taken from .orchestray/config.json in the main repo.
    const cfg = {
      auto_review: true,
      max_retries: 1,
      default_delegation: 'sequential',
      verbose: false,
      complexity_threshold: 4,
      model_floor: 'haiku',
      force_model: null,
      haiku_max_score: 3,
      opus_min_score: 6,
      default_effort: null,
      force_effort: null,
      effort_routing: true,
      enable_agent_teams: true,
      max_cost_usd: null,
      security_review: 'auto',
      tdd_mode: true,
      contract_strictness: 'standard',
      mcp_server: {
        enabled: true,
        tools: {
          pattern_find: true,
          ask_user: { enabled: true, max_per_task: 2, default_timeout_seconds: 120 },
        },
        cost_budget_check: {
          pricing_table: {
            haiku: { input_per_1m: 1, output_per_1m: 5 },
            sonnet: { input_per_1m: 3, output_per_1m: 15 },
            opus: { input_per_1m: 5, output_per_1m: 25 },
          },
          last_verified: '2026-04-15',
        },
      },
      mcp_enforcement: {
        global_kill_switch: false,
        unknown_tool_policy: 'block',
        pattern_find: 'hook',
        kb_search: 'hook',
      },
      retrieval: {
        scorer_variant: 'baseline',
        shadow_scorers: ['skip-down', 'local-success'],
        global_kill_switch: false,
      },
    };
    const r = configSchema.safeParse(cfg);
    if (!r.success) {
      console.error(JSON.stringify(r.error.issues, null, 2));
    }
    assert.equal(r.success, true);
  });

  test('repo\'s real .orchestray/config.json validates via validateOrDie', () => {
    // Walk up until we find a .orchestray/config.json, or skip if not
    // running inside a checkout (worktrees don't ship one).
    const candidates = [
      path.resolve(__dirname, '..', '..', '.orchestray', 'config.json'),
      // Fallback: main repo location for worktree runs.
      '/home/palgin/orchestray/.orchestray/config.json',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      // Not a failure: some CI environments won't have this file.
      return;
    }
    const cfg = JSON.parse(fs.readFileSync(found, 'utf8'));
    assert.doesNotThrow(() => validateOrDie(configSchema, cfg, found));
  });
});

// ---------------------------------------------------------------------------
describe('configSchema — type errors must fail loudly', () => {
  test('malformed top-level scalar (auto_review = "yes" string) fails', () => {
    const r = configSchema.safeParse({ auto_review: 'yes' });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'auto_review'));
  });

  test('invalid enum value on default_delegation fails with clear message', () => {
    const r = configSchema.safeParse({ default_delegation: 'async' });
    assert.equal(r.success, false);
    const iss = r.error.issues.find((i) => i.path[0] === 'default_delegation');
    assert.ok(iss, 'expected issue on default_delegation');
    assert.match(iss.message, /Invalid enum|Invalid option/i);
  });

  test('negative max_retries fails', () => {
    const r = configSchema.safeParse({ max_retries: -1 });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.path[0] === 'max_retries'));
  });

  test('validateOrDie throws with file path and key path in message', () => {
    const label = '/path/to/.orchestray/config.json';
    let caught;
    try {
      validateOrDie(configSchema, { auto_review: 123 }, label);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected validateOrDie to throw');
    assert.match(caught.message, /auto_review/);
    assert.match(caught.message, /validation failed for .*config\.json/);
    // Structured details available for programmatic consumers.
    assert.ok(caught.details && Array.isArray(caught.details.issues));
  });
});

// ---------------------------------------------------------------------------
describe('configSchema — unknown keys are passed through (R-CONFIG-DRIFT owns warnings)', () => {
  test('unknown top-level key does not fail validation', () => {
    const r = configSchema.safeParse({
      auto_review: true,
      // hypothetical typo that W9 should warn about, but R-ZOD must not
      // hard-fail on — otherwise W9 never gets a chance to suggest.
      auto_reviewr: true,
    });
    assert.equal(r.success, true);
    assert.equal(r.data.auto_reviewr, true);
  });

  test('unknown key inside a known object section also passes through', () => {
    const r = configSchema.safeParse({
      federation: {
        shared_dir_enabled: true,
        // hypothetical typo inside a sub-section
        shaerd_dir_path: '~/.orchestray/shared',
      },
    });
    assert.equal(r.success, true);
  });
});

// ---------------------------------------------------------------------------
describe('configSchema — kill-switch invariant', () => {
  test('global_kill_switch=true requires kill_switch_reason', () => {
    const r = configSchema.safeParse({
      mcp_enforcement: { global_kill_switch: true },
    });
    assert.equal(r.success, false);
    const iss = r.error.issues.find(
      (i) =>
        i.path.join('.') === 'mcp_enforcement.kill_switch_reason'
    );
    assert.ok(iss, 'expected targeted error on kill_switch_reason');
  });

  test('global_kill_switch=true with non-empty reason passes', () => {
    const r = configSchema.safeParse({
      mcp_enforcement: {
        global_kill_switch: true,
        kill_switch_reason: 'incident-2026-04-24',
      },
    });
    assert.equal(r.success, true);
  });

  test('global_kill_switch=false does not require a reason', () => {
    const r = configSchema.safeParse({
      mcp_enforcement: { global_kill_switch: false },
    });
    assert.equal(r.success, true);
  });
});

// ---------------------------------------------------------------------------
describe('configSchema — seeded malformed fixture (R-ZOD AC)', () => {
  test('fixture malformed-config.json fails validation with actionable messages', () => {
    const cfg = loadFixture('malformed-config.json');
    const result = validate(configSchema, cfg, 'malformed-config.json');
    assert.equal(result.ok, false);
    assert.ok(result.issues.length >= 3, 'expect multiple issues, got: ' + JSON.stringify(result.issues));
    // Spot-check at least one targeted path we know the fixture breaks.
    const paths = result.issues.map((i) => i.path).sort();
    assert.ok(
      paths.some((p) => p === 'max_retries' || p === 'complexity_threshold' ||
                       p === 'retrieval.scorer_variant'),
      'expected at least one of {max_retries, complexity_threshold, retrieval.scorer_variant} to fail, got: ' + paths.join(',')
    );
  });
});
