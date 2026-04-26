#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.1.16 R-AT-FLAG migration in bin/post-upgrade-sweep.js
 * (`runRAtFlagMigration` helper).
 *
 * Background (v2.1.16 W12-fix F-003): the legacy top-level
 * `enable_agent_teams` boolean was renamed to the namespaced
 * `agent_teams: { enabled: ... }` block. The migration runs once per install
 * (sentinel-gated), reads .orchestray/config.json, and additively seeds the
 * new namespace from the legacy value. The legacy key is left in place for
 * one release; the deprecation banner above announces the rename.
 *
 * The helper is NOT directly exported from post-upgrade-sweep.js (private
 * function), so these tests spawn the binary as a subprocess with a
 * controlled isolated cwd, matching the convention in
 * tests/post-upgrade-sweep.test.js.
 *
 * Coverage (six cases named by the W12 review F-003):
 *   (a) legacy enable_agent_teams: true   → seeds agent_teams.enabled: true
 *   (b) legacy enable_agent_teams: false  → seeds agent_teams.enabled: false
 *   (c) absent legacy                     → seeds agent_teams.enabled: false
 *   (d) agent_teams already an object     → no-op (idempotent)
 *   (e) sentinel exists                   → no-op
 *   (f) unparseable config                → no-op + sentinel touched (fail-open)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/post-upgrade-sweep.js');
const SENTINEL_NAME = '.agent-teams-namespace-migrated-2116';

// Per-test isolated tmpdirs are tracked here for cleanup.
const cleanup = [];

beforeEach(() => {
  // No-op — each test creates its own dir.
});

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Build an isolated tmpdir with .orchestray/{state,config.json}. Returns the
 * cwd path. The caller is responsible for adding it to `cleanup`.
 *
 * @param {object}  opts
 * @param {object|string|null} [opts.config]   - JSON value to write OR raw
 *                                               string (raw lets us seed
 *                                               unparseable input). null = skip.
 * @param {boolean} [opts.preCreateSentinel]   - Create the R-AT-FLAG sentinel
 *                                               BEFORE the sweep runs.
 * @param {boolean} [opts.skipDefaultSentinels] - When false (default), pre-seed
 *                                                every other migration sentinel
 *                                                so unrelated migrations don't
 *                                                mutate config.json.
 */
function makeDir({
  config = null,
  preCreateSentinel = false,
  skipDefaultSentinels = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-r-at-flag-test-'));
  const orchestrayDir = path.join(dir, '.orchestray');
  const stateDir = path.join(orchestrayDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  if (config !== null) {
    const raw = typeof config === 'string'
      ? config
      : JSON.stringify(config, null, 2) + '\n';
    fs.writeFileSync(path.join(orchestrayDir, 'config.json'), raw, 'utf8');
  }

  // Pre-seed every OTHER migration sentinel so unrelated migration helpers do
  // not mutate config.json during these tests.
  if (!skipDefaultSentinels) {
    const noiseSentinels = [
      '.config-migrated-2013',
      '.mcp-checkpoint-migrated-2013',
      '.enforcement-keys-migrated-2015',
      '.kb-write-migrated-2015',
      '.pattern-record-app-migrated-2016',
      '.cost-budget-enforcement-migrated-2016',
      '.v2016-new-tools-seeded',
      '.pattern-deprecate-seeded-2016',
      '.pattern-record-app-stage-c-2016',
      '.cost-budget-hard-block-default-2016',
      '.cost-budget-reserve-ttl-seed-2016',
      '.routing-gate-auto-seed-2016',
      '.v2017-experiments-seeded',
      '.metrics-query-seeded-2017',
      '.cache-choreography-seeded-2017',
      '.pm-prompt-variant-seeded-2017',
      '.adaptive-verbosity-seeded-2017',
      '.pattern-decay-seeded-2018',
      '.anti-pattern-gate-seeded-2018',
      '.state-sentinel-seeded-2018',
      '.redo-flow-seeded-2018',
    ];
    for (const name of noiseSentinels) {
      fs.writeFileSync(path.join(stateDir, name), '', 'utf8');
    }
  }

  if (preCreateSentinel) {
    fs.writeFileSync(path.join(stateDir, SENTINEL_NAME), '', 'utf8');
  }

  cleanup.push(dir);
  return dir;
}

/**
 * Spawn the sweep script with a fresh per-test session_id so the per-session
 * lock file in os.tmpdir() does NOT collide across tests.
 */
function run(cwd) {
  const sessionId = `r-at-flag-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lockPath = path.join(os.tmpdir(), `orchestray-sweep-${sessionId}.lock`);
  // Ensure no stale lock — should never exist with the random ID, but be safe.
  try { fs.unlinkSync(lockPath); } catch (_e) {}

  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 10000,
  });

  // Best-effort post-test cleanup of the session lock.
  try { fs.unlinkSync(lockPath); } catch (_e) {}

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.orchestray', 'config.json'), 'utf8'));
}

function readConfigRaw(dir) {
  return fs.readFileSync(path.join(dir, '.orchestray', 'config.json'), 'utf8');
}

function sentinelExists(dir) {
  return fs.existsSync(path.join(dir, '.orchestray', 'state', SENTINEL_NAME));
}

// ──────────────────────────────────────────────────────────────────────────────

describe('R-AT-FLAG migration (v2.1.16)', () => {

  test('(a) legacy enable_agent_teams: true → seeds agent_teams.enabled: true', () => {
    const dir = makeDir({ config: { enable_agent_teams: true } });
    const { status } = run(dir);
    assert.equal(status, 0, 'sweep exits 0 (fail-open)');

    const cfg = readConfig(dir);
    assert.ok(cfg.agent_teams && typeof cfg.agent_teams === 'object',
      'agent_teams namespace seeded as an object');
    assert.equal(cfg.agent_teams.enabled, true,
      'agent_teams.enabled mirrors legacy true value');
    assert.equal(cfg.enable_agent_teams, true,
      'legacy key is preserved for one release (additive migration)');
    assert.ok(sentinelExists(dir), 'sentinel created after migration');
  });

  test('(b) legacy enable_agent_teams: false → seeds agent_teams.enabled: false', () => {
    const dir = makeDir({ config: { enable_agent_teams: false } });
    const { status } = run(dir);
    assert.equal(status, 0);

    const cfg = readConfig(dir);
    assert.equal(cfg.agent_teams.enabled, false,
      'agent_teams.enabled mirrors legacy false value');
    assert.equal(cfg.enable_agent_teams, false,
      'legacy key preserved');
    assert.ok(sentinelExists(dir));
  });

  test('(c) absent legacy enable_agent_teams → seeds agent_teams.enabled: false (default OFF)', () => {
    const dir = makeDir({ config: { auto_review: true } });
    const { status } = run(dir);
    assert.equal(status, 0);

    const cfg = readConfig(dir);
    assert.ok(cfg.agent_teams && typeof cfg.agent_teams === 'object',
      'agent_teams namespace seeded even when legacy key absent');
    assert.equal(cfg.agent_teams.enabled, false,
      'default OFF when legacy is absent');
    assert.ok(!('enable_agent_teams' in cfg),
      'no spurious legacy key introduced when absent');
    assert.ok(sentinelExists(dir));
  });

  test('(d) agent_teams already present as object → no-op (idempotent shape preserved)', () => {
    const initial = {
      auto_review: true,
      enable_agent_teams: true,
      agent_teams: { enabled: false, custom_field: 'preserved' },
    };
    const dir = makeDir({ config: initial });
    run(dir);

    const cfg = readConfig(dir);
    assert.equal(cfg.agent_teams.enabled, false,
      'pre-existing agent_teams.enabled NOT overwritten by legacy true');
    assert.equal(cfg.agent_teams.custom_field, 'preserved',
      'pre-existing nested fields preserved');
    assert.equal(cfg.enable_agent_teams, true,
      'legacy key untouched');
    assert.ok(sentinelExists(dir));
  });

  test('(e) sentinel pre-exists → no-op even when migration would otherwise fire', () => {
    const dir = makeDir({
      config: { enable_agent_teams: true },
      preCreateSentinel: true,
    });
    run(dir);

    const cfg = readConfig(dir);
    assert.ok(!('agent_teams' in cfg),
      'no agent_teams seeded when sentinel pre-exists — migration short-circuited');
    assert.equal(cfg.enable_agent_teams, true,
      'legacy key untouched');
    assert.ok(sentinelExists(dir), 'sentinel still present');
  });

  test('(f) unparseable config → no-op + sentinel touched (fail-open)', () => {
    const dir = makeDir({ config: '{ this is not valid json' });
    const { status } = run(dir);
    assert.equal(status, 0,
      'sweep exits 0 even on malformed config (fail-open contract)');

    // Config left untouched (still the same garbage we wrote).
    const raw = readConfigRaw(dir);
    assert.equal(raw, '{ this is not valid json',
      'unparseable config left untouched — never rewritten');

    // Sentinel is touched so the malformed-config case does not re-trigger
    // every prompt; the user has to fix the file by hand.
    assert.ok(sentinelExists(dir),
      'sentinel touched on parse failure to prevent re-runs');
  });
});
