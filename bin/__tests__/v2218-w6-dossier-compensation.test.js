#!/usr/bin/env node
'use strict';

/**
 * v2.2.18 W6 — Dossier compensation re-inject tests.
 *
 * Covers:
 *   1. Compensation path: orphan dossier (write_count>0, inject_count=0)
 *      → injects, emits dossier_compensation_inject.
 *   2. Normal path: inject_count>0 → no compensation, no event.
 *   3. Stale dossier (31 days old): emits dossier_compensation_skipped
 *      with reason='all_archives_stale'.
 *   4. No dossier present: no inject, no event.
 *   5. Size-cap: dossier > 25 KB → dossier_compensation_skipped
 *      with reason='size_cap_exceeded'.
 *   6. Kill switch (env var): dossier_compensation_skipped
 *      with reason='kill_switch_via_env'.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'inject-resilience-dossier.js');
const {
  _tryDossierCompensation,
  COMPENSATION_STALE_MS,
  COMPENSATION_SIZE_CAP_BYTES,
} = require(HOOK);

const {
  buildDossier,
  serializeDossier,
} = require('../_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-w6-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  return tmp;
}

function writeEvents(cwd, events) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function buildDossierString(orchId = 'orch-w6-test') {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: {
      id: orchId,
      phase: 'executing',
      status: 'in_progress',
      complexity_score: 5,
    },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }));
  return serialized;
}

function writeDossier(cwd, content) {
  const p = path.join(cwd, '.orchestray', 'state', 'resilience-dossier.json');
  fs.writeFileSync(p, content);
  return p;
}

function readEmittedEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ }
  }
  return out;
}

function minimalCfg() {
  return { enabled: true, kill_switch: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W6 dossier compensation', () => {
  let tmpDir;
  const origEnv = {};

  beforeEach(() => {
    tmpDir = makeProjectDir();
    // Clear compensation kill-switch to default (off).
    delete process.env.ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('1. compensation path: orphan dossier is injected and event emitted', () => {
    const content = buildDossierString();
    const dossierPath = writeDossier(tmpDir, content);

    // Pre-stage a write event but no inject event → orphan pattern.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const output = _tryDossierCompensation(tmpDir, dossierPath, minimalCfg());

    // Should return an inject output object.
    assert.ok(output !== null, 'expected compensation output, got null');
    assert.ok(
      output && output.hookSpecificOutput && typeof output.hookSpecificOutput.additionalContext === 'string',
      'expected hookSpecificOutput.additionalContext to be a string'
    );

    // Emitted dossier_compensation_inject event.
    const events = readEmittedEvents(tmpDir);
    const compInject = events.find((e) => e.type === 'dossier_compensation_inject');
    assert.ok(compInject, 'expected dossier_compensation_inject event');
    assert.equal(compInject.previous_inject_count, 0);
    assert.ok(typeof compInject.archive_age_seconds === 'number');
    assert.ok(typeof compInject.dossier_path === 'string');
  });

  test('2. normal path: inject_count > 0 → no compensation, no event', () => {
    const content = buildDossierString();
    const dossierPath = writeDossier(tmpDir, content);

    // Both write and inject events present → not an orphan.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
      { type: 'dossier_injected', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const output = _tryDossierCompensation(tmpDir, dossierPath, minimalCfg());
    assert.equal(output, null, 'expected null (no compensation) when inject_count > 0');

    // No compensation event should be emitted.
    const events = readEmittedEvents(tmpDir);
    const compEvents = events.filter((e) => e.type === 'dossier_compensation_inject' || e.type === 'dossier_compensation_skipped');
    assert.equal(compEvents.length, 0, 'expected no compensation events emitted');
  });

  test('3. stale dossier (31 days old): emits dossier_compensation_skipped(all_archives_stale)', () => {
    const content = buildDossierString();
    const dossierPath = writeDossier(tmpDir, content);

    // Set dossier mtime to 31 days ago.
    const thirtyOneDaysAgo = new Date(Date.now() - (31 * 24 * 60 * 60 * 1000));
    fs.utimesSync(dossierPath, thirtyOneDaysAgo, thirtyOneDaysAgo);

    // Orphan pattern.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: thirtyOneDaysAgo.toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const output = _tryDossierCompensation(tmpDir, dossierPath, minimalCfg());
    assert.equal(output, null, 'expected null for stale dossier');

    const events = readEmittedEvents(tmpDir);
    const skip = events.find((e) => e.type === 'dossier_compensation_skipped');
    assert.ok(skip, 'expected dossier_compensation_skipped event');
    assert.equal(skip.reason, 'all_archives_stale');
    assert.ok(typeof skip.archive_age_seconds === 'number');
    assert.ok(skip.archive_age_seconds > COMPENSATION_STALE_MS / 1000);
  });

  test('4. no dossier file present: no inject, no event', () => {
    // Orphan events present but no dossier file.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const missingPath = path.join(tmpDir, '.orchestray', 'state', 'resilience-dossier.json');
    const output = _tryDossierCompensation(tmpDir, missingPath, minimalCfg());
    assert.equal(output, null, 'expected null when dossier file is absent');

    // No compensation events.
    const events = readEmittedEvents(tmpDir);
    const compEvents = events.filter((e) =>
      e.type === 'dossier_compensation_inject' || e.type === 'dossier_compensation_skipped'
    );
    assert.equal(compEvents.length, 0);
  });

  test('5. size cap: dossier > 25 KB → dossier_compensation_skipped(size_cap_exceeded)', () => {
    // Generate a dossier larger than COMPENSATION_SIZE_CAP_BYTES.
    const padding = 'x'.repeat(COMPENSATION_SIZE_CAP_BYTES + 1024);
    // Build a valid JSON but oversized by stuffing padding into a known field.
    const base = buildDossierString();
    // Create a raw JSON object that passes size check but not necessarily schema.
    // We directly write a large JSON string (not necessarily valid dossier schema).
    const oversized = JSON.stringify({ type: 'fake', padding });
    const dossierPath = writeDossier(tmpDir, oversized);

    // Orphan pattern.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const output = _tryDossierCompensation(tmpDir, dossierPath, minimalCfg());
    assert.equal(output, null, 'expected null for oversized dossier');

    const events = readEmittedEvents(tmpDir);
    const skip = events.find((e) => e.type === 'dossier_compensation_skipped');
    assert.ok(skip, 'expected dossier_compensation_skipped event');
    assert.equal(skip.reason, 'size_cap_exceeded');
  });

  test('6. kill switch (env var) → dossier_compensation_skipped(kill_switch_via_env)', () => {
    process.env.ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED = '1';

    const content = buildDossierString();
    const dossierPath = writeDossier(tmpDir, content);

    // Orphan pattern.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const output = _tryDossierCompensation(tmpDir, dossierPath, minimalCfg());
    assert.equal(output, null, 'expected null when kill switch active');

    const events = readEmittedEvents(tmpDir);
    const skip = events.find((e) => e.type === 'dossier_compensation_skipped');
    assert.ok(skip, 'expected dossier_compensation_skipped event');
    assert.equal(skip.reason, 'kill_switch_via_env');

    delete process.env.ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED;
  });

  test('6b. kill switch (config) → dossier_compensation_skipped(kill_switch_via_config)', () => {
    const content = buildDossierString();
    const dossierPath = writeDossier(tmpDir, content);

    // Orphan pattern.
    writeEvents(tmpDir, [
      { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w6-test' },
    ]);

    const cfgWithKillSwitch = Object.assign(minimalCfg(), { dossier_compensation: { enabled: false } });
    const output = _tryDossierCompensation(tmpDir, dossierPath, cfgWithKillSwitch);
    assert.equal(output, null, 'expected null when config kill switch active');

    const events = readEmittedEvents(tmpDir);
    const skip = events.find((e) => e.type === 'dossier_compensation_skipped');
    assert.ok(skip, 'expected dossier_compensation_skipped event');
    assert.equal(skip.reason, 'kill_switch_via_config');
  });
});
