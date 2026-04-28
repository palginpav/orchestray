#!/usr/bin/env node
'use strict';

/**
 * v2.2.9 B-3.2 — Dossier-injection skip-coverage test.
 *
 * For each of the documented silent-skip branches in
 * `bin/inject-resilience-dossier.js`, construct a synthetic input that
 * triggers exactly that branch and assert exactly one
 * `dossier_injection_skipped` event with the correct `skip_reason` is emitted.
 *
 * Anti-regression guarantee: every early-return path now lands a categorised
 * skip event in events.jsonl. No branch returns silently. The orphan auditor
 * (`bin/audit-dossier-orphan.js`) consumes this stream.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'inject-resilience-dossier.js');

const {
  handleUserPromptSubmit,
  handleSessionStart,
  SKIP_REASON,
} = require(HOOK);

const {
  buildDossier,
  serializeDossier,
} = require('../_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMinimalDossierRaw(orchId = 'orch-v229-skip') {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: { id: orchId, phase: 'executing', status: 'in_progress', complexity_score: 5 },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }));
  return serialized;
}

function buildCompletedDossierRaw(orchId = 'orch-v229-skip-completed') {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: { id: orchId, phase: 'completed', status: 'completed', complexity_score: 5 },
    task_ids: { pending: [], completed: ['W1'], failed: [] },
  }));
  return serialized;
}

function makeProjectDir({ dossierRaw, withLock = true, lockPayload, config = null, withCounter } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-skip-'));
  const orchestrayDir = path.join(tmp, '.orchestray');
  const stateDir = path.join(orchestrayDir, 'state');
  const auditDir = path.join(orchestrayDir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  if (dossierRaw !== undefined && dossierRaw !== null) {
    fs.writeFileSync(path.join(stateDir, 'resilience-dossier.json'), dossierRaw);
  }

  if (withLock) {
    const lock = lockPayload != null ? lockPayload : JSON.stringify({
      source: 'compact',
      ingested_count: withCounter != null ? withCounter : 0,
      max_injections: 3,
      written_at: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(stateDir, 'compact-signal.lock'), lock);
  }

  if (config) {
    fs.writeFileSync(path.join(orchestrayDir, 'config.json'), JSON.stringify(config, null, 2));
  }

  return tmp;
}

function readEvents(cwd) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ }
  }
  return out;
}

function skipEvents(cwd) {
  return readEvents(cwd).filter((ev) => ev && ev.type === 'dossier_injection_skipped');
}

/**
 * Run a function with selected env vars temporarily set.
 */
function withEnv(envOverrides, fn) {
  const prior = {};
  for (const k of Object.keys(envOverrides)) {
    prior[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = envOverrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(prior)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

// ---------------------------------------------------------------------------
// UserPromptSubmit branches
// ---------------------------------------------------------------------------

describe('v2.2.9 B-3.2 — UserPromptSubmit skip coverage', () => {
  test('SKIP-1: env kill switch → kill_switch_set/env_kill_switch', () => {
    const cwd = makeProjectDir({ withLock: false });
    withEnv({ ORCHESTRAY_RESILIENCE_DISABLED: '1' }, () => {
      const result = handleUserPromptSubmit({ cwd });
      assert.equal(result.action, 'skipped_kill_switch');
    });
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].sub_reason, 'env_kill_switch');
    assert.equal(skips[0].trigger, 'UserPromptSubmit');
    assert.equal(skips[0].dossier_path, '.orchestray/state/resilience-dossier.json');
  });

  test('SKIP-2: config kill_switch → kill_switch_set/config_kill_switch', () => {
    const cwd = makeProjectDir({
      withLock: false,
      config: { resilience: { enabled: true, kill_switch: true } },
    });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_config');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].sub_reason, 'config_kill_switch');
  });

  test('SKIP-3: no compact-signal.lock → not_session_start/no_lock', () => {
    const cwd = makeProjectDir({ withLock: false });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_no_lock');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.NOT_SESSION_START);
    assert.equal(skips[0].sub_reason, 'no_lock');
    assert.equal(skips[0].trigger, 'UserPromptSubmit');
  });

  test('SKIP-4: lock parse error → dossier_file_corrupt/lock_parse_failed', () => {
    const cwd = makeProjectDir({ withLock: true, lockPayload: '{not valid json' });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_corrupt');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_FILE_CORRUPT);
    assert.equal(skips[0].sub_reason, 'lock_parse_failed');
  });

  test('SKIP-5: counter exhausted → kill_switch_set/counter_exhausted', () => {
    const cwd = makeProjectDir({ withCounter: 5 });
    // max_injections defaults to 3 in lock; counter 5 >= 3.
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_counter');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].sub_reason, 'counter_exhausted');
    assert.equal(skips[0].counter, 5);
    assert.equal(skips[0].max, 3);
  });

  test('SKIP-6: dossier file missing → dossier_file_missing', () => {
    const cwd = makeProjectDir({ dossierRaw: null, withLock: true });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_no_dossier');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_FILE_MISSING);
    assert.equal(skips[0].lock_source, 'compact');
  });

  test('SKIP-8: dossier parse failure → dossier_file_corrupt/parse_failed', () => {
    const cwd = makeProjectDir({ dossierRaw: '{garbage}}', withLock: true });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_corrupt');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_FILE_CORRUPT);
    assert.equal(skips[0].sub_reason, 'parse_failed');
    assert.ok(skips[0].parse_reason, 'parse_reason should be set');
  });

  test('SKIP-10: dossier completed → dossier_stale/completed', () => {
    const cwd = makeProjectDir({ dossierRaw: buildCompletedDossierRaw('orch-stale-x') });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'skipped_stale');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_STALE);
    assert.equal(skips[0].sub_reason, 'completed');
    assert.equal(skips[0].orchestration_id, 'orch-stale-x');
  });

  test('SKIP-11: shadow_mode → kill_switch_set/shadow_mode', () => {
    const cwd = makeProjectDir({
      dossierRaw: buildMinimalDossierRaw('orch-shadow-x'),
      config: { resilience: { enabled: true, shadow_mode: true } },
    });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'shadow_dry_run');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].sub_reason, 'shadow_mode');
  });

  test('Kill switch ORCHESTRAY_DOSSIER_INJECT_TELEMETRY_DISABLED suppresses skip telemetry only', () => {
    const cwd = makeProjectDir({ withLock: false });
    withEnv({ ORCHESTRAY_DOSSIER_INJECT_TELEMETRY_DISABLED: '1' }, () => {
      const result = handleUserPromptSubmit({ cwd });
      assert.equal(result.action, 'skipped_no_lock');
    });
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 0, 'telemetry kill-switch should suppress dossier_injection_skipped');
  });
});

// ---------------------------------------------------------------------------
// SessionStart branches
// ---------------------------------------------------------------------------

describe('v2.2.9 B-3.2 — SessionStart skip coverage', () => {
  test('SKIP-13: SessionStart env kill switch → kill_switch_set/env_kill_switch', () => {
    const cwd = makeProjectDir({ withLock: false });
    withEnv({ ORCHESTRAY_RESILIENCE_DISABLED: '1' }, () => {
      const result = handleSessionStart({ cwd });
      assert.equal(result.action, 'skipped_kill_switch');
    });
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].trigger, 'SessionStart');
  });

  test('SKIP-14: SessionStart config disabled → kill_switch_set/config_disabled', () => {
    const cwd = makeProjectDir({
      withLock: false,
      config: { resilience: { enabled: false } },
    });
    const result = handleSessionStart({ cwd });
    assert.equal(result.action, 'skipped_config');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].sub_reason, 'config_disabled');
    assert.equal(skips[0].trigger, 'SessionStart');
  });

  test('SKIP-15: SessionStart dossier missing → dossier_file_missing', () => {
    const cwd = makeProjectDir({ dossierRaw: null, withLock: false });
    const result = handleSessionStart({ cwd });
    assert.equal(result.action, 'skipped_no_dossier');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_FILE_MISSING);
    assert.equal(skips[0].trigger, 'SessionStart');
  });

  test('SKIP-17: SessionStart parse failure → dossier_file_corrupt/parse_failed', () => {
    const cwd = makeProjectDir({ dossierRaw: '{junk}', withLock: false });
    const result = handleSessionStart({ cwd });
    assert.equal(result.action, 'skipped_corrupt');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_FILE_CORRUPT);
    assert.equal(skips[0].sub_reason, 'parse_failed');
    assert.equal(skips[0].trigger, 'SessionStart');
  });

  test('SKIP-18: SessionStart completed dossier → dossier_stale/completed', () => {
    const cwd = makeProjectDir({
      dossierRaw: buildCompletedDossierRaw('orch-ss-stale'),
      withLock: false,
    });
    const result = handleSessionStart({ cwd });
    assert.equal(result.action, 'skipped_stale');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.DOSSIER_STALE);
    assert.equal(skips[0].trigger, 'SessionStart');
    assert.equal(skips[0].orchestration_id, 'orch-ss-stale');
  });

  test('SKIP-19: SessionStart shadow_mode → kill_switch_set/shadow_mode', () => {
    const cwd = makeProjectDir({
      dossierRaw: buildMinimalDossierRaw('orch-ss-shadow'),
      withLock: false,
      config: { resilience: { enabled: true, shadow_mode: true } },
    });
    const result = handleSessionStart({ cwd });
    assert.equal(result.action, 'shadow_dry_run');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skip_reason, SKIP_REASON.KILL_SWITCH_SET);
    assert.equal(skips[0].sub_reason, 'shadow_mode');
    assert.equal(skips[0].trigger, 'SessionStart');
  });
});

// ---------------------------------------------------------------------------
// No-silent-skip invariant: every non-success outcome has exactly one skip event
// ---------------------------------------------------------------------------

describe('v2.2.9 B-3.2 — no silent skip invariant', () => {
  test('Every UserPromptSubmit non-success outcome lands exactly one dossier_injection_skipped', () => {
    const fixtures = [
      { name: 'no_lock', setup: () => makeProjectDir({ withLock: false }) },
      { name: 'lock_parse', setup: () => makeProjectDir({ lockPayload: 'broken' }) },
      { name: 'no_dossier', setup: () => makeProjectDir({ dossierRaw: null }) },
      { name: 'parse_failed', setup: () => makeProjectDir({ dossierRaw: '{x}' }) },
      { name: 'completed', setup: () => makeProjectDir({ dossierRaw: buildCompletedDossierRaw() }) },
      { name: 'counter_exhausted', setup: () => makeProjectDir({ withCounter: 99 }) },
      {
        name: 'shadow_mode',
        setup: () => makeProjectDir({
          dossierRaw: buildMinimalDossierRaw(),
          config: { resilience: { enabled: true, shadow_mode: true } },
        }),
      },
    ];
    for (const f of fixtures) {
      const cwd = f.setup();
      handleUserPromptSubmit({ cwd });
      const skips = skipEvents(cwd);
      assert.equal(
        skips.length,
        1,
        `[${f.name}] expected exactly 1 dossier_injection_skipped event, got ${skips.length}`,
      );
      // Every emit must carry the canonical fields.
      assert.equal(skips[0].type, 'dossier_injection_skipped');
      assert.equal(skips[0].version, 1);
      assert.ok(typeof skips[0].skip_reason === 'string' && skips[0].skip_reason.length > 0,
        `[${f.name}] skip_reason missing`);
      assert.equal(skips[0].dossier_path, '.orchestray/state/resilience-dossier.json');
    }
  });

  test('Successful inject path emits dossier_injected (NOT dossier_injection_skipped) with version: 1', () => {
    const cwd = makeProjectDir({ dossierRaw: buildMinimalDossierRaw('orch-success') });
    const result = handleUserPromptSubmit({ cwd });
    assert.equal(result.action, 'injected');
    const skips = skipEvents(cwd);
    assert.equal(skips.length, 0, 'success path must not emit skip event');
    const events = readEvents(cwd);
    const injected = events.filter((ev) => ev.type === 'dossier_injected');
    assert.equal(injected.length, 1);
    assert.equal(injected[0].version, 1, 'dossier_injected must carry version: 1 explicitly');
  });
});
