#!/usr/bin/env node
'use strict';

/**
 * Tests for the FC3b legacy-key auto-strip in bin/post-upgrade-sweep.js.
 *
 * runFC3bLegacyKeyStrip removes pm_prompt_variant and pm_prose_strip from
 * .orchestray/config.json on every invocation. It emits a config_key_stripped
 * audit event listing the stripped keys. It is idempotent: a second run on the
 * same config is a no-op and emits no event.
 *
 * Coverage:
 *   STRIP-A — config with pm_prompt_variant only → key removed, event emitted
 *   STRIP-B — config with both pm_prompt_variant and pm_prose_strip → both removed, event lists both
 *   STRIP-C — config with neither key → no-op, no event emitted
 *   STRIP-D — idempotency: second run on post-strip config is a no-op (no second event)
 *   STRIP-E — other config keys are preserved byte-exactly around the strip
 *   STRIP-F — pm_prose_strip inside v2017_experiments sub-object is also stripped
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/post-upgrade-sweep.js');

/** Default session ID used when tests don't supply their own. */
const DEFAULT_SESSION_ID = 'fc3b-strip-test-default-session';

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

/**
 * Create a fresh isolated tmpdir with .orchestray/state/ and optional config.
 * All prior-migration sentinels are pre-created so the non-FC3b sweep sub-ops
 * are skipped and don't interfere with the config under test.
 */
function makeDir({ config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fc3b-strip-test-'));
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

  // Pre-create all prior-migration sentinels so no unrelated sub-operation
  // touches the config during these tests.
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
    '.cost-budget-hard-block-default-2016',
    '.cost-budget-reserve-ttl-seed-2016',
    '.routing-gate-auto-seed-2016',
    '.v2017-experiments-seeded',
    '.metrics-query-seeded-2017',
    '.cache-choreography-seeded-2017',
    '.pm-prompt-variant-seeded-2017',
    '.adaptive-verbosity-seeded-2017',
    '.pricing-table-migrated-2014',
  ]) {
    fs.writeFileSync(path.join(stateDir, name), '', 'utf8');
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

/**
 * Read the audit events.jsonl and return all config_key_stripped events.
 */
function readStripEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  try {
    const raw = fs.readFileSync(eventsPath, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
      .filter(e => e.type === 'config_key_stripped');
  } catch (_e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FC3b legacy-key auto-strip', () => {

  test('STRIP-A: config with pm_prompt_variant only → key removed, event emitted', () => {
    const sessionId = 'fc3b-strip-a';
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const dir = makeDir({
      config: {
        auto_review: true,
        pm_prompt_variant: 'lean',
        v2017_experiments: { __schema_version: 1, global_kill_switch: false, prompt_caching: 'off', adaptive_verbosity: 'off' },
      },
    });

    run(dir, { session_id: sessionId });
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const cfg = readConfig(dir);
    assert.ok(!('pm_prompt_variant' in cfg), 'pm_prompt_variant should be stripped');
    assert.strictEqual(cfg.auto_review, true, 'other keys must be preserved');

    const events = readStripEvents(dir);
    assert.strictEqual(events.length, 1, 'exactly one strip event should be emitted');
    assert.deepStrictEqual(events[0].keys_stripped, ['pm_prompt_variant']);
    assert.strictEqual(events[0].release, '2.0.18');
  });

  test('STRIP-B: config with both pm_prompt_variant and pm_prose_strip → both removed, event lists both', () => {
    const sessionId = 'fc3b-strip-b';
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const dir = makeDir({
      config: {
        auto_review: false,
        pm_prompt_variant: 'fat',
        v2017_experiments: {
          __schema_version: 1,
          global_kill_switch: false,
          prompt_caching: 'off',
          pm_prose_strip: 'off',
          adaptive_verbosity: 'off',
        },
      },
    });

    run(dir, { session_id: sessionId });
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const cfg = readConfig(dir);
    assert.ok(!('pm_prompt_variant' in cfg), 'pm_prompt_variant should be stripped');
    // pm_prose_strip in v2017_experiments should also be gone
    assert.ok(!('pm_prose_strip' in cfg.v2017_experiments), 'pm_prose_strip should be stripped from v2017_experiments');

    const events = readStripEvents(dir);
    assert.strictEqual(events.length, 1, 'exactly one strip event');
    assert.deepStrictEqual(events[0].keys_stripped, ['pm_prompt_variant']);
    assert.strictEqual(events[0].release, '2.0.18');
  });

  test('STRIP-C: config with neither key → no-op, no event emitted', () => {
    const sessionId = 'fc3b-strip-c';
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const dir = makeDir({
      config: {
        auto_review: true,
        v2017_experiments: { __schema_version: 1, global_kill_switch: false, prompt_caching: 'off', adaptive_verbosity: 'off' },
      },
    });

    run(dir, { session_id: sessionId });
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const cfg = readConfig(dir);
    assert.strictEqual(cfg.auto_review, true, 'config must be unchanged');

    const events = readStripEvents(dir);
    assert.strictEqual(events.length, 0, 'no strip event should be emitted for a no-op');
  });

  test('STRIP-D: idempotency — second run on already-stripped config emits no additional event', () => {
    const session1 = 'fc3b-strip-d-run1';
    const session2 = 'fc3b-strip-d-run2';
    try { fs.unlinkSync(lockPathFor(session1)); } catch (_e) {}
    try { fs.unlinkSync(lockPathFor(session2)); } catch (_e) {}

    const dir = makeDir({
      config: {
        complexity_threshold: 4,
        pm_prompt_variant: 'lean',
        v2017_experiments: { __schema_version: 1, global_kill_switch: false, prompt_caching: 'off', pm_prose_strip: 'off', adaptive_verbosity: 'off' },
      },
    });

    // First run — strips the keys and emits an event.
    run(dir, { session_id: session1 });
    try { fs.unlinkSync(lockPathFor(session1)); } catch (_e) {}

    const eventsAfterRun1 = readStripEvents(dir);
    assert.strictEqual(eventsAfterRun1.length, 1, 'first run should emit exactly one event');

    const cfgAfterRun1 = readConfig(dir);
    assert.ok(!('pm_prompt_variant' in cfgAfterRun1), 'pm_prompt_variant stripped after run 1');

    // Second run — keys are gone, should be a no-op with no additional event.
    run(dir, { session_id: session2 });
    try { fs.unlinkSync(lockPathFor(session2)); } catch (_e) {}

    const eventsAfterRun2 = readStripEvents(dir);
    assert.strictEqual(eventsAfterRun2.length, 1, 'second run must not emit another strip event');

    const cfgAfterRun2 = readConfig(dir);
    assert.deepStrictEqual(cfgAfterRun2, cfgAfterRun1, 'config must be identical after second run');
  });

  test('STRIP-E: other config keys are preserved byte-exactly around the strip', () => {
    const sessionId = 'fc3b-strip-e';
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const originalConfig = {
      auto_review: true,
      max_retries: 3,
      complexity_threshold: 4,
      pm_prompt_variant: 'lean',
      v2017_experiments: {
        __schema_version: 1,
        global_kill_switch: false,
        prompt_caching: 'off',
        adaptive_verbosity: 'off',
      },
      adaptive_verbosity: {
        enabled: false,
        base_response_tokens: 2000,
      },
    };

    const dir = makeDir({ config: originalConfig });

    run(dir, { session_id: sessionId });
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const cfg = readConfig(dir);

    // Strip target gone.
    assert.ok(!('pm_prompt_variant' in cfg), 'pm_prompt_variant must be stripped');

    // All other top-level keys intact.
    assert.strictEqual(cfg.auto_review, true);
    assert.strictEqual(cfg.max_retries, 3);
    assert.strictEqual(cfg.complexity_threshold, 4);
    assert.deepStrictEqual(cfg.v2017_experiments, {
      __schema_version: 1,
      global_kill_switch: false,
      prompt_caching: 'off',
      adaptive_verbosity: 'off',
    });
    assert.deepStrictEqual(cfg.adaptive_verbosity, {
      enabled: false,
      base_response_tokens: 2000,
    });
  });

  test('STRIP-F: pm_prose_strip inside v2017_experiments is stripped even when top-level key absent', () => {
    const sessionId = 'fc3b-strip-f';
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const dir = makeDir({
      config: {
        auto_review: true,
        v2017_experiments: {
          __schema_version: 1,
          global_kill_switch: false,
          prompt_caching: 'off',
          pm_prose_strip: 'shadow',
          adaptive_verbosity: 'off',
        },
      },
    });

    // Note: pm_prose_strip inside v2017_experiments is not a top-level key so it
    // won't trigger a top-level strip event, but it must still be removed.
    run(dir, { session_id: sessionId });
    try { fs.unlinkSync(lockPathFor(sessionId)); } catch (_e) {}

    const cfg = readConfig(dir);
    assert.ok(
      !('pm_prose_strip' in cfg.v2017_experiments),
      'pm_prose_strip must be removed from v2017_experiments'
    );
    assert.strictEqual(cfg.v2017_experiments.prompt_caching, 'off', 'other experiment flags preserved');
    assert.strictEqual(cfg.v2017_experiments.adaptive_verbosity, 'off', 'other experiment flags preserved');
  });

});
