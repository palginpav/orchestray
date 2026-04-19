#!/usr/bin/env node
'use strict';

/**
 * Unit tests — bin/inject-resilience-dossier.js
 *
 * Covers every branch of handleUserPromptSubmit:
 *   - no-lock        → skipped_no_lock (silent)
 *   - lock-present + fresh dossier → injected (fence emitted)
 *   - counter at cap → skipped_counter
 *   - dossier missing → skipped_no_dossier
 *   - dossier corrupt → skipped_corrupt + dossier_corrupt journal
 *   - dossier completed → skipped_stale
 *   - shadow_mode=true → shadow_dry_run (no fence)
 *   - kill-switch env var → skipped_kill_switch
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDossier, serializeDossier } =
  require('../../bin/_lib/resilience-dossier-schema');

function freshModule(relPath) {
  const p = require.resolve(relPath);
  delete require.cache[p];
  // Also reset degraded-journal's per-process dedup set.
  const djp = require.resolve('../../bin/_lib/degraded-journal');
  delete require.cache[djp];
  return require(relPath);
}

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function writeLock(cwd, payload) {
  const p = path.join(cwd, '.orchestray', 'state', 'compact-signal.lock');
  fs.writeFileSync(p, JSON.stringify(payload));
}

function writeDossier(cwd, sourcesOverride) {
  const { serialized } = serializeDossier(buildDossier(Object.assign({
    orchestration: { id: 'orch-XYZ', phase: 'implementation', status: 'in_progress', complexity_score: 7 },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }, sourcesOverride || {})));
  fs.writeFileSync(path.join(cwd, '.orchestray', 'state', 'resilience-dossier.json'), serialized);
  return serialized;
}

function readLock(cwd) {
  const p = path.join(cwd, '.orchestray', 'state', 'compact-signal.lock');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('handleUserPromptSubmit — branches', () => {
  test('no lock → silent skip', () => {
    const cwd = mkProject();
    writeDossier(cwd);
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_no_lock');
    assert.equal(r.output.continue, true);
    assert.ok(!r.output.hookSpecificOutput);
  });

  test('lock-present + fresh dossier → injected with fence', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: new Date().toISOString(), ingested_count: 0, max_injections: 3 });
    writeDossier(cwd);
    const { handleUserPromptSubmit, FENCE_OPEN, FENCE_CLOSE } =
      freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'injected');
    assert.equal(r.counter_before, 0);
    assert.equal(r.counter_after, 1);
    assert.ok(r.output.hookSpecificOutput);
    const ctx = r.output.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(FENCE_OPEN));
    assert.ok(ctx.includes(FENCE_CLOSE));
    assert.ok(ctx.includes('orch-XYZ'));
    // Counter advanced on disk.
    const lock = readLock(cwd);
    assert.equal(lock.ingested_count, 1);
  });

  test('counter exhausted → skipped and lock deleted', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: new Date().toISOString(), ingested_count: 3, max_injections: 3 });
    writeDossier(cwd);
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_counter');
    assert.equal(readLock(cwd), null, 'lock should be deleted after exhaustion');
  });

  test('dossier missing → skipped_no_dossier', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: 'x', ingested_count: 0, max_injections: 3 });
    // no dossier file
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_no_dossier');
  });

  test('corrupt dossier → skipped_corrupt, does not crash', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: 'x', ingested_count: 0, max_injections: 3 });
    fs.writeFileSync(path.join(cwd, '.orchestray', 'state', 'resilience-dossier.json'), '{not-json');
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_corrupt');
    // Degraded journal should have an entry.
    const j = path.join(cwd, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(j), 'degraded journal should exist');
    const lines = fs.readFileSync(j, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(lines.some((l) => l.kind === 'dossier_corrupt'));
  });

  test('future schema version → corrupt + skip', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: 'x', ingested_count: 0, max_injections: 3 });
    fs.writeFileSync(
      path.join(cwd, '.orchestray', 'state', 'resilience-dossier.json'),
      JSON.stringify({ schema_version: 99, written_at: 'x', orchestration_id: 'x', phase: 'x', status: 'in_progress', complexity_score: 1, current_group_id: null, pending_task_ids: [], completed_task_ids: [], cost_so_far_usd: null, cost_budget_remaining_usd: null, last_compact_detected_at: null, ingested_counter: 0 })
    );
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_corrupt');
    assert.equal(r.reason, 'schema_mismatch');
  });

  test('status=completed → skipped_stale', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: 'x', ingested_count: 0, max_injections: 3 });
    writeDossier(cwd, {
      orchestration: { id: 'orch-DONE', phase: 'complete', status: 'completed', complexity_score: 5 },
    });
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_stale');
  });

  test('shadow_mode=true → writes telemetry but does NOT inject', () => {
    const cwd = mkProject();
    fs.writeFileSync(
      path.join(cwd, '.orchestray', 'config.json'),
      JSON.stringify({ resilience: { shadow_mode: true } })
    );
    writeLock(cwd, { source: 'compact', at: 'x', ingested_count: 0, max_injections: 3 });
    writeDossier(cwd);
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'shadow_dry_run');
    assert.ok(!r.output.hookSpecificOutput,
      'shadow mode MUST NOT emit additionalContext');
    // Counter should NOT advance in shadow mode.
    const lock = readLock(cwd);
    assert.equal(lock.ingested_count, 0);
  });

  test('env kill-switch → skipped_kill_switch', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: 'x', ingested_count: 0, max_injections: 3 });
    writeDossier(cwd);
    const prior = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
    try {
      const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
      const r = handleUserPromptSubmit({ cwd });
      assert.equal(r.action, 'skipped_kill_switch');
      assert.ok(!r.output.hookSpecificOutput);
    } finally {
      if (prior === undefined) delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      else process.env.ORCHESTRAY_RESILIENCE_DISABLED = prior;
    }
  });

  test('corrupt lock → cleans up and skips', () => {
    const cwd = mkProject();
    fs.writeFileSync(path.join(cwd, '.orchestray', 'state', 'compact-signal.lock'), '{not-lock');
    writeDossier(cwd);
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_corrupt');
    assert.equal(readLock(cwd), null,
      'corrupt lock should be cleaned up to avoid infinite loop');
  });
});

// ---------------------------------------------------------------------------
// D3: ingested_counter absent from serialized dossier (schema v2)
// ---------------------------------------------------------------------------

describe('D3 — ingested_counter absent from dossier on inject', () => {
  test('injected dossier JSON does not contain ingested_counter field', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: new Date().toISOString(), ingested_count: 0, max_injections: 3 });
    writeDossier(cwd);
    // Read the dossier that was written.
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'state', 'resilience-dossier.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(!('ingested_counter' in parsed),
      'schema v2 dossier must not contain ingested_counter field');
    assert.equal(parsed.schema_version, 2, 'schema_version must be 2');
  });

  test('schema_version=1 dossier with ingested_counter is accepted by injector (compat shim)', () => {
    const cwd = mkProject();
    writeLock(cwd, { source: 'compact', at: new Date().toISOString(), ingested_count: 0, max_injections: 3 });
    // Write a v1 dossier manually (pre-patch format).
    const v1 = {
      schema_version: 1,
      written_at: new Date().toISOString(),
      orchestration_id: 'orch-COMPAT',
      phase: 'implementation',
      status: 'in_progress',
      complexity_score: 5,
      current_group_id: null,
      pending_task_ids: ['W1'],
      completed_task_ids: [],
      cost_so_far_usd: null,
      cost_budget_remaining_usd: null,
      last_compact_detected_at: null,
      ingested_counter: 0,  // vestigial — compat shim must drop silently
    };
    fs.writeFileSync(
      path.join(cwd, '.orchestray', 'state', 'resilience-dossier.json'),
      JSON.stringify(v1)
    );
    const { handleUserPromptSubmit } = freshModule('../../bin/inject-resilience-dossier');
    const r = handleUserPromptSubmit({ cwd });
    // Compat shim allows v1 dossiers: injector should inject, not reject.
    assert.equal(r.action, 'injected',
      'v1 dossier with ingested_counter must be accepted by compat shim');
  });
});
