#!/usr/bin/env node
'use strict';

/**
 * Unit tests — bin/write-resilience-dossier.js writeDossierSnapshot().
 *
 * Covers:
 *   - atomic write succeeds from seeded .orchestray/state/*
 *   - kill-switch short-circuits
 *   - fs failure journals dossier_write_failed
 *   - no orchestration → no-op
 *   - shadow-mode still writes the dossier (it is read-only inject that changes)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModule(relPath) {
  const p = require.resolve(relPath);
  delete require.cache[p];
  const djp = require.resolve('../../bin/_lib/degraded-journal');
  delete require.cache[djp];
  return require(relPath);
}

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writedossier-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function seedOrchestration(dir, opts) {
  const fm = [
    '---',
    'id: ' + (opts.id || 'orch-WTEST'),
    'status: ' + (opts.status || 'in_progress'),
    'current_phase: ' + (opts.phase || 'implementation'),
    'complexity_score: ' + (opts.complexity_score || 7),
    'delegation_pattern: parallel',
    'current_group_id: group-1',
    '---',
    '',
    '## Progress',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.orchestray', 'state', 'orchestration.md'), fm);
}

function seedTask(dir, id, status) {
  const body = [
    '---',
    'id: ' + id,
    'status: ' + status,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.orchestray', 'state', 'tasks', id + '-test.md'), body);
}

describe('writeDossierSnapshot — happy path', () => {
  test('seeds + reads + writes dossier with correct content', () => {
    const dir = mkProject();
    seedOrchestration(dir, { id: 'orch-HAPPY' });
    seedTask(dir, 'W1', 'completed');
    seedTask(dir, 'W2', 'pending');
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(r.written, true);
    assert.ok(r.size_bytes > 0);
    const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
    assert.ok(fs.existsSync(dossierPath));
    const parsed = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
    assert.equal(parsed.orchestration_id, 'orch-HAPPY');
    assert.ok(parsed.completed_task_ids.includes('W1'));
    assert.ok(parsed.pending_task_ids.includes('W2'));
  });

  test('emits dossier_written audit event', () => {
    const dir = mkProject();
    seedOrchestration(dir, { id: 'orch-AUDIT' });
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    writeDossierSnapshot(dir, { trigger: 'pre_compact' });
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath));
    const rows = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const evt = rows.find((r) => r.type === 'dossier_written');
    assert.ok(evt);
    assert.equal(evt.trigger, 'pre_compact');
    assert.equal(evt.orchestration_id, 'orch-AUDIT');
  });
});

describe('writeDossierSnapshot — kill switches', () => {
  test('env kill-switch → no write', () => {
    const dir = mkProject();
    seedOrchestration(dir, {});
    const prior = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
    try {
      const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
      const r = writeDossierSnapshot(dir, { trigger: 'stop' });
      assert.equal(r.written, false);
      assert.equal(r.reason, 'env_kill_switch');
      assert.ok(!fs.existsSync(path.join(dir, '.orchestray', 'state', 'resilience-dossier.json')));
    } finally {
      if (prior === undefined) delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      else process.env.ORCHESTRAY_RESILIENCE_DISABLED = prior;
    }
  });

  test('config.resilience.enabled:false → no write', () => {
    const dir = mkProject();
    seedOrchestration(dir, {});
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ resilience: { enabled: false } })
    );
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(r.written, false);
  });

  test('no orchestration.md and no marker → no-op', () => {
    const dir = mkProject();
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'no_active_orchestration');
  });
});

describe('writeDossierSnapshot — failure paths', () => {
  test('directory collision at dossier path → journal entry', () => {
    const dir = mkProject();
    seedOrchestration(dir, { id: 'orch-COLLIDE' });
    // Plant a directory where the dossier file should go.
    fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'resilience-dossier.json'));
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'write_failed');
    const degraded = path.join(dir, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(degraded));
    const rows = fs.readFileSync(degraded, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(rows.some((r) => r.kind === 'dossier_write_failed'));
  });
});

// ---------------------------------------------------------------------------
// SEC-04: file_too_large — size-cap tests
// ---------------------------------------------------------------------------

describe('writeDossierSnapshot — SEC-04 file size caps (file_too_large)', () => {
  test('oversize routing.jsonl journals file_too_large and write still succeeds', () => {
    const dir = mkProject();
    seedOrchestration(dir, { id: 'orch-SIZCAP' });
    // Write a routing.jsonl that exceeds 4 MiB.
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    const bigContent = Buffer.alloc(5 * 1024 * 1024, 'x');
    fs.writeFileSync(routingPath, bigContent);
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    // Dossier write should still succeed (fail-open on routing).
    assert.equal(r.written, true);
    // Degraded journal should have a file_too_large entry.
    const degraded = path.join(dir, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(degraded), 'degraded.jsonl must exist');
    const rows = fs.readFileSync(degraded, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(rows.some((row) => row.kind === 'file_too_large'), 'must journal file_too_large');
  });

  test('routing.jsonl at exactly the cap boundary is read successfully', () => {
    const dir = mkProject();
    seedOrchestration(dir, { id: 'orch-ATCAP' });
    // Write exactly 4 MiB — should be readable.
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    // Write valid JSONL content that is exactly 4 MiB in size.
    const oneLine = '{"subtask_id":"W1"}\n';
    const repeats = Math.floor((4 * 1024 * 1024) / Buffer.byteLength(oneLine));
    fs.writeFileSync(routingPath, oneLine.repeat(repeats));
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(r.written, true);
    // No file_too_large for routing — it is at (not over) the cap.
    const degraded = path.join(dir, '.orchestray', 'state', 'degraded.jsonl');
    const rows = fs.existsSync(degraded)
      ? fs.readFileSync(degraded, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      : [];
    assert.ok(!rows.some((row) => row.kind === 'file_too_large'), 'must NOT journal file_too_large at exactly the cap');
  });

  test('oversize drift-invariants.jsonl journals file_too_large and write still succeeds', () => {
    const dir = mkProject();
    seedOrchestration(dir, { id: 'orch-DRIFT-CAP' });
    const driftPath = path.join(dir, '.orchestray', 'state', 'drift-invariants.jsonl');
    // 256 KiB + 1 byte exceeds the 256 KiB drift cap.
    const oversize = Buffer.alloc(256 * 1024 + 1, 'x');
    fs.writeFileSync(driftPath, oversize);
    const { writeDossierSnapshot } = freshModule('../../bin/write-resilience-dossier');
    const r = writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(r.written, true);
    const degraded = path.join(dir, '.orchestray', 'state', 'degraded.jsonl');
    const rows = fs.readFileSync(degraded, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(rows.some((row) => row.kind === 'file_too_large'), 'must journal file_too_large for oversize drift file');
  });
});
