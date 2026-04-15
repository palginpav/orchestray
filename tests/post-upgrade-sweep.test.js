#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/post-upgrade-sweep.js
 *
 * UserPromptSubmit hook — runs two idempotent post-upgrade operations once per
 * session and once per upgrade:
 *
 *   W8 (2013-W8-config-migration): additive migration of .orchestray/config.json
 *   W11 (2013-W11-ledger-sweep): flip BUG-B-poisoned phase values in mcp-checkpoint.jsonl
 *
 * Coverage:
 *   W8-A  — config has no mcp_enforcement → full default block added
 *   W8-B  — config has mcp_enforcement with partial sub-keys → missing keys filled, others preserved
 *   W8-C  — config has full mcp_enforcement → no-op
 *   W8-D  — config has unrelated keys → preserved untouched after migration
 *   W8-E  — config sentinel already exists → no-op even when migration needed
 *
 *   W11-F — empty ledger → no-op
 *   W11-G — rows with no matching routing entry → all post-decomposition rows flipped
 *   W11-H — rows with matching routing but all routing-ts > row-ts → flipped
 *   W11-I — rows with matching routing AND at least one routing-ts < row-ts → left alone
 *   W11-J — checkpoint sentinel already exists → no-op
 *   W11-K — corrupted ledger lines → skipped, rest still processed (fail-open)
 *   W11-L — _migrated_from_phase field added to flipped rows
 *
 *   M     — session lock exists → full sweep is a no-op fast-path
 *   N     — no session lock → sweep runs and lock is created
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/post-upgrade-sweep.js');

/** Default session ID used when tests don't supply their own. */
const DEFAULT_SESSION_ID = 'sweep-test-default-session';

/** Lock path for the default session ID. */
const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), `orchestray-sweep-${DEFAULT_SESSION_ID}.lock`);

const cleanup = [];

beforeEach(() => {
  // Ensure no stale session lock from a previous test interferes.
  try { fs.unlinkSync(DEFAULT_LOCK_PATH); } catch (_e) {}
});

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
  // Belt-and-suspenders: always clean the default lock after each test.
  try { fs.unlinkSync(DEFAULT_LOCK_PATH); } catch (_e) {}
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh isolated tmpdir with .orchestray/state/ and optional files.
 *
 * @param {object} opts
 * @param {object|null}  [opts.config]         - Content for config.json; null = omit file
 * @param {string|null}  [opts.checkpointRaw]  - Raw JSONL for mcp-checkpoint.jsonl; null = omit
 * @param {string|null}  [opts.routingRaw]     - Raw JSONL for routing.jsonl; null = omit
 * @param {boolean}      [opts.configSentinel] - Pre-create the W8 sentinel (.config-migrated-2013)
 * @param {boolean}      [opts.checkpointSentinel] - Pre-create the W11 sentinel
 * @param {boolean}      [opts.enforcementKeysSentinel] - Pre-create the W5 2.0.15 sentinel
 * @param {boolean}      [opts.kbWriteSentinel] - Pre-create the W6 2.0.15 sentinel (.kb-write-migrated-2015)
 */
function makeDir({
  config = null,
  checkpointRaw = null,
  routingRaw = null,
  configSentinel = false,
  checkpointSentinel = false,
  enforcementKeysSentinel = false,
  kbWriteSentinel = false,
  v2016Sentinels = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-test-'));
  cleanup.push(dir);

  const orchestrayDir = path.join(dir, '.orchestray');
  const stateDir = path.join(orchestrayDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  if (config !== null) {
    fs.writeFileSync(path.join(orchestrayDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  if (checkpointRaw !== null) {
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), checkpointRaw, 'utf8');
  }
  if (routingRaw !== null) {
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), routingRaw, 'utf8');
  }
  if (configSentinel) {
    fs.writeFileSync(path.join(stateDir, '.config-migrated-2013'), '', 'utf8');
  }
  if (checkpointSentinel) {
    fs.writeFileSync(path.join(stateDir, '.mcp-checkpoint-migrated-2013'), '', 'utf8');
  }
  if (enforcementKeysSentinel) {
    fs.writeFileSync(path.join(stateDir, '.enforcement-keys-migrated-2015'), '', 'utf8');
  }
  if (kbWriteSentinel) {
    fs.writeFileSync(path.join(stateDir, '.kb-write-migrated-2015'), '', 'utf8');
  }
  if (v2016Sentinels) {
    // Default-on for this suite: 2.0.16 and 2.0.17 sub-ops are not under test
    // here and should not mutate the config during unrelated migration tests.
    // Includes DEV1/DEV-A sentinels (W1/W5/W2/D1/D4), DEV-B sentinels (D2/D3/D5/D7),
    // and v2.0.17 T4/T5/T12/T19/T22 sentinels.
    for (const name of [
      '.pattern-record-app-migrated-2016',
      '.cost-budget-enforcement-migrated-2016',
      '.v2016-new-tools-seeded',
      // DEV-A additions (D1/D4)
      '.pattern-deprecate-seeded-2016',
      // DEV-B additions (D2/D3/D5/D7)
      '.pattern-record-app-stage-c-2016',
      '.cost-budget-hard-block-default-2016',
      '.cost-budget-reserve-ttl-seed-2016',
      '.routing-gate-auto-seed-2016',
      // v2.0.17 additions (T4/T5)
      '.v2017-experiments-seeded',
      '.metrics-query-seeded-2017',
      // v2.0.17 additions (T12/T19/T22)
      '.cache-choreography-seeded-2017',
      '.pm-prompt-variant-seeded-2017',
      '.adaptive-verbosity-seeded-2017',
    ]) {
      fs.writeFileSync(path.join(stateDir, name), '', 'utf8');
    }
  }

  return dir;
}

/**
 * Run the sweep script.
 *
 * The caller is responsible for pre-creating or cleaning up any session lock
 * file via `ensureNoLock(sessionId)` / `cleanup.push(lockPath)`.
 *
 * @param {string} cwd     - Isolated project root
 * @param {object} [extra] - Extra fields merged into the hook payload
 */
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

/**
 * Compute the session lock path for a given sessionId.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function lockPathFor(sessionId) {
  return path.join(os.tmpdir(), `orchestray-sweep-${sessionId}.lock`);
}

/** Read config.json from the isolated tmpdir. */
function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.orchestray', 'config.json'), 'utf8'));
}

/** Read checkpoint rows from the isolated tmpdir. */
function readCheckpointRows(dir) {
  const raw = fs.readFileSync(
    path.join(dir, '.orchestray', 'state', 'mcp-checkpoint.jsonl'),
    'utf8'
  );
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/** Check if a sentinel exists in the isolated tmpdir. */
function sentinelExists(dir, name) {
  return fs.existsSync(path.join(dir, '.orchestray', 'state', name));
}

// ──────────────────────────────────────────────────────────────────────────────
// All tests always exit 0 (fail-open)
// ──────────────────────────────────────────────────────────────────────────────

describe('fail-open contract', () => {
  test('always outputs { continue: true } and exits 0', () => {
    const dir = makeDir();
    const { stdout, status } = run(dir);
    assert.equal(status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.continue, true);
  });

  test('exits 0 on garbage stdin', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: 'not json at all',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// W8: Config migration
// ──────────────────────────────────────────────────────────────────────────────

describe('W8 config migration', () => {

  test('W8-A: config has no mcp_enforcement → full default block added', () => {
    const dir = makeDir({ config: { auto_review: true } });
    run(dir);
    const cfg = readConfig(dir);
    assert.ok(cfg.mcp_enforcement, 'mcp_enforcement block should be present');
    assert.equal(cfg.mcp_enforcement.global_kill_switch, false);
    assert.ok(['hook', 'prompt', 'allow'].includes(cfg.mcp_enforcement.pattern_find),
      'pattern_find should have a valid policy value');
    assert.ok(['hook', 'prompt', 'allow'].includes(cfg.mcp_enforcement.kb_search),
      'kb_search should have a valid policy value');
    assert.ok(['block', 'warn', 'allow'].includes(cfg.mcp_enforcement.unknown_tool_policy),
      'unknown_tool_policy should have a valid policy value');
  });

  test('W8-A: sentinel is created after migration', () => {
    const dir = makeDir({ config: { auto_review: true } });
    run(dir);
    assert.ok(sentinelExists(dir, '.config-migrated-2013'), 'sentinel should exist');
  });

  test('W8-B: partial mcp_enforcement → missing keys filled, existing preserved', () => {
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'allow', // user-specified value — must be preserved
          global_kill_switch: false,
          // kb_search, history_find_similar_tasks, pattern_record_application,
          // unknown_tool_policy intentionally absent
        }
      }
    });
    run(dir);
    const cfg = readConfig(dir);
    // Existing value preserved
    assert.equal(cfg.mcp_enforcement.pattern_find, 'allow',
      'user-specified value must be preserved');
    // Missing keys should be filled
    assert.ok('kb_search' in cfg.mcp_enforcement, 'kb_search should be filled in');
    assert.ok('unknown_tool_policy' in cfg.mcp_enforcement, 'unknown_tool_policy should be filled in');
  });

  test('W8-C: config has full mcp_enforcement → no-op (content unchanged)', () => {
    const fullBlock = {
      pattern_find: 'allow',
      kb_search: 'allow',
      history_find_similar_tasks: 'allow',
      pattern_record_application: 'allow',
      unknown_tool_policy: 'warn',
      global_kill_switch: true,
    };
    const dir = makeDir({ config: { mcp_enforcement: fullBlock } });
    run(dir);
    const cfg = readConfig(dir);
    // All values should be exactly as set — no overwriting of present keys
    assert.equal(cfg.mcp_enforcement.pattern_find, 'allow');
    assert.equal(cfg.mcp_enforcement.kb_search, 'allow');
    assert.equal(cfg.mcp_enforcement.unknown_tool_policy, 'warn');
    assert.equal(cfg.mcp_enforcement.global_kill_switch, true);
  });

  test('W8-D: unrelated config keys are preserved after migration', () => {
    const dir = makeDir({
      config: {
        auto_review: true,
        complexity_threshold: 5,
        force_solo: false,
        mcp_enforcement: { pattern_find: 'hook', kb_search: 'hook',
          history_find_similar_tasks: 'hook', pattern_record_application: 'hook',
          unknown_tool_policy: 'block', global_kill_switch: false }
      }
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.auto_review, true, 'auto_review must be preserved');
    assert.equal(cfg.complexity_threshold, 5, 'complexity_threshold must be preserved');
    assert.equal(cfg.force_solo, false, 'force_solo must be preserved');
  });

  test('W8-D: non-schema keys inside mcp_enforcement (e.g. _note) are preserved', () => {
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook', kb_search: 'hook',
          history_find_similar_tasks: 'hook', pattern_record_application: 'hook',
          unknown_tool_policy: 'block', global_kill_switch: false,
          _note: 'important note that must survive',
        }
      }
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_enforcement._note, 'important note that must survive',
      '_note field must be preserved');
  });

  test('W8-E: config sentinel already exists → no migration runs', () => {
    // Config has no mcp_enforcement block, but W8 sentinel is pre-created.
    // We also pre-create W5 (enforcement-keys-migrated-2015) and W6
    // (kb-write-migrated-2015) sentinels so that all config-related migrations
    // are already done — nothing should change the file.
    const dir = makeDir({
      config: { auto_review: true },
      configSentinel: true,
      enforcementKeysSentinel: true,
      kbWriteSentinel: true,
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_enforcement, undefined,
      'mcp_enforcement should not be added when all config migration sentinels already present');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// W11: Ledger phase sweep
// ──────────────────────────────────────────────────────────────────────────────

describe('W11 ledger phase sweep', () => {

  test('W11-F: empty ledger → no-op, sentinel created', () => {
    const dir = makeDir({ checkpointRaw: '' });
    run(dir);
    assert.ok(sentinelExists(dir, '.mcp-checkpoint-migrated-2013'));
    // Empty file stays empty
    const raw = fs.readFileSync(
      path.join(dir, '.orchestray', 'state', 'mcp-checkpoint.jsonl'), 'utf8'
    );
    assert.equal(raw, '');
  });

  test('W11-G: rows with no matching routing entry → all post-decomposition rows flipped', () => {
    // Checkpoint rows for orch-111, no routing entries for orch-111 at all
    const checkpointRaw = [
      JSON.stringify({ timestamp: '2026-04-11T10:00:00.000Z', orchestration_id: 'orch-111', tool: 'pattern_find', outcome: 'answered', phase: 'post-decomposition', result_count: 3 }),
      JSON.stringify({ timestamp: '2026-04-11T10:00:01.000Z', orchestration_id: 'orch-111', tool: 'kb_search', outcome: 'answered', phase: 'post-decomposition', result_count: 2 }),
    ].join('\n') + '\n';
    // routing.jsonl exists but has entries for a different orchestration
    const routingRaw = JSON.stringify({ timestamp: '2026-04-11T09:50:00.000Z', orchestration_id: 'orch-999', task_id: 'T1', agent_type: 'developer' }) + '\n';

    const dir = makeDir({ checkpointRaw, routingRaw });
    run(dir);

    const rows = readCheckpointRows(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].phase, 'pre-decomposition', 'row 0 should be flipped');
    assert.equal(rows[1].phase, 'pre-decomposition', 'row 1 should be flipped');
  });

  test('W11-H: rows with matching routing but all routing-ts > row-ts → flipped', () => {
    // Checkpoint row timestamp is BEFORE all routing entries for same orch-id
    const rowTs = '2026-04-11T10:00:00.000Z';
    const routingTs = '2026-04-11T10:05:00.000Z'; // AFTER the checkpoint row

    const checkpointRaw = JSON.stringify({
      timestamp: rowTs,
      orchestration_id: 'orch-222',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: 1,
    }) + '\n';

    const routingRaw = JSON.stringify({
      timestamp: routingTs,
      orchestration_id: 'orch-222',
      task_id: 'T1',
      agent_type: 'developer',
    }) + '\n';

    const dir = makeDir({ checkpointRaw, routingRaw });
    run(dir);

    const rows = readCheckpointRows(dir);
    assert.equal(rows[0].phase, 'pre-decomposition', 'row should be flipped (routing after checkpoint)');
  });

  test('W11-I: rows with matching routing AND routing-ts < row-ts → left alone (correctly post-decomposition)', () => {
    // Routing entry timestamp is BEFORE the checkpoint row — genuinely post-decomposition
    const rowTs = '2026-04-11T10:05:00.000Z';
    const routingTs = '2026-04-11T10:00:00.000Z'; // BEFORE the checkpoint row

    const checkpointRaw = JSON.stringify({
      timestamp: rowTs,
      orchestration_id: 'orch-333',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: 1,
    }) + '\n';

    const routingRaw = JSON.stringify({
      timestamp: routingTs,
      orchestration_id: 'orch-333',
      task_id: 'T1',
      agent_type: 'developer',
    }) + '\n';

    const dir = makeDir({ checkpointRaw, routingRaw });
    run(dir);

    const rows = readCheckpointRows(dir);
    assert.equal(rows[0].phase, 'post-decomposition', 'row should remain post-decomposition');
    assert.equal(rows[0]._migrated_from_phase, undefined,
      '_migrated_from_phase should not be added to unflipped rows');
  });

  test('W11-J: checkpoint sentinel already exists → no-op even when rows would be flipped', () => {
    const checkpointRaw = JSON.stringify({
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-444',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'post-decomposition', // would normally be flipped
      result_count: 1,
    }) + '\n';
    // No routing entries → would flip without sentinel
    const dir = makeDir({ checkpointRaw, checkpointSentinel: true });
    run(dir);

    const rows = readCheckpointRows(dir);
    assert.equal(rows[0].phase, 'post-decomposition',
      'row must remain unchanged when sentinel exists');
  });

  test('W11-K: corrupted ledger lines are skipped, valid rows still processed (fail-open)', () => {
    // Mix of good and corrupted lines
    const goodRow = JSON.stringify({
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-555',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: 1,
    });
    const checkpointRaw = goodRow + '\n' + 'NOT VALID JSON{{{' + '\n';

    const dir = makeDir({ checkpointRaw });
    // Should not throw
    const { status } = run(dir);
    assert.equal(status, 0, 'must exit 0 even with malformed ledger lines');
  });

  test('W11-L: _migrated_from_phase field added to flipped rows', () => {
    const checkpointRaw = JSON.stringify({
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-666',
      tool: 'kb_search',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: 2,
    }) + '\n';
    // No routing entries → flip
    const dir = makeDir({ checkpointRaw });
    run(dir);

    const rows = readCheckpointRows(dir);
    assert.equal(rows[0].phase, 'pre-decomposition');
    assert.equal(rows[0]._migrated_from_phase, 'post-decomposition',
      '_migrated_from_phase must be set on flipped rows');
  });

  test('W11: pre-decomposition rows are never modified', () => {
    const checkpointRaw = JSON.stringify({
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-777',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: 3,
    }) + '\n';
    const dir = makeDir({ checkpointRaw });
    run(dir);

    const rows = readCheckpointRows(dir);
    assert.equal(rows[0].phase, 'pre-decomposition');
    assert.equal(rows[0]._migrated_from_phase, undefined);
  });

  test('W11: sentinel created after sweep', () => {
    const checkpointRaw = JSON.stringify({
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-888',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: 1,
    }) + '\n';
    const dir = makeDir({ checkpointRaw });
    run(dir);
    assert.ok(sentinelExists(dir, '.mcp-checkpoint-migrated-2013'));
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Session lock
// ──────────────────────────────────────────────────────────────────────────────

describe('session lock', () => {

  test('M: session lock exists → full sweep is a no-op fast-path (config not modified)', () => {
    const dir = makeDir({ config: { auto_review: true } }); // no mcp_enforcement
    const sessionId = 'lock-test-session';
    const lockPath = path.join(os.tmpdir(), `orchestray-sweep-${sessionId}.lock`);
    cleanup.push(lockPath);

    // Pre-create the lock
    fs.writeFileSync(lockPath, '', 'utf8');
    const { status } = run(dir, { session_id: sessionId });
    assert.equal(status, 0, 'must exit 0 even with existing lock');

    // Config should NOT have been modified (lock short-circuited the sweep)
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_enforcement, undefined,
      'mcp_enforcement should not be added when session lock prevents sweep');
  });

  test('N: no session lock → sweep runs and sentinels are created', () => {
    const dir = makeDir({
      config: { auto_review: true },
      checkpointRaw: '',
    });
    const sessionId = 'no-lock-test-session-n';
    const lockPath = lockPathFor(sessionId);
    // Register for cleanup
    cleanup.push(lockPath);
    // Ensure no pre-existing lock
    try { fs.unlinkSync(lockPath); } catch (_e) {}

    const { status } = run(dir, { session_id: sessionId });
    assert.equal(status, 0);

    // W8 sentinel must exist, proving sweep ran
    assert.ok(sentinelExists(dir, '.config-migrated-2013'),
      'W8 sentinel must exist, proving sweep ran when lock was absent');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// W5 (2.0.15): enforcement keys backfill
// ──────────────────────────────────────────────────────────────────────────────

describe('W5 enforcement keys backfill (2.0.15)', () => {

  test('W5-A: existing mcp_enforcement without new 2.0.15 keys → keys backfilled', () => {
    // Simulate a config that was written by the 2.0.13/2.0.14 W8 migration —
    // it has mcp_enforcement but lacks pattern_record_skip_reason and cost_budget_check.
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
        },
      },
      configSentinel: true, // W8 already ran
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_enforcement.pattern_record_skip_reason, 'allow',
      'pattern_record_skip_reason must be backfilled');
    assert.equal(cfg.mcp_enforcement.cost_budget_check, 'allow',
      'cost_budget_check must be backfilled');
    // Existing keys must be preserved
    assert.equal(cfg.mcp_enforcement.pattern_find, 'hook',
      'existing pattern_find must be preserved');
    assert.equal(cfg.mcp_enforcement.unknown_tool_policy, 'block',
      'existing unknown_tool_policy must be preserved');
  });

  test('W5-B: keys already present → no-op (idempotent)', () => {
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'prompt', // user customized
          unknown_tool_policy: 'block',
          global_kill_switch: false,
        },
      },
      configSentinel: true,
    });
    run(dir);
    const cfg = readConfig(dir);
    // User customization must be preserved
    assert.equal(cfg.mcp_enforcement.cost_budget_check, 'prompt',
      'user-customized cost_budget_check value must not be overwritten');
  });

  test('W5-C: sentinel already exists → no-op even when keys are missing', () => {
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
          // pattern_record_skip_reason and cost_budget_check intentionally absent
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true, // W5 already ran
      kbWriteSentinel: true,         // W6 already ran (prevents W6 adding kb_write)
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_enforcement.pattern_record_skip_reason, undefined,
      'keys must not be added when W5 sentinel is already present');
    assert.equal(cfg.mcp_enforcement.cost_budget_check, undefined,
      'keys must not be added when W5 sentinel is already present');
  });

  test('W5-D: sentinel created after successful migration', () => {
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
        },
      },
      configSentinel: true,
    });
    run(dir);
    assert.ok(sentinelExists(dir, '.enforcement-keys-migrated-2015'),
      'W5 sentinel must be created after migration');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Grep anchors — verify the script contains required anchor strings
// ──────────────────────────────────────────────────────────────────────────────

describe('grep anchors', () => {
  test('script contains 2013-W8-config-migration anchor', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('2013-W8-config-migration'),
      'script must contain 2013-W8-config-migration grep anchor');
  });

  test('script contains 2013-W11-ledger-sweep anchor', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('2013-W11-ledger-sweep'),
      'script must contain 2013-W11-ledger-sweep grep anchor');
  });

  test('script contains 2015-W5-enforcement-keys anchor', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('2015-W5-enforcement-keys'),
      'script must contain 2015-W5-enforcement-keys grep anchor');
  });

  test('script contains 2015-W6-kb-write-keys anchor', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('2015-W6-kb-write-keys'),
      'script must contain 2015-W6-kb-write-keys grep anchor');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// W6 (2.0.15): kb_write enable seed
// ──────────────────────────────────────────────────────────────────────────────

describe('W6 kb_write enable seed (2.0.15)', () => {

  test('W6-A: mcp_enforcement.kb_write backfilled when absent', () => {
    // Config has mcp_enforcement but lacks the kb_write key.
    // W6 must add mcp_enforcement.kb_write = 'allow'.
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'allow',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
          // kb_write intentionally absent
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true,  // W5 already ran
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.ok('kb_write' in cfg.mcp_enforcement,
      'W6: mcp_enforcement.kb_write must be added by W6 migration');
    assert.equal(cfg.mcp_enforcement.kb_write, 'allow',
      'W6: mcp_enforcement.kb_write must default to "allow"');
  });

  test('W6-B: mcp_server.tools.kb_write backfilled when absent', () => {
    // Config has mcp_server.tools but lacks kb_write.
    // W6 must add mcp_server.tools.kb_write = true.
    const dir = makeDir({
      config: {
        mcp_server: {
          tools: {
            pattern_find: true,
            // kb_write intentionally absent
          },
        },
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'allow',
          kb_write: 'allow',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true,
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.ok(cfg.mcp_server && cfg.mcp_server.tools,
      'W6: mcp_server.tools must exist');
    assert.equal(cfg.mcp_server.tools.kb_write, true,
      'W6: mcp_server.tools.kb_write must be set to true');
  });

  test('W6-C: both keys already present → no-op (idempotent)', () => {
    // Both mcp_enforcement.kb_write and mcp_server.tools.kb_write already present.
    // W6 must be a no-op and not overwrite user customizations.
    const dir = makeDir({
      config: {
        mcp_server: {
          tools: {
            kb_write: false,  // user explicitly disabled — must be preserved
          },
        },
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'allow',
          kb_write: 'prompt',  // user customized — must be preserved
          unknown_tool_policy: 'block',
          global_kill_switch: false,
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true,
    });
    run(dir);
    const cfg = readConfig(dir);
    // User customizations must be preserved.
    assert.equal(cfg.mcp_enforcement.kb_write, 'prompt',
      'W6: user-customized mcp_enforcement.kb_write must not be overwritten');
    assert.equal(cfg.mcp_server.tools.kb_write, false,
      'W6: user-set mcp_server.tools.kb_write=false must not be overwritten');
  });

  test('W6-D: sentinel created after successful migration', () => {
    // After W6 runs, a .kb-write-migrated-2015 sentinel must be created.
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'allow',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
          // kb_write absent
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true,
    });
    run(dir);
    assert.ok(sentinelExists(dir, '.kb-write-migrated-2015'),
      'W6: .kb-write-migrated-2015 sentinel must be created after migration');
  });

  test('W6-E: sentinel already exists → no-op even when keys are missing', () => {
    // W6 sentinel pre-created — migration must not run.
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'allow',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
          // kb_write intentionally absent — but sentinel exists, so W6 skips
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true,
      kbWriteSentinel: true,  // W6 already ran
    });
    run(dir);
    const cfg = readConfig(dir);
    assert.equal(cfg.mcp_enforcement.kb_write, undefined,
      'W6: kb_write must NOT be added when .kb-write-migrated-2015 sentinel exists');
  });

  test('W6-F: idempotency — running sweep twice does not double-mutate config', () => {
    // Second run must produce same result as first run (idempotent via sentinel).
    const dir = makeDir({
      config: {
        mcp_enforcement: {
          pattern_find: 'hook',
          kb_search: 'hook',
          history_find_similar_tasks: 'hook',
          pattern_record_application: 'hook',
          pattern_record_skip_reason: 'allow',
          cost_budget_check: 'allow',
          unknown_tool_policy: 'block',
          global_kill_switch: false,
          // kb_write absent
        },
      },
      configSentinel: true,
      enforcementKeysSentinel: true,
    });

    // First run — W6 should add kb_write.
    const sessionId1 = 'idempotency-test-w6-session1';
    const lockPath1 = path.join(os.tmpdir(), `orchestray-sweep-${sessionId1}.lock`);
    cleanup.push(lockPath1);
    try { fs.unlinkSync(lockPath1); } catch (_e) {}
    run(dir, { session_id: sessionId1 });
    const cfg1 = readConfig(dir);
    assert.ok('kb_write' in cfg1.mcp_enforcement, 'after first run, kb_write must exist');

    // Second run — sentinel already set; config must be unchanged.
    const sessionId2 = 'idempotency-test-w6-session2';
    const lockPath2 = path.join(os.tmpdir(), `orchestray-sweep-${sessionId2}.lock`);
    cleanup.push(lockPath2);
    try { fs.unlinkSync(lockPath2); } catch (_e) {}
    run(dir, { session_id: sessionId2 });
    const cfg2 = readConfig(dir);
    assert.deepEqual(cfg2, cfg1,
      'W6: second run must produce identical config to first run (idempotent)');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Mixed: both operations run in same sweep
// ──────────────────────────────────────────────────────────────────────────────

describe('combined W8+W11 sweep', () => {

  test('both operations run and both sentinels created in a single sweep invocation', () => {
    const checkpointRaw = JSON.stringify({
      timestamp: '2026-04-11T10:00:00.000Z',
      orchestration_id: 'orch-combined',
      tool: 'pattern_find',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: 1,
    }) + '\n';

    const dir = makeDir({
      config: { auto_review: true }, // no mcp_enforcement
      checkpointRaw,
      // no routing → W11 will flip
    });

    run(dir);

    // W8 ran
    const cfg = readConfig(dir);
    assert.ok(cfg.mcp_enforcement, 'mcp_enforcement block should be added by W8');
    assert.ok(sentinelExists(dir, '.config-migrated-2013'), 'W8 sentinel must exist');

    // W11 ran
    const rows = readCheckpointRows(dir);
    assert.equal(rows[0].phase, 'pre-decomposition', 'W11 should have flipped the row');
    assert.ok(sentinelExists(dir, '.mcp-checkpoint-migrated-2013'), 'W11 sentinel must exist');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// A2-B1 regression: D3 must NOT overwrite an operator's explicit hard_block:false
// ──────────────────────────────────────────────────────────────────────────────

describe('A2-B1 regression: D3 preserves operator hard_block:false', () => {

  /**
   * Run a fresh sweep with only the D3 sentinel absent (all other 2016 sentinels
   * pre-created so the rest of the sweep does not mutate config).
   */
  function makeD3Dir(costBudgetEnforcementBlock) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-d3-test-'));
    cleanup.push(dir);

    const orchestrayDir = path.join(dir, '.orchestray');
    const stateDir = path.join(orchestrayDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Write config with the caller-supplied cost_budget_enforcement block.
    const config = {};
    if (costBudgetEnforcementBlock !== undefined) {
      config.cost_budget_enforcement = costBudgetEnforcementBlock;
    }
    fs.writeFileSync(
      path.join(orchestrayDir, 'config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf8'
    );

    // Pre-create all 2016 sentinels EXCEPT D3 so only D3 runs.
    for (const name of [
      '.config-migrated-2013',
      '.mcp-checkpoint-migrated-2013',
      '.enforcement-keys-migrated-2015',
      '.kb-write-migrated-2015',
      '.pattern-record-app-migrated-2016',
      '.cost-budget-enforcement-migrated-2016',
      '.v2016-new-tools-seeded',
      '.pattern-deprecate-seeded-2016',
      '.pattern-record-app-stage-c-2016',
      // '.cost-budget-hard-block-default-2016',  ← intentionally absent: D3 must run
      '.cost-budget-reserve-ttl-seed-2016',
      '.routing-gate-auto-seed-2016',
    ]) {
      fs.writeFileSync(path.join(stateDir, name), '', 'utf8');
    }

    return dir;
  }

  test('D3-A: existing hard_block:false is preserved (operator choice must not be overwritten)', () => {
    // A2-B1 reproduction: W5 seeds hard_block:false; D3 used to unconditionally flip it to true.
    const dir = makeD3Dir({ enabled: false, hard_block: false });
    const sessionId = 'd3-test-a-' + Date.now();
    const lockPath = lockPathFor(sessionId);
    cleanup.push(lockPath);
    try { fs.unlinkSync(lockPath); } catch (_e) {}

    run(dir, { session_id: sessionId });

    const cfg = readConfig(dir);
    assert.equal(
      cfg.cost_budget_enforcement.hard_block,
      false,
      'D3 must NOT overwrite an existing hard_block:false (A2-B1 regression)'
    );
    assert.ok(
      sentinelExists(dir, '.cost-budget-hard-block-default-2016'),
      'D3 sentinel must be created even when no-op'
    );
  });

  test('D3-B: existing hard_block:true is preserved', () => {
    const dir = makeD3Dir({ enabled: false, hard_block: true });
    const sessionId = 'd3-test-b-' + Date.now();
    const lockPath = lockPathFor(sessionId);
    cleanup.push(lockPath);
    try { fs.unlinkSync(lockPath); } catch (_e) {}

    run(dir, { session_id: sessionId });

    const cfg = readConfig(dir);
    assert.equal(
      cfg.cost_budget_enforcement.hard_block,
      true,
      'D3 must preserve existing hard_block:true'
    );
  });

  test('D3-C: absent cost_budget_enforcement block gets seeded with hard_block:true', () => {
    // When the block is completely absent, D3 seeds the full default (hard_block:true).
    const dir = makeD3Dir(undefined); // no cost_budget_enforcement in config
    const sessionId = 'd3-test-c-' + Date.now();
    const lockPath = lockPathFor(sessionId);
    cleanup.push(lockPath);
    try { fs.unlinkSync(lockPath); } catch (_e) {}

    run(dir, { session_id: sessionId });

    const cfg = readConfig(dir);
    assert.ok(
      cfg.cost_budget_enforcement,
      'D3 must seed cost_budget_enforcement block when absent'
    );
    assert.equal(
      cfg.cost_budget_enforcement.hard_block,
      true,
      'D3 must seed hard_block:true when block was absent'
    );
    assert.ok(
      sentinelExists(dir, '.cost-budget-hard-block-default-2016'),
      'D3 sentinel must be created after seeding'
    );
  });

  test('D3-D: D3 is idempotent — second run is a no-op', () => {
    const dir = makeD3Dir({ enabled: false, hard_block: false });
    const sessionId1 = 'd3-test-d-s1-' + Date.now();
    const lockPath1 = lockPathFor(sessionId1);
    cleanup.push(lockPath1);
    try { fs.unlinkSync(lockPath1); } catch (_e) {}
    run(dir, { session_id: sessionId1 });

    // Second run (sentinel now exists → D3 must no-op).
    const sessionId2 = 'd3-test-d-s2-' + Date.now();
    const lockPath2 = lockPathFor(sessionId2);
    cleanup.push(lockPath2);
    try { fs.unlinkSync(lockPath2); } catch (_e) {}
    run(dir, { session_id: sessionId2 });

    const cfg = readConfig(dir);
    assert.equal(
      cfg.cost_budget_enforcement.hard_block,
      false,
      'D3 idempotency: hard_block:false must survive two sweep runs'
    );
  });

});
