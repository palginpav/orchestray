#!/usr/bin/env node
'use strict';

/**
 * Tests for the W3 pricing-table seed sub-operation in bin/post-upgrade-sweep.js
 *
 * UserPromptSubmit hook — the W3 sub-operation seeds the pricing-table config
 * key on first 2.0.14 use. It is idempotent via a sentinel at
 * .orchestray/state/.pricing-table-migrated-2014.
 *
 * Per 2014-scope-proposal.md §W3 AC7.
 *
 * Coverage:
 *   W3-A — config has no mcp_server.cost_budget_check → full default block added
 *   W3-B — config has mcp_server.cost_budget_check.pricing_table → not overwritten (idempotent)
 *   W3-C — pricing-table sentinel already exists → no migration runs
 *   W3-D — config has mcp_server but no cost_budget_check → block added
 *   W3-E — sentinel is created after seed
 *   W3-F — seeded pricing_table values match DEFAULT_COST_BUDGET_CHECK
 *   W3-G — unrelated config keys are preserved after seed
 *   W3-H — last_verified is set on fresh seed
 *   W3-I — sub-operation runs in default invocation path (grep anchor)
 *   W3-J — fails open (exits 0) when config is missing
 *   W3-K — session lock prevents W3 from running (fast-path)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/post-upgrade-sweep.js');
const { DEFAULT_COST_BUDGET_CHECK } = require('../bin/_lib/config-schema');

/** Default session ID used when tests don't supply their own. */
const DEFAULT_SESSION_ID = 'pricing-seed-test-default-session';

/** Lock path for the default session ID. */
const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), `orchestray-sweep-${DEFAULT_SESSION_ID}.lock`);

const cleanup = [];

beforeEach(() => {
  try { fs.unlinkSync(DEFAULT_LOCK_PATH); } catch (_e) {}
});

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
  try { fs.unlinkSync(DEFAULT_LOCK_PATH); } catch (_e) {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir({ config = null, pricingSentinel = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pricing-seed-test-'));
  cleanup.push(dir);

  const orchestrayDir = path.join(dir, '.orchestray');
  const stateDir = path.join(orchestrayDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  if (config !== null) {
    fs.writeFileSync(
      path.join(orchestrayDir, 'config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf8'
    );
  }

  if (pricingSentinel) {
    fs.writeFileSync(
      path.join(stateDir, '.pricing-table-migrated-2014'),
      '',
      'utf8'
    );
  }

  return dir;
}

function run(cwd, extra = {}) {
  const sessionId = extra.session_id || DEFAULT_SESSION_ID;
  const payload = Object.assign({ cwd, session_id: sessionId }, extra);

  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function lockPathFor(sessionId) {
  return path.join(os.tmpdir(), `orchestray-sweep-${sessionId}.lock`);
}

function readConfig(dir) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, '.orchestray', 'config.json'), 'utf8')
  );
}

function sentinelExists(dir, name) {
  return fs.existsSync(path.join(dir, '.orchestray', 'state', name));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W3 pricing-table seed', () => {

  test('W3-A: config has no mcp_server.cost_budget_check → full default block added', () => {
    const dir = makeDir({ config: { auto_review: true } });
    run(dir);
    const cfg = readConfig(dir);
    assert.ok(
      cfg.mcp_server && cfg.mcp_server.cost_budget_check,
      'mcp_server.cost_budget_check block should be present'
    );
    const pt = cfg.mcp_server.cost_budget_check.pricing_table;
    assert.ok(pt, 'pricing_table should be present');
    assert.ok(pt.haiku, 'haiku tier should be present');
    assert.ok(pt.sonnet, 'sonnet tier should be present');
    assert.ok(pt.opus, 'opus tier should be present');
    assert.equal(pt.haiku.input_per_1m, 1.00, 'haiku input rate must be seeded');
    assert.equal(pt.sonnet.input_per_1m, 3.00, 'sonnet input rate must be seeded');
    assert.equal(pt.opus.input_per_1m, 5.00, 'opus input rate must be seeded');
  });

  test('W3-B: config already has pricing_table → not overwritten (user-customized preserved)', () => {
    const customTable = {
      haiku:  { input_per_1m: 99.00, output_per_1m: 99.00 },
      sonnet: { input_per_1m: 99.00, output_per_1m: 99.00 },
      opus:   { input_per_1m: 99.00, output_per_1m: 99.00 },
    };
    const dir = makeDir({
      config: {
        mcp_server: {
          cost_budget_check: {
            pricing_table: customTable,
            last_verified: '2025-01-01',
          },
        },
      },
    });
    run(dir);
    const cfg = readConfig(dir);
    const pt = cfg.mcp_server.cost_budget_check.pricing_table;
    assert.equal(pt.haiku.input_per_1m, 99.00,
      'user-customized pricing must be preserved');
    assert.equal(pt.opus.output_per_1m, 99.00,
      'user-customized pricing must be preserved');
    // last_verified also preserved
    assert.equal(cfg.mcp_server.cost_budget_check.last_verified, '2025-01-01',
      'user-customized last_verified must be preserved');
  });

  test('W3-C: pricing-table sentinel already exists → no migration runs', () => {
    const dir = makeDir({ config: { auto_review: true }, pricingSentinel: true });
    run(dir);
    const cfg = readConfig(dir);
    // With sentinel, the W3 op must not run
    assert.equal(
      cfg.mcp_server,
      undefined,
      'mcp_server block should not be added when pricing sentinel exists'
    );
  });

  test('W3-D: config has mcp_server but no cost_budget_check → block added', () => {
    const dir = makeDir({
      config: {
        mcp_server: {
          enabled: true,
          tools: { pattern_find: true },
        },
      },
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.ok(
      cfg.mcp_server.cost_budget_check,
      'cost_budget_check block should be added under existing mcp_server'
    );
    // Existing mcp_server keys preserved
    assert.equal(cfg.mcp_server.enabled, true, 'mcp_server.enabled must be preserved');
    assert.ok(cfg.mcp_server.tools, 'mcp_server.tools must be preserved');
  });

  test('W3-E: sentinel is created after seed', () => {
    const dir = makeDir({ config: { auto_review: true } });
    run(dir);
    assert.ok(
      sentinelExists(dir, '.pricing-table-migrated-2014'),
      'sentinel .pricing-table-migrated-2014 must exist after seed'
    );
  });

  test('W3-F: seeded pricing_table values match DEFAULT_COST_BUDGET_CHECK', () => {
    const dir = makeDir({ config: { auto_review: true } });
    run(dir);
    const cfg = readConfig(dir);
    const pt = cfg.mcp_server.cost_budget_check.pricing_table;

    assert.equal(pt.haiku.input_per_1m, DEFAULT_COST_BUDGET_CHECK.pricing_table.haiku.input_per_1m,
      'haiku input_per_1m must match DEFAULT_COST_BUDGET_CHECK');
    assert.equal(pt.haiku.output_per_1m, DEFAULT_COST_BUDGET_CHECK.pricing_table.haiku.output_per_1m,
      'haiku output_per_1m must match DEFAULT_COST_BUDGET_CHECK');
    assert.equal(pt.sonnet.input_per_1m, DEFAULT_COST_BUDGET_CHECK.pricing_table.sonnet.input_per_1m,
      'sonnet input_per_1m must match DEFAULT_COST_BUDGET_CHECK');
    assert.equal(pt.sonnet.output_per_1m, DEFAULT_COST_BUDGET_CHECK.pricing_table.sonnet.output_per_1m,
      'sonnet output_per_1m must match DEFAULT_COST_BUDGET_CHECK');
    assert.equal(pt.opus.input_per_1m, DEFAULT_COST_BUDGET_CHECK.pricing_table.opus.input_per_1m,
      'opus input_per_1m must match DEFAULT_COST_BUDGET_CHECK');
    assert.equal(pt.opus.output_per_1m, DEFAULT_COST_BUDGET_CHECK.pricing_table.opus.output_per_1m,
      'opus output_per_1m must match DEFAULT_COST_BUDGET_CHECK');
  });

  test('W3-F: seeded haiku pricing matches collect-agent-metrics.js (input=$1, output=$5)', () => {
    const dir = makeDir({ config: {} });
    run(dir);
    const cfg = readConfig(dir);
    const haiku = cfg.mcp_server.cost_budget_check.pricing_table.haiku;
    assert.equal(haiku.input_per_1m, 1.00, 'haiku input must be $1/1M');
    assert.equal(haiku.output_per_1m, 5.00, 'haiku output must be $5/1M');
  });

  test('W3-F: seeded sonnet pricing matches collect-agent-metrics.js (input=$3, output=$15)', () => {
    const dir = makeDir({ config: {} });
    run(dir);
    const cfg = readConfig(dir);
    const sonnet = cfg.mcp_server.cost_budget_check.pricing_table.sonnet;
    assert.equal(sonnet.input_per_1m, 3.00, 'sonnet input must be $3/1M');
    assert.equal(sonnet.output_per_1m, 15.00, 'sonnet output must be $15/1M');
  });

  test('W3-F: seeded opus pricing matches collect-agent-metrics.js (input=$5, output=$25)', () => {
    const dir = makeDir({ config: {} });
    run(dir);
    const cfg = readConfig(dir);
    const opus = cfg.mcp_server.cost_budget_check.pricing_table.opus;
    assert.equal(opus.input_per_1m, 5.00, 'opus input must be $5/1M');
    assert.equal(opus.output_per_1m, 25.00, 'opus output must be $25/1M');
  });

  test('W3-G: unrelated config keys are preserved after seed', () => {
    const dir = makeDir({
      config: {
        auto_review: true,
        complexity_threshold: 5,
        force_solo: false,
      },
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.auto_review, true, 'auto_review must be preserved');
    assert.equal(cfg.complexity_threshold, 5, 'complexity_threshold must be preserved');
    assert.equal(cfg.force_solo, false, 'force_solo must be preserved');
  });

  test('W3-H: last_verified is set on fresh seed', () => {
    const dir = makeDir({ config: { auto_review: true } });
    run(dir);
    const cfg = readConfig(dir);
    const lv = cfg.mcp_server.cost_budget_check.last_verified;
    assert.ok(typeof lv === 'string' && lv.length >= 8, 'last_verified must be a date string');
    // Must match YYYY-MM-DD pattern
    assert.ok(/^\d{4}-\d{2}-\d{2}/.test(lv), 'last_verified must match YYYY-MM-DD');
  });

  test('W3-I: pricing_table anchor appears in sweep script (grep invariant)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('pricing_table'),
      'bin/post-upgrade-sweep.js must contain "pricing_table" string');
  });

  test('W3-I: 2014-W3-pricing-table-seed anchor appears in sweep script', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('2014-W3-pricing-table-seed'),
      'script must contain 2014-W3-pricing-table-seed anchor');
  });

  test('W3-J: fails open (exits 0) when config is missing', () => {
    // No config file at all
    const dir = makeDir({ config: null });
    const { status, stdout } = run(dir);
    assert.equal(status, 0, 'must exit 0 when config is missing');
    const out = JSON.parse(stdout);
    assert.equal(out.continue, true);
  });

  test('W3-J: fails open (exits 0) when config is malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pricing-malformed-'));
    cleanup.push(dir);
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), 'NOT JSON {{{', 'utf8');

    const { status } = run(dir);
    assert.equal(status, 0, 'must exit 0 when config is malformed');
  });

  test('W3-K: session lock prevents W3 from running (fast-path)', () => {
    const dir = makeDir({ config: { auto_review: true } });
    const sessionId = 'w3-lock-test-session';
    const lockPath = lockPathFor(sessionId);
    cleanup.push(lockPath);

    // Pre-create the lock
    fs.writeFileSync(lockPath, '', 'utf8');
    run(dir, { session_id: sessionId });

    // config must NOT have been modified (lock short-circuited the sweep)
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_server, undefined,
      'mcp_server block should not be added when session lock prevents sweep');
  });

  test('W3-write-failure: rename failure leaves sentinel untouched and config uncorrupted', () => {
    // Simulate a disk-full / permission error during the atomic write by making
    // the .orchestray directory read-only (no-write) so both the temp file write
    // and the subsequent rename will fail.
    // Assert:
    //   1. The sentinel is NOT created (so W3 will be retried next session).
    //   2. The config file is not corrupted (still valid JSON with original content).
    //   3. The process exits 0 (fail-open — no unhandled throw escapes).
    const dir = makeDir({ config: { auto_review: true } });
    const orchestrayDir = path.join(dir, '.orchestray');
    const configPath = path.join(orchestrayDir, 'config.json');
    const sentinelPath = path.join(orchestrayDir, 'state', '.pricing-table-migrated-2014');

    // Capture the original config content before we lock down the directory.
    const originalContent = fs.readFileSync(configPath, 'utf8');

    // Make the .orchestray directory read-only so writeFileSync(tmpPath) fails.
    // The state/ subdirectory is separate, so the sentinel check is irrelevant.
    fs.chmodSync(orchestrayDir, 0o555);

    let { status } = run(dir);

    // Restore permissions so afterEach cleanup can delete the directory.
    try { fs.chmodSync(orchestrayDir, 0o755); } catch (_e) {}

    // 1. Process must exit 0 (fail-open).
    assert.equal(status, 0, 'sweep must exit 0 even when rename fails');

    // 2. Sentinel must NOT have been created (retry will happen next session).
    assert.equal(
      fs.existsSync(sentinelPath),
      false,
      'sentinel must NOT be created when write fails — so W3 retries next session'
    );

    // 3. Config must not be corrupted — must still parse and have original content.
    const afterContent = fs.readFileSync(configPath, 'utf8');
    assert.equal(afterContent, originalContent, 'config file content must be unchanged after write failure');
    // Must still parse as valid JSON.
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(afterContent); },
      'config must still be valid JSON after write failure');
    // pricing_table must NOT have been added (the write never committed).
    assert.equal(
      parsed.mcp_server,
      undefined,
      'mcp_server block must NOT appear in config after a failed write'
    );
  });

  test('W3: sub-operation is idempotent — running sweep twice does not duplicate data', () => {
    const sessionA = 'pricing-idem-session-a';
    const sessionB = 'pricing-idem-session-b';
    cleanup.push(lockPathFor(sessionA));
    cleanup.push(lockPathFor(sessionB));

    const dir = makeDir({ config: { auto_review: true } });

    // First run
    try { fs.unlinkSync(lockPathFor(sessionA)); } catch (_e) {}
    run(dir, { session_id: sessionA });

    const cfgAfterFirst = readConfig(dir);
    const ptAfterFirst = cfgAfterFirst.mcp_server.cost_budget_check.pricing_table;

    // Second run with different session (bypasses session lock but sentinel gates W3)
    try { fs.unlinkSync(lockPathFor(sessionB)); } catch (_e) {}
    run(dir, { session_id: sessionB });

    const cfgAfterSecond = readConfig(dir);
    const ptAfterSecond = cfgAfterSecond.mcp_server.cost_budget_check.pricing_table;

    // Pricing table must be identical after second run
    assert.deepEqual(ptAfterFirst, ptAfterSecond,
      'pricing_table must be unchanged after second sweep run (sentinel gates W3)');
  });

});

// ---------------------------------------------------------------------------
// Integration: W3 runs alongside W8+W11
// ---------------------------------------------------------------------------

describe('W3 combined with W8+W11', () => {
  test('all three sub-operations run in a single sweep invocation', () => {
    const dir = makeDir({
      config: { auto_review: true }, // no mcp_enforcement, no cost_budget_check
    });
    run(dir);

    // W8 ran
    const cfg = readConfig(dir);
    assert.ok(cfg.mcp_enforcement, 'W8: mcp_enforcement block should be added');

    // W3 ran
    assert.ok(cfg.mcp_server && cfg.mcp_server.cost_budget_check,
      'W3: cost_budget_check block should be added');

    // All three sentinels exist
    assert.ok(sentinelExists(dir, '.config-migrated-2013'), 'W8 sentinel must exist');
    assert.ok(sentinelExists(dir, '.mcp-checkpoint-migrated-2013'), 'W11 sentinel must exist');
    assert.ok(sentinelExists(dir, '.pricing-table-migrated-2014'), 'W3 sentinel must exist');
  });
});
